import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Channel, MessagePage, Result, TimelinePage, TopicPage, TopicSummaryResponse } from './api'
import { createSession } from './session'
import { flush } from './sync-test-helpers'
import { deferred, msg, ok, page, summary, topicClient } from './topic-test-helpers'
import { createTopics } from './topics'
import { selectMainTimeline } from './topic-selectors'

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
    if (reason === 'subscription refusal' || reason === 'Organization loss') {
      expect(c.topics.get('A').main).toMatchObject({ asOfSeq: 10, hasMore: true, loading: false })
    } else {
      expect(c.topics.get('A').main.asOfSeq).toBeUndefined()
    }
    await c.sync.close()
  },
)

it('C9 and C10 keep loaded Topic projections while fencing in-flight reads', async () => {
  for (const trigger of ['sync.unavailable', 'ws_4003', 'channel_access_lost'] as const) {
    const c = topicClient()
    c.topicsApi.listTimeline.mockResolvedValueOnce(ok({
      as_of_seq: 3,
      items: [{ kind: 'message', message: msg(3) }],
      has_more: true,
    }))
    await c.sync.start()
    c.handlers[0].onReady()
    await c.sync.watch('A')
    c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3 })

    c.topicsApi.listTimeline.mockResolvedValueOnce(ok({
      as_of_seq: 3,
      items: [
        { kind: 'message', message: msg(1) },
        { kind: 'topic', topic: summary('T', 2, 1) },
      ],
      has_more: false,
    }))
    await c.topics.loadMain('A')
    c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [msg(2, 'T')], has_more: false }))
    await c.topics.loadTopic('A', 'T')

    // Sync holds only the bootstrap Message at W=3; [1, 2] live in Topic projections.
    expect(c.sync.get().channels.A.messages.map(m => m.seq)).toEqual([3])
    expect(c.topics.get('A').lines.map(l => (l.kind === 'message' ? l.message.seq : l.position))).toEqual([1, 2, 3])
    expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([2])

    const inFlightList = deferred<Awaited<ReturnType<typeof c.topicsApi.listTopics>>>()
    c.topicsApi.listTopics.mockReturnValueOnce(inFlightList.promise)
    const loadingList = c.topics.loadList('A')
    await flush()

    if (trigger === 'sync.unavailable') await c.sync.unavailable()
    else if (trigger === 'ws_4003') c.handlers[0].onClose(4003)
    else c.handlers[0].onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await flush()

    expect(c.topics.get('A').unavailable).toBe(true)
    expect(c.topics.get('A').lines.map(l => (l.kind === 'message' ? l.message.seq : l.position))).toEqual([1, 2, 3])
    expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([2])

    inFlightList.resolve(ok({ as_of_seq: 3, topics: [summary('stale', 1, 1)], has_more: false }))
    await loadingList
    expect(c.topics.get('A').topics.map(t => t.topicId)).toEqual(['T'])
    expect(c.topics.get('A').list.loading).toBe(false)
    await c.sync.close()
  }
})

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

