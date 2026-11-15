import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChannelList, Result } from './api'
import type { RealtimeHandlers } from './realtime'
import { createSession } from './session'
import { deferred, flush, ok, row, summary } from './unread-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function client() {
  let socket!: RealtimeHandlers
  let count = 0, position = 0, watermark = 3
  const listChannels = vi.fn(async (): Promise<Result<ChannelList>> => ok({ channels: [row(), row({ id: 'B', name: 'B', as_of_seq: watermark, read_seq: position,
    unread_count: count, main_unread_count: count, mention_unread_count: count, main_mention_unread_count: count })] }))
  const session = createSession({ selfId: 'me', onEnded() {},
    unreadApi: { listChannels, getTopicSummary: async () => ok({ as_of_seq: 3, topic: summary() }), markRead: async (_scope, body) => ok(body) },
    topicsApi: { getTopicSummary: async () => ok({ as_of_seq: 3, topic: summary() }),
      listTimeline: async () => ok({ as_of_seq: 3, has_more: false, items: [] }),
      listTopics: async () => ok({ as_of_seq: 3, has_more: false, topics: [] }),
      listTopicMessages: async () => ok({ messages: [], has_more: false }),
    },
    sync: { random: () => 0.5, connect(h) { socket = h; return { send() {}, close() {} } },
      api: { listMessages: async () => ok({ messages: [], has_more: false }), sendMessage: async () => ({ ok: false, kind: 'network' }) },
    },
  })
  return { session, listChannels, get socket() { return socket },
    committed(n: number, read = 0, w = 4) { count = n; position = read; watermark = w },
    async boot() { socket.onReady(); await flush(); socket.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3 }); await flush() },
  }
}
it('Mention notices only refetch both fields coalesce duplicates and keep Topic coverage independent from aggregate', async () => {
  const c = client(); await c.boot()
  expect(c.session.unread.get('B').mentionUnreadCount).toBe(0)
  const calls = c.listChannels.mock.calls.length
  c.committed(1)
  for (let n = 0; n < 3; n++) c.socket.onEvent({ type: 'channel_activity', channel_id: 'B', seq: 4 })
  expect(c.session.unread.get('B')).toMatchObject({ unreadCount: 0, mentionUnreadCount: 0 })
  await vi.advanceTimersByTimeAsync(200)
  expect(c.listChannels).toHaveBeenCalledTimes(calls + 1)
  expect(c.session.unread.get('B')).toMatchObject({ unreadCount: 1, mentionUnreadCount: 1 })
  c.committed(0, 4)
  c.socket.onEvent({ type: 'read_position_changed', channel_id: 'B', topic_id: null, read_seq: 4 })
  expect(c.session.unread.get('B').mentionUnreadCount).toBe(1)
  await vi.advanceTimersByTimeAsync(200)
  expect(c.session.unread.get('B')).toMatchObject({ unreadCount: 0, mentionUnreadCount: 0 })
  const before = c.listChannels.mock.calls.length
  c.socket.onEvent({ type: 'read_position_changed', channel_id: 'B', topic_id: 'T', read_seq: 4 })
  await vi.advanceTimersByTimeAsync(200)
  expect(c.listChannels).toHaveBeenCalledTimes(before + 1)
  c.session.close(); expect(vi.getTimerCount()).toBe(0)
})
it('Mention lost notices and uncertain commits converge through the existing periodic schedule without another mutation', async () => {
  const c = client(); await c.boot()
  c.socket.onEvent({ type: 'activity_ready' }); await vi.advanceTimersByTimeAsync(200)
  c.committed(2, 0, 5)
  expect(c.session.unread.get('B').mentionUnreadCount).toBe(0)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(c.session.unread.get('B')).toMatchObject({ unreadCount: 2, mentionUnreadCount: 2 })
  c.committed(0, 5, 5)
  await vi.advanceTimersByTimeAsync(31_000)
  expect(c.session.unread.get('B')).toMatchObject({ main: { position: 5 }, unreadCount: 0, mentionUnreadCount: 0 })
  c.session.close(); expect(vi.getTimerCount()).toBe(0)
})
it('Mention unwatched access loss removes both badges immediately and old list work cannot restore the regrant generation', async () => {
  const c = client(); await c.boot(); c.committed(2)
  await c.session.channels.load()
  expect(c.session.unread.get('B').mentionUnreadCount).toBe(2)
  const late = deferred<Result<ChannelList>>()
  c.listChannels.mockReturnValueOnce(late.promise)
  const pending = c.session.channels.load(); await flush()
  c.socket.onEvent({ type: 'channel_access_revoked', channel_id: 'B' })
  expect(c.session.unread.get('B')).toMatchObject({ unreadCount: null, mentionUnreadCount: null })
  c.socket.onEvent({ type: 'channel_access_gained', channel_id: 'B' }); c.committed(0, 10, 10)
  late.resolve(ok({ channels: [row(), row({ id: 'B', as_of_seq: 20, unread_count: 20, mention_unread_count: 20 })] })); await pending
  expect(c.session.unread.get('B').mentionUnreadCount).toBeNull()
  await vi.advanceTimersByTimeAsync(200)
  expect(c.session.unread.get('B')).toMatchObject({ asOfSeq: 10, unreadCount: 0, mentionUnreadCount: 0 })
  c.session.close()
})
it('Mention activity coverage never accepts an Unread-only response or suppresses its retry', async () => {
  const c = client(); await c.boot()
  c.committed(2)
  const incomplete = row({ id: 'B', as_of_seq: 50, read_seq: 50, unread_count: 0, main_unread_count: 0 })
  Reflect.deleteProperty(incomplete, 'mention_unread_count')
  c.listChannels.mockResolvedValueOnce(ok({ channels: [row(), incomplete] }))
  c.socket.onEvent({ type: 'channel_activity', channel_id: 'B', seq: 4 }); await vi.advanceTimersByTimeAsync(200)
  expect(c.session.unread.get('B')).toMatchObject({ asOfSeq: 3, mentionUnreadCount: 0 })
  const calls = c.listChannels.mock.calls.length
  c.socket.onEvent({ type: 'read_position_changed', channel_id: 'B', topic_id: null, read_seq: 50 })
  expect(c.session.unread.get('B').mentionUnreadCount).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.listChannels.mock.calls.length).toBeGreaterThan(calls)
  expect(c.session.unread.get('B')).toMatchObject({ asOfSeq: 4, unreadCount: 2, mentionUnreadCount: 2 })
  c.session.close()
})
