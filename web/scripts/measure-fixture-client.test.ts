import { describe, expect, it } from 'vitest'
import { loadClientScenarios, makeProtocolClient } from './measure-fixture-client.ts'
import { partitionScenarios, runClientScenario } from './realtime-fixtures.ts'

// The measurement smoke records traces by replaying every running protocol fixture.
// A fixture input type the harness cannot map must fail here, not abort a measurement (#545).
describe('measurement fixture client', () => {
  const running = partitionScenarios(loadClientScenarios()).running.filter((s) => s.layer !== 'controller')

  it('replays every running protocol fixture, including events_result inputs', () => {
    const types = new Set<string>()
    for (const scenario of running) {
      const errs = runClientScenario(scenario, makeProtocolClient((input) => types.add(input.type)))
      expect(errs, scenario.id).toEqual([])
    }
    expect(types).toContain('events_result')
  })
})
