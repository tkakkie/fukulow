import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aggregateDirectory,
  biasCorrectedBootstrapCI,
  evaluateMetric,
  nearestRank,
  olsSlope,
} from './aggregate-wasm-core.ts'

describe('aggregate-wasm-core statistics (§3)', () => {
  it('computes nearest-rank p50, p95, p99 with index = ceil(q*N)-1', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(nearestRank(ten, 50)).toBe(5)
    expect(nearestRank(ten, 95)).toBe(10)
    expect(nearestRank(ten, 99)).toBe(10)
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(nearestRank(hundred, 50)).toBe(50)
    expect(nearestRank(hundred, 95)).toBe(95)
    expect(nearestRank(hundred, 99)).toBe(99)
  })

  it('computes ordinary least-squares slope over post-warmup memory samples', () => {
    const xs = Array.from({ length: 16 }, (_, i) => 2500 + i * 500)
    const ys = xs.map((x) => 50_000_000 + 32 * x)
    expect(olsSlope(xs, ys)).toBeCloseTo(32, 6)
  })

  it('produces reproducible 95% bias-corrected percentile bootstrap CIs with seeded RNG', () => {
    const deltas = [2.0, 3.5, 4.0, 4.5, 8.0]
    const ci1 = biasCorrectedBootstrapCI(deltas, 10_000, 466)
    const ci2 = biasCorrectedBootstrapCI(deltas, 10_000, 466)
    expect(ci1).toEqual(ci2)
    expect(ci1.ciLowPct).toBeGreaterThanOrEqual(2.0)
    expect(ci1.ciHighPct).toBeLessThanOrEqual(8.0)
  })

  it('marks INCONCLUSIVE when baseline 5-round spread exceeds 10% and the spread floor', () => {
    const res = evaluateMetric(
      [100, 102, 105, 110, 120],
      [101, 103, 105, 110, 121],
      { thresholdPct: 10, minDetectableFloor: 2, baselineSpreadFloor: 5 },
      466,
    )
    expect(res.baselineNoisy).toBe(true)
    expect(res.status).toBe('INCONCLUSIVE')
  })

  it('marks INCONCLUSIVE when 95% bootstrap CI straddles +T% and absDiff exceeds min-detectable floor', () => {
    const res = evaluateMetric(
      [100, 100, 100, 100, 100],
      [104, 106, 108, 112, 115],
      { thresholdPct: 10, minDetectableFloor: 2, baselineSpreadFloor: 5 },
      466,
    )
    expect(res.straddlesThreshold).toBe(true)
    expect(res.status).toBe('INCONCLUSIVE')
  })

  it('marks MET within threshold and MISSED when CI is cleanly above threshold', () => {
    const met = evaluateMetric(
      [100, 101, 99, 100, 100],
      [103, 104, 102, 103, 104],
      { thresholdPct: 10, minDetectableFloor: 2, baselineSpreadFloor: 5 },
      466,
    )
    expect(met.status).toBe('MET')

    const missed = evaluateMetric(
      [100, 101, 99, 100, 100],
      [125, 126, 124, 125, 127],
      { thresholdPct: 10, minDetectableFloor: 2, baselineSpreadFloor: 5 },
      466,
    )
    expect(missed.status).toBe('MISSED')
  })

  it('marks a delta above the threshold MISSED even when the absolute difference is below the floor', () => {
    const res = evaluateMetric([1, 1, 1, 1, 1], [1.5, 1.5, 1.5, 1.5, 1.5], { thresholdPct: 10, minDetectableFloor: 2, baselineSpreadFloor: 5 }, 466)
    expect(res.status).toBe('MISSED')
  })
})

describe('aggregateDirectory input checks', () => {
  const round = (arm: string, n: number, omit?: string) => [
    { type: 'meta', arm, round: n, smoke: false },
    { type: 'step_summary', combinedP50: 5, combinedP95: 30, combinedP99: 60 },
    { type: 'sustained', p50: 1, p95: 2, p99: 3, finalQueue: 0 },
    { type: 'max_rate_summary', maxSustainableRateMsgPerSec: 8000 },
    ...['history_8x50', 'history_2x200', 'catchup_250', 'catchup_1000'].map((subCase) => ({ type: 'bulk_receipt', subCase, p50: 1, p95: 2 })),
    { type: 'memory_summary', steadyMedianMiB: 50, peakMaxMiB: 80, wasmPeakKiB: 0, wasmPeakPages: 0, wasmPagesAddedPostWarmup: 0, olsSlopeBytesPerMessage: 1 },
    { type: 'g3_integrity', passed: true, totalStepAssertions: 1, totalRunCompletionAssertions: 1 },
  ].filter((l) => l.type !== omit).map((l) => JSON.stringify(l)).join('\n')
  const withDir = (files: Record<string, string>, check: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'agg466-'))
    try {
      for (const [name, body] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), body) }
      check(dir)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const all = (omitFromW?: string) => Object.fromEntries([1, 2].flatMap((n) =>
    (['B', 'W', 'R'] as const).map((arm) => [`round-${n}-${arm}.jsonl`, round(arm, n, arm === 'W' ? omitFromW : undefined)])))

  it('aggregates complete paired rounds', () => {
    withDir(all(), (dir) => expect(aggregateDirectory(dir, 466, [2]).step.status).toBe('MET'))
  })
  it('rejects a round with a missing section instead of scoring it as 0 or passed', () => {
    withDir(all('memory_summary'), (dir) => expect(() => aggregateDirectory(dir, 466, [2])).toThrow(/missing memory_summary/))
    withDir(all('g3_integrity'), (dir) => expect(() => aggregateDirectory(dir, 466, [2])).toThrow(/missing g3_integrity/))
  })
  it('rejects a round count the plan does not use', () => {
    withDir(all(), (dir) => expect(() => aggregateDirectory(dir)).toThrow(/the plan needs 5 or 9/))
  })
  it('rejects a failed G3 integrity record', () => {
    const files = all(); files['round-1-W.jsonl'] = files['round-1-W.jsonl'].replace('"passed":true', '"passed":false')
    withDir(files, (dir) => expect(() => aggregateDirectory(dir, 466, [2])).toThrow(/G3 integrity did not pass/))
  })
  it('rejects arms that do not cover the same rounds', () => {
    const files = all(); delete files['round-2-R.jsonl']
    withDir(files, (dir) => expect(() => aggregateDirectory(dir, 466, [2])).toThrow(/R rounds/))
  })
})
