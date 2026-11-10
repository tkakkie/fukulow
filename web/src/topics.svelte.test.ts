import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
