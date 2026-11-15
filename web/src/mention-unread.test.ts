import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChannelList, Message, Result, TopicSummaryResponse } from './api'
import { chooseBaseline, chooseChannelBaseline, scopeCount } from './unread-counts'
import { deferred, flush, msg, ok, row, summary, unreadClient } from './unread-test-helpers'
import { retentionClient } from './unread-retention-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const mentioned = (seq: number, topic: string | null = null, sender = 'other', channel = 'A'): Message => ({
  ...msg(seq, topic, sender, channel), body: '@{member:me} @{member:me}', mentions: [{ member_id: 'me', name: 'Reader' }],
})
function client() {
  const c = unreadClient()
  c.history.splice(0, 3, mentioned(1), mentioned(2, 'T'), mentioned(3, 'U'))
  c.rows[0] = row({ main_mention_unread_count: 1, mention_unread_count: 3 })
  for (const [id, seq] of [['T', 2], ['U', 3]] as const) c.summaries.set(id, { ...summary(id, seq), mention_unread_count: 1, latest_message: mentioned(seq, id) })
  return c
}
it.each(['before', 'after'])('Mention REST/event overlap %s the baseline deduplicates replay ACK and history', async order => {
  const c = client(); await c.boot()
  const event = mentioned(4)
  const baseline = row({ as_of_seq: 4, main_unread_count: 2, unread_count: 4, main_mention_unread_count: 2, mention_unread_count: 4 })
  if (order === 'before') c.event(event)
  c.rows[0] = baseline; await c.unread.refresh()
  if (order === 'after') c.event(event)
  c.event(event); await c.sync.settleHistory('A', [event]); c.event(mentioned(5, null, 'me'))
  c.event({ ...mentioned(6), mentions: [] }); await flush()
  expect(c.unread.get('A')).toMatchObject({ mentionUnreadCount: 4, main: { position: 0, unreadCount: 3, mentionUnreadCount: 2 } })
  c.event(mentioned(7)); c.event(mentioned(7)); await flush()
  expect(c.unread.get('A').mentionUnreadCount).toBe(5)
  await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})
