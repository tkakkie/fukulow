// Statistical aggregator for Issue #466 wasm sync core measurements.
// Usage: node web/scripts/aggregate-wasm-core.ts <dir> [--seed 466]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type Arm = 'B' | 'W' | 'R'
export type MetricConfig = { thresholdPct: number; minDetectableFloor: number; baselineSpreadFloor: number }
export type BootstrapCI = { pointPct: number; ciLowPct: number; ciHighPct: number; z0: number }
export type ArmSummary = { median: number; min: number; max: number; rounds: number[] }
export type ComparisonResult = {
  baseline: ArmSummary; candidate: ArmSummary; pairedDeltasPct: number[]; medianDeltaPct: number; absDiff: number
  baselineSpreadPct: number; baselineAbsSpread: number; baselineNoisy: boolean
  ci: BootstrapCI; straddlesThreshold: boolean; status: 'MET' | 'MISSED' | 'INCONCLUSIVE'
}

/** Nearest-rank percentile: index = ceil(q * N) - 1 (q in [0, 1] or [0, 100]). */
export function nearestRank(values: number[], q: number): number {
  if (values.length === 0) return 0
  const ratio = q > 1 ? q / 100 : q
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))]
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const summarizeRounds = (values: number[]): ArmSummary =>
  values.length === 0 ? { median: 0, min: 0, max: 0, rounds: [] }
    : { median: medianOf(values), min: Math.min(...values), max: Math.max(...values), rounds: [...values] }

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

/** Deterministic Mulberry32 PRNG. */
function createRng(seed = 466): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function normCdf(z: number): number {
  if (z < -8) return 0
  if (z > 8) return 1
  const sign = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

function normInv(p: number): number {
  if (p <= 0) return -8
  if (p >= 1) return 8
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - 0.02425) {
    const q = p - 0.5, r = q * q
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

/** 95% bias-corrected percentile bootstrap CI (10,000 resamples of paired round ratios). */
export function biasCorrectedBootstrapCI(pairedDeltasPct: number[], resamples = 10_000, seed = 466): BootstrapCI {
  const k = pairedDeltasPct.length
  if (k === 0) return { pointPct: 0, ciLowPct: 0, ciHighPct: 0, z0: 0 }
  const pointPct = medianOf(pairedDeltasPct)
  if (k === 1 || pairedDeltasPct.every((v) => v === pairedDeltasPct[0])) return { pointPct, ciLowPct: pointPct, ciHighPct: pointPct, z0: 0 }
  const rng = createRng(seed), replicates = new Array<number>(resamples), sample = new Array<number>(k)
  let lessCount = 0, equalCount = 0
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < k; i++) sample[i] = pairedDeltasPct[Math.floor(rng() * k)]
    const stat = medianOf(sample)
    replicates[b] = stat
    if (stat < pointPct) lessCount++
    else if (stat === pointPct) equalCount++
  }
  replicates.sort((a, b) => a - b)
  const prop = (lessCount + 0.5 * equalCount) / resamples
  const z0 = prop > 0 && prop < 1 ? normInv(prop) : 0, zAlpha = 1.959963984540054
  const alphaLow = z0 === 0 ? 0.025 : normCdf(2 * z0 - zAlpha), alphaHigh = z0 === 0 ? 0.975 : normCdf(2 * z0 + zAlpha)
  return {
    pointPct, z0,
    ciLowPct: replicates[Math.min(resamples - 1, Math.max(0, Math.ceil(alphaLow * resamples) - 1))],
    ciHighPct: replicates[Math.min(resamples - 1, Math.max(0, Math.ceil(alphaHigh * resamples) - 1))],
  }
}