it('session replacement and close clear Topic projections before sync notifies subscribers and fence in-flight reads', async () => {
  const c = topicClient()
  await c.boot()
  await c.topics.loadTopic('A', 'T')
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([5, 10])

  const lateAuth = deferred<Result<TopicSummaryResponse>>()
  const lateList = deferred<Awaited<ReturnType<typeof c.topicsApi.listTopics>>>()
  c.topicsApi.getTopicSummary.mockReturnValueOnce(lateAuth.promise)
  c.topicsApi.listTopics.mockReturnValueOnce(lateList.promise)
  const loadingSummary = c.topics.loadSummary('A', 'U')
  const loadingList = c.topics.loadList('A')
  await flush()

  let snapshotOnReplace: ReturnType<typeof c.topics.get> | undefined
  let snapshotOnClose: ReturnType<typeof c.topics.get> | undefined
  c.sync.subscribe(() => {
    const cur = c.sync.get()
    if (cur.selfId === 'next' && !snapshotOnReplace) snapshotOnReplace = c.topics.get('A')
    if (!cur.running && !snapshotOnClose) snapshotOnClose = c.topics.get('A')
  })

  await c.sync.replaceSession('next')
  expect(snapshotOnReplace).toBeDefined()
  expect(snapshotOnReplace!.main.asOfSeq).toBeUndefined()
  expect(snapshotOnReplace!.topics).toEqual([])
  expect(snapshotOnReplace!.topic('T').messages).toEqual([])

  // Late 401 and late list from the replaced session are fenced even after the new session watches Channel A
  c.handlers.at(-1)!.onReady()
  await c.sync.watch('A')
  lateAuth.resolve({ ok: false, kind: 'http', status: 401 })
  lateList.resolve(ok({ as_of_seq: 10, topics: [summary('stale', 2, 1)], has_more: false }))
  await Promise.all([loadingSummary, loadingList])
  expect(c.onSessionEnded).not.toHaveBeenCalled()
  expect(c.topics.get('A').topics.some(t => t.topicId === 'stale')).toBe(false)

  // Hang a new read and verify close clears projections synchronously before sync listeners run and releases timers
  c.topicsApi.listTopicMessages.mockImplementationOnce(() => new Promise(() => {}))
  const hanging = c.topics.loadTopic('A', 'T')
  await flush()
  await c.sync.close()
  await hanging
  expect(snapshotOnClose).toBeDefined()
  expect(snapshotOnClose!.topics).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('reconciles Topic snapshots across sync listener ordering and coalesces own-send settlement notifications', async () => {
  const c = topicClient()
  const seenInEarlySyncListener: number[][] = []
  let secondaryTopics!: ReturnType<typeof createTopics>
  // Subscribe BEFORE secondaryTopics is created so this listener runs before secondaryTopics' sync listener
  c.sync.subscribe(() => {
    if (!secondaryTopics) return
    seenInEarlySyncListener.push(
      secondaryTopics.get('A').lines.map(l => (l.kind === 'message' ? l.message.seq : l.position)),
    )
  })
  secondaryTopics = createTopics(c.sync, { api: c.topicsApi })
  await c.boot()
  await secondaryTopics.loadMain('A')
  // Prime snapshot cache on secondaryTopics before the next sync event
  expect(secondaryTopics.get('A').lines.map(l => (l.kind === 'message' ? l.message.seq : l.position))).toEqual([8, 10])
  seenInEarlySyncListener.length = 0

  c.event(11, 'T')
  expect(seenInEarlySyncListener.at(-1)).toEqual([8, 11])
  secondaryTopics.close()

  // Older page success returns true and emits one consistent notification even when settling an own send
  c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.sync.getTimeline('A').send('unknown own')
  const pending = c.sync.get().channels.A.pending[0]!
  const own = { ...msg(4), sender: 'me', client_message_id: pending.clientMessageId }
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ as_of_seq: 10, items: [{ kind: 'message', message: own }], has_more: true }))
  let topicNotifications = 0
  const unsub = c.topics.subscribe(() => {
    topicNotifications++
  })
  expect(await c.topics.loadMain('A')).toBe(true)
  // 1 notification for loading=true, 1 notification for settled page + settleHistory
  expect(topicNotifications).toBe(2)

  // HTTP 503 returns false
  c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status: 503 })
  expect(await c.topics.loadMain('A')).toBe(false)

  // C9 404 returns false and marks unavailable in a single completion notification
  topicNotifications = 0
  c.topicsApi.listTimeline.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'channel_not_found' })
  expect(await c.topics.loadMain('A')).toBe(false)
  expect(topicNotifications).toBe(2)
  expect(c.topics.get('A').unavailable).toBe(true)
  expect(await c.topics.loadMain('A')).toBe(false)
  unsub()
  await c.sync.close()
})

it('ensureSummary deduplicates concurrent callers, retries retryable failures with backoff, and stops on 404 or close', async () => {
  const c = topicClient()
  await c.boot()
  c.event(11, 'U')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'U')?.baseline).toBeNull()

  const first = deferred<Result<TopicSummaryResponse>>()
  c.topicsApi.getTopicSummary
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ok: true, data: { as_of_seq: 11, topic: { ...summary('U', 11, 2), name: 'Recovered' } } })

  // Concurrent ensureSummary calls from Timeline + TopicList deduplicate into one HTTP request
  const p1 = c.topics.ensureSummary('A', 'U')
  const p2 = c.topics.ensureSummary('A', 'U')
  await flush()
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(1)

  first.resolve({ ok: false, kind: 'http', status: 503 })
  await Promise.all([p1, p2])
  // Scheduled retry prevents re-render loops from firing immediately before backoff elapses
  await c.topics.ensureSummary('A', 'U')
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(500)
  await flush()
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(2)
  expect(c.topics.get('A').topics.find(t => t.topicId === 'U')?.baseline?.summary.name).toBe('Recovered')

  // 404 topic_not_found marks notFound and never schedules retries
  c.topicsApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'topic_not_found' })
  await c.topics.ensureSummary('A', 'missing')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
  await c.sync.close()
})

