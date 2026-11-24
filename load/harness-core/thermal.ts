import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { hwmon } from './host-record.ts';

// Thermal samples taken by the launcher while a job runs (#796 cooling plan, approved 2026-11-24).
// Read-only sysfs, no root: the measured average frequency of every CPU (cpuinfo_avg_freq, not the
// requested one), every hwmon temperature and fan. A missing reading is null, never an error.

export type ThermalSample = { at: string; avgFreqKHz: (number | null)[]; temperaturesC: Record<string, number> | null; fansRpm: Record<string, number> | null };

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

export type SetStats = { medianKHz: number; minKHz: number };
export type BlockThermal = { samples: number; server: SetStats | null; client: SetStats | null; maxTctlC: number | null };

// One set in one sample: the median and minimum over its CPUs, or null if any of them is unreadable.
function setStats(s: ThermalSample, set: number[]) {
  const f = set.map(c => s.avgFreqKHz[c] ?? null);
  return f.some(x => x === null) || f.length === 0 ? null : { median: median(f as number[]), min: Math.min(...(f as number[])) };
}

// A block's thermal record from the samples inside [startMs, endMs]: per set, the median of the
// per-sample set medians and the minimum of the per-sample set minima. A set with any unusable
// sample in the window is null, so missing data can never look like an unthrottled block.
export function blockThermal(samples: ThermalSample[], startMs: number, endMs: number, sets: { server: number[]; client: number[] }): BlockThermal {
  const inside = samples.filter(s => { const t = Date.parse(s.at); return t >= startMs && t <= endMs; });
  const stats = (set: number[]): SetStats | null => {
    const per = inside.map(s => setStats(s, set));
    if (per.length === 0 || per.some(p => p === null)) return null;
    return { medianKHz: median(per.map(p => p!.median)), minKHz: Math.min(...per.map(p => p!.min)) };
  };
  const temps = inside.map(tctl).filter((t): t is number => t !== null);
  return { samples: inside.length, server: stats(sets.server), client: stats(sets.client), maxTctlC: temps.length ? Math.max(...temps) : null };
}

export const parseSamples = (jsonl: string): ThermalSample[] =>
  jsonl.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as ThermalSample).filter(s => Array.isArray(s.avgFreqKHz));