export function evaluateMetric(baselineRounds: number[], candidateRounds: number[], config: MetricConfig, seed = 466): ComparisonResult {
  const baseline = summarizeRounds(baselineRounds), candidate = summarizeRounds(candidateRounds)
  const pairCount = Math.min(baselineRounds.length, candidateRounds.length)
  const pairedDeltasPct = Array.from({ length: pairCount }, (_, r) => baselineRounds[r] > 0 ? 100 * (candidateRounds[r] / baselineRounds[r] - 1) : 0)
  const medianDeltaPct = medianOf(pairedDeltasPct), absDiff = Math.abs(candidate.median - baseline.median)
  const baselineAbsSpread = baseline.max - baseline.min
  const baselineSpreadPct = baseline.median > 0 ? (100 * baselineAbsSpread) / baseline.median : 0
  const baselineNoisy = baselineRounds.length > 1 && baselineSpreadPct > 10.0 && baselineAbsSpread > config.baselineSpreadFloor
  const ci = biasCorrectedBootstrapCI(pairedDeltasPct, 10_000, seed)
  const straddlesThreshold = pairedDeltasPct.length > 1 && ci.ciLowPct <= config.thresholdPct && config.thresholdPct < ci.ciHighPct && absDiff > config.minDetectableFloor
  const status: ComparisonResult['status'] = baselineNoisy || straddlesThreshold ? 'INCONCLUSIVE'
    : medianDeltaPct <= config.thresholdPct ? 'MET' : 'MISSED'
  return { baseline, candidate, pairedDeltasPct, medianDeltaPct, absDiff, baselineSpreadPct, baselineAbsSpread, baselineNoisy, ci, straddlesThreshold, status }
}

const fmtVal = (s: ArmSummary, digits = 2) => `${s.median.toFixed(digits)} [${s.min.toFixed(digits)}–${s.max.toFixed(digits)}]`
const fmtDelta = (pct: number) => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
const fmtCand = (c: ComparisonResult, digits = 2, extra = '') =>
  `${fmtVal(c.candidate, digits)}${extra} (${fmtDelta(c.medianDeltaPct)}, CI [${fmtDelta(c.ci.ciLowPct)}, ${fmtDelta(c.ci.ciHighPct)}])`
const combineStatuses = (s: Array<'MET' | 'MISSED' | 'INCONCLUSIVE'>): 'MET' | 'MISSED' | 'INCONCLUSIVE' =>
  s.includes('MISSED') ? 'MISSED' : s.includes('INCONCLUSIVE') ? 'INCONCLUSIVE' : 'MET'

type RoundData = {
  arm: Arm; round: number; stepP50: number; stepP95: number; stepP99: number
  sustainedP50: number; sustainedP95: number; sustainedP99: number; sustainedFinalQueue: number
  maxSustainableRate: number; bulk: Record<string, { p50: number; p95: number }>
  steadyMiB: number; peakMiB: number; wasmPeakKiB: number; wasmPeakPages: number; wasmPagesAdded: number; olsSlope: number
  g3Passed: boolean; g3Steps: number
}

function walkFiles(dir: string, suffix: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkFiles(full, suffix, out)
    else if (entry.endsWith(suffix)) out.push(full)
  }
  return out.sort()
}

type FirstPaintCell = { pathLabel: string; network: string; cache: string; fcpMs: { p50: number; p95: number }; timelineVisibleMs: { p50: number; p95: number } }
type FirstPaintRound = { arm: Arm; round: number; cells: Record<string, FirstPaintCell> }