it('records notFound per Topic on 404 topic_not_found for summary and Topic history reads', async () => {
  const c = topicClient()
  await c.boot()
  expect(c.topics.get('A').topic('missing').notFound).toBe(false)

  c.topicsApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'topic_not_found' })
  await c.topics.loadSummary('A', 'missing')
  expect(c.topics.get('A').topic('missing')).toMatchObject({ notFound: true, error: false })
  expect(c.topics.get('A').topic('T').notFound).toBe(false)
  expect(c.topics.get('A').unavailable).toBe(false)

  c.topicsApi.listTopicMessages.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'topic_not_found' })
  await c.topics.loadTopic('A', 'missing-history')
  expect(c.topics.get('A').topic('missing-history')).toMatchObject({ notFound: true, loading: false, error: false })
  await c.sync.close()
})

it('ensureSummary bounds automatic retries on persistent 503 and network failures, enters terminal retryable error, and restarts on explicit retry or new generation', async () => {
  for (const makeFailure of [
    () => ({ ok: false as const, kind: 'http' as const, status: 503 }),
    () => ({ ok: false as const, kind: 'network' as const }),
  ]) {
    const c = topicClient()
    await c.boot()
    c.event(11, 'U')
    c.topicsApi.getTopicSummary.mockImplementation(async () => makeFailure())

    // Render-driven subscriber calling ensureSummary on every state notification while baseline is null
    const unsub = c.topics.subscribe(() => {
      for (const line of c.topics.get('A').topics) {
        if (line.baseline === null) void c.topics.ensureSummary('A', line.topicId)
      }
    })

    await c.topics.ensureSummary('A', 'U')
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()

    const callsAtTerminal = c.topicsApi.getTopicSummary.mock.calls.length
    expect(callsAtTerminal).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
    expect(c.topics.get('A').topics.find(t => t.topicId === 'U')).toMatchObject({
      baseline: null,
      summaryError: 'retryable',
    })
    expect(c.topics.get('A').topic('U').summaryError).toBe('retryable')

    // Repeated render-driven ensureSummary calls after reaching terminal error make no further automatic requests
    await c.topics.ensureSummary('A', 'U')
    await c.topics.ensureSummary('A', 'U')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(callsAtTerminal)

    // Explicit user retry clears terminal error and restarts bounded retry -> succeeds on the retry backoff
    c.topicsApi.getTopicSummary
      .mockImplementationOnce(async () => makeFailure())
      .mockImplementationOnce(async () => ok({ as_of_seq: 11, topic: { ...summary('U', 11, 2), name: 'Recovered U' } }))
    await c.topics.retrySummary('A', 'U')
    expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(callsAtTerminal + 1)
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(callsAtTerminal + 2)
    expect(c.topics.get('A').topics.find(t => t.topicId === 'U')).toMatchObject({
      messageCount: 2,
      summaryError: null,
      baseline: { summary: { name: 'Recovered U' } },
    })
    expect(c.topics.get('A').topic('U').summaryError).toBeNull()

    // Another live-only Topic V reaches terminal error, then restarts when a new C9 recovery generation begins
    c.event(12, 'V')
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()
    expect(c.topics.get('A').topic('V').summaryError).toBe('retryable')
    const beforeRecoveryCalls = c.topicsApi.getTopicSummary.mock.calls.length

    c.handlers[0].onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await flush()
    c.topicsApi.getTopicSummary.mockImplementationOnce(async () =>
      ok({ as_of_seq: 12, topic: { ...summary('V', 12, 1), name: 'Recovered V' } }),
    )
    await c.sync.watch('A')
    c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 12 })
    await flush()
    expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(beforeRecoveryCalls + 1)
    expect(c.topics.get('A').topics.find(t => t.topicId === 'V')).toMatchObject({
      summaryError: null,
      baseline: { summary: { name: 'Recovered V' } },
    })

    unsub()
    await c.sync.close()
  }
})

