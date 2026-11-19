import { afterEach, expect, it, vi } from 'vitest'
import { createActivity } from './activity'
import { deferred, replyPage, msg, ok, page, summary, topicClient } from './topic-test-helpers'
import { reply, replyClient, root } from './reply-test-helpers'
import { moveEvent } from './protocol-test-helpers'
import { flush } from './sync-test-helpers'
import type { ReplyChainPage, Result, TimelinePage } from './api'
import { createReplies } from './replies'
const generation = '00000000-0000-4000-8000-000000000515'
const expired = { ok: false as const, kind: 'http' as const, status: 409, error: 'snapshot_expired' }
afterEach(() => vi.useRealTimers())

it('Topic bootstrap trusts the event watermark with empty or older visible records', async () => {
  for (const items of [[], [{ kind: 'topic' as const, topic: summary('T', 3, 1) }]]) {
    const c = topicClient()
    c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 10, items, has_more: false }))
    await c.boot()
    expect(c.sync.get().channels.A!.cursor).toBe(10)
    expect(c.sync.get().channels.A!.messages.map(m => m.created_seq)).toEqual(items.length ? [3] : [])
    expect(c.controls).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10, history_generation: generation })
    expect(c.listMessages).not.toHaveBeenCalled()
    await c.sync.close()
  }
})

it('Topic expiry refetches only that window at a fresh watermark', async () => {
  const c = topicClient(); await c.boot(); await c.topics.loadTopic('A', 'T')
  const before = c.topics.get('A'), core = c.sync.get().channels.A
  const mainReads = c.topicsApi.listTimeline.mock.calls.length, listReads = c.topicsApi.listTopics.mock.calls.length
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(expired).mockResolvedValueOnce(ok({
    history_generation: generation, as_of_seq: 20, messages: [msg(15, 'T')], has_more: false,
  }))
  await c.topics.loadTopic('A', 'T')
  expect(c.topicsApi.listTopicMessages.mock.calls.slice(-2)).toEqual([
    ['A', 'T', { history_generation: generation, as_of_seq: 10, before_seq: 5 }],
    ['A', 'T', { history_generation: generation }],
  ])
  expect(c.topics.get('A').topic('T').messages.map(m => m.created_seq)).toEqual([15])
  expect(c.topics.get('A').main).toEqual(before.main)
  expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(mainReads)
  expect(c.topicsApi.listTopics).toHaveBeenCalledTimes(listReads)
  expect(c.sync.get().channels.A).toBe(core)
  await c.sync.close()
})
it('main expiry leaves the active Topic window and sync cursor intact', async () => {
  const c = topicClient(); await c.boot(); await c.topics.loadTopic('A', 'T')
  const topic = c.topics.get('A').topic('T'), core = c.sync.get().channels.A
  const reads = c.topicsApi.listTopicMessages.mock.calls.length
  c.topicsApi.listTimeline.mockResolvedValueOnce(expired).mockResolvedValueOnce(ok(page(20)))
  await c.topics.loadMain('A')
  expect(c.topicsApi.listTimeline.mock.calls.slice(-2)).toEqual([
    ['A', { history_generation: generation, as_of_seq: 10, before_position: 8 }],
    ['A', { history_generation: generation }],
  ])
  expect(c.topics.get('A').main.asOfSeq).toBe(20)
  expect(c.topics.get('A').topic('T')).toEqual(topic)
  expect(c.topicsApi.listTopicMessages).toHaveBeenCalledTimes(reads)
  expect(c.sync.get().channels.A).toBe(core)
  await c.sync.close()
})
it('Topic-list expiry discards list-only baselines and preserves main paging', async () => {
  const c = topicClient(); await c.boot()
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 10, topics: [summary('L', 7, 1)], has_more: true }))
  await c.topics.loadList('A')
  const main = c.topics.get('A').main, reads = c.topicsApi.listTimeline.mock.calls.length
  expect(c.topics.get('A').topics.some(t => t.topicId === 'L')).toBe(true)
  c.topicsApi.listTopics.mockResolvedValueOnce(expired).mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 20, topics: [], has_more: false }))
  await c.topics.loadList('A')
  expect(c.topics.get('A').topics.some(t => t.topicId === 'L')).toBe(false)
  expect(c.topics.get('A').main).toEqual(main)
  expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(reads)
  expect(c.sync.get().channels.A!.cursor).toBe(10)
  await c.sync.close()
})
it('Reply expiry restarts just its chain and never loops on repeated fresh expiry', async () => {
  const c = replyClient(); await c.boot()
  c.listReplyChain.mockResolvedValueOnce(ok(replyPage({ history_generation: generation, as_of_seq: 10, root_id: 'id1', messages: [root(), reply(3)], has_more: true })))
  await c.replies.open('A', root())
  const core = c.sync.get().channels.A, reads = c.listMessages.mock.calls.length
  c.listReplyChain.mockResolvedValueOnce(expired).mockResolvedValueOnce(ok(replyPage({ history_generation: generation, as_of_seq: 20, root_id: 'id1', messages: [root(), reply(15)], has_more: true })))
  await c.replies.loadMore('A')
  expect(c.listReplyChain.mock.calls.slice(-2)).toEqual([
    ['A', 'id1', { history_generation: generation, as_of_seq: 10, after_seq: 3 }],
    ['A', 'id1', { history_generation: generation, as_of_seq: undefined, after_seq: 0 }],
  ])
  expect(c.replies.get('A').messages.map(m => m.created_seq)).toEqual([1, 15])
  expect(c.listMessages).toHaveBeenCalledTimes(reads)
  expect(c.sync.get().channels.A).toBe(core)
  c.listReplyChain.mockResolvedValue(expired)
  const before = c.listReplyChain.mock.calls.length
  await c.replies.loadMore('A')
  expect(c.listReplyChain).toHaveBeenCalledTimes(before + 2)
  expect(c.replies.get('A').error).toBe(true)
  expect(c.sync.get().channels.A!.cursor).toBe(1)
  await c.sync.close()
})


