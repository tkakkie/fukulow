// #727 A1/A2 receive-path split: applies the start criteria recorded on the Issue before the run.
// Usage: node web/scripts/aggregate-receive-path.ts <dir>
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { medianOf, nearestRank } from './aggregate-wasm-core.ts'

export const A1_CASES = ['history_8x50', 'history_2x200', 'catchup_250', 'catchup_1000'] as const
export const A2_FRAMES = [250, 1000] as const
const ROUNDS = 5, REPETITIONS = 100
const NOISE_PCT = 10, OVERHEAD_PCT = 10, SHARE_MIN = 0.3, S1_SAVING_MS = 3, S2_TOTAL_MS = 100

export type Status = 'MET' | 'NOT MET' | 'INCONCLUSIVE'
export type RoundMetric = { median: number; min: number; max: number; spreadPct: number; noisy: boolean; rounds: number[] }
type A1Trial = { total: number; input: number; wasm: number; output: number; steps: number }
type A2Trial = { total: number; parse: number; validate: number; stepInput: number; wasm: number; output: number; controller: number; steps: number }
type Scenario = { plainP95: number; totalP95: number; iP95: number; iShare: number; parts: Record<string, number> }

const metric = (rounds: number[]): RoundMetric => {
  const median = medianOf(rounds), min = Math.min(...rounds), max = Math.max(...rounds)
  const spreadPct = median > 0 ? (100 * (max - min)) / median : Infinity
  return { median, min, max, spreadPct, noisy: spreadPct > NOISE_PCT, rounds }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.jsonl')) out.push(full)
  }
  return out.sort()
}

