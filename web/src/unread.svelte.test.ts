import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { unreadAdapter } from './unread.svelte'
import { flush, msg, ok, row, unreadClient } from './unread-test-helpers'
import { mount, settle } from './adapter-test-helpers.svelte'
import { createReplySync } from './reply-sync'
import { createUnreadSync } from './unread-sync'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it('observes memoized controller snapshots with one subscription and no render-driven requests', async () => {
  const c = unreadClient(); await c.boot(); const a = unreadAdapter(c.unread, 'A')
  const initial = a.state; expect(a.state).toBe(initial)
  const n = c.unreadApi.listChannels.mock.calls.length
  let active = 0
  const subscribe = c.unread.subscribe
  vi.spyOn(c.unread, 'subscribe').mockImplementation(fn => { active++; const release = subscribe(fn); return () => { active--; release() } })
  const one = await mount(() => a.state), two = await mount(() => a.state)
  expect(active).toBe(1); expect(one.last).toBe(initial)
  c.event(msg(4)); await settle()
  expect(one.last.unreadCount).toBe(4); expect(one.last).toBe(a.state)
  expect(c.unreadApi.listChannels).toHaveBeenCalledTimes(n); expect(c.unreadApi.markRead).not.toHaveBeenCalled()
  await one.unmount(); await two.unmount(); expect(active).toBe(0)
  c.event(msg(5)); expect(a.state.unreadCount).toBe(5)
  await c.sync.close()
})
it('forwards view presentation visibility refresh and exit intents with fixed visit identity', async () => {
  const c = unreadClient(); await c.boot(); const a = unreadAdapter(c.unread, 'A')
  const id = (await a.enter())!
  a.visibility(false); a.presented(id, [1]); await flush(); expect(c.unreadApi.markRead).not.toHaveBeenCalled()
  a.visibility(true); a.presented(id, [1]); await flush(); expect(a.state.main.position).toBe(1)
  const n = c.unreadApi.listChannels.mock.calls.length
  await a.refresh(); expect(c.unreadApi.listChannels).toHaveBeenCalledTimes(n + 1)
  a.leave(id); expect(a.state.entry).toBeNull()
  await c.topics.loadTopic('A', 'T'); const topicVisit = (await a.enter('T'))!
  a.presented(id, [2]); await flush(); expect(c.unreadApi.markRead).toHaveBeenCalledTimes(1)
  a.presented(topicVisit, [2]); await flush(); expect(a.state.topics.T.position).toBe(2)
  await c.sync.close()
})
it.each(['Topics', 'Topics and Replies'] as const)('%s composition clears Unread synchronously before replacement and close sync notifications', async composition => {
  const base = unreadClient(); await base.boot()
  const reply = composition === 'Topics and Replies' ? createReplySync({ selfId: 'me', repliesApi: {
    listReplyChain: async () => ok({ root_id: msg(1).id, messages: [msg(1)], has_more: false }),
  } }, base.sync) : undefined
  const source = reply?.sync ?? base.sync
  const seen: { position: number | null; unreadCount: number | null; entry: unknown; topicCount: number }[] = []
  let a: ReturnType<typeof unreadAdapter>
  // Subscribe before Unread so its own sync reconciliation cannot mask teardown ordering.
  const release = source.subscribe(() => {
    if (!a) return
    const state = a.state
    seen.push({ position: state.main.position, unreadCount: state.unreadCount, entry: state.entry, topicCount: Object.keys(state.topics).length })
  })
  const c = createUnreadSync({ selfId: 'me', unreadApi: base.unreadApi }, { sync: source, topics: base.topics })
  await flush()
  a = unreadAdapter(c.unread, 'A')
  const view = await mount(() => a.state)
  expect(view.last.unreadCount).toBe(3)
  await a.enter()
  if (reply) await reply.replies.open('A', msg(1))
  seen.length = 0
  const cleared = { position: null, unreadCount: null, entry: null, topicCount: 0 }
  await c.sync.replaceSession('next')
  expect(seen.length).toBeGreaterThan(0); expect(seen).toEqual(seen.map(() => cleared))
  await settle()
  expect(view.last.unreadCount).toBeNull(); expect(view.last.entry).toBeNull()
  await c.sync.watch('A'); await flush(); await a.enter()
  expect(a.state.unreadCount).toBe(3); expect(a.state.entry).not.toBeNull()
  if (reply) await reply.replies.open('A', msg(1))
  seen.length = 0
  await c.sync.close()
  expect(seen.length).toBeGreaterThan(0); expect(seen).toEqual(seen.map(() => cleared))
  await settle()
  expect(view.last.main.position).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  release(); await view.unmount()
})
it('notifies only the changed Channel and leaves other Channels reference-equal; multi-Channel changes notify only affected Channels', async () => {
  const c = unreadClient()
  c.rows.push(row({ id: 'B', name: 'B', unread_count: 2, main_unread_count: 2 }), row({ id: 'C', name: 'C', unread_count: 1, main_unread_count: 1 }))
  await c.boot()
  await c.sync.watch('B')
  await c.sync.watch('C')
  await flush()
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'B', caught_up_seq: 3 })
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'C', caught_up_seq: 3 })
  await settle()

  const adapterA = unreadAdapter(c.unread, 'A')
  const adapterB = unreadAdapter(c.unread, 'B')
  const adapterC = unreadAdapter(c.unread, 'C')
  const snapA0 = adapterA.state
  const snapB0 = adapterB.state
  const snapC0 = adapterC.state
  const viewA = await mount(() => adapterA.state)
  const viewB = await mount(() => adapterB.state)
  const viewC = await mount(() => adapterC.state)
  const listenerA = vi.fn()
  const listenerB = vi.fn()
  const listenerC = vi.fn()
  const unsubA = c.unread.subscribe(listenerA, 'A')
  const unsubB = c.unread.subscribe(listenerB, 'B')
  const unsubC = c.unread.subscribe(listenerC, 'C')

  // Single-Channel change on A (message, enter/presented/leave) notifies only A; B and C stay ===.
  c.event(msg(4, null, 'other', 'A'))
  await settle()
  expect(listenerA).toHaveBeenCalledTimes(1)
  expect(listenerB).not.toHaveBeenCalled()
  expect(listenerC).not.toHaveBeenCalled()
  expect(viewA.values).toHaveLength(2)
  expect(viewB.values).toHaveLength(1)
  expect(viewC.values).toHaveLength(1)
  expect(adapterA.state).not.toBe(snapA0)
  expect(adapterB.state).toBe(snapB0)
  expect(adapterC.state).toBe(snapC0)

  const idA = (await adapterA.enter())!
  adapterA.visibility(true)
  adapterA.presented(idA, [1])
  await settle()
  adapterA.leave(idA)
  await settle()
  expect(listenerB).not.toHaveBeenCalled()
  expect(listenerC).not.toHaveBeenCalled()
  expect(adapterB.state).toBe(snapB0)
  expect(adapterC.state).toBe(snapC0)

  // Multi-Channel refresh where A and B change while C stays identical notifies exactly A and B.
  const callsABefore = listenerA.mock.calls.length
  const snapA1 = adapterA.state
  c.rows[0] = row({ id: 'A', name: 'A', as_of_seq: 10, read_seq: 1, main_unread_count: 5, unread_count: 7 })
  c.rows[1] = row({ id: 'B', name: 'B', as_of_seq: 10, read_seq: 0, main_unread_count: 4, unread_count: 4 })
  await c.unread.refresh()
  await settle()
  expect(listenerA.mock.calls.length).toBeGreaterThan(callsABefore)
  expect(listenerB).toHaveBeenCalledTimes(1)
  expect(listenerC).not.toHaveBeenCalled()
  expect(viewB.values).toHaveLength(2)
  expect(viewC.values).toHaveLength(1)
  expect(adapterA.state).not.toBe(snapA1)
  expect(adapterB.state).not.toBe(snapB0)
  expect(adapterC.state).toBe(snapC0)

  unsubA()
  unsubB()
  unsubC()
  await viewA.unmount()
  await viewB.unmount()
  await viewC.unmount()
  await c.sync.close()
})
