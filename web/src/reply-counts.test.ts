import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message, ReplyCountPage, Result } from './api'
import { createReplyCounts, type ReplyCountsApi } from './reply-counts'
import { deferred, ok, reply, replyClient, root } from './reply-test-helpers'
import { flush } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())
const generation = '00000000-0000-4000-8000-000000000515'
const nextGeneration = '00000000-0000-4000-8000-000000000516'
const page = (as_of_seq: number, reply_count: number): ReplyCountPage => ({ history_generation: generation, as_of_seq, counts: [{ message_id: 'id1', root_id: 'id1', reply_count }] })
async function client(baseline = page(1, 51)) {
  const c = replyClient(); await c.boot()
  const read = vi.fn<ReplyCountsApi>(async () => ok(baseline))
  let messages: Message[] = [], listener = () => {}
  const counts = createReplyCounts(c.sync, { replies: c.replies, topics: {
    countMessages: () => [messages], subscribe(fn) { listener = () => fn(new Set(['A'])); return () => { listener = () => {} } },
  } }, { api: read, requestTimeoutMs: 5000, random: () => 0.5, onSessionEnded: c.onSessionEnded })
  await flush()
  return { ...c, read, counts,
    project(next: Message[]) { messages = next; listener() },
    async close() { counts.close(); await c.sync.close(); expect(vi.getTimerCount()).toBe(0) },
  }
}

it('paging and root body eviction preserve authoritative totals while a child remains loaded and cold opens share that total', async () => {
  const c = await client(page(10_000, 5000))
  expect(c.sync.get().channels.A.cursor).toBe(1)
  expect(c.counts.get('A').id1).toBe(5000)
  c.project(Array.from({ length: 250 }, (_, i) => reply(i + 600)))
  expect(c.counts.get('A').id1).toBe(5000)
  // Evict the root from sync while retaining only a descendant in the projection.
  for (let seq = 2; seq <= 411; seq++) c.event({ ...root(), id: `other${seq}`, client_message_id: `other${seq}`, created_seq: seq, version: seq })
  c.project([reply(600)])
  await flush()
  expect(c.sync.get().channels.A.messages.some(m => m.id === 'id1')).toBe(false)
  expect(c.sync.get().channels.A.cursor).toBe(411)
  expect(c.counts.get('A').id1).toBe(5000)
  const reads = c.read.mock.calls.filter(([, body]) => body.ids.includes('id1')).length
  await c.replies.open('A', reply(600)); await flush()
  expect(c.counts.get('A').id1).toBe(5000)
  expect(c.read.mock.calls.filter(([, body]) => body.ids.includes('id1'))).toHaveLength(reads)
  await c.close()
})

it('merges duplicate tracked roots and batches at most 100 ids without projection-derived counts', async () => {
  const c = await client()
  c.read.mockImplementation(async (_channel, body) => ok({ history_generation: generation, as_of_seq: 1000, counts: body.ids.map(id => ({ message_id: id, root_id: id, reply_count: 9999 })) }))
  const completed = deferred<void>()
  const release = c.counts.subscribe(() => {
    if (Object.values(c.counts.get('A')).filter(count => count === 9999).length === 205) completed.resolve()
  })
  c.project(Array.from({ length: 205 }, (_, i) => ({ ...root(), id: `r${i}` })).flatMap(m => [m, m]))
  await completed.promise; release()
  expect(c.read.mock.calls.slice(1).map(([, body]) => body.ids.length)).toEqual([100, 100, 5])
  expect(new Set(c.read.mock.calls.slice(1).flatMap(([, body]) => body.ids)).size).toBe(205)
  expect(c.counts.get('A').r204).toBe(9999)
  await c.close()
})

it('delayed baseline reconciles a live Reply once and duplicate replay cannot change the total', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
  await c.sync.watch('A'); await flush()
  c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
  c.event(reply(2)); c.event(reply(2)); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  pending.resolve(ok(page(1, 51))); await flush()
  expect(c.counts.get('A').id1).toBe(52)
  c.event(reply(2)); expect(c.counts.get('A').id1).toBe(52)
  expect(c.sync.get().channels.A.cursor).toBe(2)
  await c.close()
})

it('overflow becomes unresolved aborts the stale response and refetches after backoff despite forgotten duplicate replay', async () => {
  const c = await client(), old = deferred<Result<ReplyCountPage>>(), fresh = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  await c.sync.watch('A'); await flush()
  c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
  const oldSignal = c.read.mock.calls.at(-1)![2]
  for (let seq = 2; seq <= 402; seq++) c.event(reply(seq))
  expect(c.counts.get('A').id1).toBeNull()
  expect(oldSignal.aborted).toBe(true)
  for (let seq = 2; seq <= 402; seq++) c.event(reply(seq))
  old.resolve(ok(page(1, 51))); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  const starts = c.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(250)
  expect(c.read).toHaveBeenCalledTimes(starts)
  await vi.advanceTimersByTimeAsync(1)
  expect(c.read).toHaveBeenCalledTimes(starts + 1)
  fresh.resolve(ok(page(402, 452))); await flush()
  expect(c.counts.get('A').id1).toBe(452)
  c.event(reply(402)); expect(c.counts.get('A').id1).toBe(452)
  await c.close()
})

