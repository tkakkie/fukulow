import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { repliesAdapter } from './replies.svelte'
import { reply, replyClient, root } from './reply-test-helpers'
import { mount, settle } from './adapter-test-helpers.svelte'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('memoizes chain adapter snapshots while observed and unobserved and forwards intents', async () => {
  const c = replyClient(); await c.boot()
  const adapter = repliesAdapter(c.replies, 'A')
  await adapter.open(root())
  const initial = adapter.state
  expect(adapter.state).toBe(initial)
  let active = 0
  const subscribe = c.replies.subscribe
  vi.spyOn(c.replies, 'subscribe').mockImplementation(fn => {
    active++; const release = subscribe(fn)
    return () => { active--; release() }
  })
  const one = await mount(() => adapter.state), two = await mount(() => adapter.state)
  expect(active).toBe(1)
  expect(one.last).toBe(initial)
  c.event(reply(2)); await settle()
  expect(one.last.messages.map(m => m.seq)).toEqual([1, 2, 3])
  expect(one.last).toBe(adapter.state)
  expect(one.last).not.toBe(initial)
  await adapter.send('hello')
  expect(c.sendMessage).toHaveBeenLastCalledWith('A', expect.objectContaining({ reply_to: 'id1' }))
  await adapter.loadMore(); await adapter.retry('missing')
  await one.unmount(); await two.unmount(); expect(active).toBe(0)
  const before = adapter.state
  c.event(reply(3)); expect(adapter.state).not.toBe(before)
  expect(adapter.state).toBe(adapter.state)
  const requests = c.listReplyChain.mock.calls.length
  const again = await mount(() => adapter.state)
  expect(c.listReplyChain).toHaveBeenCalledTimes(requests)
  adapter.dismiss(); await settle(); expect(again.last.messages).toEqual([])
  await again.unmount(); await c.sync.close()
  expect(adapter.state.messages).toEqual([])
})

it('composition close and replacement clear observed chains and fence adapter reads', async () => {
  const c = replyClient(); await c.boot()
  const adapter = repliesAdapter(c.replies, 'A')
  await adapter.open(root())
  const view = await mount(() => adapter.state)
  await c.sync.replaceSession('next'); await settle()
  expect(view.last.messages).toEqual([])
  await c.sync.watch('A'); await adapter.open(root()); await c.sync.close(); await settle()
  expect(view.last.messages).toEqual([])
  await adapter.open(root()); expect(adapter.state.messages).toEqual([])
  await view.unmount(); expect(vi.getTimerCount()).toBe(0)
})
