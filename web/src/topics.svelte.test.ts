import topicProjectionFixtures from '../../contract/realtime/client/topic-projections.json'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { partitionScenarios, runClientScenarioAsync, type ClientScenario } from '../scripts/realtime-fixtures'
import { controllerClient } from './sync-test-helpers'
import { topicsAdapter } from './topics.svelte'
import { topicClient } from './topic-test-helpers'
import { mount, settle } from './adapter-test-helpers.svelte'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('reactively shows projection and stream changes and forwards Topic history and summary intents', async () => {
  const c = topicClient()
  await c.boot()
  const adapter = topicsAdapter(c.topics, 'A')
  const view = await mount(() => ({ topics: adapter.state.topics, messages: adapter.state.topic('T').messages }))
  expect(view.last.topics[0].messageCount).toBe(3)
  await adapter.loadTopic('T'); c.event(11, 'T'); await settle()
  expect(view.last.messages.map(m => m.seq)).toEqual([5, 10, 11])
  expect(view.last.topics[0]).toMatchObject({ position: 11, messageCount: 4 })
  await adapter.loadSummary('T'); await settle()
  expect(view.last.topics[0]).toMatchObject({ position: 12, messageCount: 4 })
  expect(c.sync.get().channels.A.cursor).toBe(11)
  await view.unmount(); await c.sync.close()
})

it('releases observers without losing windows and remounts current state without I/O', async () => {
  const c = topicClient()
  await c.boot()
  let active = 0
  const subscribe = c.topics.subscribe
  vi.spyOn(c.topics, 'subscribe').mockImplementation(listener => {
    active++; const release = subscribe(listener)
    return () => { active--; release() }
  })
  const adapter = topicsAdapter(c.topics, 'A')
  const one = await mount(() => adapter.state), two = await mount(() => adapter.state)
  expect(active).toBe(1)
  await one.unmount(); expect(active).toBe(1)
  await two.unmount(); expect(active).toBe(0)
  c.event(11, 'T'); await settle()
  const again = await mount(() => adapter.state)
  expect(again.last.topics[0]).toMatchObject({ position: 11, messageCount: 4 })
  expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(1)
  expect(c.sync.get().channels.A.cursor).toBe(11)
  await again.unmount(); await c.sync.close()
})

it('ending the composition clears an observed projection and prevents later reads from exposing the old session', async () => {
  const c = topicClient()
  await c.boot()
  const adapter = topicsAdapter(c.topics, 'A')
  const view = await mount(() => adapter.state)
  expect(view.last.lines.length).toBeGreaterThan(0)
  await c.sync.close(); await settle()
  expect(view.last.lines).toEqual([])
  expect(adapter.state.topic('T').messages).toEqual([])
  await view.unmount()
})

it('reuses merged adapter and Topic snapshots until notify, including reads while unobserved', async () => {
  const c = topicClient()
  await c.boot()
  const adapter = topicsAdapter(c.topics, 'A')
  const initial = adapter.state, topic = initial.topic('T')
  expect(adapter.state).toBe(initial)
  expect(adapter.state.topic('T')).toBe(topic)
  const view = await mount(() => ({ state: adapter.state, topic: adapter.state.topic('T') }))
  expect(view.last.state).toBe(initial)
  expect(view.last.topic).toBe(topic)
  c.event(11, 'T'); await settle()
  expect(view.last.state).not.toBe(initial)
  expect(view.last.state).toBe(adapter.state)
  expect(view.last.topic).toBe(adapter.state.topic('T'))
  await view.unmount()
  const before = adapter.state
  c.event(12, 'T')
  expect(adapter.state).not.toBe(before)
  expect(adapter.state.topics[0].position).toBe(12)
  await c.sync.close()
})

const { running: topicScenarios, proposed: proposedTopicScenarios } = partitionScenarios(
  topicProjectionFixtures.scenarios as unknown as ClientScenario[],
)
it.skip.each(proposedTopicScenarios)('proposed adapter fixture: $id', () => {})

it('runs all contract/realtime/client/topic-projections.json scenarios through topicsAdapter', async () => {
  expect(proposedTopicScenarios).toHaveLength(0)
  expect(topicScenarios).toHaveLength(4)
  for (const scenario of topicScenarios) {
    const client = controllerClient({}, true)
    const adapter = topicsAdapter(client.topics, 'A')
    const view = await mount(() => ({
      lines: adapter.state.lines,
      topicT: adapter.state.topic('T').messages,
    }))
    const rawObserve = client.observe
    const rawFeed = client.feed
    client.feed = async input => {
      const emitted = await rawFeed(input)
      await settle()
      return emitted
    }
    client.observe = () => {
      const observation = rawObserve()
      const ch = observation.channels.A
      if (ch) {
        ch.main_timeline = view.last.lines.map(l =>
          l.kind === 'message'
            ? { seq: l.message.seq }
            : { topic: l.topicId, position: l.position, message_count: l.messageCount },
        )
        if (ch.topics?.T) {
          ch.topics.T = { visible: view.last.topicT.map(m => m.seq) }
        }
      }
      return observation
    }
    expect(await runClientScenarioAsync(scenario, client), scenario.id).toEqual([])
    await view.unmount()
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})
