import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { A1_CASES, A2_FRAMES, aggregateReceivePath } from './aggregate-receive-path.ts'

type Shape = { total: number; input: number; plain?: number; validate?: number }
type ShapeOf = Shape | ((subCase: string, trial: number) => Shape)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// By default every trial of a scenario has the same values, scaled per round, so each p95 and share is exact.
function writeRounds(a1: ShapeOf, a2: ShapeOf, scale: (round: number) => number = () => 1, rounds = [1, 2, 3, 4, 5], extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'receive-path-')); dirs.push(dir)
  const at = (shape: ShapeOf, name: string, i: number) => (typeof shape === 'function' ? shape(name, i) : shape)
  for (const round of rounds) {
    const k = scale(round), trials = <T>(t: (i: number) => T) => Array.from({ length: 100 }, (_, i) => t(i))
    const lines: unknown[] = [{ type: 'meta', arm: 'B', round, smoke: false, ...extra }]
    for (const subCase of A1_CASES) {
      const s = (i: number) => at(a1, subCase, i)
      lines.push({ type: 'receive_a1', subCase, plain: trials((i) => (s(i).plain ?? s(i).total) * k),
        probed: trials((i) => { const total = s(i).total * k, input = s(i).input * k; return { total, input, wasm: (total - input) / 2, output: (total - input) / 2, steps: 4 } }) })
    }
    for (const frames of A2_FRAMES) {
      const s = (i: number) => at(a2, String(frames), i)
      lines.push({ type: 'receive_a2', frames, plain: trials((i) => (s(i).plain ?? s(i).total) * k),
        probed: trials((i) => {
          const total = s(i).total * k, input = s(i).input * k, validate = s(i).validate ?? 0.1
          return { total, parse: input / 2, validate, stepInput: input / 2, wasm: 1, output: 1, controller: total - input - validate - 2, steps: frames + 1 }
        }) })
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

  it('meets S1 when any one A1 scenario meets it, and is INCONCLUSIVE only without a MET scenario', () => {
    const met = { total: 10, input: 3 }, notMet = { total: 20, input: 1 }, unclear = { total: 10, input: 4, plain: 8 }, a2 = { total: 100, input: 10 }
    expect(aggregateReceivePath(writeRounds((c) => (c === 'catchup_250' ? met : notMet), a2)).S1).toBe('MET')
    expect(aggregateReceivePath(writeRounds((c) => (c === 'catchup_250' ? met : c === 'history_8x50' ? unclear : notMet), a2)).S1).toBe('MET')
    const r = aggregateReceivePath(writeRounds((c) => (c === 'history_8x50' ? unclear : notMet), a2))
    expect(r.a1.history_8x50.status).toBe('INCONCLUSIVE')
    expect(r.S1).toBe('INCONCLUSIVE')
  })

  it('takes the I share as the sum of I over the sum of total, not the ratio of p95s', () => {
    // 95 trials of 10 ms with 1 ms of I, 5 trials of 100 ms with 90 ms of I: both p95s are the small trial (I/total 10%).
    const r = aggregateReceivePath(writeRounds((_, i) => (i < 95 ? { total: 10, input: 1 } : { total: 100, input: 90 }), { total: 100, input: 10 }))
    expect(r.a1.history_8x50.iP95.median).toBe(1)
    expect(r.a1.history_8x50.totalP95.median).toBe(10)
    expect(r.a1.history_8x50.iShare.median).toBeCloseTo(545 / 1450, 10)
  })

  it('leaves isServerEvent (V) out of the A2 I share', () => {
    // Counting V would make the share (59 + 20) / 200 = 39.5%.
    const r = aggregateReceivePath(writeRounds({ total: 10, input: 1 }, { total: 200, input: 59, validate: 20 }))
    expect(r.a2[1000].iShare.median).toBeCloseTo(0.295, 10)
    expect(r.S2).toBe('NOT MET')
  })

  it('is INCONCLUSIVE when the instrumented p95 is more than 10% below the uninstrumented one', () => {
    const r = aggregateReceivePath(writeRounds({ total: 10, input: 4, plain: 11.2 }, { total: 150, input: 60, plain: 167 }))
    expect(r.a1.history_8x50.overheadOk).toBe(false)
    expect(r.S1).toBe('INCONCLUSIVE')
    expect(r.S2).toBe('INCONCLUSIVE')
  })

  it('rejects smoke output and a round count other than 5', () => {
    expect(() => aggregateReceivePath(writeRounds({ total: 10, input: 3 }, { total: 100, input: 30 }, undefined, [1, 2, 3, 4]))).toThrow(/5 distinct rounds/)
    expect(() => aggregateReceivePath(writeRounds({ total: 10, input: 3 }, { total: 100, input: 30 }, undefined, [1, 2, 3, 4, 5], { smoke: true }))).toThrow(/smoke/)
  })
})
