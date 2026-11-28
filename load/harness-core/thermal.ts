import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { hwmon } from './host-record.ts';

// Thermal samples taken by the launcher while a job runs (#796 cooling plan, approved 2026-11-24).
// Read-only sysfs and procfs, no root: the measured average frequency of every CPU (cpuinfo_avg_freq,
// not the requested one), every CPU's /proc/stat counters, every hwmon temperature and fan. A missing
// reading is null, never an error.

// launchSession: the launcher session that wrote the line; monoMs: the launcher's monotonic clock at
// the tick (both absent on a sample not yet written).
// procStat: each CPU's /proc/stat counters in jiffies (user nice system idle iowait irq softirq steal
// ...), indexed by CPU number, null for a CPU without a usable line; null when /proc/stat is unreadable.
export type ProcStat = (number[] | null)[];
export type ThermalSample = { at: string; avgFreqKHz: (number | null)[]; procStat?: ProcStat | null; temperaturesC: Record<string, number> | null; fansRpm: Record<string, number> | null; launchSession?: string; monoMs?: number };
// A tick that produced no sample. `at` is null when the line could not be placed in time (torn or unparseable).
export type FailedSample = { at: string | null; error: string; launchSession?: string; monoMs?: number };
export type SampleLine = ThermalSample | FailedSample;
export const isFailed = (s: SampleLine): s is FailedSample => !Array.isArray((s as ThermalSample).avgFreqKHz);

// A frequency reading the judge accepts: a positive integer number of kHz, as sysfs writes it.
export const validKHz = (f: unknown): f is number => Number.isSafeInteger(f) && (f as number) > 0;
// A CPU's /proc/stat counters the judge accepts: at least the first 8 (through steal), every one a
// non-negative integer. Anything else (null, a string, a fraction, a negative) is unreadable.
export const validCounters = (c: unknown): c is number[] => Array.isArray(c) && c.length >= 8 && c.every(n => Number.isSafeInteger(n) && n >= 0);

// The `cpuN` lines of /proc/stat, each kept whole when every counter is valid, else null.
export function parseProcStat(text: string): ProcStat {
  const out: (number[] | null)[] = [];
  for (const line of text.split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(x => (/^\d+$/.test(x) ? Number(x) : NaN));
    out[Number(m[1])] = validCounters(v) ? v : null;
  }
  return Array.from(out, x => x ?? null);
}

// A CPU's busy and total jiffies between two ticks, exactly: total = the first 8 counters' delta (guest
// time is already in user and nice), busy = total - (idle + iowait delta). The counters present on both
// lines are compared (always the first 8; a line may gain or lose trailing columns, which alone is not
// a failure). null (activity unknown, never "idle") when either side is unreadable, any compared counter
// went backwards (guest included), or the total did not advance.
export function cpuDelta(prev: unknown, cur: unknown): { busy: bigint; total: bigint } | null {
  if (!validCounters(prev) || !validCounters(cur)) return null;
  const d = cur.slice(0, Math.min(prev.length, cur.length)).map((x, i) => BigInt(x) - BigInt(prev[i]));
  if (d.some(x => x < 0n)) return null;
  const total = d.slice(0, 8).reduce((a, b) => a + b, 0n);
  return total > 0n ? { busy: total - d[3] - d[4], total } : null;
}
// The same as a fraction, for display and tests; the judge compares cpuDelta exactly (isActive).
export function busyFraction(prev: number[], cur: number[]): number | null {
  const d = cpuDelta(prev, cur);
  return d === null ? null : Number(d.busy) / Number(d.total);
}
// A decimal threshold as an exact fraction over 10^6; one with more digits is refused, never rounded.
export function exactFraction(x: number): [bigint, bigint] {
  const n = Math.round(x * 1e6);
  if (!(n / 1e6 === x && x >= 0 && x <= 1)) throw new Error(`threshold ${x} is not a fraction in [0, 1] with at most 6 decimals`);
  return [BigInt(n), 1_000_000n];
}
// busy / total >= minBusy, in integers.
export function isActive(d: { busy: bigint; total: bigint }, minBusy: number): boolean {
  const [n, m] = exactFraction(minBusy);
  return d.busy * m >= n * d.total;
}

// One file as text, or null when it cannot be read.
const readText = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const kHz = (text: string | null) => { const t = text?.trim() ?? ''; return /^\d+$/.test(t) && validKHz(Number(t)) ? Number(t) : null; };

