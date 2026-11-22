import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { A1_CASES, A2_FRAMES, aggregateReceivePath } from './aggregate-receive-path.ts'

type Shape = { total: number; input: number; plain?: number }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// Every trial of a scenario has the same values, scaled per round, so each p95 and share is exact.
function writeRounds(a1: Shape, a2: Shape, scale: (round: number) => number = () => 1, rounds = [1, 2, 3, 4, 5], extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'receive-path-')); dirs.push(dir)
  for (const round of rounds) {
    const k = scale(round), trials = <T>(t: T) => Array.from({ length: 100 }, () => t)
    const lines: unknown[] = [{ type: 'meta', arm: 'B', round, smoke: false, ...extra }]
    for (const subCase of A1_CASES) {
      const total = a1.total * k, input = a1.input * k
      lines.push({ type: 'receive_a1', subCase, plain: trials(a1.plain ?? total), probed: trials({ total, input, wasm: (total - input) / 2, output: (total - input) / 2, steps: 4 }) })
    }
    for (const frames of A2_FRAMES) {
      const total = a2.total * k, input = a2.input * k
      lines.push({ type: 'receive_a2', frames, plain: trials(a2.plain ?? total),
        probed: trials({ total, parse: input / 2, validate: 0.1, stepInput: input / 2, wasm: 1, output: 1, controller: total - input - 2.1, steps: frames + 1 }) })
    }
    writeFileSync(join(dir, `round-${round}-wasm.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  return dir
}

describe('aggregate-receive-path start criteria (#727)', () => {
  it('meets S1 at an I share of 30% and an I p95 of 3 ms, and S2 at 100 ms with a 30% share', () => {
    const r = aggregateReceivePath(writeRounds({ total: 10, input: 3 }, { total: 100, input: 30 }))
    expect(r.a1.catchup_1000.iShare.median).toBeCloseTo(0.3, 10)
    expect(r.S1).toBe('MET')
    expect(r.S2).toBe('MET')
    expect(r.a2[250].status).toBe('REPORT-ONLY')
  })

  it('does not meet S1 below 3 ms of I even with a high share, nor S2 below 100 ms', () => {
    const r = aggregateReceivePath(writeRounds({ total: 5, input: 2.9 }, { total: 99, input: 60 }))
    expect(r.S1).toBe('NOT MET')
    expect(r.S2).toBe('NOT MET')
  })

  it('does not meet S1 or S2 below a 30% I share', () => {
    const r = aggregateReceivePath(writeRounds({ total: 20, input: 5.9 }, { total: 200, input: 59 }))
    expect(r.S1).toBe('NOT MET')
    expect(r.S2).toBe('NOT MET')
  })

  it('is INCONCLUSIVE when a used metric spreads more than 10% over the rounds', () => {
    const r = aggregateReceivePath(writeRounds({ total: 10, input: 4 }, { total: 150, input: 60 }, (round) => (round === 5 ? 1.11 : 1)))
    expect(r.a1.history_8x50.iP95.noisy).toBe(true)
    expect(r.S1).toBe('INCONCLUSIVE')
    expect(r.S2).toBe('INCONCLUSIVE')
  })

  it('is INCONCLUSIVE when instrumented and uninstrumented p95 differ by more than 10%', () => {
    const r = aggregateReceivePath(writeRounds({ total: 10, input: 4, plain: 9 }, { total: 150, input: 60, plain: 136 }))
    expect(r.a1.catchup_250.overheadOk).toBe(false)
    expect(r.S1).toBe('INCONCLUSIVE')
    expect(r.S2).toBe('INCONCLUSIVE')
  })

  it('rejects smoke output and a round count other than 5', () => {
    expect(() => aggregateReceivePath(writeRounds({ total: 10, input: 3 }, { total: 100, input: 30 }, undefined, [1, 2, 3, 4]))).toThrow(/5 distinct rounds/)
    expect(() => aggregateReceivePath(writeRounds({ total: 10, input: 3 }, { total: 100, input: 30 }, undefined, [1, 2, 3, 4, 5], { smoke: true }))).toThrow(/smoke/)
  })
})