it('terminal loss clears counts cancels requests and fences late success without a refetch', async () => {
  for (const loss of ['channel_access_lost', 'unwatch', 'organization', 'session', 'close'] as const) {
    const c = await client(), pending = deferred<Result<ReplyCountPage>>()
    await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
    await c.sync.watch('A'); await flush()
    c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
    const signal = c.read.mock.calls.at(-1)![2], starts = c.read.mock.calls.length
    if (loss === 'channel_access_lost') c.handlers[0].onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    else if (loss === 'unwatch') await c.sync.unwatch('A')
    else if (loss === 'organization') await c.sync.unavailable()
    else if (loss === 'session') await c.sync.replaceSession('next')
    else c.counts.close()
    expect(c.counts.get('A')).toEqual({}); expect(signal.aborted).toBe(true)
    pending.resolve(ok(page(500, 9000))); await flush()
    expect(c.counts.get('A')).toEqual({})
    expect(c.read).toHaveBeenCalledTimes(starts)
    await c.close()
  }
})

it('access regrant fences the old watch lifetime while a new baseline stays authoritative', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
  await c.sync.watch('A'); await flush()
  c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
  c.handlers[0].onEvent({ type: 'channel_access_lost', channel_id: 'A' }); await flush()
  c.read.mockResolvedValueOnce(ok(page(1, 7)))
  await c.sync.watch('A'); await flush()
  expect(c.counts.get('A').id1).toBe(7)
  pending.resolve(ok(page(500, 999))); await flush()
  expect(c.counts.get('A').id1).toBe(7)
  await c.close()
})

it('reconnect refetches totals and replay does not double count before or after the new watermark', async () => {
  const c = await client()
  c.event(reply(2)); expect(c.counts.get('A').id1).toBe(52)
  c.handlers[0].onClose(1006); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  c.read.mockResolvedValueOnce(ok(page(2, 52)))
  await vi.advanceTimersByTimeAsync(1000)
  c.handlers.at(-1)!.onReady(); await flush()
  c.event(reply(2)); c.event(reply(3)); c.event(reply(3)); await flush()
  expect(c.counts.get('A').id1).toBe(53)
  await c.close()
})

it('same Session late 401 remains authoritative after timeout while replacement fences old Session 401', async () => {
  for (const replace of [false, true]) {
    const c = await client(), pending = deferred<Result<ReplyCountPage>>()
    await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
    await c.sync.watch('A'); await flush()
    if (replace) await c.sync.replaceSession('next')
    else await vi.advanceTimersByTimeAsync(5000)
    pending.resolve({ ok: false, kind: 'http', status: 401 }); await flush()
    expect(c.onSessionEnded).toHaveBeenCalledTimes(replace ? 0 : 1)
    await c.close()
  }
})

it('complete history eviction and retracking fence the pre-eviction response even in one watch lifetime', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  const only = { ...root(), id: 'projection-root' }
  c.read.mockReturnValueOnce(pending.promise)
  c.project([only]); await flush()
  const signal = c.read.mock.calls.at(-1)![2]
  c.project([]); c.project([only]); await flush()
  expect(signal.aborted).toBe(true)
  expect(c.counts.get('A')['projection-root']).toBeNull()
  pending.resolve(ok({ history_generation: generation, as_of_seq: 100, counts: [{ message_id: only.id, root_id: only.id, reply_count: 900 }] })); await flush()
  expect(c.counts.get('A')['projection-root']).toBeNull()
  await c.close()
})

it('a cold child without a loaded root requests the root total through the same endpoint', async () => {
  const c = await client()
  const child = { ...reply(7), id: 'isolated-child', reply_root_id: 'isolated-root' }
  c.read.mockImplementationOnce(async (_channel, body) => ok({ history_generation: generation, as_of_seq: 20, counts: body.ids.map(id => ({ message_id: id, root_id: id, reply_count: 777 })) }))
  c.listReplyChain.mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 20, root_id: 'isolated-root', messages: [child], has_more: false }))
  await c.replies.open('A', child); await flush()
  expect(c.read).toHaveBeenLastCalledWith('A', { history_generation: generation, ids: ['isolated-root'] }, expect.any(AbortSignal))
  expect(c.counts.get('A')['isolated-root']).toBe(777)
  expect(c.replies.get('A').messages.some(m => m.id === 'isolated-root')).toBe(false)
  await c.close()
})

