import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Result, TopicSummaryResponse } from './api'
import { deferred, flush, main, msg, ok, summary, unreadClient } from './unread-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

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
