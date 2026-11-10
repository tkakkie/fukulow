import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Result, TimelinePage, TopicSummaryResponse } from './api'
import { flush } from './sync-test-helpers'
import { deferred, msg, ok, page, summary, topicClient } from './topic-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('bootstraps from the first timeline W and pages by its boundary despite posting during paging', async () => {
  const c = topicClient()
  await c.boot()
  expect(c.controls).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10 })
  expect(c.listMessages).not.toHaveBeenCalled()
  expect(c.sync.get().channels.A.cursor).toBe(10)
  expect(c.topics.get('A').lines.map(l => l.kind === 'message' ? l.message.seq : l.position)).toEqual([8, 10])
  const older = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
  const loading = c.topics.loadMain('A')
  await flush()
  c.event(11, 'T'); c.event(12, 'U'); c.event(13, 'U')
  older.resolve(ok({ as_of_seq: 10, has_more: false, items: [{ kind: 'topic', topic: summary('U', 7, 2) }] }))
  await loading
  expect(c.topicsApi.listTimeline.mock.calls).toEqual([['A', {}], ['A', { as_of_seq: 10, before_position: 8 }]])
  expect(c.topics.get('A').topics.map(t => [t.topicId, t.position, t.messageCount])).toEqual([['T', 11, 4], ['U', 13, 4]])
  expect(c.sync.get().channels.A.cursor).toBe(13)
  await c.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses zero for an empty initial timeline, independent of an ack received during bootstrap', async () => {
  const c = topicClient(), first = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(first.promise)
  await c.sync.start(); c.handlers[0].onReady()
  const watching = c.sync.watch('A')
  await c.sync.getTimeline('A').send('hello')
  expect(c.sync.get().channels.A.cursor).toBeNull()
  first.resolve(ok({ as_of_seq: 0, items: [], has_more: false }))
  await watching
  expect(c.controls).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 0 })
  expect(c.sync.get().channels.A.cursor).toBe(0)
  await c.sync.close()
})

it('keeps filtered records out of cursor evidence and fills a real gap only with unfiltered history', async () => {
  const c = topicClient()
  await c.boot()
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [msg(12, 'T')], has_more: false }))
  await c.topics.loadTopic('A', 'T')
  expect(c.sync.get().channels.A.cursor).toBe(10)
  expect(c.sync.get().channels.A.messages.map(m => m.seq)).toEqual([10])
  expect(c.listMessages).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  c.event(13)
  await vi.advanceTimersByTimeAsync(100)
  expect(c.listMessages.mock.calls).toEqual([['A', { after_seq: 10 }]])
  expect(c.sync.get().channels.A.cursor).toBe(13)
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([10, 12])
  await c.sync.close()
})

it('merges a larger summary W, dedupes replay and never replaces it with an older baseline', async () => {
  const c = topicClient()
  await c.boot()
  c.event(11, 'T'); c.event(12, 'T'); c.event(12, 'T'); c.event(13, 'T')
  expect(c.topics.get('A').topics[0].messageCount).toBe(6)
  await c.topics.loadSummary('A', 'T')
  expect(c.topics.get('A').topics[0]).toMatchObject({ position: 13, messageCount: 5, latestMessage: msg(13, 'T') })
  await c.topics.loadList('A')
  c.event(10, 'T')
  expect(c.topics.get('A').topics[0]).toMatchObject({ position: 13, messageCount: 5, baseline: { asOfSeq: 12 } })
  await c.sync.close()
})

it('keeps a live-only Topic count unknown until its summary arrives', async () => {
  const c = topicClient()
  await c.boot(); c.event(11, 'U'); c.event(12, 'U')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'U')?.messageCount).toBeNull()
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ as_of_seq: 11, topic: summary('U', 11, 1) }))
  await c.topics.loadSummary('A', 'U')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'U')).toMatchObject({ position: 12, messageCount: 2 })
  await c.sync.close()
})

it('pages Topic history and the Topic list by response boundaries while live activity moves their lines', async () => {
  const c = topicClient()
  await c.boot()
  await c.topics.loadTopic('A', 'T'); c.event(11, 'T')
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [msg(2, 'T')], has_more: false }))
  await c.topics.loadTopic('A', 'T')
  expect(c.topicsApi.listTopicMessages.mock.calls).toEqual([['A', 'T', {}], ['A', 'T', { before_seq: 5 }]])
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([2, 5, 10, 11])
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 10, topics: [summary('T', 10, 3)], has_more: true }))
  await c.topics.loadList('A')
  await c.topics.loadList('A')
  expect(c.topicsApi.listTopics.mock.calls[1]).toEqual(['A', { as_of_seq: 10, before_position: 10 }])
  await c.sync.close()
})

it('discards W, baselines and filtered windows on clamp and fences a late older page', async () => {
  const c = topicClient()
  await c.boot(); await c.topics.loadTopic('A', 'T')
  const older = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
  const loading = c.topics.loadMain('A'); await flush()
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ as_of_seq: 2, items: [{ kind: 'message', message: msg(2) }], has_more: false }))
  c.handlers[0].onClose(1006)
  await vi.advanceTimersByTimeAsync(500)
  c.handlers.at(-1)!.onReady()
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 2 })
  await flush()
  older.resolve(ok(page())); await loading
  expect(c.topicsApi.listTimeline.mock.calls[2]).toEqual(['A', {}])
  expect(c.sync.get().channels.A.cursor).toBe(2)
  expect(c.topics.get('A').main.asOfSeq).toBe(2)
  expect(c.topics.get('A').topics).toEqual([])
  expect(c.topics.get('A').topic('T').messages).toEqual([])
  await c.sync.close()
})

