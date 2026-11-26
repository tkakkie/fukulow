import { nearestRank } from '../harness-core/nearest-rank.ts';

export const minimumSamples = 1_000;
const option3ThresholdMs = 50;
const readinessBoundMs = 200;

export type Sample = {
  sample: number;
  startedMs: number;
  finishedMs: number;
  elapsedNs: number;
  ok: boolean;
};

export function readSamples(raw: string): Sample[] {
  return raw.trimEnd().split('\n').filter(Boolean).map((line, i) => {
    const row: Sample = JSON.parse(line);
    if (row.sample !== i + 1 || typeof row.ok !== 'boolean' ||
        ![row.startedMs, row.finishedMs, row.elapsedNs].every(n => Number.isSafeInteger(n) && n >= 0) ||
        row.finishedMs < row.startedMs) throw new Error(`Invalid sample row ${i + 1}`);
    return row;
  });
}

function distribution(samples: readonly Sample[]) {
  const sorted = samples.filter(row => row.ok).map(row => row.elapsedNs / 1e6).sort((a, b) => a - b);
  return {
    samples: samples.length,
    failed: samples.length - sorted.length,
    p50Ms: nearestRank(sorted, 0.5) ?? null,
    p99Ms: nearestRank(sorted, 0.99) ?? null,
    p999Ms: nearestRank(sorted, 0.999) ?? null,
    maxMs: sorted.at(-1) ?? null,
    atOrAboveReadinessBound: sorted.filter(ms => ms >= readinessBoundMs).length,
  };
}

export function summarize(idle: readonly Sample[], loaded: readonly Sample[], problems: readonly string[] = []) {
  const states = { idle: distribution(idle), loaded: distribution(loaded) };
  const reasons = [...problems];
  for (const [name, state] of Object.entries(states)) {
    if (state.failed > 0) reasons.push(`${name} has failed acquisitions`);
    if (state.samples - state.failed < minimumSamples) reasons.push(`${name} has fewer than ${minimumSamples} successful samples`);
  }
  const verdict = reasons.length > 0 ? 'INVALID'
    : Object.values(states).every(state => state.p999Ms !== null && state.p999Ms < option3ThresholdMs)
      ? 'option 3' : 'maintainer chooses';
  return { verdict, reasons, readinessBoundMs, option3ThresholdMs, minimumSamples, states } as const;
}
