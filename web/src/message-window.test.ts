import { expect, it, vi } from 'vitest'
import { initialState, step, MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT, REPLY_MESSAGE_LIMIT,
  INACTIVE_CHANNEL_LIMIT, INACTIVE_CHANNEL_MESSAGE_LIMIT, SYNC_MESSAGE_LIMIT, TOTAL_MESSAGE_LIMIT,
  type Input } from './protocol'
import { record } from './protocol-test-helpers'
import { windowClient } from './message-window-test-helpers'
import { topicClient, deferred, msg, ok } from './topic-test-helpers'
import { flush } from './sync-test-helpers'
import type { MessagePage, ReplyChainPage, Result, TimelinePage } from './api'
import { countSequencesAfter, rememberSequence } from './message-window'
import { replyClient, reply, root } from './reply-test-helpers'

it('compacts consecutive Topic evidence and counts arbitrary W boundaries after reordered duplicate replay', () => {
  const ranges: Parameters<typeof rememberSequence>[0] = []
  const reference = new Set<number>()
  for (const seq of [5, 1, 4, 3, 2, 7, 6, 5, 9, 10, 8, 100, 12]) {
    rememberSequence(ranges, seq); reference.add(seq)
    for (let w = 0; w <= 101; w++) expect(countSequencesAfter(ranges, w)).toBe([...reference].filter(n => n > w).length)
  }
  expect(ranges).toEqual([{ start: 1, end: 10, total: 10 }, { start: 12, end: 12, total: 11 }, { start: 100, end: 100, total: 12 }])
})

it('bounds sync bodies during an unresolved gap and keeps evicted continuation evidence through replay reconnect and C8', () => {
  let state = initialState('me')
  const feed = (input: Input) => { const r = step(state, input); state = r.state; return r.effects }
  feed({ type: 'session_start', selfId: 'me' })
  feed({ type: 'connection_ready', connection: state.connection! })
  feed({ type: 'watch', channel: 'A' })
  feed({ type: 'history_result', request: state.channels.A.latest!, page: { messages: [record(1)], has_more: false } })
  feed({ type: 'event', connection: state.connection!, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 1 } })
  for (let seq = 3; seq <= 1200; seq++) feed({ type: 'event', connection: state.connection!, event: { type: 'message', message: record(seq) } })
  expect(state.channels.A.cursor).toBe(1)
  expect(state.channels.A.messages).toHaveLength(MAIN_MESSAGE_LIMIT)
  expect(state.channels.A.messages[0].seq).toBe(801)
  const fill = feed({ type: 'timer_elapsed', id: state.channels.A.wait! }).find(e => e.type === 'fetch_history')!
  expect(fill).toMatchObject({ page: 'after', seq: 1 })
  feed({ type: 'history_result', request: fill.id, page: { messages: [record(2)], has_more: false } })
  expect(state.channels.A.cursor).toBe(1200)
  for (const seq of [3, 1000, 1200]) feed({ type: 'event', connection: state.connection!, event: { type: 'message', message: record(seq) } })
  expect(new Set(state.channels.A.messages.map(m => m.seq)).size).toBe(state.channels.A.messages.length)
  feed({ type: 'socket_closed', connection: state.connection!, code: 1006 })
  feed({ type: 'timer_elapsed', id: state.reconnectWait! })
  const subscriptions = feed({ type: 'connection_ready', connection: state.connection! })
  expect(subscriptions).toContainEqual(expect.objectContaining({ type: 'subscribe', after_seq: 1200 }))
  feed({ type: 'event', connection: state.connection!, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 10 } })
  expect(state.channels.A).toMatchObject({ cursor: null, messages: [], advancing: [] })
})

it('enforces named caps and five inactive Channel LRU slots without discarding pending sends or cursors', () => {
  let state = initialState('me')
  const feed = (input: Input) => { state = step(state, input).state }
  feed({ type: 'session_start', selfId: 'me' })
  for (let i = 0; i < 9; i++) {
    const channel = String(i)
    feed({ type: 'watch', channel })
    feed({ type: 'history_result', request: state.channels[channel].latest!, page: {
      messages: Array.from({ length: 200 }, (_, n) => record(n + 1, channel)), has_more: false } })
    feed({ type: 'user_send', channel, body: 'pending', clientMessageId: channel })
    feed({ type: 'unwatch', channel })
  }
  expect(Object.values(state.channels).filter(c => c.messages.length)).toHaveLength(INACTIVE_CHANNEL_LIMIT)
  for (const c of Object.values(state.channels)) {
    expect(c.messages.length).toBeLessThanOrEqual(INACTIVE_CHANNEL_MESSAGE_LIMIT)
    expect(c.cursor).toBe(200); expect(c.pending).toHaveLength(1)
  }
  expect(Object.values(state.channels).reduce((n, c) => n + c.messages.length, 0)).toBeLessThanOrEqual(SYNC_MESSAGE_LIMIT)
  expect(SYNC_MESSAGE_LIMIT + MAIN_MESSAGE_LIMIT + TOPIC_MESSAGE_LIMIT + REPLY_MESSAGE_LIMIT).toBe(TOTAL_MESSAGE_LIMIT)
})

