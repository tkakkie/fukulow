import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import type { ChannelList, Result, TimelinePage } from './api'
import { createSession } from './session'
import { deferred } from './topic-test-helpers'

const generation = record(1).history_generation
const scope = { channel: 'A', topicId: null }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function list(watermark: number, unread: number, read = 1) {
  return ok<ChannelList>({ history_generation: generation, channels: [
    { ...channel('A'), history_generation: generation, as_of_seq: watermark, read_seq: read,
      unread_count: unread, main_unread_count: unread, mention_unread_count: 0, main_mention_unread_count: 0 },
    { ...channel('B'), history_generation: generation, as_of_seq: 0, read_seq: 0,
      unread_count: 0, main_unread_count: 0, mention_unread_count: 0, main_mention_unread_count: 0 },
  ] })
}

function timeline(watermark: number) {
  return ok<TimelinePage>({ history_generation: generation, as_of_seq: watermark,
    items: Array.from({ length: watermark }, (_, i) => ({ kind: 'message', message: record(i + 1) })), has_more: false })
}

function client(initial: Result<ChannelList>, page: Promise<Result<TimelinePage>>) {
  const net = fakeNetwork(), options = net.options()
  const read = vi.fn(async (): Promise<Result<ChannelList>> => initial)
  // The first GET is started by Auth and handed to the session while the core is loading.
  const initialChannels = read()
  const session = createSession({ ...options, selfId: 'me', organizationId: 'o', initialChannels, onEnded: vi.fn(),
    channelsApi: undefined, unreadApi: { ...options.unreadApi!, listChannels: read },
    topicsApi: { ...options.topicsApi!, listTimeline: (id, query) => id === 'A' ? page : options.topicsApi!.listTimeline(id, query) },
    sync: { ...options.sync, random: () => 0.5 },
  })
  async function connect() {
    net.socket.onReady()
    await settle()
    net.event({ type: 'activity_ready' })
    await settle()
  }
  return { ...session, net, read, connect }
}

it.each([
  { pendingW: 2, reads: 2 },
  { pendingW: 1, reads: 3 },
])('checks the pending Channel list at W=$pendingW against Timeline bootstrap W=2', async ({ pendingW, reads }) => {
  const history = deferred<Result<TimelinePage>>()
  const response = deferred<Result<ChannelList>>()
  const c = client(list(1, 0), history.promise)
  try {
    await settle()
    c.read.mockReturnValueOnce(response.promise).mockResolvedValue(list(2, 1))
    await c.connect()
    expect(c.read).toHaveBeenCalledTimes(2)
    expect(c.sync.get().channels.A.cursor).toBeNull()

    history.resolve(timeline(2))
    await settle()
    expect(c.sync.get().channels.A.cursor).toBe(2)
    expect(c.unread.get('A').unreadCount).toBeNull()
    expect(c.read).toHaveBeenCalledTimes(2)

    response.resolve(list(pendingW, pendingW - 1))
    await settle()
    expect(c.channels.authorizedList.get().current).toBe(true)
    expect(c.unread.get('A').unreadCount).toBe(pendingW === 2 ? 1 : null)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(c.read).toHaveBeenCalledTimes(reads)
    expect(c.unread.get('A').unreadCount).toBe(1)
  } finally { await c.close() }
})

it('waits for bootstrap before fixing the visit marker for a Message committed before entry', async () => {
  const history = deferred<Result<TimelinePage>>()
  const c = client(list(1, 0), history.promise)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(c.channels.get()).toMatchObject({ status: 'ready', selectedId: 'A' })
    expect(c.unread.get('A').unreadCount).toBe(0)
    expect(c.sync.get().channels.A.cursor).toBeNull()
    c.read.mockResolvedValue(list(2, 1))
    const id = await c.unread.enter(scope)
    const pendingEntry = c.unread.get('A').entry
    history.resolve(timeline(2))
    await settle()
    expect(c.sync.get().channels.A.cursor).toBe(2)
    expect(c.unread.get('A')).toMatchObject({ unreadCount: 1, entry: {
      id, boundary: 1, unreadAtEntry: 1, firstUnread: { id: record(2).id, created_seq: 2 },
    } })
    expect(pendingEntry).toMatchObject({ id, boundary: null, unreadAtEntry: null })
  } finally { await c.close() }
})

it('refetches Unread on reselection when the inactive sync window dropped live evidence', async () => {
  const c = client(list(1, 1, 0), Promise.resolve(timeline(1)))
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(c.channels.get()).toMatchObject({ status: 'ready', selectedId: 'A' })
    await c.connect()
    c.net.subscribed('A', 1)
    for (let seq = 2; seq <= 52; seq++) c.net.event({ type: 'message', kind: 'create', seq, message: record(seq) })
    await settle()
    expect(c.sync.get().channels.A.cursor).toBe(52)
    expect(c.unread.get('A').unreadCount).toBe(52)

    c.channels.selectHint('B')
    await settle()
    expect(c.sync.get().channels.A).toMatchObject({ watched: false, cursor: 52 })
    expect(c.sync.get().channels.A.messages).toHaveLength(50)
    const reads = c.read.mock.calls.length
    const response = deferred<Result<ChannelList>>()
    c.read.mockReturnValueOnce(response.promise)

    c.channels.selectHint('A')
    await settle()
    expect(c.sync.get().channels.A).toMatchObject({ watched: true, cursor: 52 })
    expect(c.unread.get('A').unreadCount).toBeNull()
    expect(c.read).toHaveBeenCalledTimes(reads + 1)
    response.resolve(list(52, 52, 0))
    await settle()
    expect(c.unread.get('A').unreadCount).toBe(52)
  } finally { await c.close() }
})
