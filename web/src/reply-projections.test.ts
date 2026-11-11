import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { partitionScenarios, runClientScenarioAsync } from '../scripts/realtime-fixtures'
import { controllerClient, scenarios } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const projections = scenarios.filter(s => s.id.startsWith('reply-chain-'))
const { running, proposed } = partitionScenarios(projections)
it.skip.each(proposed)('proposed: $id', () => {})
it('runs all shared Reply projections through createReplySync', async () => {
  expect(running).toHaveLength(9)
  for (const scenario of running) {
    const client = controllerClient({}, false, true)
    expect(await runClientScenarioAsync(scenario, client), scenario.id).toEqual([])
    client.topics.close(); await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('rejects incorrect chain errors and Channel or Organization denial scope', async () => {
  for (const change of ['chain error', 'Channel A', 'Channel B', 'Organization'] as const) {
    const client = controllerClient({}, false, true), observe = client.observe
    client.observe = () => {
      const result = observe()
      if (change === 'chain error' && result.channels.A?.reply_chain?.error) result.channels.A.reply_chain.error = false
      if (change === 'Channel A' && result.channels.A?.state === 'unavailable') result.channels.A.state = 'ready'
      if (change === 'Channel B' && result.channels.A?.state === 'unavailable') result.channels.B.state = 'unavailable'
      if (change === 'Organization' && result.organization === 'unavailable') result.organization = 'available'
      return result
    }
    const id = change === 'chain error' ? 'reply-chain-anchor-not-found'
      : change === 'Organization' ? 'reply-chain-organization-denial' : 'reply-chain-channel-denial-403'
    const scenario = projections.find(s => s.id === id)!
    expect(await runClientScenarioAsync(scenario, client), change).not.toEqual([])
    client.topics.close(); await client.sync.close()
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
