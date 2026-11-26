import { msg, replyPage, summary, topicClient } from './topic-test-helpers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message, ReplyCountPage, Result } from './api'
import { createReplyCounts, type ReplyCountsApi } from './reply-counts'
import { deferred, ok, reply, replyClient, root } from './reply-test-helpers'
import { flush } from './sync-test-helpers'
import { moveEvent } from './protocol-test-helpers'
import { createReplies } from './replies'
import { repliesAdapter } from './replies.svelte'

const observed = vi.hoisted(() => ({ input: vi.fn() }))
vi.mock('#sync-core', async importOriginal => {
  const original = await importOriginal<typeof import('#sync-core')>()
  return { ...original, createReplyCountCore() {
    const core = original.createReplyCountCore()
    return { ...core, step(input: import('./reply-count-core').CountInput) { observed.input(input); return core.step(input) } }
  } }
})

async function watch(c: ReturnType<typeof replyClient>, channel = 'A') {
  await c.sync.watch(channel)
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: channel, caught_up_seq: c.sync.get().channels[channel].cursor ?? 0, history_generation: c.sync.get().historyGeneration ?? generation })
  await flush()
}
function subscribed(c: ReturnType<typeof replyClient>, seq = c.sync.get().channels.A.cursor ?? 0) {
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: seq, history_generation: c.sync.get().historyGeneration ?? generation })
}

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
  } }, { api: read, requestTimeoutMs: 5000, random: () => 0.5 })
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
  await watch(c)
  c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
  c.event(reply(2)); c.event(reply(2)); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  pending.resolve(ok(page(1, 51))); await flush()
  expect(c.counts.get('A').id1).toBe(52)
  c.event(reply(2)); expect(c.counts.get('A').id1).toBe(52)
  expect(c.sync.get().channels.A.cursor).toBe(2)
  await c.close()
})

it('overflow fences its stale ticket while allowing the batch to finish before a covering refetch', async () => {
  const c = await client(), old = deferred<Result<ReplyCountPage>>(), fresh = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  await watch(c)
  c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
  const oldSignal = c.read.mock.calls.at(-1)![2]
  for (let seq = 2; seq <= 402; seq++) c.event(reply(seq))
  expect(c.counts.get('A').id1).toBeNull()
  expect(oldSignal.aborted).toBe(false)
  for (let seq = 2; seq <= 402; seq++) c.event(reply(seq))
  old.resolve(ok(page(1, 51))); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  expect(c.read).toHaveBeenCalledTimes(3)
  fresh.resolve(ok(page(402, 452))); await flush()
  expect(c.counts.get('A').id1).toBe(452)
  c.event(reply(402)); expect(c.counts.get('A').id1).toBe(452)
  await c.close()
})

it('terminal loss clears counts cancels requests and fences late success without a refetch', async () => {
  for (const loss of ['channel_access_lost', 'unwatch', 'organization', 'session', 'close'] as const) {
    const c = await client(), pending = deferred<Result<ReplyCountPage>>()
    await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
    await watch(c)
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
  await watch(c)
  c.handlers[0].onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 1 })
  c.handlers[0].onEvent({ type: 'channel_access_lost', channel_id: 'A' }); await flush()
  c.read.mockResolvedValueOnce(ok(page(1, 7)))
  await watch(c)
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
  c.handlers.at(-1)!.onReady(); await flush(); subscribed(c); await flush()
  c.event(reply(2)); c.event(reply(3)); c.event(reply(3)); await flush()
  expect(c.counts.get('A').id1).toBe(53)
  await c.close()
})

