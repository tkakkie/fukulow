import { afterEach, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, flush, ok, record } from './adapter-test-helpers.svelte'
import type { ListMessagesQuery, ListTimelineQuery, Message, MessagePage, Result, TimelineItem, TimelinePage, TopicSummary } from './api'
import { createSession } from './session'
import { deferred } from './topic-test-helpers'
import { MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT } from './protocol-types'
import { moveEvent } from './protocol-test-helpers'

const generation = record(1).history_generation
const page = (messages: Message[], as_of_seq: number, has_more = false) =>
  ({ ok: true as const, data: { history_generation: generation, as_of_seq, messages, has_more } })
const target = { channelId: 'A', messageId: 'id40', createdSeq: 40 }

function client(read: (query?: ListMessagesQuery) => Promise<Result<MessagePage>>, base = 100) {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = page([record(base - 1), record(base)], base)
  const defaultTimeline = options.topicsApi!.listTimeline
  const session = createSession({ ...options, selfId: 'me', onEnded: vi.fn(),
    topicsApi: { ...options.topicsApi!, listTopicMessages: (_channel, _topic, query) => read(query),
      listTimeline: async (channelId, query) => {
        if (query?.before_position === undefined && query?.limit === undefined) return defaultTimeline(channelId, query)
        const result = await read({
          history_generation: query.history_generation,
          ...(query.as_of_seq !== undefined ? { as_of_seq: query.as_of_seq } : {}),
          ...(query.before_position !== undefined ? { before_seq: query.before_position } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        })
        if (!result.ok) return result
        return ok({
          history_generation: result.data.history_generation,
          as_of_seq: result.data.as_of_seq,
          has_more: result.data.has_more,
          items: result.data.messages.map(message => ({ kind: 'message' as const, message })),
        })
      },
    },
    sync: { ...options.sync, random: () => 0, api: {
      ...options.sync!.api!, listMessages: (_channel, query) => read(query),
    } },
  })
  return {
    net, session, anchor: session.searchAnchor,
    cursor: () => session.sync.get().channels.A.cursor,
    async ready() {
      net.socket.onReady()
      net.lists[0].resolve(ok({ history_generation: generation, channels: [channel('A')] }))
      await flush()
      net.subscribed('A', base)
      await flush()
    },
  }
}
afterEach(() => vi.useRealTimers())

it('opens history outside the wasm window, holds its position during live delivery and resumes the real cursor after reconnect', async () => {
  vi.useFakeTimers()
  const older = deferred<Result<MessagePage>>()
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40), record(55)], 100, true)
    if (query?.after_seq === 55) return page([record(99), record(100)], 100)
    if (query?.before_seq === 40) return older.promise
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, net, session, ready } = client(read)
  try {
    await ready()
    expect(session.sync.get().channels.A.messages.some(m => m.id === target.messageId)).toBe(false)
    anchor.open(target)
    await flush()
    expect(read.mock.calls.map(([query]) => query)).toEqual([
      { history_generation: generation, after_seq: 39, limit: 26 },
      { history_generation: generation, as_of_seq: 100, before_seq: 40, limit: 25 },
    ])
    net.event({ type: 'message', kind: 'create', seq: 101, message: record(101) })
    older.resolve(page([record(28)], 100))
    await flush()
    expect(cursor()).toBe(101)
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([28, 40, 55])
    expect(anchor.get()?.hasNewer).toBe(true)

    net.socket.onClose(1001)
    await vi.runOnlyPendingTimersAsync()
    net.socket.onReady()
    expect(net.socket.sent).toContainEqual(expect.objectContaining({ type: 'subscribe', channel_id: 'A', after_seq: 101 }))
    net.event({ type: 'message', kind: 'create', seq: 102, message: record(102) })
    net.subscribed('A', 102)
    await anchor.loadNewer()
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([28, 40, 55, 99, 100, 101, 102])
    expect(cursor()).toBe(102)
    expect(read).toHaveBeenLastCalledWith({ history_generation: generation, as_of_seq: 100, after_seq: 55, limit: 25 })

    net.event({ type: 'message', kind: 'create', seq: 103, message: record(103) })
    expect(anchor.get()?.messages.at(-1)?.id).toBe('id103')
    expect(cursor()).toBe(103)
  } finally {
    session.close()
  }
})

it('keeps one visit and retains loaded pages across history settlement and live Edits and Deletes', async () => {
  const edited = { ...record(38), version: 90, body: 'edited in history' }
  const delayed = deferred<Result<MessagePage>>()
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40), record(41)], 100)
    if (query?.before_seq === 40) return page([edited], 100, true)
    if (query?.before_seq === 38) return page([record(25)], 100, true)
    if (query?.before_seq === 25) return delayed.promise
    return page([], 104)
  })
  const { anchor, net, session, ready } = client(read)
  try {
    await ready()
    const visits = new Set<symbol>()
    const statuses: string[] = []
    anchor.subscribe(() => {
      const view = anchor.get()
      if (view) { visits.add(view.visit); statuses.push(view.status) }
    })
    anchor.open(target)
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(statuses.slice(statuses.indexOf('ready'))).not.toContain('loading')
    await anchor.loadOlder()
    const hitEdit = { ...record(40), version: 102, body: 'edited live' }
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101 } })
    net.event({ type: 'message', kind: 'edit', seq: 102, message: hitEdit })
    net.event({ type: 'message', kind: 'delete', seq: 103, message: { ...edited, version: 103, deleted: true } })
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'ready', messages: [record(25), hitEdit, record(41)], hasOlder: true })
    expect(read).toHaveBeenCalledTimes(3)
    expect(visits.size).toBe(1)

    const pending = anchor.loadOlder()
    await flush()
    net.event({ type: 'message', kind: 'delete', seq: 104, message: { ...hitEdit, version: 104, deleted: true } })
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [], paging: false })
    delayed.resolve(page([record(5)], 100))
    await pending
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [] })
    expect(read).toHaveBeenCalledTimes(4)
    expect(visits.size).toBe(1)
  } finally {
    session.close()
  }
})

