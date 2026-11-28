import { afterEach, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, flush, ok, record } from './adapter-test-helpers.svelte'
import type { ListMessagesQuery, Message, MessagePage, Result } from './api'
import { createSession } from './session'
import { deferred } from './topic-test-helpers'
import { MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT } from './protocol-types'
import { moveEvent } from './protocol-test-helpers'
import { flushSearch, messageTimeline, searchTimelineFixture } from './search-main-test-helpers'

const generation = record(1).history_generation
const page = (messages: Message[], as_of_seq: number, has_more = false) =>
  ({ ok: true as const, data: { history_generation: generation, as_of_seq, messages, has_more } })
const target = { channelId: 'A', messageId: 'id40', createdSeq: 40 }

function client(read: (query?: ListMessagesQuery) => Promise<Result<MessagePage>>, base = 100,
  snapshot = () => ({ watermark: base, generation })) {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = page([record(base - 1), record(base)], base)
  const session = createSession({ ...options, selfId: 'me', onEnded: vi.fn(),
    topicsApi: { ...options.topicsApi!, listTopicMessages: (_channel, _topic, query) => read(query),
      async listTimeline(channel, query, signal) {
        if (!signal || !query) return options.topicsApi!.listTimeline(channel, query)
        if (query.limit === 1 && query.as_of_seq === undefined) {
          const { generation, watermark } = snapshot()
          return ok({ history_generation: generation, as_of_seq: watermark, items: [], has_more: false })
        }
        const result = await read({ history_generation: query.history_generation, as_of_seq: query.as_of_seq, limit: query.limit,
          ...(query.before_position !== undefined ? { before_seq: query.before_position } : { after_seq: query.after_position }) })
        if (!result.ok) return result
        const { messages, ...data } = result.data
        return ok({ ...data, items: messages.map(message => ({ kind: 'message', message })) })
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
  const inTopic = (seq: number) => ({ ...record(seq), topic_id: 'T' })
  const edited = { ...inTopic(38), version: 90, body: 'edited in history' }
  const delayed = deferred<Result<MessagePage>>()
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([inTopic(40), inTopic(41)], 100)
    if (query?.before_seq === 40) return page([edited], 100, true)
    if (query?.before_seq === 38) return page([inTopic(25)], 100, true)
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
    anchor.open({ ...target, topicId: 'T' })
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(statuses.slice(statuses.indexOf('ready'))).not.toContain('loading')
    await anchor.loadOlder()
    const hitEdit = { ...inTopic(40), version: 102, body: 'edited live' }
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101 } })
    net.event({ type: 'message', kind: 'edit', seq: 102, message: hitEdit })
    net.event({ type: 'message', kind: 'delete', seq: 103, message: { ...edited, version: 103, deleted: true } })
    await flush()
    expect(anchor.get()).toMatchObject({ status: 'ready', messages: [inTopic(25), hitEdit, inTopic(41)], hasOlder: true })
    expect(read).toHaveBeenCalledTimes(3)
    expect(visits.size).toBe(1)

    const pending = anchor.loadOlder()
    await flush()
    net.event({ type: 'message', kind: 'delete', seq: 104, message: { ...hitEdit, version: 104, deleted: true } })
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [], paging: false })
    delayed.resolve(page([inTopic(5)], 100))
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
    if (query?.after_seq === 0) return page([inTopic(30), inTopic(40), inTopic(55)], 101)
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
    expect(searchReads()).toHaveLength(5)
    expect(searchReads()[3]?.[0]).toEqual({ history_generation: generation, after_seq: 0, limit: 101 })
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
  const { anchor, net, session, ready } = client(read, 100, () => ({ watermark, generation: readGeneration }))
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
    expect(read).toHaveBeenCalledTimes(3)
    delayed.resolve(page([record(20)], 100))
    await pending
    await flush()
    expect(read).toHaveBeenCalledTimes(5)
    expect(read.mock.calls[3]?.[0]?.history_generation).toBe(readGeneration)
    expect(anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 80 })
    expect(anchor.get()?.messages.map(m => m.created_seq)).toEqual([35, 40])
  } finally {
    session.close()
  }
})

const expired = { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' } as const

it('never displays a deleted Message in a Topic search window when Delete replay arrives after the replacement snapshot', async () => {
  const older = { ...record(30), topic_id: 'T' }
  const hit = { ...record(40), topic_id: 'T' }
  const removed = { ...record(45), topic_id: 'T', body: 'deleted Topic body' }
  const tombstone = { ...removed, deleted: true, version: 101 }
  const newer = { ...record(55), topic_id: 'T' }
  const read = async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return page([hit, removed], 100, true)
    if (query?.before_seq === 40) return page([older], 100)
    if (query?.after_seq === 45 && query.as_of_seq === 100) return expired
    if (query?.after_seq === 0) return page([older, hit, newer], 101)
    if (query?.after_seq === 45 && query.as_of_seq === 101) return page([newer], 101)
    throw new Error('Unexpected Topic history query')
  }
  const { anchor, cursor, net, ready, session } = client(read)
  try {
    await ready()
    anchor.open({ ...target, topicId: 'T' })
    await flushSearch()
    expect(anchor.get()?.messages).toEqual([older, hit, removed])
    const reading = anchor.loadNewer()
    const seen: (Message[] | undefined)[] = []
    anchor.subscribe(() => seen.push(anchor.get()?.messages))
    await reading
    expect(anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 101, messages: [older, hit, newer] })
    expect(cursor()).toBe(100)
    net.event({ type: 'message', kind: 'delete', seq: 101, message: tombstone })
    await flushSearch()
    expect(cursor()).toBe(101)
    expect(anchor.get()?.messages).toEqual([older, hit, newer])
    expect(seen).toContainEqual([])
    expect(seen.flat().some(message => message?.id === removed.id)).toBe(false)
  } finally { session.close() }
})