it('same Session late 401 remains authoritative after timeout while replacement fences old Session 401', async () => {
  for (const replace of [false, true]) {
    const c = await client(), pending = deferred<Result<ReplyCountPage>>()
    await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
    await watch(c)
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
  expect(signal.aborted).toBe(false)
  expect(c.counts.get('A')['projection-root']).toBeNull()
  pending.resolve(ok({ history_generation: generation, as_of_seq: 100, counts: [{ message_id: only.id, root_id: only.id, reply_count: 900 }] })); await flush()
  expect(c.counts.get('A')['projection-root']).toBeNull()
  await c.close()
})

it('a cold child without a loaded root requests the root total through the same endpoint', async () => {
  const c = await client()
  const child = { ...reply(7), id: 'isolated-child', reply_root_id: 'isolated-root' }
  c.read.mockImplementationOnce(async (_channel, body) => ok({ history_generation: generation, as_of_seq: 20, counts: body.ids.map(id => ({ message_id: id, root_id: id, reply_count: 777 })) }))
  c.listReplyChain.mockResolvedValueOnce(ok(replyPage({ history_generation: generation, as_of_seq: 20, root_id: 'isolated-root', messages: [child], has_more: false })))
  await c.replies.open('A', child); await flush()
  expect(c.read).toHaveBeenLastCalledWith('A', { history_generation: generation, ids: ['isolated-root'] }, expect.any(AbortSignal))
  expect(c.counts.get('A')['isolated-root']).toBe(777)
  expect(c.replies.get('A').messages.some(m => m.id === 'isolated-root')).toBe(false)
  await c.close()
})

it('C8 clamp fences late snapshots and clears pre-restore evidence above the rewound watermark', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  c.event(reply(2)); expect(c.counts.get('A').id1).toBe(52)
  c.read.mockReturnValueOnce(pending.promise)
  c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 3, message: { ...root(), version: 3 } }); await flush()
  const signal = c.read.mock.calls.at(-1)![2]
  c.handlers[0].onClose(1006)
  await vi.advanceTimersByTimeAsync(1000)
  c.handlers.at(-1)!.onReady(); await flush()
  c.read.mockResolvedValueOnce(ok(page(1, 3)))
  c.handlers.at(-1)!.onEvent({ history_generation: generation, type: 'subscribed', channel_id: 'A', caught_up_seq: 0 }); await flush()
  subscribed(c); await flush()
  expect(signal.aborted).toBe(true)
  pending.resolve(ok(page(100, 9000))); await flush()
  expect(c.counts.get('A').id1).toBe(3)
  await c.close()
})

it('Edit Delete and Move events stay unresolved until a covering refetch without mutation deltas', async () => {
  for (const kind of ['edit', 'delete', 'move'] as const) {
    const c = await client(), pending = deferred<Result<ReplyCountPage>>()
    if (kind === 'move') { await c.replies.open('A', root()); await flush() }
    c.read.mockReturnValueOnce(pending.promise)
    c.handlers[0].onEvent(kind === 'move' ? moveEvent(2) : { type: 'message', kind, seq: 2, message: { ...root(), version: 2, deleted: kind === 'delete' } })
    expect(c.counts.get('A').id1).toBeNull()
    await flush()
    pending.resolve(ok(page(2, 51))); await flush()
    expect(c.counts.get('A').id1).toBe(51)
    await c.close()
  }
})

