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
        if (query?.before_position === undefined && query?.after_position === undefined && query?.limit === undefined) return defaultTimeline(channelId, query)
        const result = await read({
          history_generation: query.history_generation,
          ...(query.as_of_seq !== undefined ? { as_of_seq: query.as_of_seq } : {}),
          ...(query.before_position !== undefined ? { before_seq: query.before_position } : {}),
          ...(query.after_position !== undefined ? { after_seq: query.after_position } : {}),
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
    if (query?.limit === 1 && query.after_seq === undefined && query.before_seq === undefined) return page([], 100)
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
      { history_generation: generation, limit: 1 },
      { history_generation: generation, as_of_seq: 100, after_seq: 39, limit: 26 },
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
    if (query?.limit === 1 && query.after_seq === undefined && query.before_seq === undefined) return page([], 100)
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
    expect(read).toHaveBeenCalledTimes(3)
    expect(statuses.slice(statuses.indexOf('ready'))).not.toContain('loading')
    await anchor.loadOlder()
    const hitEdit = { ...record(40), version: 102, body: 'edited live' }
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101 } })
    net.event({ type: 'message', kind: 'edit', seq: 102, message: hitEdit })
    net.event({ type: 'message', kind: 'delete', seq: 103, message: { ...edited, version: 103, deleted: true } })
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'ready', messages: [record(25), hitEdit, record(41)], hasOlder: true })
    expect(read).toHaveBeenCalledTimes(4)
    expect(visits.size).toBe(1)

    const pending = anchor.loadOlder()
    await flush()
    net.event({ type: 'message', kind: 'delete', seq: 104, message: { ...hitEdit, version: 104, deleted: true } })
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [], paging: false })
    delayed.resolve(page([record(5)], 100))
    await pending
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [] })
    expect(read).toHaveBeenCalledTimes(5)
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
    if (query?.limit === 1 && query.after_seq === undefined && query.before_seq === undefined) return currentPage([])
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
    await flush()
    expect(read).toHaveBeenCalledTimes(7)
    expect(read.mock.calls[4]?.[0]?.history_generation).toBe(readGeneration)
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
  const pendingMovePage = kind === 'move' ? deferred<Result<MessagePage>>() : undefined
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([record(40), record(41)], watermark, true)
    if (query?.before_seq === 40) return page([record(30)], watermark, true)
    if (query?.before_seq === 30) return page([record(20)], watermark, true)
    if (query?.after_seq === 41) return page([record(50)], watermark, true)
    if (query?.before_seq === 20) {
      if (pendingMovePage && query.as_of_seq === 100) return pendingMovePage.promise
      return page([record(10)], query.as_of_seq ?? watermark)
    }
    if (query?.limit === 1 && query.before_seq === undefined && query.after_seq === undefined) return page([], watermark)
    if (query?.after_seq === 19 && query.limit === 100) return page([record(20), record(30), record(40), record(41), record(50)], watermark, true)
    if (query?.before_seq === 51 && query.limit === 100) return page([record(20), record(30), record(40), record(41), record(50)], watermark, true)
    if (query?.after_seq === 50) {
      if (pendingMovePage && query.as_of_seq === 100) return pendingMovePage.promise
      return query.as_of_seq === 100 ? expired : page([record(60)], watermark, true)
    }
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

    if (kind === 'move' && pendingMovePage) {
      read.mockClear()
      const paging = direction === 'older' ? anchor.loadOlder() : anchor.loadNewer()
      await flush()
      watermark = 102
      net.event(moveEvent(101, 'id99'))
      await flush()
      expect(cursor()).toBe(101)
      pendingMovePage.resolve(direction === 'older' ? page([record(10)], 100) : expired)
      await paging
    } else if (kind !== 'move') {
      watermark = 102
      net.event({
        type: 'message', kind, seq: 101, message: { ...record(99), version: 101, deleted: kind === 'delete' },
      })
      await flush()
      expect(cursor()).toBe(101)
      read.mockClear()
      await (direction === 'older' ? anchor.loadOlder() : anchor.loadNewer())
    }
    expect(anchor.get()).toMatchObject({ visit, status: 'ready', asOfSeq: 102 })
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual(direction === 'older'
      ? [10, 20, 30, 40, 41, 50] : [20, 30, 40, 41, 50, 60])
    const bound = direction === 'older' ? { before_seq: 20 } : { after_seq: 50 }
    expect(read.mock.calls.map(([query]) => query).filter(query => query?.limit !== undefined)).toEqual(direction === 'older' ? [
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 100 },
      { history_generation: generation, limit: 1 },
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 102 },
      { history_generation: generation, after_seq: 19, limit: 100, as_of_seq: 102 },
    ] : [
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 100 },
      { history_generation: generation, limit: 1 },
      { history_generation: generation, ...bound, limit: 25, as_of_seq: 102 },
      { history_generation: generation, before_seq: 51, limit: 100, as_of_seq: 102 },
    ])
    expect(cursor()).toBe(101)
  } finally {
    session.close()
  }
})

it('uses the server-selected initial page W for its fixed-W companion after an unrelated Edit', async () => {
  const older100 = deferred<Result<MessagePage>>()
  let watermark = 100
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.limit === 1 && query.after_seq === undefined && query.before_seq === undefined) {
      return page([], watermark)
    }
    if (query?.after_seq === 39) return page([record(40)], query.as_of_seq ?? watermark)
    if (query?.before_seq === 40) return query.as_of_seq === 100 ? older100.promise : page([record(30)], query.as_of_seq ?? watermark)
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, net, session, ready } = client(read)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(read.mock.calls.map(([query]) => query)).toEqual([
      { history_generation: generation, limit: 1 },
      { history_generation: generation, as_of_seq: 100, after_seq: 39, limit: 26 },
      { history_generation: generation, as_of_seq: 100, before_seq: 40, limit: 25 },
    ])
    watermark = 102
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101 } })
    older100.resolve(expired)
    await flush()
    expect(read.mock.calls.map(([query]) => query)).toEqual([
      { history_generation: generation, limit: 1 },
      { history_generation: generation, as_of_seq: 100, after_seq: 39, limit: 26 },
      { history_generation: generation, as_of_seq: 100, before_seq: 40, limit: 25 },
      { history_generation: generation, limit: 1 },
      { history_generation: generation, as_of_seq: 102, after_seq: 39, limit: 26 },
      { history_generation: generation, as_of_seq: 102, before_seq: 40, limit: 25 },
    ])
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
  let probed = false
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.limit === 1 && query.before_seq === undefined && query.after_seq === undefined) {
      if (!probed) { probed = true; return page([], 100) }
      return fails ? expired : page([], 102)
    }
    if (query?.after_seq === 39) return page([record(40)], 100)
    if (query?.before_seq === 40) return page([record(30)], 100, true)
    if (query?.after_seq === 29 && query.limit === 100) return page([record(30), record(40)], 102)
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
    expect(read.mock.calls.map(([query]) => query?.as_of_seq)).toEqual(fails ? [undefined, 100, 100, 100, undefined] : [undefined, 100, 100, 100, undefined, 102, 102])
    expect(anchor.get()).toMatchObject(fails
      ? { visit, status: 'error', paging: false, pageError: undefined, messages: [], lines: [] }
      : { visit, status: 'ready', paging: false, pageError: undefined, messages: [record(20), record(30), record(40)] })
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

const records = (first: number, last: number, topic_id: string | null = null) =>
  Array.from({ length: last - first + 1 }, (_, offset) => ({ ...record(first + offset), topic_id }))