it('ensureSummary makes no further automatic requests after non-retryable 400 and 429 despite repeated render-driven calls, and explicit retry restarts', async () => {
  for (const status of [400, 429] as const) {
    const c = topicClient()
    await c.boot()
    c.event(11, 'U')
    c.topicsApi.getTopicSummary.mockResolvedValue({ ok: false, kind: 'http', status })

    // Render-driven subscriber calling ensureSummary on every notification
    const unsub = c.topics.subscribe(() => {
      const line = c.topics.get('A').topics.find(t => t.topicId === 'U')
      if (line && line.baseline === null) void c.topics.ensureSummary('A', 'U')
    })

    await c.topics.ensureSummary('A', 'U')
    // Repeated render-driven calls and advancing timers cause zero additional automatic requests
    for (let i = 0; i < 5; i++) {
      await c.topics.ensureSummary('A', 'U')
    }
    await vi.advanceTimersByTimeAsync(120_000)
    expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(c.topics.get('A').topics.find(t => t.topicId === 'U')).toMatchObject({
      baseline: null,
      summaryError: 'non_retryable',
    })
    expect(c.topics.get('A').topic('U').summaryError).toBe('non_retryable')

    // Explicit retry restarts and resolves the summary baseline
    c.topicsApi.getTopicSummary.mockResolvedValueOnce(
      ok({ as_of_seq: 11, topic: { ...summary('U', 11, 1), name: 'Explicit Retry' } }),
    )
    await c.topics.retrySummary('A', 'U')
    expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(2)
    expect(c.topics.get('A').topics.find(t => t.topicId === 'U')).toMatchObject({
      messageCount: 1,
      summaryError: null,
      baseline: { summary: { name: 'Explicit Retry' } },
    })

    unsub()
    await c.sync.close()
  }
})