it('Move refetches source and destination Topic counts once despite repeats', async () => {
  // A client holds one open Topic per Channel. Exercise both views of the same Move.
  for (const topic of ['source', 'destination']) {
    const c = topicClient()
    const source = topic === 'source'
    const resident = msg(source ? 3 : 4, topic)
    const chain = [root('source'), reply(2, 'id1', 'source')]
    const before = source ? [...chain, resident] : [resident]
    const after = source ? [resident] : [...chain.map(m => ({ ...m, topic_id: topic, version: 11 })), resident]
    const snapshot = (as_of_seq: number, messages: Message[]) => ok({ history_generation: generation, as_of_seq, messages, has_more: false })
    c.topicsApi.listTimeline.mockImplementation(async () => ok({
      history_generation: generation, as_of_seq: 10, items: [], has_more: false,
    }))
    c.topicsApi.listTopicMessages.mockResolvedValueOnce(snapshot(10, before)).mockResolvedValueOnce(snapshot(11, after))
    c.topicsApi.getTopicSummary.mockResolvedValue(ok({
      history_generation: generation, as_of_seq: 11, topic: summary(topic, resident.created_seq, after.length),
    }))
    const replies = createReplies(c.sync, { api: { listReplyChain: vi.fn() } })
    const started = deferred<void>(), pending = deferred<Result<ReplyCountPage>>()
    const baseline = (seq: number, ids: string[]) => ok({
      history_generation: generation, as_of_seq: seq,
      counts: ids.map(id => ({ message_id: id, root_id: id, reply_count: id === 'id1' ? 51 : 0 })),
    })
    const read = vi.fn<ReplyCountsApi>()
      .mockImplementationOnce(async (_channel, { ids }) => baseline(10, ids))
      .mockImplementationOnce(() => { started.resolve(); return pending.promise })
    const counts = createReplyCounts(c.sync, { replies, topics: c.topics }, { api: read })
    const view = repliesAdapter(replies, 'A', counts)
    const waitForCount = (id: string, expected: number) => new Promise<void>(resolve => {
      if (view.counts[id] === expected) { resolve(); return }
      const stop = counts.subscribe(() => {
        if (view.counts[id] === expected) { stop(); resolve() }
      })
    })
    try {
      await c.boot()
      await c.topics.loadTopic('A', topic)
      await waitForCount(resident.id, 0)
      expect(view.counts.id1).toBe(source ? 51 : undefined)
      const move = { ...moveEvent(11), source_topic_id: 'source' }
      const late = { ...moveEvent(9), destination_topic_id: 'source' }
      c.topicsApi.listTimeline.mockResolvedValueOnce(ok({
        history_generation: generation, as_of_seq: 11, items: [], has_more: false,
      }))
      c.listMessages.mockResolvedValue(snapshot(11, []))
      c.handlers[0].onEvent(move)
      expect(view.counts.id1 ?? null).toBeNull()
      expect(view.counts[resident.id] ?? null).toBeNull()

      await started.promise
      const refetch = read.mock.calls[1]
      const ids = source ? [resident.id] : ['id1', resident.id]
      expect(refetch[1]).toEqual({ ids, history_generation: generation })
      expect(c.topicsApi.listTopicMessages.mock.calls).toEqual([
        ['A', topic, { history_generation: generation }],
        ['A', topic, { history_generation: generation }],
      ])
      expect(c.topics.get('A').topic(topic)).toMatchObject({ initialized: true, messages: after })
      const timelineReads = c.topicsApi.listTimeline.mock.calls.length
      const messageReads = c.listMessages.mock.calls.length
      c.handlers[0].onEvent(move)
      c.handlers[0].onEvent(late)
      expect(refetch[2].aborted).toBe(false)
      expect(view.counts.id1 ?? null).toBeNull()
      pending.resolve(baseline(11, ids))
      await waitForCount(resident.id, 0)
      expect(view.counts.id1).toBe(source ? undefined : 51)

      c.handlers[0].onEvent(move)
      c.handlers[0].onEvent(late)
      await flush()
      expect(view.counts.id1).toBe(source ? undefined : 51)
      expect(view.counts[resident.id]).toBe(0)
      expect(read).toHaveBeenCalledTimes(2)
      expect(c.topicsApi.listTopicMessages).toHaveBeenCalledTimes(2)
      expect(c.topicsApi.listTimeline).toHaveBeenCalledTimes(timelineReads)
      expect(c.listMessages).toHaveBeenCalledTimes(messageReads)
    } finally {
      counts.close()
      replies.close()
      await c.sync.close()
    }
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
    await watch(c, 'B')
    await c.sync.unwatch('A')
    c.read.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: organization ? 'organization_unavailable' : 'channel_not_found' })
    await watch(c)
    expect(c.counts.get('A')).toEqual({})
    expect(c.sync.get().organization).toBe(organization ? 'unavailable' : 'available')
    expect(c.counts.get('B')).toEqual(organization ? {} : { id1: 51 })
    await c.close()
  }
  const c = await client(), old = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(old.promise)
  await watch(c)
  await c.sync.unwatch('A'); await watch(c)
  old.resolve({ ok: false, kind: 'http', status: 404, error: 'channel_not_found' }); await flush()
  expect(c.counts.get('A').id1).toBe(51)
  expect(c.sync.get().channels.A.state).not.toBe('unavailable')
  await c.close()
})

