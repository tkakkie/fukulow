import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from './api'
import type { ReadPosition, Result, TopicSummaryResponse } from './api'
import { MAIN_MESSAGE_LIMIT } from './protocol-types'
import type { RealtimeHandlers } from './realtime'
import { createSession } from './session'
import { deferred, flush, http, msg, ok, row, summary, unreadClient } from './unread-test-helpers'

const history_generation = '00000000-0000-4000-8000-000000000515'
const scope = { channel: 'A', topicId: 'T' }
const read = (as_of_seq: number, position = 0, count = 3) => ({
  history_generation, as_of_seq, topic: { ...summary('T', 3, position, count), mention_unread_count: count },
})
const page = (asOfSeq: number, position = 0, count = 3) => {
  const { topic } = read(asOfSeq, position, count)
  return ok({ history_generation, as_of_seq: asOfSeq, topics: [topic], has_more: false })
}
const hidden = { unreadCount: null, mentionUnreadCount: null }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

async function localVisit() {
  const c = unreadClient()
  c.history.splice(0, c.history.length, ...[1, 2, 3].map(seq => msg(seq, 'T')))
  c.summaries.clear()
  c.summaries.set('T', read(3).topic)
  await c.boot()
  const visit = await c.enter('T')
  expect(c.unread.get('A').topics.T).toMatchObject({ unreadCount: 3, mentionUnreadCount: 3 })
  return { ...c, visit, counts: () => c.unread.get('A').topics.T }
}

it('1. a stale Topic projection preserves summary backoff', async () => {
  const c = await localVisit()
  try {
    const stale = deferred<Awaited<ReturnType<typeof c.topicsApi.listTopics>>>()
    c.topicsApi.listTopics.mockReturnValueOnce(stale.promise)
    const projection = c.topics.loadList('A')
    await flush()
    c.unreadApi.getTopicSummary.mockResolvedValueOnce(http(503)).mockResolvedValueOnce(ok(read(3, 1, 2)))
    c.unread.activityRead('A', 'T')
    await flush()
    expect(c.counts()).toMatchObject(hidden)
    stale.resolve(page(3))
    await projection
    c.unread.presented(c.visit, [1])
    await flush()
    expect(c.counts()).toMatchObject(hidden)
    expect(c.unreadApi.markRead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(c.counts()).toMatchObject({ position: 1, unreadCount: 2, mentionUnreadCount: 2 })
  } finally { await c.sync.close() }
})

it('2. an acknowledged Topic mark cannot release a queued mark during summary recovery', async () => {
  const c = await localVisit()
  try {
    const first = deferred<Result<ReadPosition>>()
    c.unreadApi.markRead.mockReturnValueOnce(first.promise)
    c.unread.presented(c.visit, [1])
    await flush()
    c.unread.presented(c.visit, [2])
    c.unreadApi.getTopicSummary.mockResolvedValueOnce(http(503))
    c.unread.activityRead('A', 'T')
    await flush()
    expect(c.counts()).toMatchObject(hidden)
    first.resolve(ok({ history_generation, read_seq: 1 }))
    await flush()
    expect(c.unreadApi.markRead.mock.calls.map(([, mark]) => mark.read_seq)).toEqual([1])
    expect(c.counts()).toMatchObject(hidden)
  } finally { await c.sync.close() }
})

it('3. a newer Topic watermark cannot cover an older read position', async () => {
  const c = await localVisit()
  try {
    c.unreadApi.getTopicSummary.mockResolvedValueOnce(http(503))
    c.unread.activityRead('A', 'T', 2)
    await flush()
    c.topicsApi.listTopics.mockResolvedValueOnce(page(4, 1, 2))
    await c.topics.loadList('A')
    c.unread.presented(c.visit, [1, 2])
    await flush()
    expect(c.counts()).toMatchObject(hidden)
    expect(c.unreadApi.markRead).not.toHaveBeenCalled()
  } finally { await c.sync.close() }
})

async function sharedVisit(cached = true) {
  const lists = ok({ history_generation, channels: [row({ main_unread_count: 0 })] })
  vi.spyOn(api, 'listChannels').mockResolvedValue(lists)
  const markRead = vi.spyOn(api, 'markTopicRead').mockImplementation(async (_org, _channel, _topic, body) => ok({ history_generation, read_seq: body.read_seq }))
  const getTopicSummary = vi.fn<() => Promise<Result<TopicSummaryResponse>>>().mockResolvedValue(ok(read(3)))
  const listTopics = vi.fn<() => Promise<Result<api.TopicPage>>>().mockResolvedValue(page(3))
  let socket!: RealtimeHandlers
  const session = createSession({
    selfId: 'me', onEnded() {},
    channelsApi: { listChannels: async () => lists, createChannel: async () => http(400) },
    topicsApi: {
      getTopicSummary, listTopics,
      listTimeline: async () => ok({ history_generation, as_of_seq: 3, has_more: false,
        items: cached ? [{ kind: 'topic', topic: read(3).topic }] : [] }),
      listTopicMessages: async () => ok({ history_generation, as_of_seq: 3, messages: [1, 2, 3].map(seq => msg(seq, 'T')), has_more: false }),
    },
    sync: { random: () => 0,
      connect(handlers) { socket = handlers; return { send() {}, close() {} } },
      api: { listChannelEvents: async () => http(400), listMessages: async () => http(400), sendMessage: async () => http(400) },
    },
  })
  await flush()
  socket.onReady()
  await flush()
  socket.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3, history_generation })
  await flush()
  expect(session.sync.get().channels.A?.subscription?.confirmed).toBe(true)
  const enter = async () => {
    await session.topics.loadTopic('A', 'T')
    session.unread.visibility(true)
    return (await session.unread.enter(scope))!
  }
  const visit = cached ? await enter() : undefined
  await flush()
  const counts = () => session.unread.get('A').topics.T
  if (cached) expect(counts()).toMatchObject({ unreadCount: 3, mentionUnreadCount: 3 })
  return { ...session, socket, enter, visit: visit!, counts, markRead, getTopicSummary, listTopics }
}