it('C8 clamp fences late snapshots and clears pre-restore evidence above the rewound watermark', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  c.event(reply(2)); expect(c.counts.get('A').id1).toBe(52)
  c.handlers[0].onClose(1006)
  c.read.mockReturnValueOnce(pending.promise)
  await vi.advanceTimersByTimeAsync(1000)
  c.handlers.at(-1)!.onReady(); await flush()
  c.read.mockResolvedValueOnce(ok(page(1, 3)))
  c.handlers.at(-1)!.onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 0 }); await flush()
  pending.resolve(ok(page(100, 9000))); await flush()
  expect(c.counts.get('A').id1).toBe(3)
  await c.close()
})

it('Edit Delete and Move events stay unresolved until a covering refetch without mutation deltas', async () => {
  for (const kind of ['edit', 'delete', 'move'] as const) {
    const c = await client(), pending = deferred<Result<ReplyCountPage>>()
    c.read.mockReturnValueOnce(pending.promise)
    c.handlers[0].onEvent({ type: 'message', kind, seq: 2, message: { ...root(), version: 2, deleted: kind === 'delete' } })
    expect(c.counts.get('A').id1).toBeNull()
    await flush()
    pending.resolve(ok(page(2, 51))); await flush()
    expect(c.counts.get('A').id1).toBe(51)
    await c.close()
  }
})

it('own ACK before echo and history before stream never hide creation evidence or count a duplicate twice', async () => {
  const c = await client()
  await c.replies.open('A', root())
  await c.replies.send('A', 'own Reply'); await flush()
  expect(c.counts.get('A').id1).toBe(52)
  const own = c.sync.get().channels.A.messages.find(m => m.sender === 'me')!
  c.event(own); c.event(own); await flush()
  expect(c.counts.get('A').id1).toBe(52)
  // A projection body can arrive before its event; it proves no count suffix itself.
  await c.sync.settleHistory('A', [reply(5)])
  expect(c.counts.get('A').id1).toBe(52)
  c.event(reply(5)); await flush()
  // The intentionally missing positions start gap recovery, which discards the old count baseline.
  // The refetch covers the history and the replay suffix reconciles independently.
  expect(c.counts.get('A').id1).toBe(53)
  await c.close()
})

it('current count denials apply C9 or C10 while stale Channel denials cannot end a regranted lifetime', async () => {
  for (const organization of [false, true]) {
    const c = await client()
    await c.sync.watch('B'); await flush()
    await c.sync.unwatch('A')
    c.read.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: organization ? 'organization_unavailable' : 'channel_not_found' })
    await c.sync.watch('A'); await flush()
    expect(c.counts.get('A')).toEqual({})
    expect(c.sync.get().organization).toBe(organization ? 'unavailable' : 'available')
    expect(c.counts.get('B')).toEqual(organization ? {} : { id1: 51 })
    await c.close()
  }
  const c = await client(), old = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(old.promise)
  await c.sync.watch('A'); await flush()
  await c.sync.unwatch('A'); await c.sync.watch('A'); await flush()
  old.resolve({ ok: false, kind: 'http', status: 404, error: 'channel_not_found' }); await flush()
  expect(c.counts.get('A').id1).toBe(51)
  expect(c.sync.get().channels.A.state).not.toBe('unavailable')
  await c.close()
})

it('timeouts abort and fence late successes while Retry-After prevents an early count retry', async () => {
  const c = await client(), old = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(old.promise)
  await c.sync.watch('A'); await flush()
  const signal = c.read.mock.calls.at(-1)![2]
  await vi.advanceTimersByTimeAsync(5000)
  expect(signal.aborted).toBe(true)
  old.resolve(ok(page(1, 9000))); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  c.read.mockResolvedValueOnce({ ok: false, kind: 'network', retryAfterMs: 3000 })
  await vi.advanceTimersByTimeAsync(251)
  const starts = c.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(2999)
  expect(c.read).toHaveBeenCalledTimes(starts)
  await vi.advanceTimersByTimeAsync(1)
  expect(c.read).toHaveBeenCalledTimes(starts + 1)
  expect(c.counts.get('A').id1).toBe(51)
  await c.close()
})

it('a current Reply count snapshot with a different Organization generation is rejected through history recovery', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>(), bootstrap = deferred<never>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
  await c.sync.watch('A'); await flush()
  c.listMessages.mockReturnValue(bootstrap.promise)
  const epoch = c.sync.get().historyEpoch
  pending.resolve(ok({ ...page(9000, 9000), history_generation: nextGeneration })); await flush()
  expect(c.counts.get('A').id1).not.toBe(9000)
  expect(c.sync.get().historyEpoch).toBe(epoch + 1)
  expect(c.sync.get().historyGeneration).toBe(nextGeneration)
  await c.close()
})

