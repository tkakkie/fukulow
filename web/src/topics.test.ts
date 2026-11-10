import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Result, TimelinePage, TopicSummaryResponse } from './api'
import { flush } from './sync-test-helpers'
import { deferred, msg, ok, page, summary, topicClient } from './topic-test-helpers'
import { createTopics } from './topics'

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

it('UI retry after a bootstrap 503 requests a fresh initial timeline and subscribes at W', async () => {
  const c = topicClient()
  c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status: 503 })
  await c.sync.start(); c.handlers[0].onReady(); await c.sync.watch('A')
  expect(c.sync.get().channels.A).toMatchObject({ cursor: null, historyError: true })
  await c.topics.loadMain('A')
  expect(c.topicsApi.listTimeline.mock.calls).toEqual([['A', {}], ['A', {}]])
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 10, historyError: false })
  expect(c.controls).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10 })
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 })
  expect(c.sync.get().channels.A.state).toBe('ready')
  await c.sync.close()
})

it('an in-flight UI loadMain coalesces with bootstrap and cannot strand the Channel in loading', async () => {
  const c = topicClient(), first = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status: 503 })
  await c.sync.start(); c.handlers[0].onReady(); await c.sync.watch('A')
  c.topicsApi.listTimeline.mockReturnValueOnce(first.promise)
  const loading = c.topics.loadMain('A')
  await flush()
  const refreshing = c.sync.getTimeline('A').loadLatest()
  expect(c.topicsApi.listTimeline.mock.calls).toEqual([['A', {}], ['A', {}]])
  first.resolve(ok(page()))
  await Promise.all([loading, refreshing])
  expect(c.sync.get().channels.A.cursor).toBe(10)
  expect(c.controls).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10 })
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 })
  expect(c.sync.get().channels.A.state).toBe('ready')
  await c.sync.close()
})

it('bootstrap resets a populated main window and fences its in-flight projection request', async () => {
  const c = topicClient(), older = deferred<Result<TimelinePage>>()
  await c.boot()
  c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
  const loading = c.topics.loadMain('A'); await flush()
  await c.topics.bootstrap('A')
  expect(c.topicsApi.listTimeline.mock.calls[2]).toEqual(['A', {}])
  older.resolve(ok({ as_of_seq: 10, items: [{ kind: 'message', message: msg(2) }], has_more: false }))
  await loading
  expect(c.topics.get('A').main).toMatchObject({ before: 8, hasMore: true, loading: false })
  expect(c.topics.get('A').lines.some(l => l.kind === 'message' && l.message.seq === 2)).toBe(false)
  await c.sync.close()
})

it('initial timeline history below W settles an unknown own send without duplicate display', async () => {
  const c = topicClient(), first = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(first.promise)
  c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.sync.start(); c.handlers[0].onReady()
  const watching = c.sync.watch('A')
  await c.sync.getTimeline('A').send('unknown')
  const pending = c.sync.get().channels.A.pending[0]!
  expect(pending.state).toBe('unknown')
  const own = { ...msg(9), sender: 'me', client_message_id: pending.clientMessageId, body: 'canonical' }
  first.resolve(ok({ ...page(), items: [{ kind: 'message', message: own }, ...page().items.slice(1)] }))
  await watching
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 10, pending: [], advancing: [] })
  expect(c.sync.get().channels.A.messages.map(m => m.seq)).toEqual([10])
  expect(c.topics.get('A').lines.filter(l => l.kind === 'message' && l.message.seq === 9)).toEqual([{ kind: 'message', message: own }])
  await c.sync.close()
})