it('merges live Topic Messages and refreshes only when a Move affects the open Topic window', async () => {
  const inTopic = (seq: number) => ({ ...record(seq), topic_id: 'T' })
  const neighbour = { ...inTopic(39), reply_to: 'id1', reply_root_id: 'id1' }
  let through = 100
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page(through === 104 ? [inTopic(102)] : [inTopic(40)], through)
    if (query?.before_seq === 40) return page([neighbour], through)
    if (query?.after_seq === 0) return page([inTopic(40), inTopic(102)], through)
    return page([record(99)], through)
  })
  const { anchor, net, session, ready } = client(read)
  const searchReads = () => read.mock.calls.filter(([query]) => query?.after_seq !== undefined || query?.before_seq !== undefined)
  try {
    await ready()
    anchor.open({ ...target, topicId: 'T' })
    await flush()
    const visit = anchor.get()!.visit
    through = 101
    net.event(moveEvent(101, 'id99'))
    through = 102
    net.event({ type: 'message', kind: 'create', seq: 102, message: inTopic(102) })
    await flush()
    expect(searchReads()).toHaveLength(2)
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', messages: [neighbour, inTopic(40), inTopic(102)] })

    through = 103
    net.event({ ...moveEvent(103, 'id1'), source_topic_id: 'T' })
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', messages: [inTopic(40), inTopic(102)] })
    await flush()
    expect(searchReads()).toHaveLength(3)
    expect(searchReads()[2]?.[0]).toEqual({ history_generation: generation, after_seq: 0, limit: 101 })
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', messages: [inTopic(40), inTopic(102)] })

    through = 104
    net.event({ ...moveEvent(104, 'id40'), source_topic_id: 'T' })
    await flush()
    expect(searchReads()).toHaveLength(4)
    expect(anchor.get()).toMatchObject({ visit, status: 'missing', messages: [] })
  } finally {
    session.close()
  }
})

it('fences a fixed-W page overtaken by a Move outside the retained Topic window', async () => {
  const inTopic = (seq: number) => ({ ...record(seq), topic_id: 'T' })
  const delayed = deferred<Result<MessagePage>>()
  let watermark = 100
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 55) return query.as_of_seq === 100 ? delayed.promise : page([], watermark)
    if (query?.after_seq === 39) return page([inTopic(40), inTopic(55)], watermark, watermark === 100)
    if (query?.before_seq === 40) return page([inTopic(30)], watermark)
    return page([record(99)], watermark)
  })
  const { anchor, net, session, ready } = client(read)
  const searchReads = () => read.mock.calls.filter(([query]) => query?.after_seq !== undefined || query?.before_seq !== undefined)
  try {
    await ready()
    anchor.open({ ...target, topicId: 'T' })
    await flush()
    const visit = anchor.get()!.visit
    const pending = anchor.loadNewer()
    await flush()
    watermark = 101
    net.event({ ...moveEvent(101, 'id65'), source_topic_id: 'T' })
    await flush()
    expect(searchReads()).toHaveLength(3)

    delayed.resolve(page([inTopic(65)], 100))
    await pending
    expect(searchReads()).toHaveLength(4)
    expect(searchReads()[3]?.[0]).toEqual({ history_generation: generation, after_seq: 55, limit: 25 })
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', asOfSeq: 101, messages: [inTopic(30), inTopic(40), inTopic(55)] })
  } finally {
    session.close()
  }
})

it.each(['generation change', 'cursor clamp'])('reopens the result after a %s and fences the old page', async reset => {
  vi.useFakeTimers()
  const changedGeneration = '00000000-0000-4000-8000-000000000516'
  const delayed = deferred<Result<MessagePage>>()
  let readGeneration = generation
  let watermark = 100
  const currentPage = (messages: Message[], has_more = false) => ok({
    history_generation: readGeneration, as_of_seq: watermark, has_more,
    messages: messages.map(message => ({ ...message, history_generation: readGeneration })),
  })
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return currentPage([record(40)])
    if (query?.before_seq === 40) return currentPage([record(watermark === 100 ? 30 : 35)], watermark === 100)
    return delayed.promise
  })
  const { anchor, net, session, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([30, 40])
    if (reset === 'cursor clamp') {
      net.socket.onClose(1001)
      await vi.advanceTimersByTimeAsync(1000)
      net.socket.onReady()
      expect(net.socket.sent).toContainEqual(expect.objectContaining({ type: 'subscribe', channel_id: 'A', after_seq: 100 }))
    }
    const pending = anchor.loadOlder()
    await flush()
    watermark = 80
    if (reset === 'generation change') {
      const baseline = await net.options().unreadApi!.listChannels()
      if (!baseline.ok) throw new Error('Missing unread baseline')
      readGeneration = changedGeneration
      net.unreadListResult = ok({ history_generation: readGeneration,
        channels: baseline.data.channels.map(row => ({ ...row, history_generation: readGeneration, as_of_seq: watermark, read_seq: watermark })),
      })
    }
    net.timelines.A = ok({ history_generation: readGeneration, as_of_seq: watermark, has_more: false,
      items: [{ kind: 'message', message: { ...record(80), history_generation: readGeneration } }],
    })
    if (reset === 'generation change') session.sync.observeHistoryGeneration(changedGeneration)
    else net.subscribed('A', 80)
    expect(anchor.get()).toMatchObject({ status: 'loading', messages: [] })
    await flush()
    delayed.resolve(page([record(20)], 100))
    await pending
    expect(read).toHaveBeenCalledTimes(5)
    expect(read.mock.calls[3]?.[0]?.history_generation).toBe(readGeneration)
    expect(anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 80 })
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([35, 40])
  } finally {
    session.close()
  }
})