it('refetches main pages at fixed W beyond the cap in both directions during live arrivals without moving the cursor', async () => {
  const c = windowClient(); await c.boot()
  for (let i = 0; i < 12; i++) await c.topics.loadMain('A')
  const lines = c.topics.get('A').lines
  expect(lines).toHaveLength(MAIN_MESSAGE_LIMIT)
  expect(lines[0]).toMatchObject({ message: { seq: 351 } })
  expect(c.topics.get('A').main).toMatchObject({ before: 351, hasNewer: true })
  c.records.push(record(1001)); c.event(record(1001))
  expect(c.topics.get('A').lines).toEqual(lines)
  expect(c.sync.get().channels.A.cursor).toBe(1001)
  await c.topics.loadMain('A')
  expect(c.mainQueries.at(-1)).toEqual({ as_of_seq: 1000, before_position: 351 })
  expect(c.topics.get('A').lines[0]).toMatchObject({ message: { seq: 301 } })
  await c.topics.loadMainLatest('A')
  expect(c.mainQueries.at(-1)).toEqual({})
  expect(c.topics.get('A').main.asOfSeq).toBe(1001)
  expect(c.topics.get('A').lines.at(-1)).toMatchObject({ message: { seq: 1001 } })
  expect(c.sync.get().channels.A.cursor).toBe(1001)
  await c.close()
})

it('bounds Topic and Reply stores with independent continuations and releases inactive Topic history', async () => {
  const c = windowClient(); await c.boot()
  for (let i = 0; i < 9; i++) await c.topics.loadTopic('A', 'T')
  expect(c.topics.get('A').topic('T').messages).toHaveLength(TOPIC_MESSAGE_LIMIT)
  expect(c.topics.get('A').topic('T').hasNewer).toBe(true)
  expect(c.topicQueries.at(-1)).toEqual({ before_seq: 601 })
  await c.topics.loadTopicLatest('A', 'T')
  expect(c.topics.get('A').topic('T').messages.at(-1)?.seq).toBe(1000)
  await c.topics.loadTopic('A', 'U')
  expect(c.topics.get('A').topic('T').initialized).toBe(false)
  await c.replies.open('A', record(1))
  for (let i = 0; i < 7; i++) await c.replies.loadMore('A')
  expect(c.replies.get('A').messages).toHaveLength(REPLY_MESSAGE_LIMIT)
  expect(c.replies.get('A').hasOlder).toBe(true)
  expect(c.replyQueries.at(-1)).toBe(350)
  await c.replies.loadOlder('A')
  expect(c.replyQueries.at(-1)).toBe(0)
  expect(c.replies.get('A').messages[0].seq).toBe(1)
  expect(c.sync.get().channels.A.cursor).toBe(1000)
  await c.close()
})

it('preserves Topic counts and latest activity after body eviction and duplicate replay with old W pages', async () => {
  const c = topicClient(); await c.boot()
  for (let n = 11; n <= 1010; n++) c.event(n, 'T')
  expect(c.sync.get().channels.A.messages).toHaveLength(MAIN_MESSAGE_LIMIT)
  expect(c.topics.get('A').lines.find(l => l.kind === 'topic')).toMatchObject({ position: 1010, messageCount: 1003 })
  c.event(11, 'T'); c.event(800, 'T'); await c.topics.loadMain('A')
  expect(c.topics.get('A').lines.find(l => l.kind === 'topic')).toMatchObject({ position: 1010, messageCount: 1003 })
  await c.sync.close()
})