it('timeouts abort and fence late successes while Retry-After prevents an early count retry', async () => {
  const c = await client(), old = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(old.promise)
  await watch(c)
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
  await watch(c)
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
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 1, history_generation: nextGeneration }); await flush()
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
  c.handlers.at(-1)!.onReady(); await flush(); subscribed(c); await flush()
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

it('neighbouring batch successes cannot replenish a repeatedly expired root budget', async () => {
  const c = await client()
  c.read.mockImplementation(async (_id, body) => c.read.mock.calls.length > 12 ? { ok: false, kind: 'network' } : body.ids.includes('r100')
    ? { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
    : ok({ history_generation: generation, as_of_seq: 1, counts: body.ids.map(id => ({ message_id: id, root_id: id, reply_count: 7 })) }))
  c.project(Array.from({ length: 101 }, (_, i) => ({ ...root(), id: `r${String(i).padStart(3, '0')}` })))
  await flush(); await flush()
  expect(c.read.mock.calls.filter(([, body]) => body.ids.includes('r100'))).toHaveLength(2)
  const starts = c.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  expect(c.read).toHaveBeenCalledTimes(starts)
  expect(c.counts.get('A').r100).toBeNull()
  expect(c.counts.get('A').r000).toBe(7)
  await c.close()
})

it('gap recovery preserves Retry-After and the accumulated count backoff', async () => {
  const c = await client()
  await c.sync.unwatch('A')
  c.read.mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 3000 })
    .mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.sync.watch('A')
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 1, history_generation: generation }); await flush()
  const starts = c.read.mock.calls.length
  c.event(reply(3)); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  expect(c.read).toHaveBeenCalledTimes(starts)
  await vi.advanceTimersByTimeAsync(2999)
  expect(c.read).toHaveBeenCalledTimes(starts)
  await vi.advanceTimersByTimeAsync(1)
  expect(c.read).toHaveBeenCalledTimes(starts + 1)
  await vi.advanceTimersByTimeAsync(500)
  expect(c.read).toHaveBeenCalledTimes(starts + 1)
  await vi.advanceTimersByTimeAsync(1)
  expect(c.read).toHaveBeenCalledTimes(starts + 2)
  await c.close()
})

it('cold projections wait for latest history and a confirmed subscription before reading counts', async () => {
  const c = replyClient(), latest = deferred<Awaited<ReturnType<typeof c.listMessages>>>()
  c.listMessages.mockReturnValueOnce(latest.promise)
  const read = vi.fn<ReplyCountsApi>(async () => ok(page(3, 53)))
  const counts = createReplyCounts(c.sync, { replies: c.replies, topics: {
    countMessages: () => [[root()]], subscribe: () => () => {},
  } }, { api: read })
  await c.sync.start(); c.handlers[0].onReady()
  const watching = c.sync.watch('A'); await flush()
  expect(c.sync.get().channels.A.cursor).toBeNull()
  expect(read).not.toHaveBeenCalled()
  latest.resolve(ok({ history_generation: generation, as_of_seq: 3, messages: [root(), reply(2), reply(3)], has_more: false }))
  await watching; await flush()
  expect(c.sync.get().channels.A.cursor).toBe(3)
  expect(read).not.toHaveBeenCalled()
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3, history_generation: generation }); await flush()
  expect(read).toHaveBeenCalledTimes(1)
  expect(counts.get('A').id1).toBe(53)
  counts.close(); await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})