const expired = { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' } as const

it.each([
  ['edit', 'older'], ['edit', 'newer'],
  ['delete', 'older'], ['delete', 'newer'],
  ['move', 'older'], ['move', 'newer'],
] as const)('keeps loaded pages and the visit when paging %s/%s at a fresh W', async (kind, direction) => {
  let watermark = 100
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40), record(41)], watermark, true)
    if (query?.before_seq === 40) return page([record(30)], watermark, true)
    if (query?.before_seq === 30) return page([record(20)], watermark, true)
    if (query?.after_seq === 41) return page([record(50)], watermark, true)
    if (query?.before_seq === 20) return page([record(10)], query.as_of_seq ?? watermark)
    if (query?.limit === 1 && query.before_seq === undefined && query.after_seq === undefined) return page([], watermark)
    if (query?.before_seq === 51 && query.limit === 101) return page([record(20), record(30), record(40), record(41), record(50)], watermark)
    if (query?.after_seq === 50) return query.as_of_seq ? expired : page([record(60)], watermark, true)
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, net, session, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    await anchor.loadOlder()
    await anchor.loadNewer()
    const visit = anchor.get()!.visit
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([20, 30, 40, 41, 50])

    watermark = 102
    net.event(kind === 'move' ? moveEvent(101, 'id99') : {
      type: 'message', kind, seq: 101, message: { ...record(99), version: 101, deleted: kind === 'delete' },
    })
    await flush()
    expect(cursor()).toBe(101)
    read.mockClear()
    await (direction === 'older' ? anchor.loadOlder() : anchor.loadNewer())
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', asOfSeq: 102 })
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual(direction === 'older'
      ? [10, 20, 30, 40, 41, 50] : [20, 30, 40, 41, 50, 60])
    const bound = direction === 'older' ? { before_seq: 20 } : { after_seq: 50 }
    expect(read.mock.calls.map(([query]) => query)).toEqual(direction === 'older' ? [
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 100 },
      { history_generation: generation, limit: 1 },
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 102 },
      { history_generation: generation, before_seq: 51, limit: 101, as_of_seq: 102 },
    ] : [
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 100 },
      { history_generation: generation, ...bound, limit: 25 },
      { history_generation: generation, before_seq: 51, limit: 101, as_of_seq: 102 },
    ])
    expect(cursor()).toBe(101)
  } finally {
    session.close()
  }
})

it('uses the server-selected initial page W for its fixed-W companion after an unrelated Edit', async () => {
  const first = deferred<Result<MessagePage>>()
  let watermark = 100
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return watermark === 100 ? first.promise : page([record(40)], watermark)
    if (query?.before_seq === 40) return query.as_of_seq === 100 ? expired : page([record(30)], watermark)
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, net, session, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    watermark = 102
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101 } })
    first.resolve(page([record(40)], 100))
    await flush()
    expect(read.mock.calls.map(([query]) => query?.as_of_seq)).toEqual([undefined, 100, undefined, 102])
    expect(anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 102, messages: [record(30), record(40)] })
    expect(cursor()).toBe(101)
  } finally {
    session.close()
  }
})

it('refreshes the retained Topic bounds for a Move into the open Topic only', async () => {
  const inTopic = (seq: number) => ({ ...record(seq), topic_id: 'T' })
  const moved = { ...inTopic(25), version: 102 }
  const refresh = deferred<Result<MessagePage>>()
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([inTopic(40), inTopic(55)], 100, true)
    if (query?.before_seq === 40) return page([inTopic(30)], 100, true)
    if (query?.before_seq === 30) return page([inTopic(20)], 100, true)
    if (query?.after_seq === 19) return refresh.promise
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, net, session, ready } = client(read)
  const searchReads = () => read.mock.calls.filter(([query]) => query?.after_seq !== undefined || query?.before_seq !== undefined)
  try {
    await ready()
    anchor.open({ ...target, topicId: 'T' })
    await flush()
    await anchor.loadOlder()
    const visit = anchor.get()!.visit
    const loaded = [inTopic(20), inTopic(30), inTopic(40), inTopic(55)]
    net.event({ ...moveEvent(101, 'id27'), source_topic_id: 'B', destination_topic_id: 'C' })
    await flush()
    expect(searchReads()).toHaveLength(3)
    expect(cursor()).toBe(101)

    net.event({ ...moveEvent(102, moved.id), source_topic_id: 'B', destination_topic_id: 'T' })
    await flush()
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', messages: loaded })
    expect(cursor()).toBe(102)
    refresh.resolve(page([loaded[0], moved, ...loaded.slice(1), inTopic(70)], 103, true))
    await flush()
    expect(anchor.get()).toMatchObject({
      visit, status: 'ready', asOfSeq: 103, messages: [loaded[0], moved, ...loaded.slice(1)], hasOlder: true, hasNewer: true,
    })
    expect(searchReads().map(([query]) => query)).toHaveLength(4)
    expect(searchReads()[3]?.[0]).toMatchObject({ history_generation: generation, after_seq: 19 })
    expect(searchReads()[3]?.[0]?.as_of_seq).toBeUndefined()
    expect(cursor()).toBe(102)
  } finally {
    session.close()
  }
})