it('4. the shared summary cache cannot satisfy an invalidation during backoff', async () => {
  const c = await sharedVisit()
  try {
    c.getTopicSummary.mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 2000 })
      .mockResolvedValueOnce(ok(read(3, 1, 2)))
    await c.topics.loadSummary('A', 'T')
    const calls = c.getTopicSummary.mock.calls.length
    c.unread.activityRead('A', 'T')
    await flush()
    c.unread.presented(c.visit, [1])
    await vi.advanceTimersByTimeAsync(1999)
    expect(c.getTopicSummary).toHaveBeenCalledTimes(calls)
    expect(c.counts()).toMatchObject(hidden)
    expect(c.markRead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(c.counts()).toMatchObject({ position: 1, unreadCount: 2, mentionUnreadCount: 2 })
  } finally { c.close() }
})

it('5. a WebSocket read notice fences a stale Topic projection through backoff', async () => {
  const c = await sharedVisit()
  try {
    const stale = deferred<Awaited<ReturnType<typeof c.listTopics>>>()
    c.listTopics.mockReturnValueOnce(stale.promise)
    const projection = c.topics.loadList('A')
    await flush()
    c.getTopicSummary.mockResolvedValueOnce(http(503))
    c.socket.onEvent({ type: 'read_position_changed', channel_id: 'A', topic_id: 'T', read_seq: 2 })
    await vi.advanceTimersByTimeAsync(200)
    stale.resolve(page(4))
    await projection
    c.unread.presented(c.visit, [1])
    await flush()
    expect(c.counts()).toMatchObject(hidden)
    expect(c.markRead).not.toHaveBeenCalled()
  } finally { c.close() }
})

it('6. a coalesced pre-invalidation Topic summary cannot cover an unknown read position', async () => {
  const c = await sharedVisit()
  try {
    c.socket.onEvent({ type: 'message', kind: 'create', seq: 4, message: msg(4) })
    await flush()
    const stale = deferred<Result<TopicSummaryResponse>>(), fresh = deferred<Result<TopicSummaryResponse>>()
    c.getTopicSummary.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const original = c.topics.loadSummary('A', 'T')
    await flush()
    c.unread.activityRead('A', 'T')
    stale.resolve(ok(read(4)))
    await original
    await flush()
    c.unread.presented(c.visit, [1])
    await flush()
    expect(c.counts()).toMatchObject(hidden)
    expect(c.markRead).not.toHaveBeenCalled()
    fresh.resolve(ok(read(4, 1, 2)))
    await flush()
    expect(c.counts()).toMatchObject({ position: 1, unreadCount: 2, mentionUnreadCount: 2 })
  } finally { c.close() }
})

it('7. an older terminal Topic summary cannot stop a newer coalesced recovery', async () => {
  const c = await sharedVisit()
  try {
    c.socket.onEvent({ type: 'message', kind: 'create', seq: 4, message: msg(4) })
    await flush()
    const stale = deferred<Result<TopicSummaryResponse>>(), fresh = deferred<Result<TopicSummaryResponse>>()
    c.getTopicSummary.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const original = c.topics.loadSummary('A', 'T')
    await flush()
    c.unread.activityRead('A', 'T')
    stale.resolve(http(400))
    await original
    await flush()
    expect(c.counts()).toMatchObject({ ...hidden, stopped: false })
    fresh.resolve(ok(read(4, 2, 1)))
    await flush()
    expect(c.counts()).toMatchObject({ position: 2, unreadCount: 1, mentionUnreadCount: 1 })
  } finally { c.close() }
})