function parseFirstPaintFiles(dir: string): Record<Arm, FirstPaintRound[]> {
  const out: Record<Arm, FirstPaintRound[]> = { B: [], W: [], R: [] }
  for (const file of walkFiles(join(dir, 'fp'), '.json')) {
    {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { arm?: Arm; round?: number; summaries?: FirstPaintCell[] }
      if (!Array.isArray(data.summaries)) throw new Error(`${file}: no first-display summaries`)
      for (const c of data.summaries) for (const v of [c.fcpMs?.p50, c.fcpMs?.p95, c.timelineVisibleMs?.p50, c.timelineVisibleMs?.p95]) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${file}: invalid first-display value in ${c.pathLabel}|${c.network}|${c.cache}`)
      }
      // Layout fixed by the plan: <dir>/fp/<B|W|R>/round-<n>/results.json; anything else is an error, never a guess.
      const layout = file.match(/[/\\]fp[/\\]([BWR])[/\\]round-(\d+)[/\\]/)
      if (!layout) throw new Error(`first-display result outside <dir>/fp/<arm>/round-<n>/: ${file}`)
      const arm = layout[1] as Arm, round = Number(layout[2])
      const cells = Object.fromEntries(data.summaries.map((s) => [`${s.pathLabel}|${s.network}|${s.cache}`, s]))
      out[arm].push({ arm, round, cells })
    }
  }
  for (const arm of ['B', 'W', 'R'] as const) out[arm].sort((a, b) => a.round - b.round)
  return out
}

const BULK_CASES = ['history_8x50', 'history_2x200', 'catchup_250', 'catchup_1000'] as const

// A missing section or value is an error: it must never turn into 0 (a perfect score) or a passed gate.
function parseRoundFile(file: string): RoundData {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>)
  const section = (type: string) => {
    const found = lines.find((l) => l.type === type)
    if (!found) throw new Error(`${file}: missing ${type}`)
    return found
  }
  const num = (rec: Record<string, unknown>, key: string) => {
    const v = rec[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${file}: ${String(rec.type)}.${key} is not a number`)
    return v
  }
  const meta = section('meta')
  if (meta.smoke === true) throw new Error(`${file}: smoke output is not a measurement round`)
  if (meta.arm !== 'B' && meta.arm !== 'W' && meta.arm !== 'R') throw new Error(`${file}: meta.arm must be B, W or R`)
  const stepSum = section('step_summary'), sustained = section('sustained'), maxRate = section('max_rate_summary')
  const memSum = section('memory_summary'), g3 = section('g3_integrity')
  if (g3.passed !== true || num(g3, 'totalStepAssertions') <= 0 || num(g3, 'totalRunCompletionAssertions') <= 0) {
    throw new Error(`${file}: G3 integrity did not pass`)
  }
  const bulk: Record<string, { p50: number; p95: number }> = {}
  for (const l of lines.filter((x) => x.type === 'bulk_receipt')) bulk[String(l.subCase)] = { p50: num(l, 'p50'), p95: num(l, 'p95') }
  for (const k of BULK_CASES) if (!bulk[k]) throw new Error(`${file}: missing bulk_receipt ${k}`)
  return {
    arm: meta.arm, round: num(meta, 'round'),
    stepP50: num(stepSum, 'combinedP50'), stepP95: num(stepSum, 'combinedP95'), stepP99: num(stepSum, 'combinedP99'),
    sustainedP50: num(sustained, 'p50'), sustainedP95: num(sustained, 'p95'), sustainedP99: num(sustained, 'p99'),
    sustainedFinalQueue: num(sustained, 'finalQueue'), maxSustainableRate: num(maxRate, 'maxSustainableRateMsgPerSec'),
    bulk, steadyMiB: num(memSum, 'steadyMedianMiB'), peakMiB: num(memSum, 'peakMaxMiB'),
    wasmPeakKiB: num(memSum, 'wasmPeakKiB'), wasmPeakPages: num(memSum, 'wasmPeakPages'),
    wasmPagesAdded: num(memSum, 'wasmPagesAddedPostWarmup'), olsSlope: num(memSum, 'olsSlopeBytesPerMessage'),
    g3Passed: true, g3Steps: num(g3, 'totalStepAssertions'),
  }
}

// Rounds are paired by round number; B, W and R must cover exactly the same rounds.
function requireSameRounds(label: string, byArm: Record<Arm, Array<{ round: number }>>, roundCounts: readonly number[]): void {
  const key = (arm: Arm) => byArm[arm].map((r) => r.round).join(',')
  if (!roundCounts.includes(byArm.B.length)) throw new Error(`${label}: ${byArm.B.length} rounds for B, the plan needs ${roundCounts.join(' or ')}`)
  for (const arm of ['W', 'R'] as const) {
    if (key(arm) !== key('B')) throw new Error(`${label}: ${arm} rounds [${key(arm)}] differ from B rounds [${key('B')}]`)
  }
  for (const arm of ['B', 'W', 'R'] as const) {
    if (new Set(byArm[arm].map((r) => r.round)).size !== byArm[arm].length) throw new Error(`${label}: duplicate round for ${arm}`)
  }
}