it.each([false, true])('retries expired paging once, preserving the visit (fresh read fails: %s)', async fails => {
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], 100)
    if (query?.before_seq === 40) return page([record(30)], 100, true)
    if (query?.limit === 1 && query.before_seq === undefined && query.after_seq === undefined) return fails ? expired : page([], 102)
    if (query?.before_seq === 103 && query.limit === 101) return page([record(30), record(40)], 102)
    return query?.as_of_seq === 100 || fails ? expired : page([record(20)], 102)
  })
  const { anchor, session, cursor, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    const visit = anchor.get()!.visit
    const pending = anchor.loadOlder()
    expect(anchor.get()).toMatchObject({ status: 'ready', messages: [record(30), record(40)] })
    await pending
    expect(read.mock.calls.map(([query]) => query?.as_of_seq)).toEqual(fails ? [undefined, 100, 100, undefined] : [undefined, 100, 100, undefined, 102, 102])
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', paging: false,
      pageError: fails ? 'older' : undefined, messages: fails ? [record(30), record(40)] : [record(20), record(30), record(40)],
    })
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

const records = (first: number, last: number, topic_id: string | null = null) =>
  Array.from({ length: last - first + 1 }, (_, offset) => ({ ...record(first + offset), topic_id }))

it('trims search pages in both directions and detaches at the live edge when the window is full', async () => {
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.before_seq === 100) return page(records(75, 99), 175, true)
    if (query?.before_seq === 75) return page(records(50, 74), 175, true)
    if (query?.before_seq === 50) return page(records(25, 49), 175, true)
    if (query?.after_seq === 99) return page(records(100, 125), 175, true)
    if (query?.after_seq === 124) return page(records(125, 149), 175, true)
    if (query?.after_seq === 149) return page(records(150, 174), 175, true)
    if (query?.after_seq === 174) return page([record(175)], 175)
    throw new Error('Unexpected history query')
  })
  const { anchor, net, session, ready } = client(read, 175)
  try {
    await ready()
    anchor.open({ ...target, createdSeq: 100, messageId: 'id100' })
    await flush()
    const visit = anchor.get()!.visit
    await anchor.loadOlder()
    await anchor.loadOlder()
    expect(anchor.get()).toMatchObject({ visit, messages: records(25, 124), hasOlder: true, hasNewer: true })
    await anchor.loadNewer()
    await anchor.loadNewer()
    await anchor.loadNewer()
    expect(anchor.get()).toMatchObject({ visit, messages: records(76, 175), hasOlder: true, hasNewer: false, detached: false })
    net.event({ type: 'message', kind: 'create', seq: 176, message: record(176) })
    expect(anchor.get()).toMatchObject({ visit, messages: records(76, 175), hasNewer: false, detached: true })
    expect(read).toHaveBeenCalledTimes(7)
  } finally {
    session.close()
  }
})

it.each([null, 'T'])('reserves and releases space for a full search window (Topic %s)', async topicId => {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = page([record(600)], 600)
  const limit = topicId ? TOPIC_MESSAGE_LIMIT : MAIN_MESSAGE_LIMIT
  const normal = (older: boolean) => page(older ? records(400 - limit + 201, 400, topicId) : records(401, 600, topicId), 600, !older)
  const read = async (query?: ListMessagesQuery) => {
    if (query?.after_seq !== undefined) return page(records(query.after_seq + 1, query.after_seq + query.limit!, topicId), 600, true)
    if (query?.before_seq === 401 || query?.before_seq === undefined) return normal(query?.before_seq === 401)
    return page(records(query.before_seq - 25, query.before_seq - 1, topicId), 600, true)
  }
  options.sync!.api!.listMessages = (_id, query) => read(query)
  options.topicsApi!.listTopicMessages = (_id, _topic, query) => read(query)
  options.topicsApi!.listTimeline = async (_id, query) => {
    if (!topicId && query?.before_position !== undefined && query.before_position !== 401) {
      const r = await read({ before_seq: query.before_position, limit: query.limit })
      return ok({ ...r.data, items: r.data.messages.map(message => ({ kind: 'message' as const, message })) })
    }
    const data = topicId ? page([record(600)], 600).data : normal(query?.before_position === 401).data
    return ok({ ...data, items: data.messages.map(message => ({ kind: 'message', message })) })
  }
  const session = createSession({ ...options, selfId: 'me', onEnded: vi.fn() })
  const { anchor, topics } = { anchor: session.searchAnchor, topics: session.topics }
  const display = () => topicId ? topics.get('A').topic(topicId).messages : topics.get('A').lines
  const load = () => topicId ? topics.loadTopic('A', topicId) : topics.loadMain('A')
  try {
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: generation, channels: [channel('A')] }))
    await flush()
    net.subscribed('A', 600)
    if (topicId) await load()
    await load()
    expect(display()).toHaveLength(limit)
    anchor.open({ ...target, topicId })
    await flush()
    await anchor.loadNewer()
    await anchor.loadNewer()
    expect(anchor.get()?.messages).toHaveLength(100)
    expect(display()).toHaveLength(limit - 100)
    if (topicId) await load()
    expect([...topics.countMessages('A')[topicId ? 1 : 0]]).toHaveLength(limit - 100)
    anchor.open(undefined)
    if (topicId) await topics.loadTopicLatest('A', topicId)
    else await topics.loadMainLatest('A')
    await load()
    expect(display()).toHaveLength(limit)
  } finally {
    session.close()
  }
})

