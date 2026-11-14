import { evidenceClient, observeBookkeeping } from './message-window-evidence-test-helpers'
import { initialState, step, type Input } from './protocol'
import { record } from './protocol-test-helpers'
import { expect, it } from 'vitest'
import { replyClient, reply, root } from './reply-test-helpers'
import { windowClient } from './message-window-test-helpers'
import { msg, ok, summary, topicClient, deferred } from './topic-test-helpers'
import { flush } from './sync-test-helpers'
import { retentionClient } from './unread-retention-test-helpers'
import { boundTopicEvidence, EVIDENCE_LIMIT, rememberTopicMessages, topicEvidence } from './message-window'
import type { Result, TopicSummaryResponse } from './api'

it('keeps fetched Reply pages contiguous when the newest 200 same-chain records are cached', async () => {
  const c = replyClient(); await c.boot()
  for (let seq = 801; seq <= 1000; seq++) c.event(reply(seq))
  c.listReplyChain.mockImplementation(async (_channel?: unknown, _anchor?: unknown, query?: { after_seq?: number }) => {
    const after = query?.after_seq ?? 0
    return ok({ root_id: 'id1', has_more: after + 50 < 1000,
      messages: Array.from({ length: 50 }, (_, i) => after + i + 1 === 1 ? root() : reply(after + i + 1)) })
  })
  await c.replies.open('A', root())
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  await c.replies.loadMore('A')
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
  for (let page = 0; page < 4; page++) await c.replies.loadMore('A')
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 101))
  expect(c.replies.get('A').hasNewer).toBe(true)
  await c.sync.close()
})

it('Topic-list history cannot establish the main continuation or skip unfetched Messages', async () => {
  const c = windowClient(); await c.boot()
  for (let page = 0; page < 7; page++) await c.topics.loadMain('A')
  expect(c.topics.get('A').main.before).toBe(601)
  c.options.listTopics = async () => ok({ as_of_seq: 1000, has_more: false,
    topics: Array.from({ length: 50 }, (_, i) => summary(`old-${i}`, i + 1, 1)) })
  await c.topics.loadList('A')
  expect(c.topics.get('A').main.before).toBe(601)
  await c.topics.loadMain('A')
  expect(c.mainQueries.at(-1)).toEqual({ as_of_seq: 1000, before_position: 601 })
  expect(c.topics.get('A').lines.find(l => l.kind === 'message')).toMatchObject({ message: { seq: 551 } })
  await c.close()
})

it('keeps an unresolved descendant Reply visible and retryable after selecting its root and evicting the parent', async () => {
  for (const source of ['composer', 'controller'] as const) {
    const c = replyClient(); await c.boot()
    if (source === 'composer') c.event(reply(2))
    await c.replies.open('A', reply(2))
    c.sendMessage.mockResolvedValue({ ok: false, kind: 'network' })
    // The UI Composer also records the root with the pending intent.
    if (source === 'composer') {
      const composer = c.sync.getTimeline('A').reply('id1')
      composer.setDraft('unknown Reply'); await composer.submit('id2')
    } else {
      expect(c.sync.get().channels.A.messages.some(m => m.id === 'id2')).toBe(false)
      await c.replies.send('A', 'unknown Reply', 'id2')
    }
    await c.replies.open('A', root())
    c.listReplyChain.mockResolvedValue(ok({ root_id: 'id1', messages: [], has_more: false }))
    await c.replies.loadMore('A')
    for (let seq = 3; seq <= 500; seq++) c.event(reply(seq))
    expect(c.replies.get('A').messages.some(m => m.id === 'id2')).toBe(false)
    expect(c.sync.get().channels.A.pending).toHaveLength(1)
    expect(c.replies.get('A').pending).toHaveLength(1)
    expect(c.sync.getTimeline('A').get().pending[0].replyRootId).toBe('id1')
    await c.replies.retry('A', 'send1')
    expect(c.sendMessage).toHaveBeenCalledTimes(2)
    c.sync.getTimeline('A').discard('send1'); await flush()
    expect(c.replies.get('A').pending).toHaveLength(0)
    await c.sync.close()
  }
})

it('bounds interleaved Topic evidence and rejects stale counts until a safe baseline refresh', async () => {
  const evidence = topicEvidence()
  for (let seq = 1; seq <= 100_000; seq++) {
    rememberTopicMessages(evidence, [msg(seq, seq % 2 ? 'T' : 'U')]); boundTopicEvidence(evidence)
  }
  expect([...evidence.sequences.values()].reduce((n, ranges) => n + ranges.length, 0)).toBeLessThanOrEqual(EVIDENCE_LIMIT)
  expect(evidence.floor).toBeGreaterThan(0)
  const c = topicClient(); await c.boot()
  const held = deferred<Result<TopicSummaryResponse>>()
  c.topicsApi.getTopicSummary.mockReturnValue(held.promise)
  for (let seq = 11; seq <= 1010; seq++) c.event(seq, seq % 2 ? 'T' : 'U')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')?.messageCount).toBeNull()
  await flush()
  // A response older than discarded evidence cannot restore count authority.
  held.resolve(ok({ as_of_seq: 10, topic: summary('T', 10, 3) })); await flush()
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')?.messageCount).toBeNull()
  c.topicsApi.getTopicSummary.mockResolvedValue(ok({ as_of_seq: 1010, topic: summary('T', 1009, 503) }))
  await c.topics.loadSummary('A', 'T')
  c.event(11, 'T'); c.event(1009, 'T'); c.event(1011, 'T')
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')).toMatchObject({ messageCount: 504, position: 1011 })
  expect(c.sync.get().channels.A.cursor).toBe(1011)
  await c.sync.close()
})

