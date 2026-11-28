// Compute statistics for measurement samples.
import { nearestRankIndex } from '../../load/harness-core/nearest-rank.ts'

/** Nearest-rank percentile: index = ceil(q * N) - 1 (q in [0, 1] or [0, 100]). */
export function nearestRank(values: number[], q: number): number {
  if (values.length === 0) return 0
  const ratio = q > 1 ? q / 100 : q
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[nearestRankIndex(sorted.length, ratio, 'clamp')!]
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// First paint uses a percent scale, rounds to hundredths, and throws on empty input.
export function firstPaintPercentile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[nearestRankIndex(sorted.length, percentile / 100, 'clamp')!].toFixed(2))
}

/** Ordinary least-squares linear regression slope (y per unit x). */
export function olsSlope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return 0
  const meanX = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const meanY = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - meanX; num += dx * (ys[i] - meanY); den += dx * dx }
  return den === 0 ? 0 : num / den
}

export const summarizeSamples = (samples: number[]) => ({
  p50: Number(nearestRank(samples, 50).toFixed(3)),
  p95: Number(nearestRank(samples, 95).toFixed(3)),
  p99: Number(nearestRank(samples, 99).toFixed(3)),
})