it('keeps a search window and both page directions cursor-neutral even when their bodies and W are ahead of sync', async () => {
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40), record(120)], 150, true)
    if (query?.before_seq === 40) return page([record(30)], 150, true)
    if (query?.before_seq === 30) return page([record(10)], 150)
    if (query?.after_seq === 120) return page([record(150)], 150)
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, session, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([30, 40, 120])
    expect(cursor()).toBe(100)
    await anchor.loadOlder()
    await anchor.loadNewer()
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([10, 30, 40, 120, 150])
    expect(cursor()).toBe(100)
    expect(session.sync.get().channels.A.messages.some(m => m.created_seq > 100)).toBe(false)
  } finally {
    session.close()
  }
})

it('fences an in-flight result across navigation and drops confirmed search bodies on access loss', async () => {
  const delayed = deferred<Result<MessagePage>>()
  const { anchor, session, net, ready } = client(async query => query?.after_seq === 39 ? delayed.promise
    : query?.before_seq !== undefined ? page([], 100) : page([record(50)], 100))
  try {
    await ready()
    anchor.open(target)
    await flush()
    anchor.open({ ...target, messageId: 'id50', createdSeq: 50 })
    await flush()
    delayed.resolve(page([record(40)], 100))
    await flush()
    expect(anchor.get()?.messages.map(m => m.id)).toEqual(['id50'])
    net.event({ type: 'channel_access_lost', channel_id: 'A' })
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [] })
    expect(session.sync.get().channels.A.state).toBe('unavailable')
  } finally {
    session.close()
  }
})

it('keeps previously displayed search Messages on terminal Organization loss and fences a pending page', async () => {
  const delayed = deferred<Result<MessagePage>>()
  const read = vi.fn(async (query?: ListMessagesQuery) => query?.after_seq === 40 ? delayed.promise
    : query?.before_seq !== undefined ? page([], 100) : page([record(40)], 100, true))
  const { anchor, session, net, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    const next = anchor.loadNewer()
    await flush()
    net.socket.onClose(4003)
    delayed.resolve(page([record(50)], 100))
    await next
    expect(anchor.get()).toMatchObject({ status: 'ready', messages: [record(40)], hasNewer: false })
    await anchor.retry()
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    session.close()
  }
})

const topicItem = (id: string, name: string, first_seq: number, last_seq: number, message_count: number): TimelineItem => ({
  kind: 'topic',
  topic: {
    id, name, first_seq, last_seq, message_count,
    latest_message: { ...record(last_seq), topic_id: id },
    read_seq: last_seq, unread_count: 0, mention_unread_count: 0,
  } satisfies TopicSummary,
})
const timelinePage = (items: TimelineItem[], as_of_seq: number, has_more = false): Result<TimelinePage> =>
  ok({ history_generation: generation, as_of_seq, items, has_more })

function timelineClient(
  readMessages: (query?: ListMessagesQuery) => Promise<Result<MessagePage>>,
  readTimeline: (query?: ListTimelineQuery) => Promise<Result<TimelinePage>>,
  base = 500,
) {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = page([record(base - 1), record(base)], base)
  const defaultTimeline = options.topicsApi!.listTimeline
  const session = createSession({
    ...options, selfId: 'me', onEnded: vi.fn(),
    topicsApi: {
      ...options.topicsApi!,
      listTimeline: (channelId, query) =>
        query?.before_position === undefined && query?.limit === undefined
          ? defaultTimeline(channelId, query)
          : readTimeline(query),
    },
    sync: {
      ...options.sync, random: () => 0,
      api: { ...options.sync!.api!, listMessages: (_channel, query) => readMessages(query) },
    },
  })
  return {
    net, session, anchor: session.searchAnchor,
    cursor: () => session.sync.get().channels.A.cursor,
    async ready() {
      net.socket.onReady()
      net.lists[0].resolve(ok({ history_generation: generation, channels: [channel('A')] }))
      await flush()
      net.subscribed('A', base)
      await flush()
    },
  }
}