it.each([
  ['edit', 'older'], ['edit', 'newer'],
  ['delete', 'older'], ['delete', 'newer'],
  ['move', 'older'], ['move', 'newer'],
] as const)('keeps loaded pages and the visit when paging %s/%s at a fresh W', async (kind, direction) => {
  const f = searchTimelineFixture(records(1, 90))
  try {
    await f.open()
    const visit = f.anchor.get()!.visit
    const initial = f.anchor.get()!.messages.map(m => m.id)
    f.put({ ...record(90), version: 101, deleted: kind === 'delete', topic_id: kind === 'move' ? 'T' : null })
    await (direction === 'older' ? f.anchor.loadOlder() : f.anchor.loadNewer())
    expect(f.anchor.get()).toMatchObject({ visit, status: 'ready', asOfSeq: 101 })
    expect(f.anchor.get()?.messages.map(m => m.id)).toEqual(expect.arrayContaining(initial))
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it('uses the server-selected initial page W for its fixed-W companion after an unrelated Edit', async () => {
  const first = deferred<Result<MessagePage>>()
  let watermark = 100
  const read = vi.fn(async (query?: ListMessagesQuery) => {
    if (query?.after_seq === 39) return watermark === 100 ? first.promise : page([record(40)], watermark)
    if (query?.before_seq === 40) return page([record(30)], watermark)
    throw new Error('Unexpected history query')
  })
  const { anchor, cursor, net, session, ready } = client(read, 100, () => ({ watermark, generation }))
  try {
    await ready()
    anchor.open(target)
    await flushSearch()
    watermark = 102
    net.event({ type: 'message', kind: 'edit', seq: 101, message: { ...record(99), version: 101 } })
    first.resolve(page([record(40)], 100))
    await flushSearch()
    expect(read.mock.calls.map(([query]) => query?.as_of_seq)).toEqual([100, 102, 102])
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
  const f = searchTimelineFixture(records(1, 75))
  try {
    await f.open()
    const visit = f.anchor.get()!.visit
    f.put({ ...record(80), version: 102, deleted: true })
    if (fails) f.read.mockImplementation(async query => query.as_of_seq === 102 ? expired : f.serve(query))
    await f.anchor.loadOlder()
    expect(f.read.mock.calls.filter(([query]) => query.limit === 1)).toHaveLength(2)
    expect(f.anchor.get()).toMatchObject({ visit, status: fails ? 'error' : 'ready', paging: false,
      pageError: fails ? 'older' : undefined, messages: fails ? [] : records(1, 65),
    })
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
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
  options.topicsApi!.listTimeline = async (_id, query, signal) => {
    if (signal && query) return ok(messageTimeline(records(1, 600), 600, query))
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
  const { anchor, cursor, session, ready } = client(read, 100, () => ({ watermark: 150, generation }))
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
    await flushSearch()
    anchor.open({ ...target, messageId: 'id50', createdSeq: 50 })
    await flushSearch()
    delayed.resolve(page([record(40)], 100))
    await flushSearch()
    expect(anchor.get()?.messages.map(m => m.id)).toEqual(['id50'])
    net.event({ type: 'channel_access_lost', channel_id: 'A' })
    await flushSearch()
    expect(anchor.get()).toMatchObject({ status: 'missing', messages: [] })
    expect(session.sync.get().channels.A.state).toBe('unavailable')
  } finally {
    session.close()
  }
})

it.each([
  [403, 'forbidden', 'unavailable'],
  [404, 'channel not found', 'unavailable'],
  [403, 'topic_not_found', 'ready'],
  [404, 'topic_not_found', 'ready'],
  [403, 'reply_chain_not_found', 'ready'],
  [404, 'reply_chain_not_found', 'ready'],
] as const)('marks an anchor missing on HTTP %i %s and leaves the Channel %s', async (status, error, channelState) => {
  const { anchor, session, ready } = client(async () => ({ ok: false, kind: 'http', status, error }))
  try {
    await ready()
    anchor.open({ ...target, topicId: 'T' })
    await flushSearch()
    expect(anchor.get()?.status).toBe('missing')
    expect(session.sync.get().channels.A.state).toBe(channelState)
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