it('refetches held main and Topic windows on Move and fences a late pre-Move projection', async () => {
  const c = topicClient(); await c.boot()
  await c.topics.loadList('A'); await c.topics.loadTopic('A', 'T')
  const stale = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(stale.promise)
  const pending = c.topics.loadMain('A')
  await flush()
  const moved = { ...msg(8, 'T'), version: 11 }
  const timeline = { ...page(11), items: [{ kind: 'topic' as const, topic: summary('T', 10, 4) }] }
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok(timeline))
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, has_more: false, topics: [summary('T', 10, 4)] }))
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, messages: [moved, msg(10, 'T')], has_more: false }))
  c.listMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, messages: [moved, msg(10, 'T')], has_more: false }))
  c.handlers[0].onEvent({ ...moveEvent(11, 'id8'), destination_topic_id: 'T' })
  await flush()
  expect(c.topicsApi.listTimeline).toHaveBeenLastCalledWith('A', { history_generation: generation })
  expect(c.topicsApi.listTopics).toHaveBeenLastCalledWith('A', { history_generation: generation })
  expect(c.topicsApi.listTopicMessages).toHaveBeenLastCalledWith('A', 'T', { history_generation: generation })
  expect(c.topics.get('A').main.asOfSeq).toBe(11)
  expect(c.topics.get('A').topic('T').messages).toContainEqual(moved)
  stale.resolve(ok(page(10)))
  await pending; await flush()
  expect(c.topics.get('A').lines.some(line => line.kind === 'message' && line.message.id === moved.id)).toBe(false)
  expect(c.sync.get().channels.A.cursor).toBe(11)
  await c.sync.close()
})

it('refetches an open Reply chain on Move and fences its older page', async () => {
  const c = replyClient(); await c.boot(); await c.replies.open('A', root())
  const stale = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(stale.promise)
  const pending = c.replies.loadMore('A')
  await flush()
  const moved = { ...root('destination'), version: 2 }
  c.listReplyChain.mockResolvedValueOnce(ok(replyPage({
    history_generation: generation, as_of_seq: 2, root_id: 'id1', messages: [moved], has_more: false,
  })))
  c.listMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 2, messages: [moved], has_more: false }))
  c.handlers[0].onEvent(moveEvent(2))
  await flush()
  expect(c.listReplyChain).toHaveBeenLastCalledWith('A', 'id1', { history_generation: generation, as_of_seq: undefined, after_seq: 0 })
  expect(c.replies.get('A').topicId).toBe('destination')
  stale.resolve(ok(replyPage({ history_generation: generation, as_of_seq: 1, root_id: 'id1', messages: [root()], has_more: false })))
  await pending; await flush()
  expect(c.replies.get('A').messages).toEqual([moved])
  expect(c.sync.get().channels.A.cursor).toBe(2)
  await c.sync.close()
})

