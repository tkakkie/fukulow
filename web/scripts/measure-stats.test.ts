import { expect, it } from 'vitest'
import { firstPaintPercentile, medianOf, nearestRank, olsSlope, summarizeSamples } from './measure-stats.ts'

const samples = [
  [], [7.125], [3.125, 1, 2.8125, 1],
  Array.from({ length: 100 }, (_, i) => 100 - i + 0.125),
  [5, Number.NaN, 3, 2], [-Infinity, -0, 0, Infinity],
]

it('matches the previous wasm and first-paint ranks on the same samples', () => {
  for (const values of samples) {
    const sorted = [...values].sort((a, b) => a - b)
    const legacyPick = (fraction: number) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
    for (const q of [-Infinity, 0, 0.5, 1, 29, 50, 90, 95, 99, 100, Infinity, NaN]) {
      expect(nearestRank(values, q)).toBe(values.length === 0 ? 0 : legacyPick(q > 1 ? q / 100 : q))
      const picked = legacyPick(q / 100)
      if (picked === undefined) {
        expect(() => firstPaintPercentile(values, q)).toThrow(new TypeError("Cannot read properties of undefined (reading 'toFixed')"))
      } else {
        expect(firstPaintPercentile(values, q)).toBe(Number(picked.toFixed(2)))
      }
    }
  }
})

it('keeps the wasm summary rounding and the empty memory statistics', () => {
  expect(summarizeSamples([3.125, 1.0018, 2.3456])).toEqual({ p50: 2.346, p95: 3.125, p99: 3.125 })
  expect(summarizeSamples([])).toEqual({ p50: 0, p95: 0, p99: 0 })
  expect(medianOf([3, 10, 1, 2])).toBe(2.5)
  expect(medianOf([])).toBe(0)
  expect(olsSlope([1, 2, 3], [7, 10, 13])).toBe(3)
  expect(olsSlope([], [])).toBe(0)
})