// The CPU part of a sample: cpuinfo_avg_freq only (F7; scaling_cur_freq is not used, not even as a
// fallback) and /proc/stat. `read` and `count` are the file system and CPU count (injected in tests).
export function cpuReadings(read: (path: string) => string | null, count: number): Pick<ThermalSample, 'avgFreqKHz' | 'procStat'> {
  const stat = read('/proc/stat');
  return {
    avgFreqKHz: Array.from({ length: count }, (_, i) => kHz(read(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_avg_freq`))),
    procStat: stat === null ? null : parseProcStat(stat),
  };
}

export function thermalSample(now: Date): ThermalSample {
  return {
    at: now.toISOString(),
    ...cpuReadings(readText, cpus().length),
    temperaturesC: hwmon(/^temp\d+_input$/, 1000),
    fansRpm: hwmon(/^fan\d+_input$/, 1),
  };
}

// The AMD package control temperature (k10temp Tctl); null when the host has none.
export const tctl = (s: ThermalSample | null) => s?.temperaturesC?.['k10temp/Tctl'] ?? null;

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The measured interval of a block on the wall clock the sampler stamps (`at`), plus the monotonic
// length of the same interval, so a wall-clock step inside it is detectable.
export type MeasuredWindow = { startMs: number; endMs: number; monoMs: number };
export function timed<T>(fn: () => T, clock = { wall: () => Date.now(), mono: () => performance.now() }): { value: T; window: MeasuredWindow } {
  const startMs = clock.wall();
  const mono0 = clock.mono();
  const value = fn();
  const monoMs = clock.mono() - mono0;
  return { value, window: { startMs, endMs: clock.wall(), monoMs } };
}

// One CPU in one block: the ticks it was active in (busy >= the judge's threshold since the previous
// tick) and the median of its frequency in those ticks (null when it was never active). mid holds the
// two middle readings (the same one twice for an odd count), so the median is exact: (mid[0] + mid[1]) / 2.
// An idle CPU's reading is the cpuinfo_min_freq placeholder, not a measurement: recorded, never used.
export type CpuBlock = { cpu: number; activeTicks: number; valueKHz: number | null; mid: [number, number] | null };
// A set in one block; problem is why its activity cannot be known (then cpus is empty).
export type SetActivity = { cpus: CpuBlock[]; problem: string | null };
// samples: usable ticks inside the window; failed: the others (an error line, or a tick whose
// frequency or counters on a judged CPU are unreadable or whose deltas are invalid, F6); ticks: all
// ticks inside it; windowMs: the window's length. The chain is the last tick before the window,
// the ticks inside and the first after it. maxGapMs: the longest gap between consecutive ticks of the
// chain on the sampler's monotonic clock when every chain tick has one (monoComplete), else on the
// wall clock; Infinity when an edge tick is missing. offsetSpreadMs: how far wall minus monotonic
// moves along the chain, so a wall-clock step during the block shows (NaN without monotonic stamps).
export type BlockThermal = {
  samples: number; failed: number; procFailed: number; ticks: number; windowMs: number; maxGapMs: number; monoComplete: boolean; offsetSpreadMs: number;
  server: SetActivity; client: SetActivity; maxTctlC: number | null;
};

type Placed = { l: SampleLine; t: number };
type Delta = { busy: bigint; total: bigint };

// Why tick i inside the block cannot be judged on these CPUs, or its per-CPU deltas. Each tick's
// activity is taken against the tick before it (for the first, the last tick before the window).
function tickReadings(inside: Placed[], before: Placed | undefined, i: number, set: number[], requireFrequency = true): string | Delta[] {
  const cur = inside[i].l;
  if (isFailed(cur)) return 'failed thermal tick';
  const prev = i === 0 ? before?.l : inside[i - 1].l;
  if (prev === undefined) return 'no tick before the block';
  if (isFailed(prev)) return 'failed tick before the block';
  const deltas: Delta[] = [];
  for (const cpu of set) {
    if (requireFrequency && !validKHz(cur.avgFreqKHz[cpu])) return `unreadable CPU frequency on CPU ${cpu}`;
    const a = Array.isArray(prev.procStat) ? prev.procStat[cpu] : null;
    const b = Array.isArray(cur.procStat) ? cur.procStat[cpu] : null;
    if (!validCounters(a) || !validCounters(b)) return `unreadable /proc/stat on CPU ${cpu}`;
    const d = cpuDelta(a, b);
    if (d === null) return `/proc/stat counters of CPU ${cpu} went backwards or did not advance`;
    deltas.push(d);
  }
  return deltas;
}

// One set's activity over the ticks inside a block. Missing data fails the whole set, so it can never
// look like an unthrottled block (F6): no CPUs, no tick, or any tick that tickReadings refuses.
function setActivity(inside: Placed[], before: Placed | undefined, set: number[], minBusy: number): SetActivity {
  const fail = (problem: string): SetActivity => ({ cpus: [], problem });
  if (set.length === 0) return fail('no CPUs in the set');
  if (inside.length === 0) return fail('no thermal ticks');
  const active = set.map(() => [] as number[]);
  for (let i = 0; i < inside.length; i++) {
    const r = tickReadings(inside, before, i, set);
    if (typeof r === 'string') return fail(r);
    const f = (inside[i].l as ThermalSample).avgFreqKHz;
    r.forEach((d, k) => { if (isActive(d, minBusy)) active[k].push(f[set[k]] as number); });
  }
  return { cpus: set.map((cpu, k) => {
    const s = [...active[k]].sort((a, b) => a - b);
    const mid: [number, number] | null = s.length ? [s[(s.length - 1) >> 1], s[s.length >> 1]] : null;
    return { cpu, activeTicks: s.length, valueKHz: mid ? (mid[0] + mid[1]) / 2 : null, mid };
  }), problem: null };
}

// A block's thermal record from every tick inside [startMs, endMs]. A CPU counts as active in a tick
// when its busy fraction is at least minBusy (compared exactly). No tick near an edge is dropped: a
// clock step that could misplace one makes the block INVALID instead (offsetSpreadMs, judged by the caller).
export function blockThermal(lines: SampleLine[], startMs: number, endMs: number, sets: { server: number[]; client: number[] }, minBusy: number): BlockThermal {
  exactFraction(minBusy);
  const from = startMs;
  const to = endMs;
  const placed = lines.map(l => ({ l, t: l.at === null ? NaN : Date.parse(l.at) })).filter(x => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const inside = placed.filter(x => x.t >= from && x.t <= to);
  const before = placed.filter(x => x.t < from).at(-1);
  const after = placed.find(x => x.t > to);
  const chain = [before, ...inside, after].filter(x => x !== undefined);
  const monoComplete = chain.every(x => Number.isFinite(x.l.monoMs));
  const at = (x: Placed) => (monoComplete ? x.l.monoMs! : x.t);
  const gaps = chain.slice(1).map((x, i) => at(x) - at(chain[i]));
  const maxGapMs = before && after ? Math.max(...gaps) : Infinity;
  const offsets = chain.map(x => x.t - (x.l.monoMs ?? NaN));
  const offsetSpreadMs = monoComplete && chain.length > 0 ? Math.max(...offsets) - Math.min(...offsets) : NaN;
  const judged = [...sets.server, ...sets.client];
  const ok = inside.filter((_, i) => typeof tickReadings(inside, before, i, judged) !== 'string').length;
  const procFailed = inside.filter((_, i) => typeof tickReadings(inside, before, i, judged, false) === 'string').length;
  const temps = inside.map(x => x.l).filter((l): l is ThermalSample => !isFailed(l)).map(tctl).filter((t): t is number => t !== null);
  return { samples: ok, failed: inside.length - ok, procFailed, ticks: inside.length, windowMs: to - from, maxGapMs, monoComplete, offsetSpreadMs,
    server: setActivity(inside, before, sets.server, minBusy), client: setActivity(inside, before, sets.client, minBusy), maxTctlC: temps.length ? Math.max(...temps) : null };
}

// Every line is kept: an error line or an unusable line is a failed tick, never dropped.
export const parseSamples = (jsonl: string): SampleLine[] => jsonl.split('\n').filter(l => l.trim() !== '').map(l => {
  let v: Record<string, unknown>;
  try { v = JSON.parse(l); } catch { return { at: null, error: 'unparseable line' }; }
  if (typeof v?.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return { at: null, error: 'line without a time' };
  if (Array.isArray(v.avgFreqKHz)) return v as unknown as ThermalSample;
  return { at: v.at, error: String(v.error ?? 'no frequencies'), ...(typeof v.launchSession === 'string' ? { launchSession: v.launchSession } : {}),
    ...(typeof v.monoMs === 'number' ? { monoMs: v.monoMs } : {}) };
});