it('Topic history settles only matching own sends without supplying cursor or contiguity evidence', async () => {
  const c = topicClient()
  await c.boot()
  c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.sync.getTimeline('A').send('unknown')
  const pending = c.sync.get().channels.A.pending[0]!
  const own = { ...msg(12, 'T'), sender: 'me', client_message_id: pending.clientMessageId }
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [{ ...own, sender: 'other' }], has_more: true }))
  await c.topics.loadTopic('A', 'T')
  expect(c.sync.get().channels.A.pending).toEqual([pending])
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [own], has_more: false }))
  await c.topics.loadTopic('A', 'T')
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 10, pending: [], advancing: [] })
  expect(c.sync.get().channels.A.messages.map(m => m.seq)).toEqual([10])
  c.event(11)
  expect(c.sync.get().channels.A.cursor).toBe(11)
  c.handlers[0].onEvent({ type: 'message', message: own })
  expect(c.sync.get().channels.A.cursor).toBe(12)
  expect(c.topics.get('A').topic('T').messages.filter(m => m.seq === 12)).toEqual([own])
  await c.sync.close()
})

it('post-clamp initial history settles an invalidated send below W without reviving its late failure', async () => {
  const c = topicClient(), sending = deferred<Awaited<ReturnType<typeof c.sendMessage>>>()
  await c.boot()
  c.sendMessage.mockReturnValueOnce(sending.promise)
  const send = c.sync.getTimeline('A').send('before clamp')
  const pending = c.sync.get().channels.A.pending[0]!
  const own = { ...msg(1), sender: 'me', client_message_id: pending.clientMessageId }
  const initial = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(initial.promise)
  c.handlers[0].onClose(1006); await vi.advanceTimersByTimeAsync(500)
  c.handlers.at(-1)!.onReady()
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 2 })
  expect(c.sync.get().channels.A.pending[0]?.state).toBe('unknown')
  initial.resolve(ok({ as_of_seq: 2, items: [{ kind: 'message', message: own }, { kind: 'message', message: msg(2) }], has_more: false }))
  await flush()
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 2, pending: [], advancing: [] })
  expect(c.topics.get('A').lines.map(l => l.kind === 'message' && l.message.seq)).toEqual([1, 2])
  sending.resolve({ ok: false, kind: 'network' }); await send
  expect(c.sync.get().channels.A.pending).toEqual([])
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

it('a late projection response after replaceSession never reaches settleHistory', async () => {
  const c = topicClient()
  await c.boot()
  const topics = createTopics(c.sync, { api: c.topicsApi })
  const settle = vi.spyOn(c.sync, 'settleHistory')
  const older = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
  const loading = topics.loadMain('A'); await flush()
  await c.sync.replaceSession('next')
  c.handlers.at(-1)!.onReady()
  await c.sync.watch('A')
  settle.mockClear()
  older.resolve(ok(page())); await loading
  expect(settle).not.toHaveBeenCalled()
  expect(topics.get('A').main.asOfSeq).toBeUndefined()
  topics.close()
  await c.sync.close()
})

it('current projection 403 and 404 refuse Channel sends and retries while other Channels remain usable', async () => {
  for (const status of [403, 404]) {
    const c = topicClient()
    await c.boot()
    c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ as_of_seq: 0, items: [], has_more: false }))
    await c.sync.watch('B')
    c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'B', caught_up_seq: 0 })
    const other = c.sync.get().channels.B
    c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
    await c.sync.getTimeline('A').send('unknown')
    const pending = c.sync.get().channels.A.pending[0]!
    c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status })
    await c.topics.loadMain('A')
    expect(c.topics.get('A').unavailable).toBe(true)
    expect(await c.sync.getTimeline('A').send('refused')).toBe(false)
    await c.sync.getTimeline('A').retry(pending.clientMessageId)
    expect(c.sendMessage).toHaveBeenCalledTimes(1)
    expect(c.sync.get().channels.A.state).toBe('unavailable')
    expect(c.sync.get().channels.B).toBe(other)
    expect(await c.sync.getTimeline('B').send('still available')).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(3)
    await c.sync.watch('A')
    expect(c.topics.get('A').unavailable).toBe(false)
    await c.sync.close()
  }
})

