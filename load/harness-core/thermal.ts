import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { hwmon } from './host-record.ts';

// Thermal samples taken by the launcher while a job runs (#796 cooling plan, approved 2026-11-24).
// Read-only sysfs, no root: the measured average frequency of every CPU (cpuinfo_avg_freq, not the
// requested one), every hwmon temperature and fan. A missing reading is null, never an error.

// launchSession: the launcher session that wrote the line; monoMs: the launcher's monotonic clock at
// the tick (both absent on a sample not yet written).
export type ThermalSample = { at: string; avgFreqKHz: (number | null)[]; temperaturesC: Record<string, number> | null; fansRpm: Record<string, number> | null; launchSession?: string; monoMs?: number };
// A tick that produced no sample. `at` is null when the line could not be placed in time (torn or unparseable).
export type FailedSample = { at: string | null; error: string; launchSession?: string; monoMs?: number };
export type SampleLine = ThermalSample | FailedSample;
export const isFailed = (s: SampleLine): s is FailedSample => !Array.isArray((s as ThermalSample).avgFreqKHz);

const readNumber = (path: string) => {
  try { const n = Number(readFileSync(path, 'utf8').trim()); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
};

export function thermalSample(now: Date): ThermalSample {
  return {
    at: now.toISOString(),
    avgFreqKHz: cpus().map((_, i) => readNumber(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_avg_freq`)),
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

export type SetStats = { medianKHz: number; minKHz: number };
// samples: usable samples inside the window; failed: failed ticks inside it; ticks: all ticks inside
// it; windowMs: the window's length after the guard. The chain is the last tick before the window,
// the ticks inside and the first after it. maxGapMs: the longest gap between consecutive ticks of the
// chain on the sampler's monotonic clock when every chain tick has one (monoComplete), else on the
// wall clock; Infinity when an edge tick is missing. offsetSpreadMs: how far wall minus monotonic
// moves along the chain, so a wall-clock step during the block shows (NaN without monotonic stamps).
export type BlockThermal = {
  samples: number; failed: number; ticks: number; windowMs: number; maxGapMs: number; monoComplete: boolean; offsetSpreadMs: number;
  server: SetStats | null; client: SetStats | null; maxTctlC: number | null;
};

// One set in one sample: the median and minimum over its CPUs, or null if any of them is unreadable.
function setStats(s: ThermalSample, set: number[]) {
  const f = set.map(c => s.avgFreqKHz[c] ?? null);
  return f.some(x => x === null) || f.length === 0 ? null : { median: median(f as number[]), min: Math.min(...(f as number[])) };
}

// A block's thermal record from the ticks inside [startMs + guardMs, endMs - guardMs]: per set, the
// median of the per-sample set medians and the minimum of the per-sample set minima. A set is null when
// any tick in the window failed or has an unreadable CPU, so missing data can never look like an
// unthrottled block. The guard keeps out a tick that an undetected clock step of up to guardMs could
// have stamped inside the window although it was taken outside the measurement.
export function blockThermal(lines: SampleLine[], startMs: number, endMs: number, sets: { server: number[]; client: number[] }, guardMs = 0): BlockThermal {
  const from = startMs + guardMs;
  const to = endMs - guardMs;
  const placed = lines.map(l => ({ l, t: l.at === null ? NaN : Date.parse(l.at) })).filter(x => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const inside = placed.filter(x => x.t >= from && x.t <= to);
  const before = placed.filter(x => x.t < from).at(-1);
  const after = placed.find(x => x.t > to);
  const chain = [before, ...inside, after].filter(x => x !== undefined);
  const monoComplete = chain.every(x => Number.isFinite(x.l.monoMs));
  const at = (x: { l: SampleLine; t: number }) => (monoComplete ? x.l.monoMs! : x.t);
  const gaps = chain.slice(1).map((x, i) => at(x) - at(chain[i]));
  const maxGapMs = before && after ? Math.max(...gaps) : Infinity;
  const offsets = chain.map(x => x.t - (x.l.monoMs ?? NaN));
  const offsetSpreadMs = monoComplete && chain.length > 0 ? Math.max(...offsets) - Math.min(...offsets) : NaN;
  const ok = inside.map(x => x.l).filter((l): l is ThermalSample => !isFailed(l));
  const failed = inside.length - ok.length;
  const stats = (set: number[]): SetStats | null => {
    const per = ok.map(s => setStats(s, set));
    if (failed > 0 || per.length === 0 || per.some(p => p === null)) return null;
    return { medianKHz: median(per.map(p => p!.median)), minKHz: Math.min(...per.map(p => p!.min)) };
  };
  const temps = ok.map(tctl).filter((t): t is number => t !== null);
  return { samples: ok.length, failed, ticks: inside.length, windowMs: to - from, maxGapMs, monoComplete, offsetSpreadMs,
    server: stats(sets.server), client: stats(sets.client), maxTctlC: temps.length ? Math.max(...temps) : null };
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