it.each(['unwatch', 'subscription refusal', 'Organization loss', 'session replacement'] as const)(
  'fences a late projection response after %s', async reason => {
    const c = topicClient()
    await c.boot()
    const older = deferred<Result<TimelinePage>>()
    c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
    const loading = c.topics.loadMain('A'); await flush()
    if (reason === 'unwatch') await c.sync.unwatch('A')
    if (reason === 'subscription refusal') c.handlers[0].onEvent({ type: 'error', channel_id: 'A', code: 'channel_not_found' })
    if (reason === 'Organization loss') await c.sync.unavailable()
    if (reason === 'session replacement') await c.sync.replaceSession('next')
    older.resolve(ok({ as_of_seq: 10, items: [{ kind: 'topic', topic: summary('stale', 3, 1) }], has_more: false }))
    await loading
    expect(c.topics.get('A').topics.some(t => t.topicId === 'stale')).toBe(false)
    expect(c.topics.get('A').main.asOfSeq).toBeUndefined()
    await c.sync.close()
  },
)

it.each([403, 404])('a current projection %s stops watching; only explicit selection recovers', async status => {
  const c = topicClient()
  await c.boot()
  c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status })
  await c.topics.loadMain('A')
  expect(c.topics.get('A').unavailable).toBe(true)
  expect(c.sync.get().channels.A.watched).toBe(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(2)
  await c.sync.watch('A')
  expect(c.topics.get('A').unavailable).toBe(false)
  await c.sync.close()
})

it('Topic-not-found stays local; Organization-unavailable stops the Organization', async () => {
  const c = topicClient()
  await c.boot()
  c.topicsApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'topic_not_found' })
  await c.topics.loadSummary('A', 'missing')
  expect(c.sync.get().channels.A.watched).toBe(true)
  c.topicsApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  await c.topics.loadSummary('A', 'T')
  expect(c.sync.get().organization).toBe('unavailable')
  await c.sync.close()
})

it.each([false, true])('late 401 ends only the same session (replaced = %s)', async replaced => {
  const c = topicClient()
  await c.boot()
  const result = deferred<Result<TopicSummaryResponse>>()
  c.topicsApi.getTopicSummary.mockReturnValueOnce(result.promise)
  const loading = c.topics.loadSummary('A', 'T'); await flush()
  if (replaced) await c.sync.replaceSession('next')
  else await c.sync.unwatch('A')
  result.resolve({ ok: false, kind: 'http', status: 401 }); await loading
  expect(c.onSessionEnded).toHaveBeenCalledTimes(replaced ? 0 : 1)
  expect(c.sync.get().running).toBe(replaced)
  await c.sync.close()
})

it('bounds hanging projection requests, allows manual retry, and closes their deadlines', async () => {
  const c = topicClient()
  await c.boot()
  c.topicsApi.listTopicMessages.mockImplementationOnce(() => new Promise(() => {}))
  const loading = c.topics.loadTopic('A', 'T')
  await vi.advanceTimersByTimeAsync(30_000); await loading
  expect(c.topics.get('A').topic('T')).toMatchObject({ loading: false, error: true })
  await c.topics.loadTopic('A', 'T')
  expect(c.topics.get('A').topic('T')).toMatchObject({ loading: false, error: false })
  await c.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([403, 404])('a stale projection %s cannot deny a newly selected Channel', async status => {
  const c = topicClient()
  await c.boot()
  const old = deferred<Result<TopicSummaryResponse>>()
  c.topicsApi.getTopicSummary.mockReturnValueOnce(old.promise)
  const loading = c.topics.loadSummary('A', 'T'); await flush()
  await c.sync.unwatch('A'); await c.sync.watch('A')
  old.resolve({ ok: false, kind: 'http', status }); await loading
  expect(c.sync.get().channels.A.watched).toBe(true)
  expect(c.topics.get('A').unavailable).toBe(false)
  await c.sync.close()
})

it('ending sync also releases hanging projection deadlines without waiting for the transport', async () => {
  const c = topicClient()
  await c.boot()
  c.topicsApi.listTopicMessages.mockImplementationOnce(() => new Promise(() => {}))
  const loading = c.topics.loadTopic('A', 'T'); await flush()
  c.handlers[0].onClose(4001)
  await loading
  expect(vi.getTimerCount()).toBe(0)
  await c.sync.close()
})

it('posting during an older timeline request merges ack, page and echo once without moving the cursor from a page', async () => {
  const c = topicClient()
  await c.boot()
  const older = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
  const loading = c.topics.loadMain('A'); await flush()
  expect(await c.sync.getTimeline('A').send('during paging')).toBe(true)
  const confirmed = c.sync.get().channels.A.messages.find(m => m.seq === 11)!
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 10, pending: [] })
  older.resolve(ok({ as_of_seq: 10, items: [{ kind: 'message', message: msg(4) }], has_more: false }))
  await loading
  expect(c.sync.get().channels.A.cursor).toBe(10)
  c.handlers[0].onEvent({ type: 'message', message: confirmed })
  expect(c.sync.get().channels.A.cursor).toBe(11)
  expect(c.topics.get('A').lines.flatMap(l => l.kind === 'message' ? [l.message.seq] : [])).toEqual([4, 8, 11])
  expect(c.topics.get('A').topics).toHaveLength(1)
  await c.sync.close()
})
