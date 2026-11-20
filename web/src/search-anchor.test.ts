import { afterEach, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, flush, ok, record } from './adapter-test-helpers.svelte'
import type { ListMessagesQuery, Message, MessagePage, Result } from './api'
import { createSession } from './session'
import { deferred } from './topic-test-helpers'

const generation = record(1).history_generation
const page = (messages: Message[], as_of_seq: number, has_more = false) =>
  ok({ history_generation: generation, as_of_seq, messages, has_more })
const target = { channelId: 'A', messageId: 'id40', createdSeq: 40 }

function client(read: (query?: ListMessagesQuery) => Promise<Result<MessagePage>>) {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = page([record(99), record(100)], 100)
  const session = createSession({ ...options, selfId: 'me', onEnded: vi.fn(),
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
      net.subscribed('A', 100)
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