it('bounds a long active Unread visit including stalled refreshes while preserving its first-Unread marker', async () => {
  const c = retentionClient(); await c.boot(); await c.baseline(1, 0, 1, 1)
  const visit = await c.enter()
  const held = deferred<Awaited<ReturnType<typeof c.api.listChannels>>>()
  c.setList(() => held.promise)
  for (let seq = 2; seq <= 10_000; seq++) c.feed([msg(seq)])
  expect(c.records.size).toBeLessThanOrEqual(1100)
  expect(c.unread.get('A').entry).toMatchObject({ boundary: 0, unreadAtEntry: 1, firstUnread: { seq: 1 }, needsOlder: false })
  expect(c.unread.get('A').main.unreadCount).toBeNull()
  // Presentation of a far-away row must never skip the evicted unread prefix.
  await c.present(visit, [10_000])
  expect(c.marks).toEqual([])
  c.close()
})


it('caps disjoint cursor evidence and refetches its forgotten final sequence without advancing across a gap', () => {
  let state = initialState('me')
  const feed = (input: Input) => { const result = step(state, input); state = result.state; return result.effects }
  feed({ type: 'session_start', selfId: 'me' })
  feed({ type: 'connection_ready', connection: state.connection! })
  feed({ type: 'watch', channel: 'A' })
  feed({ type: 'history_result', request: state.channels.A.latest!, page: { messages: [record(1)], has_more: false } })
  feed({ type: 'event', connection: state.connection!, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 1 } })
  for (let seq = 3; seq <= 2001; seq += 2) feed({ type: 'event', connection: state.connection!, event: { type: 'message', message: record(seq) } })
  expect(state.channels.A.advancing.length).toBeLessThanOrEqual(EVIDENCE_LIMIT)
  expect(state.channels.A.cursor).toBe(1)
  let effects = feed({ type: 'timer_elapsed', id: state.channels.A.wait! })
  while (state.channels.A.cursor! < 2000) {
    const request = effects.find(e => e.type === 'fetch_history')!
    const after = state.channels.A.cursor!, end = Math.min(2000, after + 200)
    effects = feed({ type: 'history_result', request: request.id, page: {
      messages: Array.from({ length: end - after }, (_, i) => record(after + i + 1)), has_more: true } })
  }
  expect(state.channels.A.cursor).toBe(2000)
  const final = effects.find(e => e.type === 'fetch_history')!
  expect(final).toMatchObject({ seq: 2000, page: 'after' })
  feed({ type: 'history_result', request: final.id, page: { messages: [record(2001)], has_more: false } })
  expect(state.channels.A).toMatchObject({ cursor: 2001, advancing: [], wait: undefined })
})

it('refreshes bounded Unread counts and refetches the evicted first-Unread prefix before marking it', async () => {
  const c = await evidenceClient()
  for (let seq = 3; seq <= 2402; seq++) c.append({ ...msg(seq, seq % 2 ? 'T' : 'U'),
    ...(seq % 2 ? { reply_to: 'id1', reply_root_id: 'id1' } : {}) })
  await flush(); await c.unread.refresh(); await flush()
  expect(c.unread.get('A').topics.T.unreadCount).toBe(1201)
  expect(c.unread.get('A').entry).toMatchObject({ firstUnread: { seq: 1 }, unreadAtEntry: 1, boundary: 0 })
  c.unread.presented(c.visit, [2401]); await flush()
  expect(c.reads.mark).toBe(0)
  while (c.topics.get('A').topic('T').hasMore) await c.topics.loadTopic('A', 'T')
  c.unread.presented(c.visit, [1]); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ position: 1, unreadCount: 1200 })
  expect(c.unread.get('A').entry).toMatchObject({ firstUnread: { seq: 1 }, unreadAtEntry: 1, boundary: 0 })
  await c.close()
})


it('bounds production evidence under interleaved Topic arrivals while a baseline refresh is stalled', async () => {
  const observer = observeBookkeeping(), c = topicClient()
  const held = deferred<Result<TopicSummaryResponse>>()
  try {
    await c.boot(); c.topicsApi.getTopicSummary.mockReturnValue(held.promise)
    for (let seq = 11; seq <= 2410; seq++) c.event(seq, seq % 2 ? 'T' : 'U')
    expect(observer.counts().topicRanges).toBeLessThanOrEqual(400)
    expect(c.sync.get().channels.A.cursor).toBe(2410)
  } finally { observer.stop(); await c.sync.close() }
})


it('bounds Topic identities and Unread scope bookkeeping across one-off Topics during the same visit', async () => {
  const observer = observeBookkeeping(), c = await evidenceClient()
  try {
    for (let n = 0; n < 500; n++) {
      const topic = 'oneoff-' + n
      c.append(msg(n + 3, topic)); await c.topics.loadSummary('A', topic)
    }
    await flush()
    expect(observer.counts().unreadStores.topics).toBeLessThanOrEqual(400)
    expect(observer.counts().topicEvidenceKeys).toBeLessThanOrEqual(400)
    expect(c.unread.get('A').entry).toMatchObject({ firstUnread: { seq: 1 }, boundary: 0, unreadAtEntry: 1 })
  } finally { observer.stop(); await c.close() }
})