it('shows Topic summary lines outside the live window in normal timeline order while staying cursor-neutral', async () => {
  const tOld = topicItem('T-old', '古いトピック', 10, 35, 3)
  const tMid = topicItem('T-mid', '中間のトピック', 42, 48, 2)
  const tAncient = topicItem('T-ancient', 'さらに古いトピック', 1, 5, 4)
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) {
      return page([
        record(40),
        { ...record(42), topic_id: 'T-mid' },
        { ...record(45), topic_id: 'T-live' },
        { ...record(48), topic_id: 'T-mid' },
        record(55),
      ], 500, false)
    }
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 56) {
      // T-live has last_seq 495 > 55, so list_timeline at W=500 omits T-live from [40, 55].
      return timelinePage([
        { kind: 'message', message: record(40) },
        tMid,
        { kind: 'message', message: record(55) },
      ], 500, true)
    }
    if (query?.before_position === 40) {
      return timelinePage([
        { kind: 'message', message: record(30) },
        tOld,
      ], 500, true)
    }
    if (query?.before_position === 30) {
      return timelinePage([tAncient], 500, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readMessages, readTimeline, 500)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T-old@35:3', 'm:40', 't:T-mid@48:2', 'm:55'])
    expect(readTimeline.mock.calls.map(([q]) => q)).toEqual([
      { history_generation: generation, as_of_seq: 500, before_position: 56, limit: 4 },
      { history_generation: generation, as_of_seq: 500, before_position: 40, limit: 25 },
    ])
    expect(cursor()).toBe(500)

    await anchor.loadOlder()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['t:T-ancient@5:4', 'm:30', 't:T-old@35:3', 'm:40', 't:T-mid@48:2', 'm:55'])
    expect(readTimeline).toHaveBeenLastCalledWith({ history_generation: generation, as_of_seq: 500, before_position: 30, limit: 25 })
    expect(cursor()).toBe(500)
  } finally {
    session.close()
  }
})

it('keeps Channel-level rows within bounds in a Topic-heavy Channel and caps raw scanning at 200', async () => {
  // Older side: 20 Channel-level messages + 5 Topics = 25 timeline items.
  const olderItems: TimelineItem[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ kind: 'message' as const, message: record(50 + i) })),
    topicItem('T-1', 'T1', 70, 75, 10),
    topicItem('T-2', 'T2', 76, 80, 10),
    topicItem('T-3', 'T3', 81, 85, 10),
    topicItem('T-4', 'T4', 86, 90, 10),
    topicItem('T-5', 'T5', 91, 95, 10),
  ]
  // Newer side: hit at 100, 60 Topic messages in T-heavy (101..160), then 24 Channel-level messages (161..184).
  const newerRaw: Message[] = [
    record(100),
    ...records(101, 160, 'T-heavy'),
    ...records(161, 184, null),
  ]
  const newerTimeline: TimelineItem[] = [
    { kind: 'message', message: record(100) },
    topicItem('T-heavy', '重いトピック', 101, 160, 60),
    ...records(161, 184, null).map(message => ({ kind: 'message' as const, message })),
  ]
  let totalRawRequested = 0
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    const after = query?.after_seq ?? 0
    const limit = query?.limit ?? 25
    totalRawRequested += limit
    const slice = newerRaw.filter(m => m.created_seq > after).slice(0, limit)
    const hasMore = slice.length > 0 && slice.at(-1)!.created_seq < 184
    return page(slice, 500, hasMore)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 100) return timelinePage(olderItems, 500, true)
    if (query?.before_position === 185) return timelinePage(newerTimeline, 500, true)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readMessages, readTimeline, 500)
  try {
    await ready()
    anchor.open({ channelId: 'A', messageId: 'id100', createdSeq: 100 })
    await flush()
    await flush()
    expect(anchor.get()?.lines).toHaveLength(51)
    expect(anchor.get()?.messages).toHaveLength(45)
    expect(anchor.get()?.lines.filter(l => l.kind === 'topic').map(l => l.topicId)).toEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-heavy'])
    expect(totalRawRequested).toBeLessThanOrEqual(200)
    expect(cursor()).toBe(500)
  } finally {
    session.close()
  }

  // Pathological case: 250 consecutive Topic Messages must stop at the 200-record raw scan cap.
  let rawFetched = 0
  const cappedMessages = vi.fn(async (query?: ListMessagesQuery) => {
    const after = query?.after_seq ?? 0
    const limit = query?.limit ?? 25
    const slice = after === 99
      ? [record(100), ...records(101, 100 + limit - 1, 'T-flood')]
      : records(after + 1, after + limit, 'T-flood')
    rawFetched += slice.length
    return page(slice, 500, true)
  })
  const cappedTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 100) return timelinePage([], 500, false)
    return timelinePage([{ kind: 'message', message: record(100) }], 500, false)
  })
  const second = timelineClient(cappedMessages, cappedTimeline, 500)
  try {
    await second.ready()
    second.anchor.open({ channelId: 'A', messageId: 'id100', createdSeq: 100 })
    await flush()
    await flush()
    expect(rawFetched).toBe(200)
    expect(second.anchor.get()?.hasNewer).toBe(true)
    expect(second.cursor()).toBe(500)
  } finally {
    second.session.close()
  }
})