it('Organization generation changes fence old count snapshots and converge below retired floors without old evidence', async () => {
  const c = await client(), old = deferred<Result<ReplyCountPage>>(), fresh = deferred<Result<ReplyCountPage>>()
  c.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  for (let seq = 2; seq <= 402; seq++) c.event(reply(seq))
  await vi.advanceTimersByTimeAsync(251)
  const signal = c.read.mock.calls.at(-1)![2]
  c.event(reply(403))
  c.listMessages.mockResolvedValue(ok({ history_generation: nextGeneration, as_of_seq: 1,
    messages: [{ ...root(), history_generation: nextGeneration }], has_more: false }))
  c.sync.observeHistoryGeneration(nextGeneration); await flush()
  expect(signal.aborted).toBe(true)
  c.handlers.at(-1)!.onReady(); await flush()
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 1, history_generation: nextGeneration })
  expect(c.read).toHaveBeenLastCalledWith('A', { ids: ['id1'], history_generation: nextGeneration }, expect.any(AbortSignal))
  old.resolve(ok(page(9000, 9000))); await flush()
  expect(c.sync.get().historyGeneration).toBe(nextGeneration)
  expect(c.counts.get('A').id1).toBeNull()
  fresh.resolve(ok({ ...page(1, 3), history_generation: nextGeneration })); await flush()
  expect(c.counts.get('A').id1).toBe(3)
  c.event({ ...reply(2), history_generation: nextGeneration }); await flush()
  expect(c.counts.get('A').id1).toBe(4)
  await c.close()
})

it('Reply count snapshot expiry clears baseline evidence and floor and refetches once without resetting sync', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  c.read.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }).mockReturnValueOnce(pending.promise)
  c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 2, message: { ...root(), version: 2 } })
  c.event(reply(3))
  const cursor = c.sync.get().channels.A.cursor, epoch = c.sync.get().historyEpoch, connection = c.sync.get().connection
  await flush()
  expect(c.read).toHaveBeenCalledTimes(3)
  expect(c.counts.get('A').id1).toBeNull()
  pending.resolve(ok(page(1, 7))); await flush()
  expect(c.counts.get('A').id1).toBe(7)
  expect(c.sync.get()).toMatchObject({ historyEpoch: epoch, connection })
  expect(c.sync.get().channels.A.cursor).toBe(cursor)
  // A fresh request expiring again must remain unresolved without a retry loop.
  c.read.mockResolvedValue({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
  c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 4, message: { ...root(), version: 4 } }); await flush()
  const starts = c.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(c.read).toHaveBeenCalledTimes(starts)
  expect(starts).toBe(5)
  expect(c.counts.get('A').id1).toBeNull()
  await c.close()
})

it('a Reply count generation denial reuses Organization recovery and converges on a fresh lower baseline', async () => {
  const c = await client()
  c.listMessages.mockResolvedValue(ok({ history_generation: nextGeneration, as_of_seq: 1,
    messages: [{ ...root(), history_generation: nextGeneration }], has_more: false }))
  c.read.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'history_generation_changed' })
    .mockResolvedValueOnce(ok({ ...page(1, 3), history_generation: nextGeneration }))
  c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 2, message: { ...root(), version: 2 } }); await flush()
  expect(c.sync.get().historyEpoch).toBe(1)
  expect(c.sync.get().historyGeneration).toBe(nextGeneration)
  c.handlers.at(-1)!.onReady(); await flush()
  expect(c.counts.get('A').id1).toBe(3)
  c.event({ ...reply(2), history_generation: nextGeneration }); await flush()
  expect(c.counts.get('A').id1).toBe(4)
  expect(c.onSessionEnded).not.toHaveBeenCalled()
  await c.close()
})

it('sync snapshot expiry resets Reply counts through the R5 recovery path and fences the pending snapshot', async () => {
  const c = await client(), old = deferred<Result<ReplyCountPage>>()
  c.project([reply(600)])
  c.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok(page(1, 7)))
  c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 2, message: { ...root(), version: 2 } }); await flush()
  const signal = c.read.mock.calls.at(-1)![2], epoch = c.sync.get().historyEpoch, connection = c.sync.get().connection
  c.listMessages.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
  await c.sync.getTimeline('A').loadLatest(); await flush()
  expect(signal.aborted).toBe(true)
  expect(c.counts.get('A').id1).toBe(7)
  old.resolve(ok(page(9000, 9000))); await flush()
  expect(c.counts.get('A').id1).toBe(7)
  expect(c.sync.get()).toMatchObject({ historyEpoch: epoch, connection })
  expect(c.sync.get().channels.A.cursor).toBe(2)
  await c.close()
})