it('retains Topic window, baselines and paging cursors across C9 loss and same-Channel recovery with replay', async () => {
  const handlers: import('./realtime').RealtimeHandlers[] = []
  const controls: unknown[] = []
  const channelA: Channel = {
    id: 'A',
    name: 'general',
    visibility: 'private',
    capabilities: {
      can_add_members: { allowed: false },
      can_remove_members: { allowed: false },
      can_leave: { allowed: false },
    },
  }
  const listMessages = vi.fn(async (): Promise<Result<MessagePage>> => ok({ messages: [], has_more: false }))
  const sendMessage = vi.fn(async () => ok(msg(99)))
  const topicsApi = {
    listTimeline: vi.fn(async () => ok(page(10))),
    listTopics: vi.fn(async (): Promise<Result<TopicPage>> => ok({ as_of_seq: 10, has_more: false, topics: [] })),
    getTopicSummary: vi.fn(async (): Promise<Result<TopicSummaryResponse>> => ok({ as_of_seq: 10, topic: summary('T', 10, 3) })),
    listTopicMessages: vi.fn(async (): Promise<Result<MessagePage>> => ok({ messages: [], has_more: false })),
  }
  const session = createSession({
    selfId: 'me',
    organizationId: 'org-1',
    onEnded: vi.fn(),
    channelsApi: {
      listChannels: vi.fn(async () => ok({ channels: [channelA] })),
      createChannel: vi.fn(async () => ok(channelA)),
    },
    topicsApi,
    sync: {
      api: { listMessages, sendMessage },
      connect(h) {
        handlers.push(h)
        return { send: m => { controls.push(m) }, close: vi.fn() }
      },
    },
  })

  handlers[0]!.onReady()
  await flush()
  expect(controls).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10 })
  handlers[0]!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 })
  await flush()

  // 1. Fully load Topic T history (2 pages -> has_more: false) and partially load Topic U (1 page -> has_more: true)
  topicsApi.listTopicMessages
    .mockResolvedValueOnce(ok({ messages: [msg(5, 'T'), msg(10, 'T')], has_more: true }))
    .mockResolvedValueOnce(ok({ messages: [msg(2, 'T')], has_more: false }))
    .mockResolvedValueOnce(ok({ messages: [msg(7, 'U')], has_more: true }))
  await session.topics.loadTopic('A', 'T')
  await session.topics.loadTopic('A', 'T')
  await session.topics.loadTopic('A', 'U')
  expect(topicsApi.listTopicMessages.mock.calls).toEqual([
    ['A', 'T', {}],
    ['A', 'T', { before_seq: 5 }],
    ['A', 'U', {}],
  ])

  // 2. Fully load the Topic list (2 pages -> has_more: false)
  topicsApi.listTopics
    .mockResolvedValueOnce(ok({ as_of_seq: 10, topics: [summary('U', 7, 2), summary('T', 10, 3)], has_more: true }))
    .mockResolvedValueOnce(ok({ as_of_seq: 10, topics: [summary('V', 3, 1)], has_more: false }))
  await session.topics.loadList('A')
  await session.topics.loadList('A')
  expect(topicsApi.listTopics.mock.calls).toEqual([
    ['A', {}],
    ['A', { as_of_seq: 10, before_position: 7 }],
  ])

  const beforeLoss = session.topics.get('A')
  expect(beforeLoss).toMatchObject({
    unavailable: false,
    main: { asOfSeq: 10, before: 8, hasMore: true, loading: false, error: false },
    list: { asOfSeq: 10, before: 3, hasMore: false, loading: false, error: false },
  })
  expect(beforeLoss.topic('T')).toMatchObject({ initialized: true, before: 2, hasMore: false, loading: false, error: false })
  expect(beforeLoss.topic('T').messages.map(m => m.seq)).toEqual([2, 5, 10])
  expect(beforeLoss.topic('U')).toMatchObject({ initialized: true, before: 7, hasMore: true })
  expect(beforeLoss.topics.map(t => [t.topicId, t.position, t.messageCount])).toEqual([
    ['V', 3, 1],
    ['U', 7, 2],
    ['T', 10, 3],
  ])

  // 3. Lose Channel access (C9): window is kept
  handlers[0]!.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
  await flush()
  const duringLoss = session.topics.get('A')
  expect(duringLoss.unavailable).toBe(true)
  expect(duringLoss.generation).toBe(beforeLoss.generation)
  expect(duringLoss.main).toEqual(beforeLoss.main)
  expect(duringLoss.list).toEqual(beforeLoss.list)
  expect(duringLoss.topic('T')).toEqual(beforeLoss.topic('T'))
  expect(duringLoss.topic('U')).toEqual(beforeLoss.topic('U'))
  expect(duringLoss.topics).toEqual(beforeLoss.topics)

  // 4. Regain Channel access and re-select the same Channel: only generation changes; cursors & baselines stay
  controls.length = 0
  topicsApi.listTimeline.mockClear()
  topicsApi.listTopics.mockClear()
  topicsApi.listTopicMessages.mockClear()
  topicsApi.getTopicSummary.mockClear()
  listMessages.mockClear()

  session.channels.select('A')
  await flush()
  expect(controls).toEqual([{ type: 'subscribe', channel_id: 'A', after_seq: 10 }])
  expect(topicsApi.listTimeline).not.toHaveBeenCalled()
  expect(topicsApi.listTopics).not.toHaveBeenCalled()
  expect(topicsApi.listTopicMessages).not.toHaveBeenCalled()
  expect(topicsApi.getTopicSummary).not.toHaveBeenCalled()
  expect(listMessages).not.toHaveBeenCalled()

  const onRecovery = session.topics.get('A')
  expect(onRecovery.unavailable).toBe(false)
  expect(onRecovery.generation).toBe(beforeLoss.generation + 1)
  expect(onRecovery.main).toEqual(beforeLoss.main)
  expect(onRecovery.list).toEqual(beforeLoss.list)
  expect(onRecovery.topic('T')).toEqual(beforeLoss.topic('T'))
  expect(onRecovery.topic('U')).toEqual(beforeLoss.topic('U'))
  expect(onRecovery.topics).toEqual(beforeLoss.topics)
  expect(onRecovery.lines).toEqual(beforeLoss.lines)

  // 5. Deliver replay (including an at-least-once boundary duplicate seq=10) + handoff watermark
  handlers[0]!.onEvent({ type: 'message', message: msg(10, 'T') })
  handlers[0]!.onEvent({ type: 'message', message: msg(11, 'T') })
  handlers[0]!.onEvent({ type: 'message', message: msg(12, 'V') })
  handlers[0]!.onEvent({ type: 'message', message: msg(13, null) })
  handlers[0]!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 13 })
  await flush()

  expect(session.sync.get().channels.A).toMatchObject({ state: 'ready', cursor: 13 })
  const afterReplay = session.topics.get('A')
  expect(afterReplay.topic('T').messages.map(m => m.seq)).toEqual([2, 5, 10, 11])
  expect(afterReplay.topics.map(t => [t.topicId, t.position, t.messageCount])).toEqual([
    ['U', 7, 2],
    ['T', 11, 4],
    ['V', 12, 2],
  ])
  expect(
    afterReplay.lines.map(l =>
      l.kind === 'message' ? { seq: l.message.seq } : { topic: l.topicId, position: l.position, count: l.messageCount },
    ),
  ).toEqual([
    { seq: 8 },
    { topic: 'T', position: 11, count: 4 },
    { topic: 'V', position: 12, count: 2 },
    { seq: 13 },
  ])

  // 6. Outgoing paging requests respect retained hasMore, asOfSeq and before cursors
  await session.topics.loadTopic('A', 'T')
  await session.topics.loadList('A')
  expect(topicsApi.listTopicMessages).not.toHaveBeenCalled()
  expect(topicsApi.listTopics).not.toHaveBeenCalled()

  topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [msg(1, 'U')], has_more: false }))
  await session.topics.loadTopic('A', 'U')
  expect(topicsApi.listTopicMessages.mock.calls).toEqual([['A', 'U', { before_seq: 7 }]])
  expect(session.topics.get('A').topic('U').messages.map(m => m.seq)).toEqual([1, 7])
  expect(session.topics.get('A').topic('U').hasMore).toBe(false)

  topicsApi.listTimeline.mockResolvedValueOnce(
    ok({
      as_of_seq: 10,
      items: [
        { kind: 'topic', topic: summary('V', 3, 1) },
        { kind: 'message', message: msg(4) },
        { kind: 'topic', topic: summary('U', 7, 2) },
      ],
      has_more: false,
    }),
  )
  expect(await session.topics.loadMain('A')).toBe(true)
  expect(topicsApi.listTimeline.mock.calls).toEqual([['A', { as_of_seq: 10, before_position: 8 }]])
  expect(
    session.topics.get('A').lines.map(l =>
      l.kind === 'message' ? { seq: l.message.seq } : { topic: l.topicId, position: l.position, count: l.messageCount },
    ),
  ).toEqual([
    { seq: 4 },
    { topic: 'U', position: 7, count: 2 },
    { seq: 8 },
    { topic: 'T', position: 11, count: 4 },
    { topic: 'V', position: 12, count: 2 },
    { seq: 13 },
  ])

  session.close()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['list', 'history'] as const)('fences a late Topic %s page when reconnect clamps the cursor', async kind => {
  const c = topicClient()
  await c.boot(); await c.topics.loadTopic('A', 'T')
  const lateList = deferred<Result<TopicPage>>()
  const lateHistory = deferred<Result<MessagePage>>()
  if (kind === 'list') c.topicsApi.listTopics.mockReturnValueOnce(lateList.promise)
  else c.topicsApi.listTopicMessages.mockReturnValueOnce(lateHistory.promise)
  const loading = kind === 'list' ? c.topics.loadList('A') : c.topics.loadTopic('A', 'T')
  await flush()
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ as_of_seq: 2, items: [{ kind: 'topic', topic: summary('T', 2, 1) }], has_more: false }))
  c.handlers[0].onClose(1006)
  await vi.advanceTimersByTimeAsync(500)
  c.handlers.at(-1)!.onReady()
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 2 })
  await flush()
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ messages: [msg(2, 'T')], has_more: false }))
  await c.topics.loadTopic('A', 'T')
  lateList.resolve(ok({ as_of_seq: 10, topics: [summary('stale', 9, 9)], has_more: false }))
  lateHistory.resolve(ok({ messages: [msg(1, 'T'), msg(5, 'T')], has_more: false }))
  await loading
  expect(c.sync.get().channels.A.cursor).toBe(2)
  expect(c.topics.get('A').topics.map(t => [t.topicId, t.position, t.messageCount])).toEqual([['T', 2, 1]])
  expect(c.topics.get('A').lines).toHaveLength(1)
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([2])
  await c.sync.close()
})