it('keeps the unpinned window through trimming and fences late Topic responses after release and reselection', async () => {
  const c = windowClient(); await c.boot()
  for (let i = 0; i < 7; i++) await c.topics.loadMain('A')
  const lines = c.topics.get('A').lines
  c.topics.setMainPinned('A', false)
  for (let i = 1001; i <= 1500; i++) c.event(record(i))
  expect(c.topics.get('A').lines).toEqual(lines)
  expect(c.topics.get('A').main.newerCount).toBe(500)
  const held = deferred<ReturnType<typeof ok<MessagePage>>>()
  c.options.listTopicMessages = () => held.promise
  const first = c.topics.loadTopic('A', 'T'); await flush()
  c.topics.releaseTopic('A', 'T')
  const second = c.topics.loadTopic('A', 'T'); await flush()
  held.resolve(ok({ messages: [msg(2, 'T')], has_more: false })); await Promise.all([first, second])
  expect(c.topics.get('A').topic('T').messages.map(m => m.seq)).toEqual([2])
  await c.close()
})

it.each([403, 404, 401] as const)('retired refetch after eviction fences late %s data authority and preserves same-session 401 meaning', async status => {
  const c = windowClient(); await c.boot()
  for (let i = 0; i < 10; i++) await c.topics.loadMain('A')
  const original = c.options.listTimeline, held = deferred<Result<TimelinePage>>()
  c.options.listTimeline = () => held.promise
  const old = c.topics.loadMain('A'); await flush()
  c.options.listTimeline = original
  await c.topics.loadMainLatest('A')
  held.resolve({ ok: false, kind: 'http', status, error: 'channel_not_found' }); await old; await flush()
  // Projection 401 closes this controller; the Account owner callback owns the Sign-in UI.
  expect(c.sync.get().running).toBe(status !== 401)
  if (status !== 401) expect(c.topics.get('A').unavailable).toBe(false)
  await c.close()
})

it.each(['refusal', 'channel', 'organization', 'session', 'replacement'] as const)('trimmed histories keep %s loss terminal and fence outstanding refetches', async loss => {
  const c = windowClient(); await c.boot()
  for (let i = 1001; i <= 1500; i++) c.event(record(i))
  const held = deferred<Result<MessagePage>>()
  c.options.listTopicMessages = () => held.promise
  const pending = c.topics.loadTopic('A', 'T'); await flush()
  if (loss === 'channel') c.loseAccess()
  if (loss === 'refusal') {
    await c.sync.unwatch('A'); await c.sync.watch('A')
    c.refuse()
  }
  if (loss === 'organization') c.end(4003)
  if (loss === 'session') c.end(4001)
  if (loss === 'replacement') await c.sync.replaceSession('other-account')
  const before = c.sync.get()
  held.resolve(loss === 'replacement' ? { ok: false, kind: 'http', status: 401, error: 'ended' } :
    ok({ messages: [msg(2, 'T')], has_more: false }))
  await pending; await flush()
  expect(c.sync.get()).toBe(before)
  if (loss === 'refusal' || loss === 'channel') expect(c.sync.get().channels.A.state).toBe('unavailable')
  if (loss === 'organization') expect(c.sync.get().organization).toBe('unavailable')
  await c.close()
})

it('delivers gap-fill records to projections even when the display evicts the entire returned page', async () => {
  vi.useFakeTimers()
  const c = topicClient(); await c.boot()
  c.listMessages.mockResolvedValue(ok({ messages: Array.from({ length: 200 }, (_, i) => msg(11 + i, 'T')), has_more: true }))
  for (let seq = 211; seq <= 1200; seq++) c.event(seq, 'T')
  await vi.advanceTimersByTimeAsync(100)
  await flush()
  expect(c.sync.get().channels.A.cursor).toBe(1200)
  expect(c.sync.get().channels.A.messages[0].seq).toBeGreaterThan(210)
  expect(c.topics.get('A').lines.find(l => l.kind === 'topic')).toMatchObject({ messageCount: 1193, position: 1200 })
  await c.sync.close()
  vi.useRealTimers()
})

it('shares projection body budgets across watched Channels and keeps only one active Topic history', async () => {
  const c = windowClient(); await c.boot()
  for (let i = 0; i < 7; i++) await c.topics.loadMain('A')
  expect(c.topics.get('A').lines).toHaveLength(400)
  await c.sync.watch('B')
  expect(c.topics.get('A').main.asOfSeq).toBeUndefined()
  expect(c.topics.get('B').lines).toHaveLength(50)
  for (let i = 0; i < 6; i++) await c.topics.loadTopic('A', 'T')
  expect(c.topics.get('A').topic('T').messages).toHaveLength(300)
  await c.topics.loadTopic('B', 'U')
  expect(c.topics.get('A').topic('T').initialized).toBe(false)
  expect(c.topics.get('B').topic('U').messages).toHaveLength(50)
  await c.close()
})