it('trims search pages in both directions and detaches at the live edge when the window is full', async () => {
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.limit === 1 && query.before_seq === undefined && query.after_seq === undefined) return page([], 175)
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
    expect(read).toHaveBeenCalledTimes(8)
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
    if (!topicId && query?.after_position !== undefined) {
      const r = await read({ after_seq: query.after_position, limit: query.limit })
      return ok({ ...r.data, items: r.data.messages.map(message => ({ kind: 'message' as const, message })) })
    }
    if (!topicId && query?.before_position !== undefined && query.before_position !== 401) {
      const r = await read({ before_seq: query.before_position, limit: query.limit })
      return ok({ ...r.data, items: r.data.messages.map(message => ({ kind: 'message' as const, message })) })
    }
    if (!topicId && query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return ok({ history_generation: generation, as_of_seq: 600, items: [], has_more: false })
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
    if (query?.limit === 1 && query.before_seq === undefined && query.after_seq === undefined) return page([], 150)
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
  const { anchor, session, net, ready } = client(async query => query?.limit === 1 && query.after_seq === undefined && query.before_seq === undefined ? page([], 100)
    : query?.after_seq === 39 ? delayed.promise
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
  const read = vi.fn(async (query?: ListMessagesQuery) => query?.limit === 1 && query.after_seq === undefined && query.before_seq === undefined ? page([], 100)
    : query?.after_seq === 40 ? delayed.promise
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
    expect(read).toHaveBeenCalledTimes(4)
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
  readTimeline: (query?: ListTimelineQuery) => Promise<Result<TimelinePage>>,
  base = 500,
) {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = page([record(base - 1), record(base)], base)
  const defaultTimeline = options.topicsApi!.listTimeline
  const readMessages = vi.fn(async (query?: ListMessagesQuery): Promise<Result<MessagePage>> => {
    if (query?.after_seq === undefined && query?.before_seq === undefined) return net.pages.A
    throw new Error(`Unexpected listMessages query: ${JSON.stringify(query)}`)
  })
  const session = createSession({
    ...options, selfId: 'me', onEnded: vi.fn(),
    topicsApi: {
      ...options.topicsApi!,
      listTimeline: (channelId, query) =>
        query?.before_position === undefined && query?.after_position === undefined && query?.limit === undefined
          ? defaultTimeline(channelId, query)
          : readTimeline(query),
    },
    sync: {
      ...options.sync, random: () => 0,
      api: { ...options.sync!.api!, listMessages: (_channel, query) => readMessages(query) },
    },
  })
  return {
    net, session, anchor: session.searchAnchor, readMessages,
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
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([{ kind: 'message', message: record(500) }], 500, true)
    }
    if (query?.after_position === 39) {
      return timelinePage([
        { kind: 'message', message: record(40) },
        tMid,
        { kind: 'message', message: record(55) },
      ], 500, false)
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
  const { anchor, cursor, readMessages, session, ready } = timelineClient(readTimeline, 500)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T-old@35:3', 'm:40', 't:T-mid@48:2', 'm:55'])
    expect(readTimeline.mock.calls.map(([q]) => q)).toEqual([
      { history_generation: generation, limit: 1 },
      { history_generation: generation, as_of_seq: 500, after_position: 39, limit: 26 },
      { history_generation: generation, as_of_seq: 500, before_position: 40, limit: 25 },
    ])
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
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

it('keeps Channel-level rows within bounds in a Topic-heavy Channel using fixed-W timeline pages', async () => {
  // Older side: 20 Channel-level messages + 5 Topics = 25 timeline items.
  const olderItems: TimelineItem[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ kind: 'message' as const, message: record(50 + i) })),
    topicItem('T-1', 'T1', 70, 75, 10),
    topicItem('T-2', 'T2', 76, 80, 10),
    topicItem('T-3', 'T3', 81, 85, 10),
    topicItem('T-4', 'T4', 86, 90, 10),
    topicItem('T-5', 'T5', 91, 95, 10),
  ]
  // Newer side: hit at 100, 1 Topic summarizing 60 messages (101..160), then 24 Channel-level messages (161..184).
  const newerTimeline: TimelineItem[] = [
    { kind: 'message', message: record(100) },
    topicItem('T-heavy', '重いトピック', 101, 160, 60),
    ...records(161, 184, null).map(message => ({ kind: 'message' as const, message })),
  ]
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([{ kind: 'message', message: record(500) }], 500, true)
    }
    if (query?.before_position === 100) return timelinePage(olderItems, 500, true)
    if (query?.after_position === 99) return timelinePage(newerTimeline, 500, true)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, readMessages, session, ready } = timelineClient(readTimeline, 500)
  try {
    await ready()
    anchor.open({ channelId: 'A', messageId: 'id100', createdSeq: 100 })
    await flush()
    expect(anchor.get()?.lines).toHaveLength(51)
    expect(anchor.get()?.messages).toHaveLength(45)
    expect(anchor.get()?.lines.filter(l => l.kind === 'topic').map(l => l.topicId)).toEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-heavy'])
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
    expect(cursor()).toBe(500)
  } finally {
    session.close()
  }
})

it('refreshes baselines on Move, follows live Topic activity without patching counts, and clears baselines on cursor clamp', async () => {
  vi.useFakeTimers()
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], watermark, false)
    }
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], watermark, false)
    if (query?.before_position === 40) {
      return timelinePage(
        watermark === 80
          ? [{ kind: 'message', message: record(30) }]
          : [{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 20, 35, 3)],
        watermark,
        false,
      )
    }
    if (query?.after_position === 0 && query?.limit === 101) {
      return timelinePage(
        watermark === 101
          ? [
              { kind: 'message', message: record(30) },
              { kind: 'message', message: record(40) },
              topicItem('T1', '設計', 20, 101, 4),
            ]
          : [
              { kind: 'message', message: record(30) },
              { kind: 'message', message: record(40) },
            ],
        watermark,
        false,
      )
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T1@35:3', 'm:40'])

    // Live Topic Message keeps following via a bounded projection refresh without patching Topic counts on the client.
    watermark = 101
    net.event({ type: 'message', kind: 'create', seq: 101, message: { ...record(101), topic_id: 'T1' } })
    expect(anchor.get()?.detached).toBe(false)
    await flush()
    expect(anchor.get()?.asOfSeq).toBe(101)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40', 't:T1@101:4'])
    expect(cursor()).toBe(101)

    // Live Move into T1 refreshes baselines at W=103.
    watermark = 103
    net.event({ ...moveEvent(103, 'id99'), destination_topic_id: 'T1' })
    await flush()
    expect(anchor.get()?.asOfSeq).toBe(103)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40'])

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

it('refreshes all visible Topic baselines on Move even when one Topic has more than 101 raw Messages', async () => {
  let watermark = 250
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], watermark, false)
    }
    if (query?.before_position === 160) return timelinePage([{ kind: 'message', message: record(10) }, topicItem('T-big', '大トピック', 11, 158, 148)], watermark, false)
    if (query?.after_position === 159 && query?.as_of_seq === 250) {
      return timelinePage([{ kind: 'message', message: record(160) }, topicItem('T-src', '移動元', 161, 170, 3), { kind: 'message', message: record(180) }, { kind: 'message', message: record(190) }], watermark, false)
    }
    if (query?.after_position === 0 && query?.limit === 101) {
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
  const { anchor, net, readMessages, session, ready } = timelineClient(readTimeline, 250)
  try {
    await ready()
    anchor.open({ channelId: 'A', messageId: 'id160', createdSeq: 160 })
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:10', 't:T-big@158:148', 'm:160', 't:T-src@170:3', 'm:180', 'm:190'])
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
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([{ kind: 'message', message: record(watermark) }], watermark, true)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T-src', '移動元', 31, 35, 3)], 100, true)
    }
    if (query?.before_position === 30 && query?.as_of_seq === 100) { watermark = 102; return expired }
    if (query?.before_position === 30 && query?.as_of_seq === 102) return timelinePage([{ kind: 'message', message: record(20) }], 102, false)
    if (query?.after_position === 29 && query?.as_of_seq === 102) {
      return timelinePage([
        { kind: 'message', message: record(30) },
        topicItem('T-src', '移動元', 31, 32, 2),
        topicItem('T-dst', '移動先', 35, 35, 1),
        { kind: 'message', message: record(40) },
      ], 102, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readTimeline, 100)
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
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      if (failRefresh) return { ok: false as const, kind: 'network' as const }
      return timelinePage([], watermark, false)
    }
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], watermark, false)
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 31, 35, 3)], watermark, false)
    if (query?.after_position === 0 && query?.limit === 101) {
      if (failRefresh) return { ok: false as const, kind: 'network' as const }
      return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 32, 35, 2), { kind: 'message', message: record(40) }], watermark, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
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