it('Mention suffix requires both watermark and position and deduplicates only within its Channel', () => {
  const base = { asOfSeq: 3, readSeq: 3, count: 0, mentionCount: 0 }
  const records = [mentioned(3), mentioned(4), mentioned(4), mentioned(5), mentioned(6, 'T'), mentioned(7, null, 'me'), mentioned(8, null, 'other', 'B'), { ...mentioned(9), mentions: [] }]
  expect(scopeCount(base, 4, records, { channel: 'A', topicId: null }, 'me', true)).toBe(1)
  expect(scopeCount(base, 0, records, { channel: 'A', topicId: null }, 'me', true)).toBe(2)
  expect(scopeCount(base, 0, records, { channel: 'B', topicId: null }, 'me', true)).toBe(1)
})
it('Mention baselines select W then position and minimize every equal-baseline count independently', () => {
  const old = row({ as_of_seq: 10, read_seq: 3, unread_count: 10, main_unread_count: 4, mention_unread_count: 7, main_mention_unread_count: 3 })
  expect(chooseChannelBaseline(old, { ...old, as_of_seq: 9, read_seq: 8, mention_unread_count: 1 })).toBe(old)
  expect(chooseChannelBaseline(old, { ...old, read_seq: 2, mention_unread_count: 1 })).toBe(old)
  expect(chooseChannelBaseline(old, { ...old, unread_count: 9, main_unread_count: 5, mention_unread_count: 8, main_mention_unread_count: 2 }))
    .toMatchObject({ unread_count: 9, main_unread_count: 4, mention_unread_count: 7, main_mention_unread_count: 2 })
  expect(chooseChannelBaseline(old, { ...old, unread_count: 11, main_unread_count: 3, mention_unread_count: 6, main_mention_unread_count: 4 }))
    .toMatchObject({ unread_count: 10, main_unread_count: 3, mention_unread_count: 6, main_mention_unread_count: 3 })
  const b = { asOfSeq: 10, readSeq: 3, count: 4, mentionCount: 3 }
  expect(chooseBaseline(b, { ...b, count: 5, mentionCount: 2 })).toEqual({ ...b, mentionCount: 2 })
  expect(chooseBaseline(b, { ...b, count: 2, mentionCount: 4 })).toEqual({ ...b, count: 2 })
  expect(chooseBaseline(b, { ...b, asOfSeq: 9, mentionCount: 0 })).toBe(b)
  expect(chooseBaseline(b, { ...b, readSeq: 2, mentionCount: 0 })).toBe(b)
})
it('Mention production refresh retains the live suffix after stale and equal baselines in either order', async () => {
  for (const reverse of [false, true]) {
    const c = client(); await c.boot(); c.event(mentioned(8))
    const fresh = row({ as_of_seq: 7, read_seq: 1, unread_count: 6, main_unread_count: 4, mention_unread_count: 4, main_mention_unread_count: 2 })
    const stale = { ...fresh, as_of_seq: 6, mention_unread_count: 5, main_mention_unread_count: 3 }
    for (const r of reverse ? [fresh, stale] : [stale, fresh]) { c.rows[0] = r; await c.unread.refresh() }
    c.rows[0] = { ...fresh, unread_count: 5, main_unread_count: 3, mention_unread_count: 5, main_mention_unread_count: 1 }; await c.unread.refresh()
    expect(c.unread.get('A')).toMatchObject({ mentionUnreadCount: 5, main: { mentionUnreadCount: 2 } })
    // Aggregate and main minima are independent; the live suffix is reapplied to each selected scope.
    await c.sync.close()
  }
})
it('Mention Topic marks preserve independent positions and refetch the aggregate after confirmation', async () => {
  const c = client(); await c.boot()
  const aggregate = deferred<Result<ChannelList>>()
  c.unreadApi.listChannels.mockReturnValueOnce(aggregate.promise)
  await c.present([2], 'T')
  expect(c.unread.get('A')).toMatchObject({ mentionUnreadCount: 3, main: { position: 0, mentionUnreadCount: 1 }, topics: { T: { position: 2, mentionUnreadCount: 0 }, U: { position: 0, mentionUnreadCount: 1 } } })
  aggregate.resolve(ok({ channels: [row({ mention_unread_count: 2, main_mention_unread_count: 1, unread_count: 2 })] })); await flush()
  expect(c.unread.get('A').mentionUnreadCount).toBe(2)
  await c.present([1])
  expect(c.unread.get('A')).toMatchObject({ main: { position: 1, mentionUnreadCount: 0 }, topics: { T: { position: 2, mentionUnreadCount: 0 }, U: { position: 0, mentionUnreadCount: 1 } } })
  await c.sync.close()
})
it('Mention reconnect refetches another device positions by max and rejects old replay', async () => {
  const c = client(); await c.boot(); c.event(mentioned(4))
  c.rows[0] = row({ as_of_seq: 4, read_seq: 4, unread_count: 0, main_unread_count: 0 })
  for (const id of ['T', 'U']) c.summaries.set(id, { ...summary(id, 4, 4, 0), mention_unread_count: 0 })
  c.handlers[0].onClose(1006); await vi.advanceTimersByTimeAsync(250); c.handlers.at(-1)!.onReady(); await flush()
  c.event(mentioned(4)); c.event(mentioned(2, 'T')); await flush()
  expect(c.unread.get('A')).toMatchObject({ mentionUnreadCount: 0, main: { position: 4, mentionUnreadCount: 0 }, topics: { T: { position: 4, mentionUnreadCount: 0 } } })
  await c.sync.close()
})
it.each(['regrant', 'Session', 'Organization'])('Mention late REST and frames cannot restore counts after %s fencing', async boundary => {
  const c = client(); await c.boot()
  const late = deferred<Result<ChannelList>>()
  c.unreadApi.listChannels.mockReturnValueOnce(late.promise)
  const pending = c.unread.refresh(); await flush()
  const old = c.unread.get('A').generation
  if (boundary === 'regrant') {
    await c.sync.channelUnavailable('A'); c.unread.activityRevoke('A')
    expect(c.unread.get('A').mentionUnreadCount).toBeNull()
    c.unread.activityAccess('A'); c.unread.activitySnapshot([row({ as_of_seq: 9, read_seq: 9, main_unread_count: 0, unread_count: 0 })])
    expect(c.unread.get('A').generation).not.toBe(old)
  } else if (boundary === 'Session') await c.sync.replaceSession('new-reader')
  else await c.sync.unavailable()
  late.resolve(ok({ channels: [row({ as_of_seq: 100, mention_unread_count: 99, main_mention_unread_count: 99 })] })); await pending
  c.handlers[0].onEvent({ type: 'message', message: mentioned(101) }); await flush()
  expect(c.unread.get('A').mentionUnreadCount).toBe(boundary === 'regrant' ? 0 : null)
  await c.sync.close()
})
it.each(['mention_unread_count', 'main_mention_unread_count'] as const)('Mention coverage rejects an Unread-only Channel response missing %s', async field => {
  const c = client(); await c.boot()
  const incomplete = { ...row({ as_of_seq: 50 }) }; Reflect.deleteProperty(incomplete, field)
  c.unreadApi.listChannels.mockResolvedValueOnce(ok({ channels: [incomplete] }))
  await c.unread.refresh()
  expect(c.unread.get('A')).toMatchObject({ asOfSeq: 3, mentionUnreadCount: null, error: true })
  const calls = c.unreadApi.listChannels.mock.calls.length
  await vi.advanceTimersByTimeAsync(500)
  expect(c.unreadApi.listChannels).toHaveBeenCalledTimes(calls + 1)
  expect(c.unread.get('A').mentionUnreadCount).toBe(3)
  await c.sync.close()
})
it('Mention coverage rejects an Unread-only Topic response and recovers both fields', async () => {
  const c = client(); await c.boot()
  const t = { ...summary('T', 5, 5, 0) }; Reflect.deleteProperty(t, 'mention_unread_count')
  c.unreadApi.getTopicSummary.mockResolvedValueOnce(ok({ as_of_seq: 5, topic: t }))
  c.handlers[0].onClose(1006); await vi.advanceTimersByTimeAsync(250); c.handlers.at(-1)!.onReady(); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ mentionUnreadCount: null, error: true })
  await vi.advanceTimersByTimeAsync(500)
  expect(c.unread.get('A').topics.T.mentionUnreadCount).toBe(1)
  await c.sync.close()
})
it('Mention eviction stays unresolved until sufficient baselines and retains no names or bodies', async () => {
  const c = retentionClient(); await c.boot([mentioned(1)])
  const pending = deferred<Result<ChannelList>>()
  c.setList(() => pending.promise)
  c.api.getTopicSummary = () => new Promise<Result<TopicSummaryResponse>>(() => {})
  for (let seq = 2; seq <= 1400; seq++) c.feed([mentioned(seq)])
  await flush()
  expect(c.records.size).toBeLessThanOrEqual(1100)
  expect(c.unread.get('A').mentionUnreadCount).toBeNull()
  for (const record of c.records.values()) expect(record.mentions).toEqual([{ member_id: 'me' }])
  pending.resolve(ok({ channels: [row({ as_of_seq: 1400, main_unread_count: 1400, unread_count: 1400, main_mention_unread_count: 1400, mention_unread_count: 1400 })] })); await flush()
  expect(c.unread.get('A').mentionUnreadCount).toBe(1400)
  c.close(); expect(vi.getTimerCount()).toBe(0)
})