it('keeps the open Topic cursor and window on reconnect catch-up without clamp', async () => {
  const c = topicClient()
  await c.boot(); await c.topics.loadTopic('A', 'T')
  const generation = c.topics.get('A').generation
  c.handlers[0].onClose(1006)
  await vi.advanceTimersByTimeAsync(500)
  c.handlers.at(-1)!.onReady()
  expect(c.controls.at(-1)).toEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10 })
  expect(c.sync.get().channels.A.cursor).toBe(10)
  c.event(11, 'T'); c.event(11, 'T'); c.event(12)
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 12 })
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 12, state: 'ready' })
  expect(c.topics.get('A').generation).toBe(generation)
  expect(c.topics.get('A').topic('T')).toMatchObject({ before: 5, initialized: true, hasMore: true })
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([5, 10, 11])
  expect(c.topics.get('A').lines.map(l => l.kind === 'message' ? l.message.seq : l.position)).toEqual([8, 11, 12])
  expect(c.topics.get('A').topics[0]).toMatchObject({ topicId: 'T', position: 11, messageCount: 4 })
  expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(1)
  expect(c.listMessages).not.toHaveBeenCalled()
  await c.sync.close()
})

it.each(['list', 'history'] as const)('merges live and own Messages once during an in-flight Topic %s page', async kind => {
  const c = topicClient()
  await c.boot(); await c.topics.loadTopic('A', 'T')
  const list = deferred<Result<TopicPage>>(), history = deferred<Result<MessagePage>>()
  c.topicsApi.listTopics.mockReturnValueOnce(list.promise)
  c.topicsApi.listTopicMessages.mockReturnValueOnce(history.promise)
  const loading = kind === 'list' ? c.topics.loadList('A') : c.topics.loadTopic('A', 'T')
  await flush()
  if (kind === 'list') {
    expect(c.topicsApi.listTopics.mock.calls).toEqual([['A', {}]])
    expect(c.topics.get('A').list.loading).toBe(true)
    expect(c.topics.get('A').topics.map(t => t.topicId)).toEqual(['T'])
  } else {
    expect(c.topicsApi.listTopicMessages.mock.calls.at(-1)).toEqual(['A', 'T', { before_seq: 5 }])
    expect(c.topics.get('A').topic('T').loading).toBe(true)
  }
  c.event(11, 'T')
  c.sendMessage.mockImplementationOnce(async (_channel, body) => ok({ ...msg(12, 'T'), sender: 'me', client_message_id: body.client_message_id, body: body.body }))
  const composer = c.sync.getTimeline('A').topic('T')
  composer.setDraft('own Topic post')
  await composer.submit('Topic T')
  const result = await c.sendMessage.mock.results.at(-1)!.value
  if (!result.ok) throw new Error('expected canonical ACK')
  const own = result.data
  c.handlers.at(-1)!.onEvent({ type: 'message', message: own })
  c.event(11, 'T')
  list.resolve(ok({ as_of_seq: 11, topics: [summary('U', 3, 1), summary('T', 11, 4)], has_more: true }))
  history.resolve(ok({ messages: [msg(2, 'T')], has_more: false }))
  await loading
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual(kind === 'list' ? [5, 10, 11, 12] : [2, 5, 10, 11, 12])
  expect(c.topics.get('A').topics.map(t => [t.topicId, t.position, t.messageCount])).toEqual(kind === 'list' ? [['U', 3, 1], ['T', 12, 5]] : [['T', 12, 5]])
  if (kind === 'list') expect(c.topics.get('A').list.loading).toBe(false)
  expect(c.topics.get('A').lines.map(l => l.kind === 'message' ? l.message.seq : l.position)).toEqual([8, 12])
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 12, pending: [] })
  if (kind === 'history') expect(c.topicsApi.listTopicMessages.mock.calls.at(-1)).toEqual(['A', 'T', { before_seq: 5 }])
  await c.sync.close()
})