it('settles unknown own sends from main search reads and from the fresh-W limit:1 probe without moving the cursor', async () => {
  let pendingId = ''
  let probePendingId = ''
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return watermark === 100
        ? timelinePage([], 100, false)
        : timelinePage([{ kind: 'message', message: { ...record(102), sender: 'me', client_message_id: probePendingId } }], 102, true)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
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
    if (query?.before_position === 35 && query?.as_of_seq === 100) { watermark = 102; return expired }
    if (query?.before_position === 35 && query?.as_of_seq === 102) return timelinePage([{ kind: 'message', message: record(20) }], 102, false)
    if (query?.after_position === 34 && query?.as_of_seq === 102) return timelinePage([topicItem('T1', '送信確認', 30, 35, 2), { kind: 'message', message: record(40) }], 102, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
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

it('clears expired held excerpts and shows error when the fresh-W probe succeeds but the retried older Topic page fails', async () => {
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([{ kind: 'message', message: record(watermark) }], watermark, true)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
    if (query?.before_position === 40 && query?.as_of_seq === 100) return timelinePage([topicItem('T1', '設計', 25, 35, 2)], 100, true)
    if (query?.before_position === 35 && query?.as_of_seq === 100) { watermark = 102; return expired }
    if (query?.before_position === 35 && query?.as_of_seq === 102) return expired
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    const visit = anchor.get()!.visit
    await anchor.loadOlder()
    expect(readTimeline.mock.calls.map(([q]) => ({ as_of_seq: q?.as_of_seq, before_position: q?.before_position, after_position: q?.after_position, limit: q?.limit }))).toEqual([
      { as_of_seq: undefined, before_position: undefined, after_position: undefined, limit: 1 },
      { as_of_seq: 100, before_position: undefined, after_position: 39, limit: 26 },
      { as_of_seq: 100, before_position: 40, after_position: undefined, limit: 25 },
      { as_of_seq: 100, before_position: 35, after_position: undefined, limit: 25 },
      { as_of_seq: undefined, before_position: undefined, after_position: undefined, limit: 1 },
      { as_of_seq: 102, before_position: 35, after_position: undefined, limit: 25 },
    ])
    expect(anchor.get()).toMatchObject({ visit, status: 'error', paging: false, pageError: undefined, asOfSeq: undefined, lines: [], messages: [] })
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

it('refreshes the source Topic count when a non-latest Message moves into an off-window Topic', async () => {
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], watermark, false)
    }
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], watermark, false)
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T-src', '移動元', 31, 35, 2)], watermark, false)
    if (query?.after_position === 0 && query?.limit === 101) {
      return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T-src', '移動元', 35, 35, 1), { kind: 'message', message: record(40) }], watermark, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T-src@35:2', 'm:40'])

    watermark = 101
    net.event({ ...moveEvent(101, 'id31'), source_topic_id: 'T-src', destination_topic_id: 'T-off' })
    await flush()
    expect(anchor.get()?.asOfSeq).toBe(101)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T-src@35:1', 'm:40'])
    expect(cursor()).toBe(101)
  } finally {
    session.close()
  }
})