it('Mention Topic projection minima are independent of Unread and never rise on an equal stale response', async () => {
  const c = client(); await c.boot()
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 3, has_more: true, topics: [{ ...summary('T', 2, 0, 3), mention_unread_count: 0 }] }))
  await c.topics.loadList('A'); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ unreadCount: 1, mentionUnreadCount: 0 })
  c.topicsApi.listTopics.mockResolvedValueOnce(ok({ as_of_seq: 3, has_more: false, topics: [{ ...summary('T', 2, 0, 0), mention_unread_count: 1 }] }))
  await c.topics.loadList('A'); await flush()
  expect(c.unread.get('A').topics.T).toMatchObject({ unreadCount: 0, mentionUnreadCount: 0 })
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')?.baseline?.summary.mention_unread_count).toBe(0)
  await c.sync.close()
})

it('Mention own ACK echo and history settlement never increment counts or move read positions', async () => {
  const ack = mentioned(4, null, 'me')
  const c = unreadClient(async (_channel, body) => { ack.client_message_id = body.client_message_id; return ok(ack) })
  c.rows[0] = row({ main_mention_unread_count: 1, mention_unread_count: 1 })
  await c.boot()
  const composer = c.sync.getTimeline('A')
  composer.setDraft(ack.body); await composer.submit(); await flush()
  c.event(ack); await c.sync.settleHistory('A', [ack]); c.event(ack); await flush()
  expect(c.sync.get().channels.A.pending).toHaveLength(0)
  expect(c.unread.get('A')).toMatchObject({ mentionUnreadCount: 1, main: { position: 0, mentionUnreadCount: 1 } })
  expect(c.unreadApi.markRead).not.toHaveBeenCalled()
  await c.sync.close()
})

it('Mention access generation rejects a previous generation REST response while the new baseline stays visible', async () => {
  const c = client(); await c.boot()
  const late = deferred<Result<ChannelList>>()
  c.unreadApi.listChannels.mockReturnValueOnce(late.promise)
  const pending = c.unread.refresh(); await flush()
  c.unread.activityAccess('A')
  c.unread.activitySnapshot([row({ as_of_seq: 9, read_seq: 9, unread_count: 0, main_unread_count: 0 })])
  expect(c.unread.get('A').mentionUnreadCount).toBe(0)
  late.resolve(ok({ channels: [row({ as_of_seq: 20, mention_unread_count: 20, main_mention_unread_count: 20 })] })); await pending
  expect(c.unread.get('A')).toMatchObject({ asOfSeq: 9, mentionUnreadCount: 0 })
  await c.sync.close()
})