// The plan runs 5 rounds, or 9 after the one pre-committed extension.
export function aggregateDirectory(dir: string, seed = 466, roundCounts: readonly number[] = [5, 9]) {
  const parsed = walkFiles(dir, '.jsonl').map(parseRoundFile)
  const byArm: Record<Arm, RoundData[]> = { B: [], W: [], R: [] }
  for (const r of parsed) byArm[r.arm].push(r)
  for (const arm of ['B', 'W', 'R'] as const) byArm[arm].sort((a, b) => a.round - b.round)
  requireSameRounds('sync', byArm, roundCounts)
  const fpByArm = parseFirstPaintFiles(dir)
  const hasFirstDisplay = fpByArm.B.length + fpByArm.W.length + fpByArm.R.length > 0
  if (hasFirstDisplay) {
    requireSameRounds('first display', fpByArm, roundCounts)
    if (fpByArm.B.map((r) => r.round).join(',') !== byArm.B.map((r) => r.round).join(',')) throw new Error('first display rounds differ from sync rounds')
  }

  const baselineArm: Arm = 'B'
  const bRounds = byArm.B, wRounds = byArm.W, rRounds = byArm.R
  const stepCfg10: MetricConfig = { thresholdPct: 10.0, minDetectableFloor: 2.0, baselineSpreadFloor: 5.0 }
  const stepCfg25: MetricConfig = { thresholdPct: 25.0, minDetectableFloor: 2.0, baselineSpreadFloor: 5.0 }
  const sustCfg: MetricConfig = { thresholdPct: 10.0, minDetectableFloor: 0.25, baselineSpreadFloor: 1.0 }
  const bulkCfg: MetricConfig = { thresholdPct: 10.0, minDetectableFloor: 1.0, baselineSpreadFloor: 1.0 }
  const memSteadyCfg: MetricConfig = { thresholdPct: 10.0, minDetectableFloor: 0.5, baselineSpreadFloor: 0.5 }
  const memPeakCfg: MetricConfig = { thresholdPct: 20.0, minDetectableFloor: 0.5, baselineSpreadFloor: 0.5 }

  const stepW50 = evaluateMetric(bRounds.map((x) => x.stepP50), wRounds.map((x) => x.stepP50), stepCfg10, seed + 1)
  const stepW95 = evaluateMetric(bRounds.map((x) => x.stepP95), wRounds.map((x) => x.stepP95), stepCfg10, seed + 2)
  const stepW99 = evaluateMetric(bRounds.map((x) => x.stepP99), wRounds.map((x) => x.stepP99), stepCfg25, seed + 3)
  const stepR50 = evaluateMetric(bRounds.map((x) => x.stepP50), rRounds.map((x) => x.stepP50), stepCfg10, seed + 4)
  const stepR95 = evaluateMetric(bRounds.map((x) => x.stepP95), rRounds.map((x) => x.stepP95), stepCfg10, seed + 5)
  const stepR99 = evaluateMetric(bRounds.map((x) => x.stepP99), rRounds.map((x) => x.stepP99), stepCfg25, seed + 6)
  // p99 is not a target (§5.4 row 1): above +25% it is reported and investigated.
  const stepStatus = combineStatuses([stepW50.status, stepW95.status])
  const stepP99Investigate = stepW99.medianDeltaPct > 25.0

  const sustW50 = evaluateMetric(bRounds.map((x) => x.sustainedP50), wRounds.map((x) => x.sustainedP50), sustCfg, seed + 7)
  const sustW95 = evaluateMetric(bRounds.map((x) => x.sustainedP95), wRounds.map((x) => x.sustainedP95), sustCfg, seed + 8)
  const sustW99 = evaluateMetric(bRounds.map((x) => x.sustainedP99), wRounds.map((x) => x.sustainedP99), sustCfg, seed + 9)
  const sustR50 = evaluateMetric(bRounds.map((x) => x.sustainedP50), rRounds.map((x) => x.sustainedP50), sustCfg, seed + 10)
  const sustR95 = evaluateMetric(bRounds.map((x) => x.sustainedP95), rRounds.map((x) => x.sustainedP95), sustCfg, seed + 11)
  const sustR99 = evaluateMetric(bRounds.map((x) => x.sustainedP99), rRounds.map((x) => x.sustainedP99), sustCfg, seed + 12)
  const maxQueueW = Math.max(0, ...wRounds.map((x) => x.sustainedFinalQueue))
  const sustStatus: 'MET' | 'MISSED' | 'INCONCLUSIVE' = maxQueueW > 0 ? 'MISSED' : sustW95.status

  const rateB = summarizeRounds(bRounds.map((x) => x.maxSustainableRate))
  const rateW = summarizeRounds(wRounds.map((x) => x.maxSustainableRate))
  const rateR = summarizeRounds(rRounds.map((x) => x.maxSustainableRate))
  const rateStatus: 'MET' | 'MISSED' = rateW.median >= 500 && rateB.median >= 500 ? 'MET' : 'MISSED'

  const bulkCases = BULK_CASES
  const bulkW = Object.fromEntries(bulkCases.map((k, idx) => [k, {
    p50: evaluateMetric(bRounds.map((x) => x.bulk[k]?.p50 ?? 0), wRounds.map((x) => x.bulk[k]?.p50 ?? 0), bulkCfg, seed + 20 + idx * 4),
    p95: evaluateMetric(bRounds.map((x) => x.bulk[k]?.p95 ?? 0), wRounds.map((x) => x.bulk[k]?.p95 ?? 0), bulkCfg, seed + 21 + idx * 4),
  }]))
  const bulkR = Object.fromEntries(bulkCases.map((k, idx) => [k, {
    p50: evaluateMetric(bRounds.map((x) => x.bulk[k]?.p50 ?? 0), rRounds.map((x) => x.bulk[k]?.p50 ?? 0), bulkCfg, seed + 22 + idx * 4),
    p95: evaluateMetric(bRounds.map((x) => x.bulk[k]?.p95 ?? 0), rRounds.map((x) => x.bulk[k]?.p95 ?? 0), bulkCfg, seed + 23 + idx * 4),
  }]))
  const bulkStatus = combineStatuses(bulkCases.flatMap((k) => [bulkW[k].p50.status, bulkW[k].p95.status]))

  const steadyW = evaluateMetric(bRounds.map((x) => x.steadyMiB), wRounds.map((x) => x.steadyMiB), memSteadyCfg, seed + 40)
  const steadyR = evaluateMetric(bRounds.map((x) => x.steadyMiB), rRounds.map((x) => x.steadyMiB), memSteadyCfg, seed + 41)
  const peakW = evaluateMetric(bRounds.map((x) => x.peakMiB), wRounds.map((x) => x.peakMiB), memPeakCfg, seed + 42)
  const peakR = evaluateMetric(bRounds.map((x) => x.peakMiB), rRounds.map((x) => x.peakMiB), memPeakCfg, seed + 43)

  const slopeB = summarizeRounds(bRounds.map((x) => x.olsSlope)), slopeW = summarizeRounds(wRounds.map((x) => x.olsSlope)), slopeR = summarizeRounds(rRounds.map((x) => x.olsSlope))
  const wasmKiB = summarizeRounds(wRounds.map((x) => x.wasmPeakKiB)), wasmPages = summarizeRounds(wRounds.map((x) => x.wasmPeakPages))
  const wasmPagesAddedMax = Math.max(0, ...wRounds.map((x) => x.wasmPagesAdded))
  const slopeStatus: 'PASS' | 'HOLD' = slopeW.median <= 64.0 && wasmPagesAddedMax === 0 ? 'PASS' : 'HOLD'

  const bulkCellStr = (armMap: typeof bulkW, side: 'baseline' | 'candidate') =>
    bulkCases.map((k) => side === 'baseline'
      ? `${k}: ${armMap[k].p50.baseline.median.toFixed(2)}/${armMap[k].p95.baseline.median.toFixed(2)}`
      : `${k}: ${armMap[k].p50.candidate.median.toFixed(2)}/${armMap[k].p95.candidate.median.toFixed(2)} (${fmtDelta(armMap[k].p95.medianDeltaPct)})`).join('; ')

  const markdownRows = [
    '| Metric | Workload | B (`main`) | W (`wasm`) (change vs B) | R (`ts`) (change vs B) | Target | Status |',
    '|---|---|---:|---:|---:|---|---|',
    `| \`step()\` (µs) | Grid + 6,000-step trace p50 / p95 / p99 | ${fmtVal(stepW50.baseline)} / ${fmtVal(stepW95.baseline)} / ${fmtVal(stepW99.baseline)} | ${fmtVal(stepW50.candidate)} (${fmtDelta(stepW50.medianDeltaPct)}) / ${fmtVal(stepW95.candidate)} (${fmtDelta(stepW95.medianDeltaPct)}) / ${fmtVal(stepW99.candidate)} (${fmtDelta(stepW99.medianDeltaPct)}) | ${fmtVal(stepR50.candidate)} (${fmtDelta(stepR50.medianDeltaPct)}) / ${fmtVal(stepR95.candidate)} (${fmtDelta(stepR95.medianDeltaPct)}) / ${fmtVal(stepR99.candidate)} (${fmtDelta(stepR99.medianDeltaPct)}) | p50, p95 <= +10%; p99 investigated above +25% | ${stepStatus}${stepP99Investigate ? '; p99 INVESTIGATE' : ''} |`,
    `| Sustained latency (ms) | 100 msg/s × 60 s across 8 Channels, p50 / p95 / p99 | ${fmtVal(sustW50.baseline)} / ${fmtVal(sustW95.baseline)} / ${fmtVal(sustW99.baseline)} | ${fmtVal(sustW50.candidate)} / ${fmtCand(sustW95)} / ${fmtVal(sustW99.candidate)} (queue ${maxQueueW}) | ${fmtVal(sustR50.candidate)} / ${fmtCand(sustR95)} / ${fmtVal(sustR99.candidate)} | p95 <= +10%, queue 0 | ${sustStatus} |`,
    `| Max sustainable rate (msg/s) | 10 s stepped arrival windows | ${fmtVal(rateB, 0)} | ${fmtVal(rateW, 0)} | ${fmtVal(rateR, 0)} | >= 500 msg/s | ${rateStatus} |`,
    `| Bulk receipt (ms) | 8×50, 2×200 history; 250, 1000 catch-up p50 / p95 | ${bulkCellStr(bulkW, 'baseline')} | ${bulkCellStr(bulkW, 'candidate')} | ${bulkCellStr(bulkR, 'candidate')} | <= +10% | ${bulkStatus} |`,
    `| Steady memory (MiB) | Post-GC heap + wasm linear (2.5k–10k msg) | ${fmtVal(steadyW.baseline)} | ${fmtCand(steadyW, 2, ` (wasm: ${wasmKiB.median.toFixed(0)} KiB)`)} | ${fmtCand(steadyR)} | <= +10% | ${steadyW.status} |`,
    `| Peak memory (MiB) | Pre-GC peak heap + wasm linear | ${fmtVal(peakW.baseline)} | ${fmtCand(peakW, 2, ` (wasm: ${wasmPages.median.toFixed(0)} pages)`)} | ${fmtCand(peakR)} | <= +20% | ${peakW.status} |`,
    `| Memory growth slope | OLS slope over 2.5k–10k msg (B/msg); wasm pages added | ${fmtVal(slopeB)} B/msg; +0 pages | ${fmtVal(slopeW)} B/msg; +${wasmPagesAddedMax} pages | ${fmtVal(slopeR)} B/msg; +0 pages | <= +64 B/msg; +0 pages | ${slopeStatus} |`,
  ]

  const fpCfg: MetricConfig = { thresholdPct: 5.0, minDetectableFloor: 1.0, baselineSpreadFloor: 1.0 }
  const fpCellKeys = Object.keys(fpByArm.W[0]?.cells ?? fpByArm.B[0]?.cells ?? fpByArm.R[0]?.cells ?? {})
  const fpB = fpByArm.B, fpW = fpByArm.W, fpR = fpByArm.R
  const firstDisplayRows: string[] = []
  for (const arm of ['B', 'W', 'R'] as const) for (const r of fpByArm[arm]) {
    const keys = Object.keys(r.cells).sort().join(',')
    if (keys !== [...fpCellKeys].sort().join(',')) throw new Error(`first display ${arm} round ${r.round}: cells differ from the 8 planned cells`)
  }
  if (hasFirstDisplay && fpCellKeys.length !== 8) throw new Error(`first display: expected 8 cells, got ${fpCellKeys.length}`)
  if (fpCellKeys.length > 0) {
    firstDisplayRows.push('| Cell | B (`main`) p50 / p95 | W (`wasm`) p50 / p95 (change vs B) | R (`ts`) p50 / p95 (change vs B) | Target | Status |', '|---|---:|---:|---:|---|---|')
    fpCellKeys.forEach((key, idx) => {
      const fcpW50 = evaluateMetric(fpB.map((r) => r.cells[key]?.fcpMs.p50 ?? 0), fpW.map((r) => r.cells[key]?.fcpMs.p50 ?? 0), fpCfg, seed + 100 + idx * 8)
      const fcpW95 = evaluateMetric(fpB.map((r) => r.cells[key]?.fcpMs.p95 ?? 0), fpW.map((r) => r.cells[key]?.fcpMs.p95 ?? 0), fpCfg, seed + 101 + idx * 8)
      const tlW50 = evaluateMetric(fpB.map((r) => r.cells[key]?.timelineVisibleMs.p50 ?? 0), fpW.map((r) => r.cells[key]?.timelineVisibleMs.p50 ?? 0), fpCfg, seed + 102 + idx * 8)
      const tlW95 = evaluateMetric(fpB.map((r) => r.cells[key]?.timelineVisibleMs.p95 ?? 0), fpW.map((r) => r.cells[key]?.timelineVisibleMs.p95 ?? 0), fpCfg, seed + 103 + idx * 8)
      const fcpR50 = evaluateMetric(fpB.map((r) => r.cells[key]?.fcpMs.p50 ?? 0), fpR.map((r) => r.cells[key]?.fcpMs.p50 ?? 0), fpCfg, seed + 104 + idx * 8)
      const fcpR95 = evaluateMetric(fpB.map((r) => r.cells[key]?.fcpMs.p95 ?? 0), fpR.map((r) => r.cells[key]?.fcpMs.p95 ?? 0), fpCfg, seed + 105 + idx * 8)
      const tlR50 = evaluateMetric(fpB.map((r) => r.cells[key]?.timelineVisibleMs.p50 ?? 0), fpR.map((r) => r.cells[key]?.timelineVisibleMs.p50 ?? 0), fpCfg, seed + 106 + idx * 8)
      const tlR95 = evaluateMetric(fpB.map((r) => r.cells[key]?.timelineVisibleMs.p95 ?? 0), fpR.map((r) => r.cells[key]?.timelineVisibleMs.p95 ?? 0), fpCfg, seed + 107 + idx * 8)
      const cellStatus = combineStatuses([fcpW50.status, fcpW95.status, tlW50.status, tlW95.status])
      firstDisplayRows.push(`| \`${key}\` (FCP; Timeline) | FCP ${fcpW50.baseline.median.toFixed(1)}/${fcpW95.baseline.median.toFixed(1)}; TL ${tlW50.baseline.median.toFixed(1)}/${tlW95.baseline.median.toFixed(1)} | FCP ${fcpW50.candidate.median.toFixed(1)}/${fcpW95.candidate.median.toFixed(1)} (${fmtDelta(fcpW95.medianDeltaPct)}); TL ${tlW50.candidate.median.toFixed(1)}/${tlW95.candidate.median.toFixed(1)} (${fmtDelta(tlW95.medianDeltaPct)}) | FCP ${fcpR50.candidate.median.toFixed(1)}/${fcpR95.candidate.median.toFixed(1)} (${fmtDelta(fcpR95.medianDeltaPct)}); TL ${tlR50.candidate.median.toFixed(1)}/${tlR95.candidate.median.toFixed(1)} (${fmtDelta(tlR95.medianDeltaPct)}) | <= +5.0% | ${cellStatus} |`)
    })
  }

  const summary = {
    baselineArmUsed: baselineArm, roundsCount: { B: byArm.B.length, W: byArm.W.length, R: byArm.R.length },
    g3AllPassed: parsed.every((x) => x.g3Passed),
    step: { W: { p50: stepW50, p95: stepW95, p99: stepW99 }, R: { p50: stepR50, p95: stepR95, p99: stepR99 }, status: stepStatus, p99Investigate: stepP99Investigate },
    sustained: { W: { p50: sustW50, p95: sustW95, p99: sustW99, maxQueue: maxQueueW }, R: { p50: sustR50, p95: sustR95, p99: sustR99 }, status: sustStatus },
    maxSustainableRate: { B: rateB, W: rateW, R: rateR, status: rateStatus },
    bulk: { W: bulkW, R: bulkR, status: bulkStatus },
    memory: { steadyW, steadyR, peakW, peakR, slopeB, slopeW, slopeR, wasmKiB, wasmPages, wasmPagesAddedMax, slopeStatus },
    firstDisplayMarkdown: firstDisplayRows.join('\n'),
    markdownTable: [...(firstDisplayRows.length ? [...firstDisplayRows, ''] : []), ...markdownRows].join('\n'),
  }
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

if (import.meta.main) {
  const args = process.argv.slice(2), dir = args.find((a) => !a.startsWith('--'))
  if (!dir) { console.error('Usage: node web/scripts/aggregate-wasm-core.ts <dir> [--seed 466]'); process.exit(1) }
  const seedIdx = args.indexOf('--seed')
  console.log(aggregateDirectory(resolve(dir), seedIdx >= 0 ? Number(args[seedIdx + 1]) : 466).markdownTable)
}
