import { afterEach, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record } from './adapter-test-helpers.svelte'
import type { ListTimelineQuery, TimelinePage, Result } from './api'
import { createSession } from './session'
import { deferred } from './topic-test-helpers'
import { flushSearch, isProbe } from './search-main-test-helpers'

const generation = record(1).history_generation
const page = (positions: number[], has_more = false): Result<TimelinePage> =>
  ok({ history_generation: generation, as_of_seq: 100, items: positions.map(seq => ({ kind: 'message', message: record(seq) })), has_more })
const hit40 = { channelId: 'A', messageId: 'id40', createdSeq: 40 }
const hit70 = { ...hit40, messageId: 'id70', createdSeq: 70 }
const historyPage = (query?: ListTimelineQuery) => {
  if (query && isProbe(query)) return page([])
  if (query?.after_position === 39) return page([40])
  if (query?.before_position === 40) return page([30])
  if (query?.after_position === 69) return page([70])
  if (query?.before_position === 70) return page([60])
  throw new Error('Unexpected history query')
}

async function client(read: (query?: ListTimelineQuery, signal?: AbortSignal) => Promise<Result<TimelinePage>>) {
  const net = fakeNetwork()
  const options = net.options()
  net.pages.A = ok({ history_generation: generation, as_of_seq: 100, messages: [record(99), record(100)], has_more: false })
  const onEnded = vi.fn()
  const session = createSession({ ...options, selfId: 'me', onEnded,
    topicsApi: { ...options.topicsApi!, listTimeline: (id, query, signal) =>
      signal ? read(query, signal) : options.topicsApi!.listTimeline(id, query) },
  })
  net.socket.onReady()
  net.lists[0].resolve(ok({ history_generation: generation, channels: [channel('A')] }))
  await flushSearch()
  net.subscribed('A', 100)
  await flushSearch()
  return { session, anchor: session.searchAnchor, onEnded }
}

afterEach(() => vi.useRealTimers())