it('a Move keeps the open chain invalidated until a covering descendant page arrives', async () => {
  const c = replyClient(), anchor = reply(75, 'id1', 'source')
  await c.sync.start(); c.handlers[0].onReady()
  c.listMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 80, messages: [anchor], has_more: true }))
  await c.sync.watch('A')
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', history_generation: generation, caught_up_seq: 80 })
  const old = { ...replyPage({ history_generation: generation, as_of_seq: 80, root_id: 'id1', messages: [anchor], has_more: false }), chain_version: 80 }
  c.listReplyChain.mockResolvedValueOnce(ok(old))
  await c.replies.open('A', anchor)
  expect(c.replies.get('A')).toMatchObject({ anchor, topicId: 'source', moveInvalidated: false })
  const refreshed = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockResolvedValueOnce(ok(old)).mockReturnValueOnce(refreshed.promise)
  c.handlers[0].onEvent(moveEvent(81)); await flush()
  expect(c.replies.get('A')).toMatchObject({
    anchor: null, anchorId: anchor.id, rootId: 'id1', topicId: null, moveInvalidated: true, chainVersion: undefined, messages: [],
  })
  expect(c.listReplyChain.mock.calls.slice(-2)).toEqual([
    ['A', anchor.id, { history_generation: generation, as_of_seq: undefined, after_seq: 50 }],
    ['A', anchor.id, { history_generation: generation, as_of_seq: undefined, after_seq: 50 }],
  ])
  const moved = { ...anchor, topic_id: 'destination', version: 81 }
  refreshed.resolve(ok({ ...old, as_of_seq: 81, chain_version: 81, messages: [moved] })); await flush()
  expect(c.replies.get('A')).toMatchObject({
    anchor: moved, topicId: 'destination', moveInvalidated: false, chainVersion: 81, messages: [moved], hasOlder: true,
  })
  await c.sync.close()
})

it('refetches the open Topic after Move even when a summary-only sentinel was inserted first', async () => {
  const c = topicClient(); await c.boot()
  const missing = { ok: false as const, kind: 'http' as const, status: 404, error: 'topic_not_found' }
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(missing).mockResolvedValueOnce(missing)
  await c.topics.loadSummary('A', 'missing')
  await c.topics.loadSummary('A', 'T')
  expect(c.topics.get('A').topic('missing')).toMatchObject({ notFound: true, initialized: false })
  await c.topics.loadTopic('A', 'T')
  expect(c.topics.get('A').topic('T').initialized).toBe(true)
  expect(c.topics.get('A').topic('missing').notFound).toBe(true)

  const moved = { ...msg(8, 'T'), version: 11 }
  const fresh = { history_generation: generation, as_of_seq: 11, has_more: false, messages: [moved, msg(10, 'T')] }
  c.listMessages.mockResolvedValueOnce(ok(fresh))
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ ...page(11), items: [{ kind: 'topic', topic: summary('T', 10, 4) }] }))
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 10, topic: summary('T', 10, 3) }))
    .mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, topic: summary('T', 10, 4) }))
    .mockResolvedValue(missing)
  c.topicsApi.listTopicMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 10, has_more: false, messages: [msg(5, 'T')] }))
    .mockResolvedValueOnce(ok(fresh))
  c.handlers[0].onEvent({ ...moveEvent(11, 'id8'), destination_topic_id: 'T' }); await flush(); await flush()
  expect(c.topicsApi.listTopicMessages.mock.calls).toEqual([
    ['A', 'T', { history_generation: generation }], ['A', 'T', { history_generation: generation }], ['A', 'T', { history_generation: generation }],
  ])
  expect(c.topicsApi.getTopicSummary.mock.calls).toEqual([['A', 'missing'], ['A', 'T'], ['A', 'T'], ['A', 'T'], ['A', 'missing']])
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')).toMatchObject({ messageCount: 4 })
  expect(c.topics.get('A').topic('T').messages).toEqual(fresh.messages)
  await c.sync.close()
})