it('C8 with an open panel waits for rewound latest history and resubscription before the new baseline', async () => {
  const c = await client(), latest = deferred<Awaited<ReturnType<typeof c.listMessages>>>()
  await c.replies.open('A', root())
  c.project([root()])
  c.event(reply(2))
  c.handlers[0].onClose(1006)
  await vi.advanceTimersByTimeAsync(1000)
  c.handlers.at(-1)!.onReady(); await flush()
  c.listMessages.mockReturnValueOnce(latest.promise)
  const starts = c.read.mock.calls.length
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 0, history_generation: generation }); await flush()
  // Its projected root remains tracked after C8 releases the old panel history.
  expect(c.counts.get('A').id1).toBeNull()
  expect(c.read).toHaveBeenCalledTimes(starts)
  latest.resolve(ok({ history_generation: generation, as_of_seq: 3, messages: [root(), reply(2), reply(3)], has_more: false })); await flush()
  expect(c.read).toHaveBeenCalledTimes(starts)
  c.read.mockResolvedValueOnce(ok(page(3, 53)))
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3, history_generation: generation }); await flush()
  expect(c.counts.get('A').id1).toBe(53)
  expect(c.read).toHaveBeenCalledTimes(starts + 1)
  await c.close()
})

it('one invalidated root leaves neighbouring batch tickets running and installs their counts', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  c.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok({ history_generation: generation, as_of_seq: 2,
    counts: [{ message_id: 'r1', root_id: 'r1', reply_count: 43 }] }))
  c.project(['r1', 'r2'].map(id => ({ ...root(), id }))); await flush()
  const signal = c.read.mock.calls.at(-1)![2]
  c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 2, message: { ...root(), id: 'r1', version: 2 } })
  expect(signal.aborted).toBe(false)
  pending.resolve(ok({ history_generation: generation, as_of_seq: 1, counts: ['r1', 'r2'].map(id => ({ message_id: id, root_id: id, reply_count: 42 })) })); await flush()
  expect(c.counts.get('A').r2).toBe(42)
  expect(c.counts.get('A').r1).toBe(43)
  expect(c.read.mock.calls.map(([, body]) => body.ids)).toEqual([['id1'], ['r1', 'r2'], ['r1']])
  await c.close()
})

it('omitted or mismatched root identities stop unresolved after one retry without blocking other roots', async () => {
  for (const malformed of [false, true]) {
    const c = await client()
    c.read.mockImplementation(async (_channel, body) => ok({ history_generation: generation, as_of_seq: 1,
      counts: body.ids.flatMap(id => id === 'bad' ? malformed ? [{ message_id: id, root_id: 'other', reply_count: 999 }] : [] : [{ message_id: id, root_id: id, reply_count: 8 }]) }))
    c.project(['bad', 'good'].map(id => ({ ...root(), id }))); await flush()
    expect(c.counts.get('A').good).toBe(8)
    expect(c.counts.get('A').bad).toBeNull()
    await vi.advanceTimersByTimeAsync(251)
    expect(c.read.mock.calls.filter(([, body]) => body.ids.includes('bad'))).toHaveLength(2)
    const starts = c.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(c.read).toHaveBeenCalledTimes(starts)
    expect(c.counts.get('A').bad).toBeNull()
    await c.close()
  }
})

it('fill pages reconcile Replies above a delayed count watermark once across fill and stream replay', async () => {
  const c = await client(), countsPage = deferred<Result<ReplyCountPage>>(), fill = deferred<Awaited<ReturnType<typeof c.listChannelEvents>>>()
  c.read.mockReturnValueOnce(countsPage.promise)
  c.listChannelEvents.mockReturnValueOnce(fill.promise)
  c.event(reply(3)); await flush()
  countsPage.resolve(ok(page(1, 51))); await flush()
  expect(c.counts.get('A').id1).toBe(52)
  await vi.advanceTimersByTimeAsync(100)
  expect(c.listChannelEvents).toHaveBeenCalledTimes(1)
  fill.resolve(ok({ history_generation: generation, as_of_seq: 3, events: [2, 3].map(seq => ({ type: 'message' as const, kind: 'create' as const, seq, message: reply(seq) })), has_more: false })); await flush()
  expect(c.sync.get().channels.A.cursor).toBe(3)
  expect(c.counts.get('A').id1).toBe(53)
  c.event(reply(2)); c.event(reply(3)); await flush()
  expect(c.counts.get('A').id1).toBe(53)
  await c.close()
})

