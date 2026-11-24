import * as driver from '../src/protocol-driver.ts'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadClientScenarios, makeProtocolClient } from './measure-fixture-client.ts'
import { partitionScenarios, runClientScenario, type ClientScenario } from './realtime-fixtures.ts'

// The measurement smoke records traces by replaying every running protocol fixture.
// A fixture input type the harness cannot map must fail here, not abort a measurement (#545).
describe('measurement fixture client', () => {
  const running = partitionScenarios(loadClientScenarios()).running.filter((s) => s.layer !== 'controller')

  it('replays every running protocol fixture, including events_result inputs', () => {
    const types = new Set<string>()
    for (const scenario of running) {
      const errs = runClientScenario(scenario, makeProtocolClient((input) => types.add(input.type), driver))
      expect(errs, scenario.id).toEqual([])
    }
    expect(types).toContain('events_result')
  })

  // Same-input proof for #866. The golden file holds, per fixture, SHA-256 digests captured before the two
  // copies were merged: the fixture, the inputs and errors of the measurement copy (exact JSON, so wasm traces
  // stay byte-identical) and of the former web/src/protocol-test-helpers.ts copy (keys sorted: it built
  // events_result and history_result pages in another key order). A fixture changed since is not comparable.
  it('produces the inputs both former copies produced, for every fixture unchanged since #866', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
      : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'measure-fixture-client.golden.json'), 'utf8')) as Record<string, [string, string, string]>
    const replay = (scenario: ClientScenario) => {
      const inputs: unknown[] = []
      let errs: string[] | string
      try { errs = runClientScenario(scenario, makeProtocolClient((input) => inputs.push(input), driver)) } catch (e) { errs = `throw:${(e as Error).message}` }
      return { inputs, errs }
    }
    let compared = 0
    for (const scenario of loadClientScenarios()) {
      const [fixture, measure, helper] = golden[scenario.id] ?? []
      if (fixture !== sha(JSON.stringify(scenario))) continue
      const result = replay(scenario)
      expect(sha(JSON.stringify(result)), `${scenario.id} (measurement copy)`).toBe(measure)
      expect(sha(JSON.stringify(sorted(result))), `${scenario.id} (web/src copy)`).toBe(helper)
      compared++
    }
    expect(compared).toBeGreaterThan(0)
  })
})
