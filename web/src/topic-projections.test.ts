import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { partitionScenarios, runClientScenarioAsync } from '../scripts/realtime-fixtures'
import { controllerClient, scenarios } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const projections = scenarios.filter(s => s.id === 'topic-messages-leave-holes-in-projections-without-false-gap' ||
  s.id === 'filtered-page-does-not-move-cursor' || s.id === 'established-cursor-not-moved-by-page-anchor' ||
  s.id === 'posting-during-main-timeline-paging-loses-and-duplicates-no-topic')
const { running, proposed } = partitionScenarios(projections)
it.skip.each(proposed)('proposed: $id', () => {})
it('runs all four shared Topic fixtures through createTopicSync', async () => {
  expect(running).toHaveLength(4)
  for (const scenario of running) {
    const client = controllerClient({}, true)
    expect(await runClientScenarioAsync(scenario, client), scenario.id).toEqual([])
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('rejects incorrect Topic projections from a broken controller harness', async () => {
  for (const change of ['count', 'position', 'order', 'omission', 'duplicate', 'Topic window', 'missing projection'] as const) {
    const client = controllerClient({}, true), observe = client.observe
    const scenario = projections.find(s => s.id === 'posting-during-main-timeline-paging-loses-and-duplicates-no-topic')!
    const filteredScenario = projections.find(s => s.id === 'filtered-page-does-not-move-cursor')!
    client.observe = () => {
      const result = observe()
      const c = result.channels.A
      const lines = c?.main_timeline
      if (lines?.length) {
        if (change === 'missing projection') delete c.main_timeline
        if (change === 'order') lines.reverse()
        if (change === 'omission') lines.pop()
        if (change === 'duplicate') lines.push(lines[0])
        for (const line of lines) if ('topic' in line) {
          if (change === 'count') line.message_count = 999
          if (change === 'position') line.position = 999
        }
      }
      if (change === 'Topic window' && c?.topics?.T) c.topics.T.visible = []
      return result
    }
    expect((await runClientScenarioAsync(change === 'Topic window' ? filteredScenario : scenario, client)).join('\n'))
      .toContain(change === 'Topic window' ? 'Topic T visible' : 'main_timeline')
    client.topics.close(); await client.sync.close()
  }
})
