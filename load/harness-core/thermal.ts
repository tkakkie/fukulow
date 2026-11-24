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

const readNumber = (path: string) => {
  try { const n = Number(readFileSync(path, 'utf8').trim()); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
};

// The `cpuN` lines of /proc/stat. A line needs the first 8 counters (through steal) as non-negative integers.
export function parseProcStat(text: string): ProcStat {
  const out: (number[] | null)[] = [];
  for (const line of text.split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[Number(m[1])] = v.length >= 8 && v.every(n => Number.isSafeInteger(n) && n >= 0) ? v : null;
  }
  return Array.from(out, x => x ?? null);
}
const readProcStat = () => { try { return parseProcStat(readFileSync('/proc/stat', 'utf8')); } catch { return null; } };

// A CPU's busy fraction between two ticks: 1 - (idle + iowait delta) / (total delta), the total being
// the first 8 counters (guest time is already in user and nice). null when a counter went backwards,
// is missing, or the total did not advance: the activity is then unknown, never "idle".
export function busyFraction(prev: number[], cur: number[]): number | null {
  if (prev.length < 8 || cur.length < 8) return null;
  const d = Array.from({ length: 8 }, (_, i) => cur[i] - prev[i]);
  if (!d.every(x => Number.isFinite(x) && x >= 0)) return null;
  const total = d.reduce((a, b) => a + b, 0);
  return total > 0 ? 1 - (d[3] + d[4]) / total : null;
}

export function thermalSample(now: Date): ThermalSample {
  return {
    at: now.toISOString(),
    avgFreqKHz: cpus().map((_, i) => readNumber(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_avg_freq`)),
    procStat: readProcStat(),
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
// tick) and the median of its frequency in those ticks (null when it was never active). An idle CPU's
// reading is the cpuinfo_min_freq placeholder, not a measurement, so it is recorded but never used.
export type CpuBlock = { cpu: number; activeTicks: number; valueKHz: number | null };
// A set in one block; problem is why its activity cannot be known (then cpus is empty).
export type SetActivity = { cpus: CpuBlock[]; problem: string | null };
// samples: usable samples inside the window; failed: failed ticks inside it; ticks: all ticks inside
// it; windowMs: the window's length. The chain is the last tick before the window,
// the ticks inside and the first after it. maxGapMs: the longest gap between consecutive ticks of the
// chain on the sampler's monotonic clock when every chain tick has one (monoComplete), else on the
// wall clock; Infinity when an edge tick is missing. offsetSpreadMs: how far wall minus monotonic
// moves along the chain, so a wall-clock step during the block shows (NaN without monotonic stamps).
export type BlockThermal = {
  samples: number; failed: number; ticks: number; windowMs: number; maxGapMs: number; monoComplete: boolean; offsetSpreadMs: number;
  server: SetActivity; client: SetActivity; maxTctlC: number | null;
};

type Placed = { l: SampleLine; t: number };

// One set's activity over the ticks inside a block. Each tick's busy fraction is taken against the tick
// before it (for the first, the last tick before the window). Missing data fails the whole set, so it
// can never look like an unthrottled block: a failed tick, no tick or no predecessor, an unreadable
// frequency on any CPU of the set, unreadable /proc/stat, or counters that went backwards or did not advance.
function setActivity(inside: Placed[], before: Placed | undefined, set: number[], minBusy: number): SetActivity {
  const fail = (problem: string): SetActivity => ({ cpus: [], problem });
  if (inside.length === 0) return fail('no thermal ticks');
  if (inside.some(x => isFailed(x.l))) return fail('failed thermal tick');
  const active = set.map(() => [] as number[]);
  for (let i = 0; i < inside.length; i++) {
    const prev = i === 0 ? before?.l : inside[i - 1].l;
    if (prev === undefined) return fail('no tick before the block');
    if (isFailed(prev)) return fail('failed tick before the block');
    const cur = inside[i].l as ThermalSample;
    for (const [k, cpu] of set.entries()) {
      const f = cur.avgFreqKHz[cpu] ?? null;
      if (f === null) return fail(`unreadable CPU frequency on CPU ${cpu}`);
      const a = Array.isArray(prev.procStat) ? prev.procStat[cpu] : null;
      const b = Array.isArray(cur.procStat) ? cur.procStat[cpu] : null;
      if (!Array.isArray(a) || !Array.isArray(b)) return fail(`unreadable /proc/stat on CPU ${cpu}`);
      const busy = busyFraction(a, b);
      if (busy === null) return fail(`/proc/stat counters of CPU ${cpu} went backwards or did not advance`);
      if (busy >= minBusy) active[k].push(f);
    }
  }
  return { cpus: set.map((cpu, k) => ({ cpu, activeTicks: active[k].length, valueKHz: active[k].length ? median(active[k]) : null })), problem: null };
}

// A block's thermal record from every tick inside [startMs, endMs]. A CPU counts as active in a tick
// when its busy fraction is at least minBusy. No tick near an edge is dropped: a clock step that could
// misplace one makes the block INVALID instead (offsetSpreadMs, judged by the caller).
export function blockThermal(lines: SampleLine[], startMs: number, endMs: number, sets: { server: number[]; client: number[] }, minBusy: number): BlockThermal {
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
  const ok = inside.map(x => x.l).filter((l): l is ThermalSample => !isFailed(l));
  const temps = ok.map(tctl).filter((t): t is number => t !== null);
  return { samples: ok.length, failed: inside.length - ok.length, ticks: inside.length, windowMs: to - from, maxGapMs, monoComplete, offsetSpreadMs,
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
