import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { partitionScenarios, runClientScenarioAsync } from '../scripts/realtime-fixtures'
import { controllerClient, scenarios } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const { running, proposed } = partitionScenarios(scenarios.filter(s => s.id.startsWith('unread-')))
it('runs all three shared P8 fixtures through the production Unread controller', async () => {
  expect(running).toHaveLength(3)
  expect(proposed).toEqual([])
  for (const scenario of running) {
    const c = controllerClient({}, false, false, true)
    expect(await runClientScenarioAsync(scenario, c), scenario.id).toEqual([])
    c.topics.close(); await c.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})
it('rejects corrupted production Unread observations for every shared P8 fixture', async () => {
  for (const scenario of running) {
    const c = controllerClient({}, false, false, true), observe = c.observe
    c.observe = () => {
      const result = observe()
      for (const channel of Object.values(result.channels)) if (channel.unread) channel.unread.unread_count++
      return result
    }
    expect((await runClientScenarioAsync(scenario, c)).join('\n')).toContain('unread is')
    c.topics.close(); await c.sync.close()
  }
})