it('creates a Topic via topic_name from the Topic composer during main paging exactly once', async () => {
  const c = topicClient()
  await c.boot()
  const older = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(older.promise)
  const loading = c.topics.loadMain('A'); await flush()
  c.sendMessage.mockImplementationOnce(async (_channel, body) => ok({ ...msg(11, 'new'), sender: 'me', client_message_id: body.client_message_id, body: body.body }))
  const composer = c.sync.getTimeline('A').topic('new')
  composer.setDraft('first post')
  await composer.submit('New Topic')
  expect(c.sendMessage.mock.calls[0][1]).toMatchObject({ topic_name: 'New Topic', body: 'first post' })
  const result = await c.sendMessage.mock.results[0]!.value
  if (!result.ok) throw new Error('expected canonical ACK')
  const own = result.data
  c.handlers[0].onEvent({ type: 'message', message: own })
  older.resolve(ok({ as_of_seq: 10, items: [{ kind: 'topic', topic: summary('U', 3, 1) }], has_more: false }))
  await loading
  c.handlers[0].onEvent({ type: 'message', message: own })
  expect(c.topicsApi.listTimeline.mock.calls[1]).toEqual(['A', { as_of_seq: 10, before_position: 8 }])
  expect(c.topics.get('A').lines.map(l => l.kind === 'message' ? l.message.seq : [l.topicId, l.position])).toEqual([['U', 3], 8, ['T', 10], ['new', 11]])
  expect(c.topics.get('A').topic('new').messages).toEqual([own])
  expect(c.sync.get().channels.A.pending).toEqual([])
  expect(composer.get().draft).toBe('')
  await c.sync.close()
})