it('keeps at most one in-flight Search transport across cancellation and 10-second timeout retry while preserving late access handling', async () => {
  vi.useFakeTimers()
  const delayed = deferred<Result<TimelinePage>>()
  const read = vi.fn(async (query?: ListTimelineQuery, _signal?: AbortSignal) =>
    query?.after_position === 39 ? delayed.promise : historyPage(query))
  const first = await client(read)
  try {
    first.anchor.open(hit40)
    await flushSearch()
    expect(read).toHaveBeenCalledTimes(2)
    first.anchor.open(hit70)
    await flushSearch()
    expect(read).toHaveBeenCalledTimes(2)
    expect(first.anchor.get()).toMatchObject({ target: hit70, status: 'loading' })
    expect(read.mock.calls[1][1]?.aborted).toBe(true)

    delayed.resolve(page([40]))
    await flushSearch()
    expect(first.anchor.get()).toMatchObject({ target: hit70, status: 'ready', messages: [record(60), record(70)] })
    const signals = read.mock.calls.map(([, signal]) => signal)
    expect(new Set(signals).size).toBe(5)
    expect(signals.slice(2).map(signal => signal?.aborted)).toEqual([false, false, false])
  } finally {
    first.session.close()
  }

  let aborted = false
  const abortable = vi.fn(async (query?: ListTimelineQuery, _signal?: AbortSignal) => historyPage(query))
    .mockImplementationOnce((_query, signal) => new Promise(resolve => {
      signal?.addEventListener('abort', () => {
        aborted = true
        resolve({ ok: false, kind: 'network' })
      }, { once: true })
    }))
  const second = await client(abortable)
  try {
    second.anchor.open(hit40)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(second.anchor.get()?.status).toBe('loading')
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(second.anchor.get()?.status).toBe('error')
    expect(aborted).toBe(true)

    await second.anchor.retry()
    expect(abortable).toHaveBeenCalledTimes(4)
    expect(second.anchor.get()).toMatchObject({ status: 'ready', messages: [record(30), record(40)] })
  } finally {
    second.session.close()
  }

  for (const refusal of [
    { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' },
    { ok: false, kind: 'http', status: 401 },
  ] as const) {
    const late = deferred<Result<TimelinePage>>()
    const retry = deferred<Result<TimelinePage>>()
    const third = await client(vi.fn(async () => retry.promise).mockImplementationOnce(() => late.promise))
    try {
      third.anchor.open(hit40)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(third.anchor.get()?.status).toBe('error')
      void third.anchor.retry()
      await flushSearch()
      late.resolve(refusal)
      await flushSearch()
      if (refusal.status === 404) {
        expect(third.session.sync.get().organization).toBe('unavailable')
        expect(third.anchor.get()?.status).toBe('missing')
      } else expect(third.onEnded).toHaveBeenCalledOnce()
    } finally {
      third.session.close()
    }
  }
})

it('releases the Search queue when a transport never settles so Retry and opening another hit succeed within their own deadlines', async () => {
  vi.useFakeTimers()
  for (const next of [hit40, hit70]) {
    const late = deferred<Result<TimelinePage>>()
    const read = vi.fn(async (query?: ListTimelineQuery) => historyPage(query)).mockImplementationOnce(() => late.promise)
    const { anchor, session } = await client(read)
    try {
      anchor.open(hit40)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(anchor.get()?.status).toBe('error')
      if (next === hit40) await anchor.retry()
      else anchor.open(next)
      await flushSearch()
      const messages = [record(next.createdSeq - 10), record(next.createdSeq)]
      expect(anchor.get()).toMatchObject({ target: next, status: 'ready', messages })

      late.resolve(page([40]))
      await flushSearch()
      expect(anchor.get()).toMatchObject({ target: next, status: 'ready', messages })
    } finally {
      session.close()
    }
  }

  const stalled = deferred<Result<TimelinePage>>()
  const read = vi.fn(async (query?: ListTimelineQuery) => historyPage(query))
    .mockImplementationOnce(() => stalled.promise)
    .mockImplementationOnce(() => stalled.promise)
  const { anchor, session } = await client(read)
  try {
    anchor.open(hit40)
    await vi.advanceTimersByTimeAsync(100)
    anchor.open(hit70)
    await vi.advanceTimersByTimeAsync(9_899)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(99)
    expect(anchor.get()?.status).toBe('loading')
    await vi.advanceTimersByTimeAsync(1)
    expect(anchor.get()).toMatchObject({ target: hit70, status: 'error', paging: false })

    await anchor.retry()
    expect(anchor.get()).toMatchObject({ target: hit70, status: 'ready', messages: [record(60), record(70)] })

    read.mockClear().mockImplementationOnce(() => stalled.promise)
    anchor.open(hit40)
    await flushSearch()
    anchor.open(hit70)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(anchor.get()).toMatchObject({ target: hit70, status: 'error', paging: false })
  } finally {
    session.close()
  }
})

it('carries one 10-second deadline across an initial attempt and its snapshot_expired retry', async () => {
  vi.useFakeTimers()
  const companion = deferred<Result<TimelinePage>>()
  const retry = deferred<Result<TimelinePage>>()
  const read = vi.fn(async (query?: ListTimelineQuery) => historyPage(query))
    .mockImplementationOnce(async () => page([]))
    .mockImplementationOnce(async () => page([40]))
    .mockImplementationOnce(() => companion.promise)
    .mockImplementationOnce(() => retry.promise)
  const { anchor, session } = await client(read)
  try {
    anchor.open(hit40)
    await vi.advanceTimersByTimeAsync(9_900)
    companion.resolve({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
    await flushSearch()
    expect(read).toHaveBeenCalledTimes(4)
    expect(anchor.get()?.status).toBe('loading')
    await vi.advanceTimersByTimeAsync(100)
    expect(anchor.get()).toMatchObject({ status: 'error', paging: false })
  } finally {
    session.close()
  }
})

it('serialises all search read operations so at most one read runs at a time and queued paging is never dropped', async () => {
  const older = deferred<Result<TimelinePage>>()
  const read = vi.fn(async (query?: ListTimelineQuery) => {
    if (query && isProbe(query)) return page([])
    if (query?.after_position === 39) return page([40], true)
    if (query?.before_position === 40) return page([30], true)
    if (query?.before_position === 30) return older.promise
    if (query?.after_position === 40) return page([50])
    throw new Error('Unexpected history query')
  })
  const { anchor, session } = await client(read)
  try {
    anchor.open(hit40)
    await flushSearch()
    const previous = anchor.loadOlder()
    const next = anchor.loadNewer()
    await flushSearch()
    expect(read).toHaveBeenCalledTimes(4)
    older.resolve(page([20]))
    await previous
    await next
    expect(read).toHaveBeenCalledTimes(5)
    expect(anchor.get()?.messages).toEqual([20, 30, 40, 50].map(seq => record(seq)))
    expect(session.sync.get().channels.A.cursor).toBe(100)
  } finally {
    session.close()
  }
})