it('moves Topic summary lines on live Topic Messages, refreshes on Move, and clears baselines on cursor clamp', async () => {
  vi.useFakeTimers()
  let watermark = 100
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], watermark, false)
    if (query?.after_seq === 0) return page([record(30), record(40)], watermark, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40) {
      return timelinePage(
        watermark === 80
          ? [{ kind: 'message', message: record(30) }]
          : [{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 20, 35, 3)],
        watermark,
        false,
      )
    }
    if (query?.before_position === undefined && query?.limit === 101) {
      return timelinePage([
        { kind: 'message', message: record(30) },
        { kind: 'message', message: record(40) },
        topicItem('T1', '設計', 20, 101, 5),
      ], watermark, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readMessages, readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T1@35:3', 'm:40'])

    // Live Topic Message moves T1 past msg(40) and increments count (P4/P5).
    net.event({ type: 'message', kind: 'create', seq: 101, message: { ...record(101), topic_id: 'T1' } })
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40', 't:T1@101:4'])
    expect(cursor()).toBe(101)

    // Live Topic Message in a new Topic adds a live-only Topic line with unknown count (P4).
    net.event({ type: 'message', kind: 'create', seq: 102, message: { ...record(102), topic_id: 'T2' } })
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40', 't:T1@101:4', 't:T2@102:null'])

    // Live Move into T1 refreshes baselines at W=103.
    watermark = 103
    net.event({ ...moveEvent(103, 'id99'), destination_topic_id: 'T1' })
    await flush()
    expect(anchor.get()?.asOfSeq).toBe(103)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40', 't:T1@101:5'])

    // Cursor clamp clears baselines and re-reads cleanly.
    net.socket.onClose(1001)
    await vi.advanceTimersByTimeAsync(1000)
    net.socket.onReady()
    watermark = 80
    net.timelines.A = timelinePage([{ kind: 'message', message: record(80) }], 80, false)
    net.subscribed('A', 80)
    await flush()
    expect(anchor.get()?.asOfSeq).toBe(80)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40'])
  } finally {
    session.close()
  }
})

it('continues newer scanning past Topics whose latest activity falls outside the selected range', async () => {
  const raw: Message[] = [
    record(40),
    ...Array.from({ length: 25 }, (_, i) => ({ ...record(41 + i), topic_id: `T-${i + 1}` })),
    ...records(66, 90, null),
  ]
  let totalRaw = 0
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    const after = query?.after_seq ?? 0
    const limit = query?.limit ?? 25
    const slice = raw.filter(m => m.created_seq > after).slice(0, limit)
    totalRaw += slice.length
    return page(slice, 500, slice.length > 0 && slice.at(-1)!.created_seq < 90)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40) return timelinePage([], 500, false)
    if (query?.before_position === 66) return timelinePage([{ kind: 'message', message: record(40) }], 500, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readMessages, readTimeline, 500)
  try {
    await ready()
    anchor.open(target)
    await flush()
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? l.message.created_seq : l.topicId))
      .toEqual([40, ...Array.from({ length: 25 }, (_, i) => 66 + i)])
    expect(totalRaw).toBeLessThanOrEqual(200)
    expect(cursor()).toBe(500)
  } finally {
    session.close()
  }
})

it('refreshes all visible Topic baselines on Move even when one Topic has more than 101 raw Messages', async () => {
  let watermark = 250
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 159) return page([record(160), { ...record(170), topic_id: 'T-src' }, record(180), record(190)], watermark, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 160) return timelinePage([{ kind: 'message', message: record(10) }, topicItem('T-big', '大トピック', 11, 158, 148)], watermark, false)
    if (query?.before_position === 191 && query?.as_of_seq === 250) {
      return timelinePage([{ kind: 'message', message: record(160) }, topicItem('T-src', '移動元', 161, 170, 3), { kind: 'message', message: record(180) }, { kind: 'message', message: record(190) }], watermark, true)
    }
    if (query?.before_position === undefined && query?.limit === 101) {
      return timelinePage([
        { kind: 'message', message: record(10) },
        { kind: 'message', message: record(160) },
        topicItem('T-src', '移動元', 161, 165, 2),
        topicItem('T-big', '大トピック', 11, 170, 149),
        { kind: 'message', message: record(180) },
        { kind: 'message', message: record(190) },
      ], watermark, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readMessages, readTimeline, 250)
  try {
    await ready()
    anchor.open({ channelId: 'A', messageId: 'id160', createdSeq: 160 })
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:10', 't:T-big@158:148', 'm:160', 't:T-src@170:3', 'm:180', 'm:190'])
    readMessages.mockClear()
    watermark = 251
    net.event({ ...moveEvent(251, 'id170'), source_topic_id: 'T-src', destination_topic_id: 'T-big' })
    await flush()
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
    expect(anchor.get()?.asOfSeq).toBe(251)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}:${l.latestMessage.id}`))
      .toEqual(['m:10', 'm:160', 't:T-src@165:2:id165', 't:T-big@170:149:id170', 'm:180', 'm:190'])
  } finally {
    session.close()
  }
})

it('refreshes retained Topic baselines when an expired older continuation adopts a fresh W', async () => {
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], 100, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T-src', '移動元', 31, 35, 3)], 100, true)
    }
    if (query?.before_position === 30 && query?.as_of_seq === 100) return expired
    if (query?.limit === 1 && query?.before_position === undefined) return timelinePage([{ kind: 'message', message: record(102) }], 102, true)
    if (query?.before_position === 30 && query?.as_of_seq === 102) return timelinePage([{ kind: 'message', message: record(20) }], 102, false)
    if (query?.before_position === 103 && query?.as_of_seq === 102) {
      return timelinePage([
        { kind: 'message', message: record(30) },
        topicItem('T-src', '移動元', 31, 32, 2),
        topicItem('T-dst', '移動先', 35, 35, 1),
        { kind: 'message', message: record(40) },
      ], 102, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readMessages, readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T-src@35:3', 'm:40'])
    await anchor.loadOlder()
    expect(anchor.get()?.asOfSeq).toBe(102)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:20', 'm:30', 't:T-src@32:2', 't:T-dst@35:1', 'm:40'])
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

it('refreshes count on non-latest Topic Message delete and hides a deleted latest body even if refresh fails (C1)', async () => {
  let failRefresh = false
  let watermark = 100
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], watermark, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 31, 35, 3)], watermark, false)
    if (query?.before_position === undefined && query?.limit === 101) {
      if (failRefresh) return { ok: false as const, kind: 'network' as const }
      return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 32, 35, 2), { kind: 'message', message: record(40) }], watermark, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readMessages, readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T1@35:3', 'm:40'])

    // Delete a non-latest Topic Message (seq 31) -> refreshes count to 2.
    watermark = 101
    net.event({ type: 'message', kind: 'delete', seq: 101, message: { ...record(31), topic_id: 'T1', version: 101, deleted: true } })
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T1@35:2', 'm:40'])

    // Delete the latest Topic Message (seq 35) while refresh fails -> deleted body never stays visible (C1).
    failRefresh = true
    net.event({ type: 'message', kind: 'delete', seq: 102, message: { ...record(35), topic_id: 'T1', version: 102, deleted: true } })
    await flush()
    expect(anchor.get()?.pageError).toBe('refresh')
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.latestMessage.id === 'id35')).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`)).toEqual(['m:30', 'm:40'])
  } finally {
    session.close()
  }
})