it('recovers C9 Topic state by selecting a different Channel and back', async () => {
  const c = topicClient()
  const channel = (id: string): Channel => ({ id, name: id, visibility: 'public', capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_leave: { allowed: true } } })
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), topicsApi: c.topicsApi,
    channelsApi: { listChannels: async () => ok({ channels: [channel('A'), channel('B')] }), createChannel: async () => ok(channel('B')) },
    sync: { api: { listMessages: c.listMessages, sendMessage: c.sendMessage },
      connect(h) { c.handlers.push(h); return { send: m => { c.controls.push(m) }, close: vi.fn() } } },
  })
  c.handlers[0].onReady(); await flush()
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 })
  await session.topics.loadTopic('A', 'T')
  const composer = session.sync.getTimeline('A').topic('T')
  composer.setDraft('kept draft')
  c.handlers[0].onEvent({ type: 'channel_access_lost', channel_id: 'A' })
  expect(session.topics.get('A').unavailable).toBe(true)
  expect(await composer.submit('Topic T')).toBe(false)
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ as_of_seq: 0, items: [], has_more: false }))
  session.channels.select('B'); await flush()
  expect(session.sync.get().channels.B?.cursor).toBe(0)
  expect(session.topics.get('A').unavailable).toBe(true)
  session.channels.select('A'); await flush()
  await session.topics.loadMain('A')
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 })
  await session.topics.loadTopic('A', 'T')
  expect(session.sync.get().channels.A).toMatchObject({ state: 'ready', cursor: 10 })
  expect(session.topics.get('A').unavailable).toBe(false)
  expect(session.topics.get('A').lines.map(l => l.kind === 'message' ? l.message.seq : l.position)).toEqual([8, 10])
  expect(session.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([5, 10])
  expect(composer.get().draft).toBe('kept draft')
  session.close(); await c.sync.close()
})

it('selectMainTimeline emits one line per topic_id at its newest position', () => {
  const lines = selectMainTimeline(
    [msg(12, 'T'), msg(7, 'U'), msg(11), msg(12, 'T'), msg(9, 'T')],
    [msg(3), msg(7, 'U'), msg(9, 'T')],
    [{ asOfSeq: 10, summary: summary('T', 9, 3) }, { asOfSeq: 6, summary: summary('U', 4, 1) }],
  )
  expect(lines.map(l => l.kind === 'message' ? l.message.seq : [l.topicId, l.position, l.messageCount])).toEqual([3, ['U', 7, 2], 11, ['T', 12, 4]])
  expect(lines.filter(l => l.kind === 'topic').map(l => l.latestMessage)).toEqual([msg(7, 'U'), msg(12, 'T')])
})