it('a later Topic invalidation restarts an uncached ordinary summary failure', async () => {
  const c = await sharedVisit(false)
  try {
    c.getTopicSummary.mockResolvedValueOnce(http(400)).mockResolvedValueOnce(ok(read(3, 2, 1)))
    await c.enter()
    await flush()
    expect(c.counts()).toMatchObject({ ...hidden, stopped: true })
    c.unread.activityRead('A', 'T')
    await flush()
    expect(c.counts()).toMatchObject({ position: 2, unreadCount: 1, mentionUnreadCount: 1, stopped: false })
  } finally { c.close() }
})

it('covering Topic evidence restores both badges and permits a fresh presentation', async () => {
  const c = await localVisit()
  try {
    c.unreadApi.markRead.mockResolvedValue(ok({ history_generation, read_seq: 3 }))
    c.unreadApi.getTopicSummary.mockResolvedValueOnce(http(503)).mockResolvedValueOnce(ok(read(3, 2, 1)))
      .mockResolvedValueOnce(ok(read(4, 1, 2))).mockResolvedValueOnce(ok(read(4, 2, 1)))
    c.handlers[0].onEvent({ type: 'message', kind: 'delete', seq: 4, message: { ...msg(1, 'T'), version: 4, deleted: true } })
    await flush()
    c.unread.activityRead('A', 'T', 2)
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    expect(c.counts()).toMatchObject(hidden)
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.counts()).toMatchObject(hidden)
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.counts()).toMatchObject({ position: 2, unreadCount: 1, mentionUnreadCount: 1 })
    c.unread.presented(c.visit, [3])
    await flush()
    expect(c.unreadApi.markRead).toHaveBeenCalledExactlyOnceWith(scope, { history_generation, read_seq: 3 })
  } finally { await c.sync.close() }
})

it('a WebSocket read notice recovers a retained Topic after its activity target is pruned', async () => {
  const c = await sharedVisit()
  try {
    await c.topics.loadSummary('A', 'T')
    expect(c.topics.hasActivitySummary('A', 'T')).toBe(true)
    c.unread.leave()
    c.topics.releaseTopic('A', 'T')
    c.topics.reserveSearch('A', 'main', MAIN_MESSAGE_LIMIT)
    c.topics.reserveSearch('A', 'main', 0)
    expect(c.topics.hasActivitySummary('A', 'T')).toBe(false)
    expect(c.counts()).toMatchObject({ position: 0, unreadCount: 3, mentionUnreadCount: 3 })

    const fresh = deferred<Result<TopicSummaryResponse>>()
    c.getTopicSummary.mockClear().mockReturnValueOnce(fresh.promise)
    c.socket.onEvent({ type: 'read_position_changed', channel_id: 'A', topic_id: 'T', read_seq: 2 })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.counts()).toMatchObject(hidden)
    expect(c.getTopicSummary).toHaveBeenCalledTimes(1)
    fresh.resolve(ok(read(3, 2, 1)))
    await flush()
    expect(c.counts()).toMatchObject({ position: 2, unreadCount: 1, mentionUnreadCount: 1, error: false })
  } finally { c.close() }
})

it('a stale activity summary schedules Topic recovery before the periodic tick', async () => {
  const c = await sharedVisit()
  try {
    c.getTopicSummary.mockResolvedValueOnce(ok(read(3, 2, 1)))
    await c.topics.loadSummary('A', 'T')
    expect(c.counts()).toMatchObject({ position: 2, unreadCount: 1, mentionUnreadCount: 1 })
    expect(c.topics.hasActivitySummary('A', 'T')).toBe(true)

    const fresh = deferred<Result<TopicSummaryResponse>>()
    c.getTopicSummary.mockClear().mockResolvedValueOnce(ok(read(3, 1, 2))).mockReturnValueOnce(fresh.promise)
    c.socket.onEvent({ type: 'read_position_changed', channel_id: 'A', topic_id: 'T', read_seq: 3 })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.counts()).toMatchObject({ position: 2, ...hidden })
    expect(c.getTopicSummary).toHaveBeenCalledTimes(2)
    fresh.resolve(ok(read(3, 3, 0)))
    await flush()
    expect(c.counts()).toMatchObject({ position: 3, unreadCount: 0, mentionUnreadCount: 0, error: false })
  } finally { c.close() }
})
