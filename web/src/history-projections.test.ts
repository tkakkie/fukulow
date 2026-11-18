import { expect, it } from 'vitest'
import { deferred, replyPage, msg, ok, page, summary, topicClient } from './topic-test-helpers'
import { reply, replyClient, root } from './reply-test-helpers'
import { moveEvent } from './protocol-test-helpers'
import { flush } from './sync-test-helpers'
import type { ReplyChainPage, Result, TimelinePage } from './api'
const generation = '00000000-0000-4000-8000-000000000515'
const expired = { ok: false as const, kind: 'http' as const, status: 409, error: 'snapshot_expired' }

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