it('compacts live suffix Topic bodies and keeps the live Topic line attached across older paging after 401 live Messages', async () => {
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], 100, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '活発', 31, 35, 3)], 100, true)
    if (query?.before_position === 30) return timelinePage([{ kind: 'message', message: record(20) }], 100, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readMessages, readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    for (let seq = 101; seq <= 501; seq++) {
      net.event({ type: 'message', kind: 'create', seq, message: { ...record(seq), topic_id: 'T1' } })
    }
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}:${l.latestMessage.id}`))
      .toEqual(['m:30', 'm:40', 't:T1@501:404:id501'])

    await anchor.loadOlder()
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}:${l.latestMessage.id}`))
      .toEqual(['m:20', 'm:30', 'm:40', 't:T1@501:404:id501'])
  } finally {
    session.close()
  }
})

it('settles unknown own sends from main search reads and from the fresh-W limit:1 probe without moving the cursor', async () => {
  let pendingId = ''
  let probePendingId = ''
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], 100, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      const confirmed: TimelineItem = {
        kind: 'topic',
        topic: {
          id: 'T1', name: '送信確認', first_seq: 30, last_seq: 35, message_count: 2,
          latest_message: { ...record(35), topic_id: 'T1', sender: 'me', client_message_id: pendingId },
          read_seq: 35, unread_count: 0, mention_unread_count: 0,
        },
      }
      return timelinePage([confirmed], 100, true)
    }
    if (query?.before_position === 35 && query?.as_of_seq === 100) return expired
    if (query?.limit === 1 && query?.before_position === undefined) {
      return timelinePage([{ kind: 'message', message: { ...record(102), sender: 'me', client_message_id: probePendingId } }], 102, true)
    }
    if (query?.before_position === 35 && query?.as_of_seq === 102) return timelinePage([{ kind: 'message', message: record(20) }], 102, false)
    if (query?.before_position === 103 && query?.as_of_seq === 102) return timelinePage([topicItem('T1', '送信確認', 30, 35, 2), { kind: 'message', message: record(40) }], 102, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readMessages, readTimeline, 100)
  try {
    await ready()
    const firstSend = session.sync.getTimeline('A').send('lost ack 1')
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await firstSend
    pendingId = session.sync.get().channels.A.pending[0]!.clientMessageId
    expect(session.sync.get().channels.A.pending[0]?.state).toBe('unknown')

    anchor.open(target)
    await flush()
    expect(session.sync.get().channels.A.pending).toEqual([])
    expect(cursor()).toBe(100)

    const secondSend = session.sync.getTimeline('A').send('lost ack 2')
    net.sends[1].resolve({ ok: false, kind: 'network' })
    await secondSend
    probePendingId = session.sync.get().channels.A.pending[0]!.clientMessageId
    expect(session.sync.get().channels.A.pending[0]?.state).toBe('unknown')

    await anchor.loadOlder()
    expect(session.sync.get().channels.A.pending).toEqual([])
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

it('reports older pageError when the fresh-W probe succeeds but the retried older Topic page fails', async () => {
  const readMessages = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40)], 100, false)
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40 && query?.as_of_seq === 100) return timelinePage([topicItem('T1', '設計', 25, 35, 2)], 100, true)
    if (query?.before_position === 35 && query?.as_of_seq === 100) return expired
    if (query?.limit === 1 && query?.before_position === undefined) return timelinePage([{ kind: 'message', message: record(102) }], 102, true)
    if (query?.before_position === 35 && query?.as_of_seq === 102) return expired
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readMessages, readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    const visit = anchor.get()!.visit
    await anchor.loadOlder()
    expect(readTimeline.mock.calls.map(([q]) => ({ as_of_seq: q?.as_of_seq, before_position: q?.before_position, limit: q?.limit }))).toEqual([
      { as_of_seq: 100, before_position: 40, limit: 25 },
      { as_of_seq: 100, before_position: 35, limit: 25 },
      { as_of_seq: undefined, before_position: undefined, limit: 1 },
      { as_of_seq: 102, before_position: 35, limit: 25 },
    ])
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', paging: false, pageError: 'older', asOfSeq: 100 })
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['t:T1@35:2', 'm:40'])
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})