it('live Move, reconnect replay and gap fill converge on the same held projections', async () => {
  vi.useFakeTimers()
  async function run(mode: 'live' | 'replay' | 'fill') {
    const c = topicClient()
    const oldAnchor = msg(5, 'T'), moved = { ...oldAnchor, topic_id: 'destination', version: 11 }
    const initial = ok(replyPage({ history_generation: generation, as_of_seq: 10, root_id: oldAnchor.id, messages: [oldAnchor], has_more: false }))
    const latest = deferred<Result<ReplyChainPage>>()
    const listReplyChain = vi.fn().mockResolvedValueOnce(initial).mockReturnValue(latest.promise)
    const replies = createReplies(c.sync, { api: { listReplyChain } })
    await c.boot(); await c.topics.loadList('A'); await c.topics.loadTopic('A', 'T'); await replies.open('A', oldAnchor)
    const move = { ...moveEvent(11, oldAnchor.id), source_topic_id: 'T' }
    const next = { type: 'message' as const, kind: 'create' as const, seq: 12, message: msg(12) }
    const destination = { ...summary('destination', 5, 1), latest_message: moved }
    c.topicsApi.listTimeline.mockResolvedValue(ok({ history_generation: generation, as_of_seq: 12, has_more: false, items: [
      { kind: 'topic', topic: destination }, { kind: 'message', message: msg(12) },
    ] }))
    c.topicsApi.listTopics.mockResolvedValue(ok({ history_generation: generation, as_of_seq: 12, has_more: false, topics: [destination] }))
    const missing = { ok: false as const, kind: 'http' as const, status: 404, error: 'topic_not_found' }
    c.topicsApi.getTopicSummary.mockResolvedValue(missing)
    c.topicsApi.listTopicMessages.mockResolvedValue(missing)
    c.listMessages.mockResolvedValue(ok({ history_generation: generation, as_of_seq: 12, has_more: false, messages: [moved, msg(12)] }))

    let socket = c.handlers[0]
    if (mode === 'replay') {
      socket.onClose(1006); await vi.advanceTimersByTimeAsync(500)
      socket = c.handlers[1]; socket.onReady()
      expect(c.controls.at(-1)).toEqual({ type: 'subscribe', channel_id: 'A', after_seq: 10, history_generation: generation })
      c.handlers[0].onEvent(move)
      expect(replies.get('A').messages).toEqual([oldAnchor])
    }
    if (mode === 'fill') {
      c.listChannelEvents.mockResolvedValueOnce(ok({ history_generation: generation, has_more: false, events: [move] }))
      socket.onEvent(next); await vi.advanceTimersByTimeAsync(100)
    } else {
      socket.onEvent(move); socket.onEvent(next)
      if (mode === 'replay') socket.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 12, history_generation: generation })
    }
    expect(replies.get('A')).toMatchObject({ messages: [], anchor: null, chainVersion: undefined })
    latest.resolve(ok(replyPage({ history_generation: generation, as_of_seq: 12, root_id: oldAnchor.id, messages: [moved], has_more: false })))
    await flush()
    const thread = replies.get('A'), view = c.topics.get('A'), core = c.sync.get().channels.A
    expect(core.cursor).toBe(12)
    expect(view.main.asOfSeq).toBe(12)
    expect(view.list.asOfSeq).toBe(12)
    expect(view.topic('T')).toMatchObject({ notFound: true, messages: [] })
    expect(thread).toMatchObject({ chainVersion: 11, topicId: 'destination', messages: [moved] })
    socket.onEvent(move); await flush()
    expect(replies.get('A')).toBe(thread)
    expect(c.topics.get('A')).toBe(view)
    expect(listReplyChain).toHaveBeenCalledTimes(2)
    replies.close(); await c.sync.close()
    return { messages: core.messages, lines: view.lines, list: view.list, thread }
  }
  const live = await run('live')
  expect(await run('replay')).toEqual(live)
  expect(await run('fill')).toEqual(live)
})

