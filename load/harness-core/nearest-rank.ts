// What a fraction outside (0, 1] does, matching the copies harnesses use today. The rank index is
// ceil(fraction * n) - 1, and each mode applies the copy's clamping to that index:
// - 'reject' (default) throws, NaN included;
// - 'clamp' clamps to the first and last sample (sql-probes/519 `quantile`, `hot-latency.ts`,
//   `web/scripts/first-paint.ts`, `web/scripts/aggregate-wasm-core.ts`);
// - 'clamp-high' clamps only above the last sample (`dms-workload.ts`, `revocation-burst-judgment.ts`,
//   frozen `search-engines/bench.ts`);
// - 'clamp-low' clamps only below the first sample (`unread-init/model.ts`, `log-compare/measure.ts`);
// - 'none' clamps nothing (`signin-summary.ts`, `reply-counts-model.ts`, `move/*`, sql-probes/515).
// An index left outside the samples, or a NaN fraction in any mode but 'reject', gives undefined, as
// `sorted[index]` does in those copies.
export type OutOfRange = 'reject' | 'clamp' | 'clamp-low' | 'clamp-high' | 'none';

// The nearest-rank index into `length` sorted samples, or undefined where the copies index outside
// the samples (always for length 0). Use it when the samples are not plain numbers, for example the
// sql-probes/515-app rows sorted by latency with an ID tie-break.
export function nearestRankIndex(length: number, fraction: number, outOfRange: OutOfRange = 'reject'): number | undefined {
  if (outOfRange === 'reject' && !(fraction > 0 && fraction <= 1)) throw new RangeError(`Nearest-rank fraction must be in (0, 1]: ${fraction}`);
  let index = Math.ceil(fraction * length) - 1;
  if (outOfRange === 'clamp' || outOfRange === 'clamp-low') index = Math.max(0, index);
  if (outOfRange === 'clamp' || outOfRange === 'clamp-high') index = Math.min(length - 1, index);
  return index >= 0 && index < length ? index : undefined;
}

// Nearest-rank percentile: the smallest sample with at least `fraction` of the samples at or below it,
// i.e. sorted[ceil(fraction * n) - 1]. Callers on a percent scale pass p / 100. Empty input returns
// undefined; each harness's wrapper maps that to its own empty-input result (null, NaN, 0, a throw),
// because those feed different INVALID / NOT EVALUATED rules. Unsorted input throws.
export function nearestRank(sorted: readonly number[], fraction: number, outOfRange: OutOfRange = 'reject'): number | undefined {
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! < sorted[i - 1]!) throw new Error('Nearest-rank input is not sorted ascending');
  const index = nearestRankIndex(sorted.length, fraction, outOfRange);
  return index === undefined ? undefined : sorted[index];
}