it('does not publish a deleted Topic body from an expired snapshot when 110 newer lines arrive before retry', async () => {
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([{ kind: 'message', message: record(watermark) }], watermark, true)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) return timelinePage([{ kind: 'message', message: record(40) }, { kind: 'message', message: record(50) }], 100, false)
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(20) }, topicItem('T-del', '削除トピック', 31, 35, 2)], 100, true)
    }
    if (query?.before_position === 20 && query?.as_of_seq === 100) { watermark = 211; return expired }
    if (query?.before_position === 20 && query?.as_of_seq === 211) return timelinePage([{ kind: 'message', message: record(10) }], 211, false)
    if (query?.after_position === 19 && query?.as_of_seq === 211 && query?.limit === 100) {
      // T-del was deleted at W=211 and 110 newer lines exist above 50; after_position=19 reads from 20 without omitting the prefix.
      return timelinePage([
        { kind: 'message', message: record(20) },
        { kind: 'message', message: record(40) },
        { kind: 'message', message: record(50) },
        ...records(101, 197).map(message => ({ kind: 'message' as const, message })),
      ], 211, true)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T-del')).toBe(true)

    await anchor.loadOlder()
    expect(anchor.get()?.asOfSeq).toBe(211)
    expect(anchor.get()?.hasNewer).toBe(true)
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T-del')).toBe(false)
    expect(anchor.get()?.lines.slice(0, 4).map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`))
      .toEqual(['m:10', 'm:20', 'm:40', 'm:50'])
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

it('leaves no deleted live evidence in a Topic line when a live Topic Message is created and then deleted', async () => {
  let failRefresh = false
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (failRefresh) return { ok: false as const, kind: 'network' as const }
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) return timelinePage([], watermark, false)
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], watermark, false)
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 31, 35, 3)], watermark, false)
    if (query?.after_position === 0 && query?.limit === 101 && query?.as_of_seq === 102) {
      return timelinePage([
        { kind: 'message', message: record(30) },
        { kind: 'message', message: record(40) },
        topicItem('T1', '設計', 31, 102, 4),
      ], 102, false)
    }
    return { ok: false as const, kind: 'network' as const }
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    // Publish the live Topic excerpt once at W=102 before failing the deletion refresh.
    watermark = 102
    net.event({ type: 'message', kind: 'create', seq: 102, message: { ...record(102), topic_id: 'T1' } })
    expect(anchor.get()?.detached).toBe(false)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}:${l.latestMessage.id}`))
      .toEqual(['m:30', 'm:40', 't:T1@102:4:id102'])

    failRefresh = true
    net.event({ type: 'message', kind: 'delete', seq: 103, message: { ...record(102), topic_id: 'T1', version: 103, deleted: true } })
    await flush()
    expect(anchor.get()?.pageError).toBe('refresh')
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && (l.latestMessage.id === 'id102' || l.position === 102))).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}:${l.latestMessage.id}`))
      .toEqual(['m:30', 'm:40'])
  } finally {
    session.close()
  }
})

it('settles own unknown sends returned on newer after_position timeline pages without raw list_messages reads', async () => {
  let pendingId = ''
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) return timelinePage([], 100, false)
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], 100, true)
    if (query?.before_position === 40) return timelinePage([], 100, false)
    if (query?.after_position === 40) {
      return timelinePage([{ kind: 'message', message: { ...record(90), sender: 'me', client_message_id: pendingId } }], 100, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, readMessages, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    const send = session.sync.getTimeline('A').send('lost ack newer')
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await send
    pendingId = session.sync.get().channels.A.pending[0]!.clientMessageId
    expect(session.sync.get().channels.A.pending[0]?.state).toBe('unknown')

    anchor.open(target)
    await flush()
    await anchor.loadNewer()
    expect(session.sync.get().channels.A.pending).toEqual([])
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

it('completes the newer side in one after_position read even with 100 hidden Topics under 100 ms latency', async () => {
  vi.useFakeTimers()
  const delayed = async (res: Result<TimelinePage>) => {
    await new Promise(resolve => setTimeout(resolve, 100))
    return res
  }
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return delayed(timelinePage([{ kind: 'message', message: record(500) }], 500, true))
    }
    if (query?.after_position === 39) {
      // Server projection skips 100 Topics whose latest activity is above the window and returns the hit + 25 visible newer items in one page.
      return delayed(timelinePage([
        { kind: 'message', message: record(40) },
        ...records(141, 165).map(message => ({ kind: 'message' as const, message })),
      ], 500, true))
    }
    if (query?.before_position === 40) return delayed(timelinePage([], 500, false))
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, readMessages, session, ready } = timelineClient(readTimeline, 500)
  try {
    await ready()
    anchor.open(target)
    await vi.advanceTimersByTimeAsync(350)
    await flush()
    expect(anchor.get()?.status).toBe('ready')
    expect(anchor.get()?.lines).toHaveLength(26)
    expect(readTimeline).toHaveBeenCalledTimes(3)
    expect(readTimeline.mock.calls.filter(([q]) => q?.after_position !== undefined)).toHaveLength(1)
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
    expect(cursor()).toBe(500)
  } finally {
    session.close()
  }
})

it('keeps distinct retained Message bodies within reserveSearch (100) across Topic baselines and live arrivals', async () => {
  const olderItems: TimelineItem[] = [
    ...records(1, 25).map(message => ({ kind: 'message' as const, message })),
  ]
  const newerItems: TimelineItem[] = [
    { kind: 'message', message: record(40) },
    ...Array.from({ length: 25 }, (_, i) => topicItem(`T-${i + 1}`, `トピック${i + 1}`, 41 + i * 2, 42 + i * 2, 2)),
  ]
  const page2Items: TimelineItem[] = records(101, 125).map(message => ({ kind: 'message' as const, message }))
  const page3Items: TimelineItem[] = records(126, 148).map(message => ({ kind: 'message' as const, message }))
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) return timelinePage([], 150, false)
    if (query?.before_position === 40) return timelinePage(olderItems, 150, false)
    if (query?.after_position === 39) return timelinePage(newerItems, 150, true)
    if (query?.after_position === 90) return timelinePage(page2Items, 150, true)
    if (query?.after_position === 125) return timelinePage(page3Items, 150, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 150)
  const distinctBodies = () => {
    const ids = new Set<string>()
    for (const line of anchor.get()?.lines ?? []) {
      if (line.kind === 'message') ids.add(line.message.id)
      else {
        ids.add(line.latestMessage.id)
        if (line.baseline) {
          expect(line.latestMessage).toBe(line.baseline.summary.latest_message)
          ids.add(line.baseline.summary.latest_message.id)
        }
      }
    }
    return ids.size
  }
  try {
    await ready()
    anchor.open(target)
    await flush()
    await anchor.loadNewer()
    await anchor.loadNewer()
    // 25 older + 1 hit + 25 Topics + 25 + 23 = 99 lines; live Channel-level message 151 brings it to 100.
    expect(anchor.get()?.lines).toHaveLength(99)
    net.event({ type: 'message', kind: 'create', seq: 151, message: record(151) })
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(anchor.get()?.detached).toBe(false)
    expect(distinctBodies()).toBe(100)

    // 101st live Channel-level message detaches without exceeding 100 bodies.
    net.event({ type: 'message', kind: 'create', seq: 152, message: record(152) })
    expect(anchor.get()?.detached).toBe(true)
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(distinctBodies()).toBeLessThanOrEqual(100)
  } finally {
    session.close()
  }
})

function serveTimelineFromMessages(allMessages: readonly Message[], asOfSeq: number, query?: ListTimelineQuery): Result<TimelinePage> {
  const byTopic = new Map<string, Message[]>()
  const items: TimelineItem[] = []
  for (const m of allMessages) {
    if (m.deleted || m.created_seq > asOfSeq) continue
    if (m.topic_id === null) items.push({ kind: 'message', message: m })
    else {
      const list = byTopic.get(m.topic_id) ?? []
      list.push(m)
      byTopic.set(m.topic_id, list)
    }
  }
  for (const [topicId, list] of byTopic) {
    list.sort((a, b) => a.created_seq - b.created_seq)
    const first = list[0]!, latest = list.at(-1)!
    items.push({
      kind: 'topic',
      topic: {
        id: topicId, name: `トピック-${topicId}`, first_seq: first.created_seq, last_seq: latest.created_seq,
        message_count: list.length, latest_message: latest, read_seq: latest.created_seq, unread_count: 0, mention_unread_count: 0,
      },
    })
  }
  const pos = (i: TimelineItem) => i.kind === 'message' ? i.message.created_seq : i.topic.last_seq
  items.sort((a, b) => pos(a) - pos(b))
  const limit = query?.limit ?? 25
  if (query?.after_position !== undefined) {
    const filtered = items.filter(i => pos(i) > query.after_position!)
    return timelinePage(filtered.slice(0, limit), asOfSeq, filtered.length > limit)
  }
  const filtered = query?.before_position !== undefined ? items.filter(i => pos(i) < query.before_position!) : items
  const sliced = filtered.slice(-limit)
  return timelinePage(sliced, asOfSeq, filtered.length > limit)
}

it('settles an own unknown send from an overtaken newer page even when the fresh retry probe fails', async () => {
  let pendingId = ''
  let probeCalls = 0
  const newerPage = deferred<Result<TimelinePage>>()
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      probeCalls += 1
      return probeCalls === 1 ? timelinePage([], 100, false) : { ok: false as const, kind: 'network' as const }
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) return timelinePage([{ kind: 'message', message: record(40) }], 100, true)
    if (query?.before_position === 40 && query?.as_of_seq === 100) return timelinePage([], 100, false)
    if (query?.after_position === 40 && query?.as_of_seq === 100) return newerPage.promise
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    const send = session.sync.getTimeline('A').send('overtaken newer confirm')
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await send
    pendingId = session.sync.get().channels.A.pending[0]!.clientMessageId
    expect(session.sync.get().channels.A.pending[0]?.state).toBe('unknown')

    anchor.open(target)
    await flush()

    const pendingLoad = anchor.loadNewer()
    await flush()
    // An unrelated Edit overtakes W=100 while the newer page is in flight.
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101, body: 'edited' } })
    expect(cursor()).toBe(101)

    newerPage.resolve(timelinePage([
      { kind: 'message', message: { ...record(90), sender: 'me', client_message_id: pendingId } },
    ], 100, false))
    await pendingLoad

    expect(session.sync.get().channels.A.pending).toEqual([])
    expect(cursor()).toBe(101)
    expect(anchor.get()).toMatchObject({ status: 'error', pageError: undefined, lines: [], messages: [] })
  } finally {
    session.close()
  }
})

it.each([false, true])('retries refresh once at a fresh W after snapshot_expired and never leaves a deleted Topic excerpt visible (retryFails=%s)', async (retryFails) => {
  let probeCalls = 0
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      probeCalls += 1
      if (probeCalls === 1) return timelinePage([], 100, false)
      if (probeCalls === 2) return timelinePage([], 101, false)
      return retryFails ? { ok: false as const, kind: 'network' as const } : timelinePage([], 102, false)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(30) }, topicItem('T1', '削除予定', 31, 35, 2)], 100, false)
    }
    if (query?.after_position === 0 && query?.limit === 101 && query?.as_of_seq === 101) {
      // A Delete committed on the server after W=101 before the companion read, and has not replayed yet.
      return expired
    }
    if (query?.after_position === 0 && query?.limit === 101 && query?.as_of_seq === 102) {
      return timelinePage([{ kind: 'message', message: record(30) }, { kind: 'message', message: record(40) }], 102, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T1')).toBe(true)

    net.event({ ...moveEvent(101, 'id99'), source_topic_id: 'T-other', destination_topic_id: 'T-dest' })
    await flush()

    if (retryFails) {
      expect(anchor.get()?.status).toBe('error')
      expect(anchor.get()?.lines).toEqual([])
      expect(anchor.get()?.messages).toEqual([])
    } else {
      expect(anchor.get()?.status).toBe('ready')
      expect(anchor.get()?.asOfSeq).toBe(102)
      expect(anchor.get()?.pageError).toBeUndefined()
      expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`))
        .toEqual(['m:30', 'm:40'])
    }
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T1')).toBe(false)
  } finally {
    session.close()
  }
})

