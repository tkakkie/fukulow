import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSession } from './session'
import type { Dm, Message, ReadPosition, Result, TimelinePage } from './api'
import type { RealtimeHandlers } from './realtime'
import { dm } from './dm-test-helpers'
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function client() {
  const first: Message = { id: 'first', channel_id: 'D', client_message_id: 'first-key', seq: 1, sender: 'peer', body: 'First before selection', topic_id: null, reply_to: null, reply_root_id: null, created_at: '2026-11-14T00:00:00Z' }
  let rows: Dm[] = [dm('D', { as_of_seq: 1, read_seq: 0, main_unread_count: 1, unread_count: 1 })]
  let socket!: RealtimeHandlers
  const listMessages = vi.fn(async () => ok({ messages: [first], has_more: false }))
  const listTimeline = vi.fn(async (): Promise<Result<TimelinePage>> => ok({ as_of_seq: 1, items: [{ kind: 'message', message: first }], has_more: false }))
  const markRead = vi.fn(async (_scope, body) => ok(body))
  const listChannels = vi.fn(async () => ok({ channels: [] }))
  const onEnded = vi.fn(), open = vi.fn(async (): Promise<Result<Dm>> => ok(rows[0]!))
  const session = createSession({ selfId: 'me', organizationId: 'org', onEnded,
    channelsApi: { listChannels, createChannel: async () => ({ ok: false, kind: 'network' }) },
    dmsApi: {
      changes: async ({ lane }) => ok({ dms: rows.map(({ id, kind, peer }) => ({ id, kind, peer })), next_cursor: lane, caught_up: true }),
      list: async q => ok({ dms: q.channel_id ? rows.filter(row => q.channel_id!.includes(row.id)) : rows, next_cursor: null }),
      open,
    },
    topicsApi: { listTimeline, listTopics: async () => ({ ok: false, kind: 'network' }), getTopicSummary: async () => ({ ok: false, kind: 'network' }), listTopicMessages: async () => ({ ok: false, kind: 'network' }) },
    unreadApi: { listChannels, markRead, getTopicSummary: async () => ({ ok: false, kind: 'network' }) },
    sync: { connect(h) { socket = h; return { send() {}, close() {} } }, api: { listMessages, sendMessage: async () => ({ ok: false, kind: 'network' }) }, random: () => 0.5 },
  })
  return { session, listMessages, listTimeline, markRead, first, onEnded, open,
    set rows(value: Dm[]) { rows = value }, get socket() { return socket },
    async ready() { socket.onReady(); socket.onEvent({ type: 'activity_ready' }); await vi.advanceTimersByTimeAsync(1000) },
  }
}

it('DM discovery neither watches nor marks read and selection bootstraps the first Message through common sync', async () => {
  const c = client(); await c.ready()
  expect(c.session.sync.get().channels.D).toBeUndefined()
  expect(c.session.unread.get('D').unreadCount).toBe(1)
  expect(c.listMessages).not.toHaveBeenCalled(); expect(c.markRead).not.toHaveBeenCalled()
  c.session.dms.select('D'); await flush()
  expect(c.listMessages).toHaveBeenCalledOnce(); expect(c.listTimeline).not.toHaveBeenCalled()
  c.socket.onEvent({ type: 'subscribed', channel_id: 'D', caught_up_seq: 1 }); await flush()
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.session.sync.get().channels.D.messages).toEqual([c.first])
  expect(c.session.sync.get().channels.D.cursor).toBe(1)
  expect(c.markRead).not.toHaveBeenCalled()
  c.session.unread.visibility(true)
  const visit = await c.session.unread.enter({ channel: 'D', topicId: null })
  c.session.unread.presented(visit!, [1]); await flush()
  expect(c.markRead).toHaveBeenCalledWith({ channel: 'D', topicId: null }, { read_seq: 1 })
  c.session.close()
})

it('unknown-kind direct links reload common DM history after discovery and keep older Messages pageable', async () => {
  const c = client(); c.rows = []
  const messages = [1, 2, 3].map(seq => ({ ...c.first, id: String(seq), seq }))
  c.listTimeline.mockResolvedValue(ok({ as_of_seq: 3, items: messages.slice(1).map(message => ({ kind: 'message' as const, message })), has_more: true }))
  c.listMessages.mockResolvedValueOnce(ok({ messages: messages.slice(1), has_more: true }))
    .mockResolvedValueOnce(ok({ messages: messages.slice(0, 1), has_more: false }))
  c.socket.onReady(); c.session.channels.selectHint('D'); await flush()
  expect(c.listTimeline).toHaveBeenCalledOnce()
  expect(c.session.sync.get().channels.D.messages.map(m => m.seq)).toEqual([3])
  c.socket.onEvent({ type: 'subscribed', channel_id: 'D', caught_up_seq: 3 }); await flush()
  c.rows = [dm('D', { as_of_seq: 3 })]
  c.socket.onEvent({ type: 'activity_ready' }); await vi.advanceTimersByTimeAsync(1000)
  expect(c.listMessages).toHaveBeenCalledOnce()
  expect(c.session.sync.get().channels.D.messages.map(m => m.seq)).toEqual([2, 3])
  expect(c.session.sync.getTimeline('D').get().hasOlder).toBe(true)
  await c.session.sync.getTimeline('D').loadOlder(); await flush()
  expect(c.listMessages).toHaveBeenLastCalledWith('D', { before_seq: 2 })
  expect(c.session.sync.get().channels.D.messages.map(m => m.seq)).toEqual([1, 2, 3])
  expect(c.session.sync.get().channels.D.cursor).toBe(3)
  expect(c.session.sync.getTimeline('D').get().hasOlder).toBe(false)
  c.session.close()
})