it('a lower Move for another chain fences a pending projection without lowering the covering watermark', async () => {
  const c = topicClient(); await c.boot(); await c.topics.loadTopic('A', 'T')
  const old = deferred<Result<TimelinePage>>(), current = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  c.handlers[0].onEvent(moveEvent(12, 'id10')); await flush()
  c.handlers[0].onEvent(moveEvent(11, 'id8')); await flush()
  expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(3)
  const fresh = { ...page(12), items: [], has_more: false }
  current.resolve(ok(fresh)); await flush()
  old.resolve(ok(page(11))); await flush()
  expect(c.sync.get().channels.A).toMatchObject({ cursor: 12, moveSeq: 12 })
  expect(c.topics.get('A').main.asOfSeq).toBe(12)
  expect(c.topics.get('A').lines.every(line => line.kind !== 'message' || line.message.id !== 'id8')).toBe(true)
  await c.sync.close()
})

it('keeps deferred moveRefresh summaries when a second Move arrives before the first Move pages resolve', async () => {
  const c = topicClient(); await c.boot()
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 10, topic: summary('aux', 4, 1) }))
  await c.topics.loadSummary('A', 'aux')
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(1)

  const firstMain = deferred<Result<TimelinePage>>(), secondMain = deferred<Result<TimelinePage>>()
  c.topicsApi.listTimeline.mockReturnValueOnce(firstMain.promise).mockReturnValueOnce(secondMain.promise)
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 12, topic: summary('aux', 4, 2) }))
  c.listMessages.mockResolvedValue(ok({ history_generation: generation, as_of_seq: 12, has_more: false, messages: [] }))

  c.handlers[0].onEvent(moveEvent(11, 'id8')); await flush()
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(1)

  c.handlers[0].onEvent(moveEvent(12, 'id10')); await flush()
  secondMain.resolve(ok({ history_generation: generation, as_of_seq: 12, has_more: false, items: [] }))
  await flush(); await flush()

  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(2)
  expect(c.topicsApi.getTopicSummary).toHaveBeenLastCalledWith('A', 'aux')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'aux')).toMatchObject({ messageCount: 2 })

  firstMain.resolve(ok(page(11))); await flush()
  expect(c.topics.get('A').main.asOfSeq).toBe(12)
  await c.sync.close()
})

it('refreshes the Topic list on Move when main is held only through activity', async () => {
  const activity = createActivity({ watched: () => true })
  const c = topicClient(activity); await c.boot()
  expect(c.topicsApi.listTopics).not.toHaveBeenCalled()
  expect(c.topics.get('A').list.asOfSeq).toBeUndefined()

  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, has_more: false, items: [] }))
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, has_more: false, topics: [summary('T', 10, 4)] }))
  c.listMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, has_more: false, messages: [] }))

  c.handlers[0].onEvent(moveEvent(11, 'id8')); await flush(); await flush()

  expect(c.topicsApi.listTopics).toHaveBeenCalledTimes(1)
  expect(c.topicsApi.listTopics).toHaveBeenCalledWith('A', { history_generation: generation })
  expect(c.topics.get('A').list.asOfSeq).toBe(11)
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')).toMatchObject({ messageCount: 4 })
  await c.sync.close(); activity.close()
})

it('still refreshes held summaries on Move when a page-loader promise rejects', async () => {
  const c = topicClient(); await c.boot()
  await c.topics.loadList('A')
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 10, topic: summary('aux', 4, 1) }))
  await c.topics.loadSummary('A', 'aux')
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(1)

  const loadList = vi.spyOn(c.topics, 'loadList').mockRejectedValueOnce(new Error('list loader rejected'))
  c.topicsApi.listTimeline.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, has_more: false, items: [] }))
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, topic: summary('aux', 4, 2) }))
  c.listMessages.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 11, has_more: false, messages: [] }))

  c.handlers[0].onEvent(moveEvent(11, 'id8')); await flush(); await flush()

  expect(loadList).toHaveBeenCalledTimes(1)
  expect(loadList).toHaveBeenCalledWith('A')
  expect(c.topicsApi.getTopicSummary).toHaveBeenCalledTimes(2)
  expect(c.topicsApi.getTopicSummary).toHaveBeenLastCalledWith('A', 'aux')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'aux')).toMatchObject({ messageCount: 2 })
  await c.sync.close()
})
