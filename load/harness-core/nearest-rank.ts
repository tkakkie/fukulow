// Nearest-rank percentile: the smallest sample with at least `fraction` of the samples at or below it,
// i.e. sorted[ceil(fraction * n) - 1]. `fraction` is in (0, 1] (callers on a percent scale pass p / 100).
// Empty input returns undefined; each harness's wrapper maps that to its own empty-input result
// (null, NaN, 0, a throw), because those feed different INVALID / NOT EVALUATED rules.
export function nearestRank(sorted: readonly number[], fraction: number): number | undefined {
  if (!(fraction > 0 && fraction <= 1)) throw new RangeError(`Nearest-rank fraction must be in (0, 1]: ${fraction}`);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! < sorted[i - 1]!) throw new Error('Nearest-rank input is not sorted ascending');
  if (sorted.length === 0) return undefined;
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}