it('bootstrap 403 and 404 end in sync C9 unavailable and refuse sends', async () => {
  for (const status of [403, 404]) {
    const c = topicClient()
    c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status, error: 'channel_not_found' })
    await c.sync.start(); c.handlers[0].onReady(); await c.sync.watch('A')
    expect(c.sync.get().channels.A).toMatchObject({ state: 'unavailable', watched: true, cursor: null })
    expect(c.topics.get('A').unavailable).toBe(true)
    expect(await c.sync.getTimeline('A').send('refused')).toBe(false)
    expect(c.sendMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(1)
    expect(c.controls).toEqual([])
    await c.sync.close()
  }
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

it('organization_unavailable bypasses C9 even before the C10 handler runs', async () => {
  const c = topicClient(), gate = deferred<void>()
  await c.boot()
  const unavailable = c.sync.unavailable
  const ending = vi.spyOn(c.sync, 'unavailable').mockImplementationOnce(async () => { await gate.promise; await unavailable() })
  const channelUnavailable = vi.spyOn(c.sync, 'channelUnavailable')
  const topics = createTopics(c.sync, { api: c.topicsApi })
  c.topicsApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  await topics.loadSummary('A', 'T')
  expect(ending).toHaveBeenCalledOnce()
  expect(channelUnavailable).not.toHaveBeenCalled()
  expect(c.sync.get().channels.A).toMatchObject({ watched: true, state: 'ready' })
  expect(topics.get('A').unavailable).toBe(false)
  gate.resolve(); await ending.mock.results[0]!.value
  expect(c.sync.get()).toMatchObject({ organization: 'unavailable', running: false })
  // C10's terminal state also marks Channels unavailable; no Channel-specific C9 denial ran.
  expect(c.sync.get().channels.A.watched).toBe(true)
  topics.close()
  await c.sync.close()
})

it('list and summary baselines stay outside main lines until main paging or stream loads the Topic', async () => {
  const c = topicClient()
  await c.boot()
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 10, topics: [summary('U', 3, 1)], has_more: false }))
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ as_of_seq: 10, topic: summary('V', 5, 2) }))
  await c.topics.loadList('A'); await c.topics.loadSummary('A', 'V')
  expect(c.topics.get('A').topics.map(t => t.topicId)).toEqual(['U', 'V', 'T'])
  expect(c.topics.get('A').lines.filter(l => l.kind === 'topic').map(t => t.topicId)).toEqual(['T'])
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ as_of_seq: 10, items: [{ kind: 'topic', topic: summary('U', 3, 1) }], has_more: false }))
  await c.topics.loadMain('A')
  expect(c.topics.get('A').lines.filter(l => l.kind === 'topic').map(t => t.topicId)).toEqual(['U', 'T'])
  c.event(11, 'V')
  expect(c.topics.get('A').lines.filter(l => l.kind === 'topic').map(t => [t.topicId, t.messageCount])).toEqual([['U', 1], ['T', 3], ['V', 3]])
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

const readKinds = ['main', 'list', 'summary', 'topic'] as const
type ReadKind = typeof readKinds[number]
function retryRead(c: ReturnType<typeof topicClient>, kind: ReadKind) {
  switch (kind) {
    case 'main': return c.topics.loadMain('A')
    case 'list': return c.topics.loadList('A')
    case 'summary': return c.topics.loadSummary('A', 'T')
    case 'topic': return c.topics.loadTopic('A', 'T')
  }
}
function deferRead(c: ReturnType<typeof topicClient>, kind: ReadKind) {
  switch (kind) {
    case 'main': {
      const first = deferred<Result<TimelinePage>>()
      c.topicsApi.listTimeline.mockReturnValueOnce(first.promise)
      return { fail: first.resolve, succeed: () => first.resolve(ok({ as_of_seq: 20,
        items: [{ kind: 'message', message: msg(2) }], has_more: false })) }
    }
    case 'list': {
      const first = deferred<Awaited<ReturnType<typeof c.topicsApi.listTopics>>>()
      c.topicsApi.listTopics.mockReturnValueOnce(first.promise)
      return { fail: first.resolve, succeed: () => first.resolve(ok({ as_of_seq: 20,
        topics: [summary('stale', 2, 1)], has_more: true })) }
    }
    case 'summary': {
      const first = deferred<Result<TopicSummaryResponse>>()
      c.topicsApi.getTopicSummary.mockReturnValueOnce(first.promise)
      return { fail: first.resolve, succeed: () => first.resolve(ok({ as_of_seq: 20, topic: summary('T', 20, 99) })) }
    }
    case 'topic': {
      const first = deferred<Awaited<ReturnType<typeof c.topicsApi.listTopicMessages>>>()
      c.topicsApi.listTopicMessages.mockReturnValueOnce(first.promise)
      return { fail: first.resolve, succeed: () => first.resolve(ok({ messages: [msg(2, 'T')], has_more: false })) }
    }
  }
}