it.each(['move', 'delete'] as const)('coalesces a bounded projection refresh when an off-window %s brings an unheld Topic into the held range', async (kind) => {
  const store: Message[] = [
    record(10),
    record(30),
    { ...record(35), topic_id: 'T-off' },
    record(40),
    record(65),
    { ...record(90), topic_id: 'T-off' },
    record(95),
  ]
  let watermark = 100
  const burstProbe = deferred<Result<TimelinePage>>()
  let refreshProbes = 0
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      if (watermark > 100) {
        refreshProbes += 1
        if (refreshProbes === 2) return burstProbe.promise
      }
      return serveTimelineFromMessages(store, watermark, query)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(40) }, { kind: 'message', message: record(65) }], 100, true)
    }
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(30) }], 100, true)
    }
    return serveTimelineFromMessages(store, query?.as_of_seq ?? watermark, query)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    // Held range is [30, 65] with no held Topic baselines (T-off is at 90 > 65).
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}`))
      .toEqual(['m:30', 'm:40', 'm:65'])

    // Moving or deleting Message 90 drops T-off's last_seq from 90 to 35 inside [30, 65].
    const idx90 = store.findIndex(m => m.created_seq === 90)
    store[idx90] = kind === 'move'
      ? { ...store[idx90]!, topic_id: 'T-other', version: 101 }
      : { ...store[idx90]!, deleted: true, version: 101 }
    watermark = 101
    net.event(kind === 'move'
      ? { ...moveEvent(101, 'id90'), source_topic_id: 'T-off', destination_topic_id: 'T-other' }
      : { type: 'message', kind: 'delete', seq: 101, message: { ...record(90), topic_id: 'T-off', version: 101, deleted: true } })
    await flush()
    expect(anchor.get()?.asOfSeq).toBe(101)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 't:T-off@35:1', 'm:40', 'm:65'])
    expect(cursor()).toBe(101)

    // A burst of 5 off-window mutations while a refresh is in flight coalesces into at most one follow-up refresh.
    watermark = 102
    net.event({ type: 'message', kind: 'delete', seq: 102, message: { ...record(96), topic_id: 'T-burst', version: 102, deleted: true } })
    await flush()
    for (let seq = 103; seq <= 106; seq++) {
      net.event({ type: 'message', kind: 'delete', seq, message: { ...record(seq), topic_id: 'T-burst', version: seq, deleted: true } })
    }
    watermark = 106
    burstProbe.resolve(serveTimelineFromMessages(store, 102, { limit: 1 }))
    await flush()
    expect(refreshProbes).toBe(3)
    expect(anchor.get()?.asOfSeq).toBe(106)
  } finally {
    session.close()
  }
})

it('keeps following the live edge through live Topic Messages and across older paging until the capacity limit', async () => {
  const store: Message[] = [record(20), record(30), record(40), record(50)]
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(30) }], 100, true)
    }
    return serveTimelineFromMessages(store, query?.as_of_seq ?? watermark, query)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}`))
      .toEqual(['m:30', 'm:40', 'm:50'])

    // Live Topic Message at 101 refreshes without detaching; subsequent Channel-level Message 102 still appears.
    const t101: Message = { ...record(101), topic_id: 'T1' }
    store.push(t101)
    watermark = 101
    net.event({ type: 'message', kind: 'create', seq: 101, message: t101 })
    expect(anchor.get()?.detached).toBe(false)
    await flush()
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40', 'm:50', 't:T1@101:1'])

    const m102 = record(102)
    store.push(m102)
    watermark = 102
    net.event({ type: 'message', kind: 'create', seq: 102, message: m102 })
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:30', 'm:40', 'm:50', 't:T1@101:1', 'm:102'])

    // Older paging preserves live following.
    await anchor.loadOlder()
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.hasOlder).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:20', 'm:30', 'm:40', 'm:50', 't:T1@101:1', 'm:102'])

    // Live Topic Message 103 and Channel-level Message 104 keep arriving after older paging.
    const t103: Message = { ...record(103), topic_id: 'T1' }
    store.push(t103)
    watermark = 103
    net.event({ type: 'message', kind: 'create', seq: 103, message: t103 })
    await flush()
    const m104 = record(104)
    store.push(m104)
    watermark = 104
    net.event({ type: 'message', kind: 'create', seq: 104, message: m104 })
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:20', 'm:30', 'm:40', 'm:50', 'm:102', 't:T1@103:2', 'm:104'])
    expect(cursor()).toBe(104)

    // Filling to 100 lines stays attached; a 101st live Topic Message for a new Topic detaches.
    for (let seq = 105; seq <= 197; seq++) {
      const m = record(seq)
      store.push(m)
      net.event({ type: 'message', kind: 'create', seq, message: m })
    }
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(anchor.get()?.detached).toBe(false)
    net.event({ type: 'message', kind: 'create', seq: 198, message: { ...record(198), topic_id: 'T-overflow' } })
    expect(anchor.get()?.detached).toBe(true)
    expect(anchor.get()?.lines).toHaveLength(100)
  } finally {
    session.close()
  }
})

it('carries one 10-second deadline across an initial attempt and its snapshot_expired retry', async () => {
  vi.useFakeTimers()
  let probeCalls = 0
  const companion = deferred<Result<TimelinePage>>()
  const stalledRetry = deferred<Result<TimelinePage>>()
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      probeCalls += 1
      return probeCalls === 1 ? timelinePage([], 100, false) : stalledRetry.promise
    }
    if (query?.after_position === 39) return companion.promise
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await vi.advanceTimersByTimeAsync(9_900)
    expect(anchor.get()?.status).toBe('loading')

    companion.resolve(expired)
    await flush()
    expect(probeCalls).toBe(2)
    expect(anchor.get()?.status).toBe('loading')

    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(anchor.get()?.status).toBe('error')
    expect(anchor.get()?.paging).toBe(false)
  } finally {
    session.close()
  }
})

it('settles an own unknown send beyond 200 raw Topic Messages in one after_position read (data-driven)', async () => {
  let pendingId = ''
  const store: Message[] = [
    record(40),
    ...Array.from({ length: 220 }, (_, i) => ({ ...record(41 + i), topic_id: 'T-busy' })),
  ]
  const probeItems: TimelineItem[] = []
  const continuationItems: TimelineItem[] = []
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    const res = serveTimelineFromMessages(store, 301, query)
    if (res.ok) {
      if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
        probeItems.push(...res.data.items)
      } else if (query?.after_position !== undefined) {
        continuationItems.push(...res.data.items)
      }
    }
    return res
  })
  const { anchor, cursor, net, readMessages, session, ready } = timelineClient(readTimeline, 301)
  try {
    await ready()
    const send = session.sync.getTimeline('A').send('beyond 200 raw cutoff')
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await send
    pendingId = session.sync.get().channels.A.pending[0]!.clientMessageId
    // Put a later unrelated line (seq 301) in the store so the limit:1 probe returns seq 301, not the own send (seq 300).
    store.push({ ...record(300), sender: 'me', client_message_id: pendingId }, record(301))

    anchor.open(target)
    await flush()
    expect(probeItems.map(i => i.kind === 'message' ? i.message.id : i.topic.latest_message.id)).toEqual(['id301'])
    expect(continuationItems.some(i => i.kind === 'message' && i.message.id === 'id300' && i.message.client_message_id === pendingId)).toBe(true)
    expect(session.sync.get().channels.A.pending).toEqual([])
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:40', 't:T-busy@260:220', 'm:300', 'm:301'])
    expect(readTimeline.mock.calls.filter(([q]) => q?.after_position !== undefined)).toHaveLength(1)
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
    expect(cursor()).toBe(301)
  } finally {
    session.close()
  }
})

it('completes the newer side in one after_position read over a dense 100-hidden-Topic store under 100 ms latency (data-driven)', async () => {
  vi.useFakeTimers()
  const store: Message[] = [
    record(40),
    // 100 Topics each have an older Message in 41..140 and a newer Message in 401..500 (hidden in 41..140).
    ...Array.from({ length: 100 }, (_, i) => ({ ...record(41 + i), topic_id: `T-hid-${i + 1}` })),
    ...records(141, 165),
    ...Array.from({ length: 100 }, (_, i) => ({ ...record(401 + i), topic_id: `T-hid-${i + 1}` })),
  ]
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    await new Promise(resolve => setTimeout(resolve, 100))
    return serveTimelineFromMessages(store, 500, query)
  })
  const { anchor, cursor, readMessages, session, ready } = timelineClient(readTimeline, 500)
  try {
    await ready()
    anchor.open(target)
    await vi.advanceTimersByTimeAsync(350)
    await flush()
    expect(anchor.get()?.status).toBe('ready')
    expect(anchor.get()?.lines).toHaveLength(26)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? l.message.created_seq : -1)).toEqual([40, ...Array.from({ length: 25 }, (_, i) => 141 + i)])
    expect(readTimeline).toHaveBeenCalledTimes(3)
    expect(readTimeline.mock.calls.filter(([q]) => q?.after_position !== undefined)).toHaveLength(1)
    expect(readMessages.mock.calls.filter(([q]) => q?.after_seq !== undefined || q?.before_seq !== undefined)).toEqual([])
    expect(cursor()).toBe(500)
  } finally {
    session.close()
  }
})

