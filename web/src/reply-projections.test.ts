import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { partitionScenarios, runClientScenarioAsync } from '../scripts/realtime-fixtures'
import { controllerClient, scenarios } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const projections = scenarios.filter(s => s.id.startsWith('reply-chain-'))
const { running, proposed } = partitionScenarios(projections)
it.skip.each(proposed)('proposed: $id', () => {})
it('runs all shared Reply projections through createReplySync', async () => {
  expect(running).toHaveLength(4)
  for (const scenario of running) {
    const client = controllerClient({}, false, true)
    expect(await runClientScenarioAsync(scenario, client), scenario.id).toEqual([])
    client.topics.close(); await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('rejects wrong roots Topics order omissions duplicates paging and missing Reply projections', async () => {
  for (const change of ['root', 'Topic', 'order', 'omission', 'duplicate', 'paging', 'missing'] as const) {
    const client = controllerClient({}, false, true), observe = client.observe
    client.observe = () => {
      const result = observe(), c = result.channels.A, chain = c?.reply_chain
      if (chain?.visible.length) {
        if (change === 'missing') delete c.reply_chain
        if (change === 'root') chain.root_id = 'wrong'
        if (change === 'Topic') chain.topic = 'wrong'
        if (change === 'order') chain.visible.reverse()
        if (change === 'omission') chain.visible.pop()
        if (change === 'duplicate') chain.visible.push(chain.visible[0])
        if (change === 'paging') chain.has_more = !chain.has_more
      }
      return result
    }
    const scenario = projections.find(s => s.id === 'reply-chain-descendant-in-topic')!
    expect((await runClientScenarioAsync(scenario, client)).join('\n')).toContain('reply_chain')
    client.topics.close(); await client.sync.close()
  }
})