it.each(readKinds)('timed-out %s read cannot overwrite its completed retry', async kind => {
  const c = topicClient()
  await c.boot()
  const first = deferRead(c, kind)
  const loading = retryRead(c, kind)
  await vi.advanceTimersByTimeAsync(30_000); await loading
  await retryRead(c, kind)
  const retried = c.topics.get('A')
  const settled = vi.spyOn(c.sync, 'settleHistory')
  first.succeed(); await flush()
  expect(c.topics.get('A')).toEqual(retried)
  expect(c.topics.get('A').topic('T')).toEqual(retried.topic('T'))
  expect(c.sync.get().channels.A.cursor).toBe(10)
  expect(settled).not.toHaveBeenCalled()
  if (kind === 'main' || kind === 'list' || kind === 'topic') {
    await retryRead(c, kind)
    if (kind === 'main') expect(c.topicsApi.listTimeline.mock.calls.at(-1)).toEqual(['A', { as_of_seq: 10, before_position: 8 }])
    if (kind === 'list') expect(c.topicsApi.listTopics).toHaveBeenCalledTimes(2)
    if (kind === 'topic') expect(c.topicsApi.listTopicMessages.mock.calls.at(-1)).toEqual(['A', 'T', { before_seq: 5 }])
  }
  await c.sync.close()
})

it('independent read kinds and Topic targets do not supersede each other', async () => {
  const c = topicClient()
  await c.boot()
  const first = readKinds.map(kind => deferRead(c, kind))
  const loading = readKinds.map(kind => retryRead(c, kind))
  await c.topics.loadSummary('A', 'U')
  await c.topics.loadTopic('A', 'U')
  first.forEach(read => read.succeed())
  await Promise.all(loading)
  expect(c.topics.get('A').main).toMatchObject({ asOfSeq: 20, before: 2, hasMore: false, loading: false })
  expect(c.topics.get('A').list).toMatchObject({ asOfSeq: 20, before: 2, hasMore: true, loading: false })
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')).toMatchObject({ messageCount: 99 })
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([2, 10])
  await c.sync.close()
})

it.each(readKinds)('superseded timed-out %s read preserves C6/C10 but cannot cause C9', async kind => {
  for (const status of [403, 404, 401, 'organization_unavailable'] as const) {
    const c = topicClient()
    await c.boot()
    const first = deferRead(c, kind)
    const loading = retryRead(c, kind)
    await vi.advanceTimersByTimeAsync(30_000); await loading
    await retryRead(c, kind)
    const denial = vi.spyOn(c.sync, 'channelUnavailable')
    first.fail({ ok: false, kind: 'http', status: typeof status === 'number' ? status : 404,
      ...(status === 'organization_unavailable' ? { error: status } : {}) })
    await flush()
    expect(denial).not.toHaveBeenCalled()
    expect(c.onSessionEnded).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
    expect(c.sync.get().organization).toBe(status === 'organization_unavailable' ? 'unavailable' : 'available')
    if (status === 403 || status === 404) expect(c.topics.get('A').unavailable).toBe(false)
    await c.sync.close()
  }
})

it('a main read superseded by bootstrap cannot cause a late C9 denial', async () => {
  for (const status of [403, 404]) {
    const c = topicClient()
    await c.boot()
    const first = deferred<Result<TimelinePage>>()
    c.topicsApi.listTimeline.mockReturnValueOnce(first.promise)
    const loading = c.topics.loadMain('A'); await flush()
    await c.topics.bootstrap('A')
    first.resolve({ ok: false, kind: 'http', status }); await loading
    expect(c.topics.get('A').unavailable).toBe(false)
    expect(c.sync.get().channels.A.state).toBe('ready')
    await c.sync.close()
  }
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