it('an unpinned Reply window holds its anchor while duplicate arrivals remain refetchable', async () => {
  const c = windowClient(300); await c.boot()
  await c.replies.open('A', record(1))
  for (let i = 0; i < 5; i++) await c.replies.loadMore('A')
  const before = c.replies.get('A').messages
  c.replies.setPinned('A', false)
  for (let seq = 301; seq <= 500; seq++) {
    const m = { ...record(seq), reply_to: 'id1', reply_root_id: 'id1' }
    c.records.push(m); c.event(m); c.event(m)
  }
  expect(c.replies.get('A').messages).toEqual(before)
  expect(c.replies.get('A').newerCount).toBe(200)
  await c.replies.loadLatest('A')
  expect(c.replies.get('A')).toMatchObject({ hasNewer: false, newerCount: 0 })
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 301))
  await c.close()
})

it('reanchors W before refetching evicted live history without dropping the visible anchor or advancing sync', async () => {
  const c = windowClient(); await c.boot()
  for (let seq = 1001; seq <= 2000; seq++) { const m = record(seq); c.records.push(m); c.event(m) }
  expect(c.topics.get('A').lines[0]).toMatchObject({ message: { seq: 1601 } })
  await c.topics.loadMain('A')
  expect(c.mainQueries.slice(-2)).toEqual([{}, { as_of_seq: 2000, before_position: 1601 }])
  expect(c.topics.get('A').lines[0]).toMatchObject({ message: { seq: 1551 } })
  expect(c.topics.get('A').lines.some(l => l.kind === 'message' && l.message.seq === 1601)).toBe(true)
  expect(c.sync.get().channels.A.cursor).toBe(2000)
  await c.close()
})

it('retains Topic positions after evicting their latest body and refetches the excerpt through the existing summary endpoint', async () => {
  const c = topicClient(); await c.boot()
  c.event(11, 'T')
  for (let seq = 12; seq <= 1000; seq++) c.event(seq)
  expect(c.topics.get('A').lines.some(l => l.kind === 'topic')).toBe(false)
  await c.topics.loadMain('A')
  expect(c.topics.get('A').lines.find(l => l.kind === 'topic')).toMatchObject({ position: 11, messageCount: 4, latestMessage: { seq: 10 } })
  c.topicsApi.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.topics.loadSummary('A', 'T')
  expect(c.topics.get('A').lines.find(l => l.kind === 'topic')).toMatchObject({ summaryError: 'retryable' })
  c.topicsApi.getTopicSummary.mockResolvedValueOnce(ok({ as_of_seq: 1000,
    topic: { id: 'T', name: 'Topic T', first_seq: 1, last_seq: 11, message_count: 4, latest_message: msg(11, 'T'), read_seq: 0, unread_count: 0 } }))
  await c.topics.retrySummary('A', 'T')
  expect(c.topics.get('A').lines.find(l => l.kind === 'topic')).toMatchObject({ position: 11, messageCount: 4, latestMessage: { seq: 11 } })
  expect(c.sync.get().channels.A.cursor).toBe(1000)
  await c.sync.close()
})

it('Reply history failure keeps its bounded window and a superseded restart cannot deny the Channel', async () => {
  const c = replyClient(); await c.boot()
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', has_more: true,
    messages: [root(), ...Array.from({ length: 199 }, (_, n) => reply(n + 2))] }))
  await c.replies.open('A', root())
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', has_more: false,
    messages: Array.from({ length: 50 }, (_, n) => reply(n + 201)) }))
  await c.replies.loadMore('A')
  const before = c.replies.get('A').messages
  c.listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.replies.loadOlder('A')
  expect(c.replies.get('A').messages).toEqual(before)
  const held = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(held.promise)
  const first = c.replies.loadOlder('A'); await flush()
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', has_more: true,
    messages: [root(), ...Array.from({ length: 49 }, (_, n) => reply(n + 2))] }))
  await c.replies.loadOlder('A')
  held.resolve({ ok: false, kind: 'http', status: 403, error: 'denied' }); await first
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(Array.from({ length: 50 }, (_, n) => n + 1))
  expect(c.sync.get().channels.A.state).toBe('ready')
  await c.sync.close()
})