it('keeps distinct retained Message bodies within reserveSearch (100) across live updates to 25 held Topic baselines (data-driven)', async () => {
  const store: Message[] = [
    ...records(1, 25),
    record(40),
    ...Array.from({ length: 25 }, (_, i) => ({ ...record(41 + i * 2), topic_id: `T-${i + 1}` })),
    ...Array.from({ length: 25 }, (_, i) => ({ ...record(42 + i * 2), topic_id: `T-${i + 1}` })),
    ...records(101, 149),
  ]
  let watermark = 150
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => serveTimelineFromMessages(store, query?.as_of_seq ?? watermark, query))
  const { anchor, net, session, ready } = timelineClient(readTimeline, 150)
  const distinctBodies = () => {
    const ids = new Set<string>()
    for (const line of anchor.get()?.lines ?? []) {
      if (line.kind === 'message') ids.add(line.message.id)
      else {
        ids.add(line.latestMessage.id)
        if (line.baseline) {
          expect(line.latestMessage).toBe(line.baseline.summary.latest_message)
          ids.add(line.baseline.summary.latest_message.id)
        }
      }
    }
    return ids.size
  }
  try {
    await ready()
    anchor.open(target)
    await flush()
    await anchor.loadNewer()
    await anchor.loadNewer()
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(anchor.get()?.detached).toBe(false)
    expect(distinctBodies()).toBe(100)

    // Live updates to all 25 held Topic baselines keep the window attached, coalesce refreshes, and stay within 100 distinct bodies.
    readTimeline.mockClear()
    for (let i = 0; i < 25; i++) {
      const seq = 151 + i
      const msg: Message = { ...record(seq), topic_id: `T-${i + 1}` }
      store.push(msg)
      watermark = seq
      net.event({ type: 'message', kind: 'create', seq, message: msg })
    }
    await flush()
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(distinctBodies()).toBe(100)
    // All 25 Topic baselines updated to count=3 and latest seq 151..175 in coalesced refreshes (far fewer than 25*2 reads).
    const topicLines = (anchor.get()?.lines ?? []).filter(l => l.kind === 'topic')
    expect(topicLines).toHaveLength(25)
    expect(topicLines.every(l => l.messageCount === 3 && l.position >= 151 && l.position <= 175)).toBe(true)
    expect(readTimeline.mock.calls.length).toBeLessThanOrEqual(4)

    // A 101st distinct line (new unheld Topic T-26) detaches without exceeding 100 bodies.
    net.event({ type: 'message', kind: 'create', seq: 176, message: { ...record(176), topic_id: 'T-26' } })
    expect(anchor.get()?.detached).toBe(true)
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(distinctBodies()).toBe(100)
  } finally {
    session.close()
  }
})


it.each(['older', 'newer'] as const)('clears expired held Topic excerpts when a %s continuation retry reread fails before a Delete replays (C1)', async (direction) => {
  let watermark = 100
  let failRetainedReread = true
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], watermark, false)
    }
    if (query?.as_of_seq === 100) {
      if (query.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], 100, true)
      if (query.before_position === 40) return timelinePage([topicItem('T1', '削除待ち', 25, 35, 2)], 100, true)
      if (query.before_position === 35 || query.after_position === 40) {
        // Server-side Delete of T1 committed at 101 and expired W=100 before replaying to the client.
        watermark = 102
        return expired
      }
    }
    if (query?.as_of_seq === 102) {
      if (query.before_position === 35 && query.limit === 25) return timelinePage([{ kind: 'message', message: record(20) }], 102, false)
      if (query.after_position === 40 && query.limit === 25) return timelinePage([{ kind: 'message', message: record(50) }], 102, false)
      if ((query.after_position === 34 || query.before_position === 41) && query.limit === 100) {
        return failRetainedReread ? { ok: false as const, kind: 'network' as const } : timelinePage([{ kind: 'message', message: record(40) }], 102, false)
      }
      if (query.after_position === 39 && query.limit === 26) return timelinePage([{ kind: 'message', message: record(40) }, { kind: 'message', message: record(50) }], 102, false)
      if (query.before_position === 40 && query.limit === 25) return timelinePage([{ kind: 'message', message: record(20) }], 102, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T1')).toBe(true)

    await (direction === 'older' ? anchor.loadOlder() : anchor.loadNewer())
    expect(anchor.get()).toMatchObject({ status: 'error', paging: false, pageError: undefined, lines: [], messages: [] })
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T1')).toBe(false)

    // Explicit retry re-anchors at fresh W=102 without the deleted Topic excerpt.
    failRetainedReread = false
    await anchor.retry()
    expect(anchor.get()?.status).toBe('ready')
    expect(anchor.get()?.asOfSeq).toBe(102)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`))
      .toEqual(['m:20', 'm:40', 'm:50'])
    expect(cursor()).toBe(100)
  } finally {
    session.close()
  }
})

it('queues a coalesced refresh behind an in-flight loadOlder when a live Topic Create arrives', async () => {
  const store: Message[] = [record(20), record(30), record(40)]
  let watermark = 100
  const olderDeferred = deferred<Result<TimelinePage>>()
  let refreshProbes = 0
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      if (watermark > 100) refreshProbes += 1
      return serveTimelineFromMessages(store, watermark, query)
    }
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return timelinePage([{ kind: 'message', message: record(30) }], 100, true)
    }
    if (query?.before_position === 30 && query?.as_of_seq === 100) {
      return olderDeferred.promise
    }
    return serveTimelineFromMessages(store, query?.as_of_seq ?? watermark, query)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`))
      .toEqual(['m:30', 'm:40'])

    const loadingOlder = anchor.loadOlder()
    await flush()

    // Live Topic Create arrives while loadOlder is in flight: must not cancel loadOlder or start a concurrent refresh.
    const t101: Message = { ...record(101), topic_id: 'T1' }
    store.push(t101)
    watermark = 101
    net.event({ type: 'message', kind: 'create', seq: 101, message: t101 })
    await flush()
    expect(refreshProbes).toBe(0)

    olderDeferred.resolve(timelinePage([{ kind: 'message', message: record(20) }], 100, false))
    await loadingOlder
    await flush()

    expect(refreshProbes).toBe(1)
    expect(anchor.get()?.pageError).toBeUndefined()
    expect(anchor.get()?.hasOlder).toBe(false)
    expect(anchor.get()?.detached).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.messageCount}`))
      .toEqual(['m:20', 'm:30', 'm:40', 't:T1@101:1'])
    expect(cursor()).toBe(101)
  } finally {
    session.close()
  }
})

it('settles an own unknown send from the initial newer page immediately even if a hit Delete cancels the pending older companion', async () => {
  let pendingId = ''
  const olderCompanion = deferred<Result<TimelinePage>>()
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], 100, false)
    }
    if (query?.after_position === 39 && query?.as_of_seq === 100) {
      return timelinePage([
        { kind: 'message', message: record(40) },
        { kind: 'message', message: { ...record(50), sender: 'me', client_message_id: pendingId } },
      ], 100, false)
    }
    if (query?.before_position === 40 && query?.as_of_seq === 100) {
      return olderCompanion.promise
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, cursor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    const send = session.sync.getTimeline('A').send('settle before companion cancel')
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await send
    pendingId = session.sync.get().channels.A.pending[0]!.clientMessageId
    expect(session.sync.get().channels.A.pending[0]?.state).toBe('unknown')

    anchor.open(target)
    await flush()
    // Initial newer page has arrived and settled the own send while older companion is still pending.
    expect(session.sync.get().channels.A.pending).toEqual([])

    // Live Delete of the search hit cancels the pending older companion and makes the view missing.
    net.event({ type: 'message', kind: 'delete', seq: 101, message: { ...record(40), version: 101, deleted: true } })
    expect(anchor.get()?.status).toBe('missing')
    expect(session.sync.get().channels.A.pending).toEqual([])

    olderCompanion.resolve(timelinePage([{ kind: 'message', message: record(30) }], 100, false))
    await flush()
    expect(anchor.get()?.status).toBe('missing')
    expect(session.sync.get().channels.A.pending).toEqual([])
    expect(cursor()).toBe(101)
  } finally {
    session.close()
  }
})

it('preserves sticky capacity detach across an in-flight refresh when a new Topic overflows during a delayed probe', async () => {
  const store: Message[] = [
    ...records(15, 49),
    { ...record(50), topic_id: 'T-A' },
    ...records(51, 65),
  ]
  let watermark = 100
  const delayedProbe = deferred<Result<TimelinePage>>()
  let probeCalls = 0
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      probeCalls += 1
      if (probeCalls === 2) return delayedProbe.promise
    }
    return serveTimelineFromMessages(store, query?.as_of_seq ?? watermark, query)
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    // Fill to 100 lines at the live edge (51 loaded + 49 live Channel-level Messages = 100 lines).
    for (let seq = 101; seq <= 149; seq++) {
      const m = record(seq)
      store.push(m)
      watermark = seq
      net.event({ type: 'message', kind: 'create', seq, message: m })
    }
    expect(anchor.get()?.lines).toHaveLength(100)
    expect(anchor.get()?.detached).toBe(false)

    // 1. A new Message in held Topic A starts a refresh (probe is delayed).
    const a150: Message = { ...record(150), topic_id: 'T-A' }
    store.push(a150)
    watermark = 150
    net.event({ type: 'message', kind: 'create', seq: 150, message: a150 })
    await flush()
    expect(probeCalls).toBe(2)
    expect(anchor.get()?.detached).toBe(false)

    // 2. New Topic B arrives and detaches the window at capacity (101st line).
    const b151: Message = { ...record(151), topic_id: 'T-B' }
    store.push(b151)
    watermark = 151
    net.event({ type: 'message', kind: 'create', seq: 151, message: b151 })
    expect(anchor.get()?.detached).toBe(true)

    // 3. Another Message in Topic A commits before the refresh captures W=152.
    const a152: Message = { ...record(152), topic_id: 'T-A' }
    store.push(a152)
    watermark = 152
    delayedProbe.resolve(serveTimelineFromMessages(store, 152, { limit: 1 }))
    await flush()

    // Sticky capacity detach: refresh must not admit Topic B or re-attach the window.
    expect(anchor.get()?.detached).toBe(true)
    expect(anchor.get()?.hasNewer).toBe(true)
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.topicId === 'T-B')).toBe(false)
  } finally {
    session.close()
  }
})

it('serialises all search read operations so at most one read runs at a time and queued paging is never dropped', async () => {
  const store: Message[] = [record(20), record(30), record(40)]
  let watermark = 100
  let inFlight = 0
  let maxInFlight = 0
  const pendingCalls: Array<{ query: ListTimelineQuery | undefined; finish: () => void }> = []
  let gateReads = false
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (gateReads) {
        await new Promise<void>(resolve => { pendingCalls.push({ query, finish: resolve }) })
      }
      if (query?.before_position === 40 && query?.as_of_seq === 100) {
        return timelinePage([{ kind: 'message', message: record(30) }], 100, true)
      }
      return serveTimelineFromMessages(store, query?.as_of_seq ?? watermark, query)
    } finally {
      inFlight -= 1
    }
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(maxInFlight).toBe(1)

    gateReads = true
    // Start a refresh via live Topic Create, then queue loadOlder and additional live events while it is in flight.
    const t101: Message = { ...record(101), topic_id: 'T1' }
    store.push(t101)
    watermark = 101
    net.event({ type: 'message', kind: 'create', seq: 101, message: t101 })
    await flush()

    const olderPromise = anchor.loadOlder()
    const t102: Message = { ...record(102), topic_id: 'T2' }
    store.push(t102)
    watermark = 102
    net.event({ type: 'message', kind: 'create', seq: 102, message: t102 })
    net.event({ type: 'message', kind: 'delete', seq: 103, message: { ...record(99), topic_id: 'T-other', version: 103, deleted: true } })
    watermark = 103

    while (pendingCalls.length > 0) {
      const next = pendingCalls.shift()!
      next.finish()
      await flush()
    }
    await olderPromise
    await flush()

    expect(maxInFlight).toBe(1)
    expect(anchor.get()?.hasOlder).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}`))
      .toEqual(['m:20', 'm:30', 'm:40', 't:T1@101', 't:T2@102'])
  } finally {
    session.close()
  }
})