it('unchanged counts keep identity and do not notify while unrelated Channels avoid projection scans', async () => {
  const c = replyClient(); await c.boot(); await watch(c, 'B')
  const countMessages = vi.fn((_id: string) => []), read = vi.fn<ReplyCountsApi>(async () => ok(page(10, 51)))
  const counts = createReplyCounts(c.sync, { replies: c.replies, topics: { countMessages, subscribe: () => () => {} } }, { api: read })
  await flush()
  const beforeA = counts.get('A'), beforeB = counts.get('B'), listener = vi.fn()
  counts.subscribe(listener); countMessages.mockClear(); observed.input.mockClear()
  c.event(reply(2)); c.event(reply(2)); await flush()
  expect(counts.get('A')).toBe(beforeA)
  expect(counts.get('B')).toBe(beforeB)
  expect(listener).not.toHaveBeenCalled()
  expect(observed.input.mock.calls.filter(([input]) => input.type === 'track')).toHaveLength(0)
  expect(countMessages.mock.calls.every(([id]) => id === 'A')).toBe(true)
  countMessages.mockClear()
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 1, history_generation: generation }); await flush()
  expect(countMessages).not.toHaveBeenCalled()
  await c.replies.open('A', root()); await flush()
  expect(countMessages.mock.calls.length).toBeGreaterThan(0)
  expect(countMessages.mock.calls.every(([id]) => id === 'A')).toBe(true)
  counts.close(); await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
})

it('top level create and ACK seed zero counts without a count POST and later Replies reconcile exactly', async () => {
  const c = await client()
  c.event({ ...root(), id: 'fresh', created_seq: 2, version: 2 }); await flush()
  expect(c.counts.get('A').fresh).toBe(0)
  expect(c.read).toHaveBeenCalledTimes(1)
  c.event({ ...reply(3, 'fresh'), reply_root_id: 'fresh' }); await flush()
  expect(c.counts.get('A').fresh).toBe(1)
  c.sendMessage.mockResolvedValueOnce(ok({ ...root(), id: 'own-root', sender: 'me', created_seq: 4, version: 4 }))
  c.sync.getTimeline('A').setDraft('new root'); await c.sync.getTimeline('A').submit(); await flush()
  expect(c.counts.get('A')['own-root']).toBe(0)
  expect(c.read).toHaveBeenCalledTimes(1)
  await c.close()
})

it('an open panel root takes priority over more than one batch of projected roots', async () => {
  const c = await client(), held = deferred<Result<ReplyCountPage>>()
  c.read.mockReturnValueOnce(held.promise)
  c.project(Array.from({ length: 205 }, (_, i) => ({ ...root(), id: `a${i}` }))); await flush()
  const child = { ...reply(7), reply_root_id: 'z-panel' }
  c.listReplyChain.mockResolvedValueOnce(ok(replyPage({ history_generation: generation, as_of_seq: 7, root_id: 'z-panel', messages: [child], has_more: false })))
  await c.replies.open('A', child); await flush()
  c.read.mockImplementation(async (_channel, body) => ok({ history_generation: generation, as_of_seq: 7, counts: body.ids.map(id => ({ message_id: id, root_id: id, reply_count: 8 })) }))
  const ids = c.read.mock.calls.at(-1)![1].ids
  held.resolve(ok({ history_generation: generation, as_of_seq: 7, counts: ids.map(id => ({ message_id: id, root_id: id, reply_count: 8 })) })); await flush(); await flush()
  expect(c.read.mock.calls[2][1].ids[0]).toBe('z-panel')
  expect(c.counts.get('A')['z-panel']).toBe(8)
  await c.close()
})

it('covered root replay cannot seed zero over history-only Replies while a count snapshot is pending', async () => {
  const c = await client(), pending = deferred<Result<ReplyCountPage>>()
  await c.sync.unwatch('A'); c.read.mockReturnValueOnce(pending.promise)
  await watch(c)
  c.event(root()); await flush()
  expect(c.counts.get('A').id1).toBeNull()
  pending.resolve(ok(page(3, 53))); await flush()
  expect(c.counts.get('A').id1).toBe(53)
  expect(c.read).toHaveBeenCalledTimes(2)
  await c.close()
})
