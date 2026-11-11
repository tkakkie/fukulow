import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { unreadAdapter } from './unread.svelte'
import { flush, msg, unreadClient } from './unread-test-helpers'
import { mount, settle } from './adapter-test-helpers.svelte'

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
it('composition replacement and close clear observed Unread state before sync notifications', async () => {
  const c = unreadClient(); await c.boot(); const a = unreadAdapter(c.unread, 'A')
  const view = await mount(() => a.state)
  expect(view.last.unreadCount).toBe(3)
  await a.enter(); await c.sync.replaceSession('next'); await settle()
  expect(view.last.unreadCount).toBeNull(); expect(view.last.entry).toBeNull()
  await c.sync.watch('A'); await flush(); await c.sync.close(); await settle()
  expect(view.last.main.position).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  await view.unmount()
})