it('detaches directly when the live channel exceeds the continuity limit ahead of forwardWatermark', async () => {
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], 100, false)
    }
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }], 100, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    // Bootstrap at W=100 so streamBase <= forwardWatermark, then deliver MAIN_MESSAGE_LIMIT + 1
    // live Topic Messages in one Topic so the 400-body buffer evicts seq 101 while collapsing to 1 line.
    for (let seq = 101; seq <= 101 + MAIN_MESSAGE_LIMIT; seq++) {
      net.event({ type: 'message', kind: 'create', seq, message: { ...record(seq), topic_id: 'T-busy' } })
    }
    expect(session.sync.get().channels.A.streamBase).toBe(100)
    expect(session.sync.get().channels.A.messages).toHaveLength(MAIN_MESSAGE_LIMIT)
    expect(session.sync.get().channels.A.messages[0]?.created_seq).toBe(102)

    anchor.open(target)
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'ready', hasNewer: false, detached: true })
    expect(readTimeline).toHaveBeenCalledTimes(3)
  } finally {
    session.close()
  }
})

it('fences a cancelled read and rechecks snapshot freshness across the helper microtask gap', async () => {
  // Probe 1a: opening hit 70 in the microtask gap after hit 40's older readTimelinePage returns.
  const hit70 = { ...target, messageId: 'id70', createdSeq: 70 }
  const hit70Probe = deferred<Result<TimelinePage>>()
  const read1a = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return read1a.mock.calls.length === 1 ? timelinePage([], 100, false) : hit70Probe.promise
    }
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
    if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }], 100, false)
    if (query?.after_position === 69) return timelinePage([{ kind: 'message', message: record(70) }], 100, false)
    if (query?.before_position === 70) return timelinePage([{ kind: 'message', message: record(60) }], 100, false)
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const c1a = timelineClient(read1a, 100)
  try {
    await c1a.ready()
    const origSettle = c1a.session.sync.settleHistory.bind(c1a.session.sync)
    let triggered = false
    vi.spyOn(c1a.session.sync, 'settleHistory').mockImplementation((ch, msgs) => {
      if (!triggered && msgs.some(m => m.id === 'id30')) {
        triggered = true
        queueMicrotask(() => c1a.anchor.open(hit70))
      }
      return origSettle(ch, msgs)
    })
    c1a.anchor.open(target)
    await flush()
    expect(triggered).toBe(true)
    expect(c1a.anchor.get()).toMatchObject({ target: hit70, status: 'loading', messages: [], lines: [] })
    hit70Probe.resolve(timelinePage([], 100, false))
    await flush()
    expect(c1a.anchor.get()).toMatchObject({ target: hit70, status: 'ready' })
    expect(c1a.anchor.get()?.messages.map(m => m.created_seq)).toEqual([60, 70])
  } finally {
    c1a.session.close()
  }

  // Probe 1b: a live Delete delivered in the microtask gap after older readTimelinePage returns must not publish the deleted Topic excerpt.
  let watermark = 100
  const publishedExcerpts: string[] = []
  const read1b = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], watermark, false)
    }
    if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], query.as_of_seq ?? watermark, false)
    if (query?.before_position === 40) {
      return timelinePage(
        query.as_of_seq === 100
          ? [{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 31, 35, 3)]
          : [{ kind: 'message', message: record(30) }],
        query.as_of_seq ?? watermark,
        false,
      )
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const c1b = timelineClient(read1b, 100)
  try {
    await c1b.ready()
    c1b.anchor.subscribe(() => {
      for (const line of c1b.anchor.get()?.lines ?? []) {
        if (line.kind === 'topic') publishedExcerpts.push(line.latestMessage.id)
      }
    })
    const origSettle = c1b.session.sync.settleHistory.bind(c1b.session.sync)
    let triggered = false
    vi.spyOn(c1b.session.sync, 'settleHistory').mockImplementation((ch, msgs) => {
      if (!triggered && msgs.some(m => m.id === 'id35')) {
        triggered = true
        queueMicrotask(() => {
          watermark = 101
          c1b.net.event({ type: 'message', kind: 'delete', seq: 101, message: { ...record(35), topic_id: 'T1', version: 101, deleted: true } })
        })
      }
      return origSettle(ch, msgs)
    })
    c1b.anchor.open(target)
    await flush()
    expect(triggered).toBe(true)
    expect(publishedExcerpts).not.toContain('id35')
    expect(c1b.anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 101 })
    expect(c1b.anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`)).toEqual(['m:30', 'm:40'])
  } finally {
    c1b.session.close()
  }
})

it('keeps at most one in-flight Search transport across cancellation and 10-second timeout retry while preserving late access handling', async () => {
  // Probe 2a: delayed read for hit 40 must not overlap hit 70's read.
  const hit70 = { ...target, messageId: 'id70', createdSeq: 70 }
  const delayed40 = deferred<Result<TimelinePage>>()
  let inFlightA = 0
  let maxInFlightA = 0
  const readA = vi.fn(async (query?: ListTimelineQuery) => {
    inFlightA += 1
    maxInFlightA = Math.max(maxInFlightA, inFlightA)
    try {
      if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
        return timelinePage([], 100, false)
      }
      if (query?.after_position === 39) return await delayed40.promise
      if (query?.after_position === 69) return timelinePage([{ kind: 'message', message: record(70) }], 100, false)
      if (query?.before_position === 70) return timelinePage([{ kind: 'message', message: record(60) }], 100, false)
      throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
    } finally {
      inFlightA -= 1
    }
  })
  const cA = timelineClient(readA, 100)
  try {
    await cA.ready()
    cA.anchor.open(target)
    await flush()
    expect(inFlightA).toBe(1)
    cA.anchor.open(hit70)
    await flush()
    expect(inFlightA).toBe(1)
    expect(maxInFlightA).toBe(1)
    expect(cA.anchor.get()).toMatchObject({ target: hit70, status: 'loading' })

    delayed40.resolve(timelinePage([{ kind: 'message', message: record(40) }], 100, false))
    await flush()
    expect(maxInFlightA).toBe(1)
    expect(inFlightA).toBe(0)
    expect(cA.anchor.get()).toMatchObject({ target: hit70, status: 'ready' })
    expect(cA.anchor.get()?.messages.map(m => m.created_seq)).toEqual([60, 70])
  } finally {
    cA.session.close()
  }

  // Probe 2b: stalled read past 10s deadline must not overlap an explicit retry, and late access loss still applies.
  vi.useFakeTimers()
  const stalled = deferred<Result<TimelinePage>>()
  let probeCalls = 0
  let inFlightB = 0
  let maxInFlightB = 0
  const readB = vi.fn(async (query?: ListTimelineQuery) => {
    inFlightB += 1
    maxInFlightB = Math.max(maxInFlightB, inFlightB)
    try {
      if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
        probeCalls += 1
        return probeCalls === 1 ? await stalled.promise : timelinePage([], 100, false)
      }
      if (query?.after_position === 39) return timelinePage([{ kind: 'message', message: record(40) }], 100, false)
      if (query?.before_position === 40) return timelinePage([{ kind: 'message', message: record(30) }], 100, false)
      throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
    } finally {
      inFlightB -= 1
    }
  })
  const cB = timelineClient(readB, 100)
  try {
    await cB.ready()
    cB.anchor.open(target)
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    expect(cB.anchor.get()?.status).toBe('error')
    expect(inFlightB).toBe(1)

    const retryPromise = cB.anchor.retry()
    await flush()
    expect(inFlightB).toBe(1)
    expect(maxInFlightB).toBe(1)
    expect(probeCalls).toBe(1)

    stalled.resolve({ ok: false, kind: 'network' })
    await retryPromise
    await flush()
    expect(maxInFlightB).toBe(1)
    expect(inFlightB).toBe(0)
    expect(cB.anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 100 })
    expect(cB.anchor.get()?.messages.map(m => m.created_seq)).toEqual([30, 40])
  } finally {
    cB.session.close()
  }

  // Probe 2c: late 404 organization_unavailable on a timed-out transport still triggers Session access loss before queued retry runs.
  const stalled404 = deferred<Result<TimelinePage>>()
  let probeCallsC = 0
  const readC = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      probeCallsC += 1
      return await stalled404.promise
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const cC = timelineClient(readC, 100)
  try {
    await cC.ready()
    cC.anchor.open(target)
    await vi.advanceTimersByTimeAsync(10_000)
    await flush()
    expect(cC.anchor.get()?.status).toBe('error')

    const retryPromise = cC.anchor.retry()
    await flush()
    expect(probeCallsC).toBe(1)

    stalled404.resolve({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await retryPromise
    await flush()
    expect(probeCallsC).toBe(1)
    expect(cC.session.sync.get().organization).toBe('unavailable')
  } finally {
    cC.session.close()
  }
})

it('withholds unrevalidated Topic excerpts when a first refresh captures a newer W and its retained-range read fails before Delete replay', async () => {
  let failRetained = false
  let watermark = 100
  const readTimeline = vi.fn(async (query?: ListTimelineQuery) => {
    if (query?.limit === 1 && query.before_position === undefined && query.after_position === undefined) {
      return timelinePage([], watermark, false)
    }
    if (query?.after_position === 39) {
      return timelinePage([{ kind: 'message', message: record(40) }], query.as_of_seq ?? watermark, false)
    }
    if (query?.before_position === 40) {
      return timelinePage(
        watermark === 100
          ? [{ kind: 'message', message: record(30) }, topicItem('T1', '設計', 31, 35, 3)]
          : [{ kind: 'message', message: record(30) }],
        query.as_of_seq ?? watermark,
        false,
      )
    }
    if (query?.after_position === 0 && query?.limit === 101) {
      if (failRetained) return { ok: false as const, kind: 'network' as const }
      return timelinePage([{ kind: 'message', message: record(30) }, { kind: 'message', message: record(40) }], query.as_of_seq ?? watermark, false)
    }
    throw new Error(`Unexpected listTimeline query: ${JSON.stringify(query)}`)
  })
  const { anchor, net, session, ready } = timelineClient(readTimeline, 100)
  try {
    await ready()
    anchor.open(target)
    await flush()
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}@${l.position}:${l.latestMessage.id}`))
      .toEqual(['m:30', 't:T1@35:id35', 'm:40'])

    // Server deleted T1's latest Message (id35) at seq 102, but Delete replay has not arrived yet.
    // A live Topic Create at seq 101 starts a refresh whose probe captures W=102, then the retained-range read fails.
    watermark = 102
    failRetained = true
    net.event({ type: 'message', kind: 'create', seq: 101, message: { ...record(101), topic_id: 'T2' } })
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'error', paging: false, pageError: undefined, asOfSeq: undefined, lines: [], messages: [] })
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.latestMessage.id === 'id35')).toBe(false)

    // Delayed Delete replay arrives and explicit retry recovers without the deleted excerpt.
    net.event({ type: 'message', kind: 'delete', seq: 102, message: { ...record(35), topic_id: 'T1', version: 102, deleted: true } })
    failRetained = false
    await anchor.retry()
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 102 })
    expect(anchor.get()?.lines.some(l => l.kind === 'topic' && l.latestMessage.id === 'id35')).toBe(false)
    expect(anchor.get()?.lines.map(l => l.kind === 'message' ? `m:${l.message.created_seq}` : `t:${l.topicId}`)).toEqual(['m:30', 'm:40'])
  } finally {
    session.close()
  }
})