const finite = (file: string, label: string, v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${file}: ${label} is not a number`)
  return v
}

// Per trial, I is the input conversion step 1 removes: A1 `JSON.stringify(coreInput)`; A2 also the frame's JSON.parse.
function scenario(file: string, label: string, plain: unknown, probed: unknown, input: (t: Record<string, number>) => number): Scenario {
  if (!Array.isArray(plain) || !Array.isArray(probed) || plain.length !== REPETITIONS || probed.length !== REPETITIONS) {
    throw new Error(`${file}: ${label} needs ${REPETITIONS} plain and ${REPETITIONS} probed trials`)
  }
  const trials = probed as Record<string, number>[]
  for (const t of trials) for (const [k, v] of Object.entries(t)) finite(file, `${label}.${k}`, v)
  const totals = trials.map((t) => t.total), inputs = trials.map(input), sumTotal = totals.reduce((a, b) => a + b, 0)
  const parts = Object.fromEntries(Object.keys(trials[0]).filter((k) => k !== 'steps').map((k) => [k, nearestRank(trials.map((t) => t[k]), 95)]))
  return {
    plainP95: nearestRank(plain.map((v, i) => finite(file, `${label}.plain[${i}]`, v)), 95), totalP95: nearestRank(totals, 95),
    iP95: nearestRank(inputs, 95), iShare: inputs.reduce((a, b) => a + b, 0) / sumTotal, parts,
  }
}

type RoundFile = { round: number; arm: string; a1: Record<string, Scenario>; a2: Record<number, Scenario> }

function parseRound(file: string): RoundFile {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
  const meta = lines.find((l) => l.type === 'meta')
  if (!meta) throw new Error(`${file}: missing meta`)
  if (meta.smoke === true) throw new Error(`${file}: smoke output is not a measurement round`)
  const a1: Record<string, Scenario> = {}, a2: Record<number, Scenario> = {}
  for (const l of lines.filter((x) => x.type === 'receive_a1')) {
    a1[String(l.subCase)] = scenario(file, `A1 ${String(l.subCase)}`, l.plain, l.probed, (t) => (t as unknown as A1Trial).input)
  }
  for (const l of lines.filter((x) => x.type === 'receive_a2')) {
    a2[Number(l.frames)] = scenario(file, `A2 ${String(l.frames)}`, l.plain, l.probed, (t) => (t as unknown as A2Trial).parse + (t as unknown as A2Trial).stepInput)
  }
  for (const k of A1_CASES) if (!a1[k]) throw new Error(`${file}: missing receive_a1 ${k}`)
  for (const n of A2_FRAMES) if (!a2[n]) throw new Error(`${file}: missing receive_a2 ${n}`)
  return { round: finite(file, 'meta.round', meta.round), arm: String(meta.arm), a1, a2 }
}

export type ScenarioResult = {
  plainP95: RoundMetric; totalP95: RoundMetric; iP95: RoundMetric; iShare: RoundMetric; parts: Record<string, RoundMetric>
  overheadPct: number; overheadOk: boolean; status: Status | 'REPORT-ONLY'
}

function summarize(rounds: Scenario[], decide: (s: Omit<ScenarioResult, 'status'>) => ScenarioResult['status']): ScenarioResult {
  const pick = (f: (s: Scenario) => number) => metric(rounds.map(f))
  const plainP95 = pick((s) => s.plainP95), totalP95 = pick((s) => s.totalP95)
  const overheadPct = plainP95.median > 0 ? 100 * Math.abs(totalP95.median / plainP95.median - 1) : Infinity
  const base = {
    plainP95, totalP95, iP95: pick((s) => s.iP95), iShare: pick((s) => s.iShare),
    parts: Object.fromEntries(Object.keys(rounds[0].parts).map((k) => [k, pick((s) => s.parts[k])])),
    overheadPct, overheadOk: overheadPct <= OVERHEAD_PCT,
  }
  return { ...base, status: decide(base) }
}

const combine = (statuses: Status[]): Status => statuses.includes('MET') ? 'MET' : statuses.includes('INCONCLUSIVE') ? 'INCONCLUSIVE' : 'NOT MET'

export function aggregateReceivePath(dir: string) {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist`)
  const rounds = walk(dir).map(parseRound).sort((a, b) => a.round - b.round)
  if (rounds.length !== ROUNDS || new Set(rounds.map((r) => r.round)).size !== ROUNDS) throw new Error(`expected ${ROUNDS} distinct rounds, found [${rounds.map((r) => r.round).join(', ')}]`)
  if (new Set(rounds.map((r) => r.arm)).size !== 1) throw new Error('rounds come from more than one arm')
  // S1: I share >= 30% and I p95 >= 3 ms. S2 (1,000 frames): total p95 >= 100 ms and I share >= 30%.
  const s1 = (r: Omit<ScenarioResult, 'status'>): Status => !r.overheadOk || r.iShare.noisy || r.iP95.noisy ? 'INCONCLUSIVE'
    : r.iShare.median >= SHARE_MIN && r.iP95.median >= S1_SAVING_MS ? 'MET' : 'NOT MET'
  const s2 = (r: Omit<ScenarioResult, 'status'>): Status => !r.overheadOk || r.totalP95.noisy || r.iShare.noisy ? 'INCONCLUSIVE'
    : r.totalP95.median >= S2_TOTAL_MS && r.iShare.median >= SHARE_MIN ? 'MET' : 'NOT MET'
  const a1 = Object.fromEntries(A1_CASES.map((k) => [k, summarize(rounds.map((r) => r.a1[k]), s1)]))
  const a2 = { 250: summarize(rounds.map((r) => r.a2[250]), () => 'REPORT-ONLY'), 1000: summarize(rounds.map((r) => r.a2[1000]), s2) }
  const S1 = combine(A1_CASES.map((k) => a1[k].status as Status)), S2 = a2[1000].status as Status

  const fmt = (m: RoundMetric, digits = 2, scale = 1) => `${(m.median * scale).toFixed(digits)} [${(m.min * scale).toFixed(digits)}–${(m.max * scale).toFixed(digits)}]${m.noisy ? ' noisy' : ''}`
  const row = (label: string, r: ScenarioResult, status: string) =>
    `| ${label} | ${fmt(r.plainP95)} | ${fmt(r.totalP95)} (${r.overheadPct.toFixed(1)}%${r.overheadOk ? '' : ' over'}) | ${fmt(r.iP95)} | ${fmt(r.iShare, 1, 100)} | ${Object.entries(r.parts).filter(([k]) => k !== 'total').map(([k, m]) => `${k} ${m.median.toFixed(2)}`).join(', ')} | ${status} |`
  const markdownTable = [
    '| Scenario | Uninstrumented p95 (ms) | Instrumented p95 (ms) (overhead) | I p95 (ms) | I share (%) | Part p95 (ms) | Status |',
    '|---|---:|---:|---:|---:|---|---|',
    ...A1_CASES.map((k) => row(`A1 ${k}`, a1[k], `S1 ${a1[k].status}`)),
    row('A2 250 frames', a2[250], 'report-only'),
    row('A2 1,000 frames', a2[1000], `S2 ${a2[1000].status}`),
    '',
    `S1: ${S1}. S2: ${S2}. Medians of ${ROUNDS} rounds [min–max]; "noisy" = spread over ${NOISE_PCT}%.`,
  ].join('\n')
  const summary = { arm: rounds[0].arm, rounds: rounds.map((r) => r.round), a1, a2, S1, S2, markdownTable }
  writeFileSync(join(dir, 'receive-summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2]
  if (!dir) { console.error('Usage: node web/scripts/aggregate-receive-path.ts <dir>'); process.exit(1) }
  console.log(aggregateReceivePath(resolve(dir)).markdownTable)
}