it('list rediscovery cannot revive C9 and explicit DM reselection authorizes a fresh watch', async () => {
  const c = client(); await c.ready(); c.session.dms.select('D'); await flush()
  await c.session.sync.channelUnavailable('D')
  const watch = vi.spyOn(c.session.sync, 'watch')
  const history = c.listMessages.mock.calls.length
  c.socket.onEvent({ type: 'dm_list_changed' }); await vi.advanceTimersByTimeAsync(1000)
  expect(c.session.sync.get().channels.D.state).toBe('unavailable')
  expect(c.listMessages).toHaveBeenCalledTimes(history)
  c.session.dms.select('D'); await flush()
  expect(watch).toHaveBeenCalledOnce()
  expect(c.session.sync.get().channels.D.state).not.toBe('unavailable')
  c.session.close()
})

it('DM access generations discard pending marks and a late old mark cannot replace the renewed baseline', async () => {
  const c = client(); await c.ready(); c.session.dms.select('D'); await flush()
  c.socket.onEvent({ type: 'subscribed', channel_id: 'D', caught_up_seq: 1 }); await flush()
  await vi.advanceTimersByTimeAsync(1000)
  let resolve!: (value: Result<ReadPosition>) => void
  c.markRead.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  c.session.unread.visibility(true); const visit = await c.session.unread.enter({ channel: 'D', topicId: null })
  c.session.unread.presented(visit!, [1]); await flush(); expect(c.markRead).toHaveBeenCalledOnce()
  const generation = c.session.unread.get('D').generation
  c.rows = [dm('D', { as_of_seq: 1, read_seq: 1, main_unread_count: 0, unread_count: 0 })]
  c.socket.onEvent({ type: 'channel_access_gained', channel_id: 'D' }); await vi.advanceTimersByTimeAsync(16_000)
  expect(c.session.unread.get('D').generation).not.toBe(generation)
  resolve(ok({ read_seq: 99 })); await flush()
  expect(c.session.unread.get('D').main.position).toBe(1)
  expect(c.markRead).toHaveBeenCalledOnce()
  c.session.close()
})

it('a same-Session late DM 401 ends the Account owner after Organization teardown while a late Organization 404 does not', async () => {
  for (const status of [401, 404]) {
    const c = client(); await c.ready()
    let resolve!: (value: Result<Dm>) => void
    c.open.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const opening = c.session.dms.open('peer-D')
    c.session.close()
    resolve({ ok: false, kind: 'http', status, error: status === 401 ? 'invalid credentials' : 'organization_unavailable' })
    await opening; await flush()
    expect(c.onEnded).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
  }
})

it('DM discovery during an unknown-kind bootstrap uses common history before establishing the cursor', async () => {
  const c = client(); c.rows = []
  const messages = [1, 2, 3].map(seq => ({ ...c.first, id: String(seq), seq }))
  let resolve!: (value: Result<TimelinePage>) => void
  c.listTimeline.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  c.listMessages.mockResolvedValueOnce(ok({ messages: messages.slice(1), has_more: true }))
  c.socket.onReady(); c.session.channels.selectHint('D'); await flush()
  expect(c.session.sync.get().channels.D.cursor).toBeNull()
  c.rows = [dm('D', { as_of_seq: 3 })]
  c.socket.onEvent({ type: 'activity_ready' }); await vi.advanceTimersByTimeAsync(1000)
  resolve(ok({ as_of_seq: 3, items: messages.map(message => ({ kind: 'message', message })), has_more: false }))
  await flush()
  expect(c.listMessages).toHaveBeenCalledOnce()
  expect(c.session.sync.get().channels.D.messages.map(m => m.seq)).toEqual([2, 3])
  expect(c.session.sync.get().channels.D.cursor).toBe(3)
  expect(c.session.sync.getTimeline('D').get().hasOlder).toBe(true)
  c.session.close()
})
