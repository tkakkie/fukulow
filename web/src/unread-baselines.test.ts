import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Result, TopicSummaryResponse } from './api'
import { deferred, flush, http, main, msg, ok, summary, unreadClient } from './unread-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('a current Topic projection cancels the failed summary retry', async () => {
  const c = unreadClient(); await c.boot()
  c.unreadApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'network' })
  c.handlers[0].onClose(1006); await vi.advanceTimersByTimeAsync(250); c.handlers.at(-1)!.onReady(); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ unreadCount: null, error: true })
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 4, has_more: false, topics: [summary('T', 4, 0, 2)] }))
  await c.topics.loadList('A'); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ position: 0, unreadCount: 2, error: false })
  const n = c.unreadApi.getTopicSummary.mock.calls.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(n)
  expect(c.unread.get('A').topics.T).toMatchObject({ position: 0, unreadCount: 2, error: false })
  await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { result: 'network failure', response: { ok: false, kind: 'network' } as Result<TopicSummaryResponse> },
  { result: 'Channel denial', response: http(404, 'channel not found') },
  { result: 'success', response: ok({ as_of_seq: 5, topic: summary('T', 5, 5, 0) }) },
])('a current Topic projection fences an in-flight summary $result and its queued refresh', async ({ response }) => {
  const c = unreadClient(); await c.boot()
  const old = deferred<Result<TopicSummaryResponse>>()
  c.unreadApi.getTopicSummary.mockReturnValueOnce(old.promise)
  c.handlers[0].onClose(1006); await vi.advanceTimersByTimeAsync(250); c.handlers.at(-1)!.onReady(); await flush()
  // A second reconnect queues another summary behind the pending request.
  c.handlers.at(-1)!.onClose(1006); await vi.advanceTimersByTimeAsync(250); c.handlers.at(-1)!.onReady(); await flush()
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 4, has_more: false, topics: [summary('T', 4, 0, 2)] }))
  await c.topics.loadList('A'); await flush()
  const n = c.unreadApi.getTopicSummary.mock.calls.length
  const recovered = c.unread.get('A').topics.T
  expect(recovered).toMatchObject({ position: 0, unreadCount: 2, error: false, stopped: false })
  old.resolve(response); await flush()
  expect(c.unread.get('A').topics.T).toEqual(recovered)
  expect(c.unread.get('A').stopped).toBe(false)
  await vi.advanceTimersByTimeAsync(2000)
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(n)
  await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})

it('refetches a Topic baseline below the bootstrap base on entry after navigation cancels its read', async () => {
  const c = unreadClient(); c.summaries.delete('T'); await c.boot()
  const fresh = deferred<Result<TopicSummaryResponse>>()
  c.unreadApi.getTopicSummary.mockClear(); c.unreadApi.getTopicSummary.mockReturnValue(fresh.promise)
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 2, has_more: false, topics: [summary('T', 2)] }))
  await c.topics.loadList('A'); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ position: 0, unreadCount: null, error: false })
  await c.unread.enter(main)
  const before = c.unreadApi.getTopicSummary.mock.calls.length
  const id = await c.enter('T')
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(before + 1)
  expect(c.unread.get('A').entry?.boundary).toBeNull()
  expect(c.unreadApi.markRead).not.toHaveBeenCalled()
  fresh.resolve(ok({ as_of_seq: 3, topic: summary('T', 2) })); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ position: 0, unreadCount: 1 })
  expect(c.unread.get('A').entry).toMatchObject({ id, boundary: 0, unreadAtEntry: 1 })
  await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('refreshes a late stale Topic projection without repeated reads (summary already pending: %s)', async pending => {
  const c = unreadClient(); c.summaries.delete('T'); await c.boot()
  expect(c.sync.get().channels.A.cursor).toBe(3)
  const old = deferred<Result<TopicSummaryResponse>>(), fresh = deferred<Result<TopicSummaryResponse>>()
  c.unreadApi.getTopicSummary.mockClear()
  c.unreadApi.getTopicSummary.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  if (pending) await c.enter('T')
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 2, has_more: false, topics: [summary('T', 2)] }))
  await c.topics.loadList('A'); await flush()
  expect(c.unread.get('A').topics.T.unreadCount).toBeNull()
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledExactlyOnceWith('A', 'T')
  for (const seq of [4, 5, 6]) c.event(msg(seq))
  await c.topics.loadTopic('A', 'T'); await flush()
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(1)
  old.resolve(ok({ as_of_seq: 2, topic: summary('T', 2) })); await flush()
  if (!pending) {
    expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
  }
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(2)
  expect(c.unread.get('A').topics.T.unreadCount).toBeNull()
  fresh.resolve(ok({ as_of_seq: 3, topic: summary('T', 2) })); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ position: 0, unreadCount: 1, error: false })
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.unreadApi.getTopicSummary).toHaveBeenCalledTimes(2)
  expect(c.unreadApi.markRead).not.toHaveBeenCalled()
  await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})
