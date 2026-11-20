import { afterEach, expect, it, vi } from 'vitest'
import { moveChain, type Message, type MessagePage, type MoveChainResponse, type ReplyChainPage, type Result } from './api'
import { createMoveChain, type MoveChainApi } from './move-chain'
import { moveEvent, record } from './protocol-test-helpers'
import { MAIN_MESSAGE_LIMIT, REPLY_MESSAGE_LIMIT } from './protocol-types'
import { deferred, ok, reply, replyClient, root } from './reply-test-helpers'
import { flush } from './sync-test-helpers'

const history_generation = root().history_generation
const receipt = (move_seq: number | null = 21): MoveChainResponse => ({
  history_generation, move_seq, operation_id: 'operation-1', root_id: 'id1', destination_topic_id: 'T',
  chain_version: move_seq ?? 20, operation_version: move_seq ?? 20, topic_id: 'T',
})
const http = (status: number, error: string): Result<never> => ({ ok: false, kind: 'http', status, error })
const anchor = reply(3)
const chainPage = (chain_version: number) => ok({
  history_generation, as_of_seq: chain_version, root_id: 'id1', messages: [root(), anchor], has_more: true, chain_version,
})

afterEach(() => vi.useRealTimers())

async function client(openAt: Message | false = anchor) {
  const c = replyClient()
  const transport = vi.fn<MoveChainApi>(async () => ok(receipt()))
  let seq = 0
  const newId = vi.fn(() => `operation-${++seq}`)
  const move = createMoveChain(c.sync, c.replies, { api: transport, newId, requestTimeoutMs: 20 })
  await c.boot()
  if (openAt) {
    c.listReplyChain.mockResolvedValueOnce(chainPage(20))
    await c.replies.open('A', openAt)
  }
  return { ...c, move, transport, newId }
}

it('posts a generated Move request to the encoded anchor path', async () => {
  const response = receipt()
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response))
  const body = { history_generation, operation_id: response.operation_id, expected_version: 20, topic_id: 'T' }
  await expect(moveChain('org/1', 'channel/2', 'message/3', body, fetch)).resolves.toEqual(ok(response))
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/v1/orgs/org%2F1/channels/channel%2F2/messages/message%2F3/move', {
    credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  fetch.mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '2' } }))
  await expect(moveChain('org', 'A', 'id3', body, fetch)).resolves.toEqual({ ok: false, kind: 'network', retryAfterMs: 2000 })
})

it('uses the full-chain version with either destination and leaves projections to the stream', async () => {
  const c = await client()
  const before = c.replies.get('A')
  expect(before.chainVersion).toBe(20)
  expect(before.messages.at(-1)?.version).toBe(3)
  await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'moved', receipt: receipt() })
  c.transport.mockResolvedValueOnce(ok(receipt(null)))
  await expect(c.move('A', anchor.id, { topicName: 'Release' })).resolves.toEqual({ kind: 'moved', receipt: receipt(null) })
  expect(c.transport.mock.calls).toEqual([
    ['A', anchor.id, { history_generation, operation_id: 'operation-1', expected_version: 20, topic_id: 'T' }],
    ['A', anchor.id, { history_generation, operation_id: 'operation-2', expected_version: 20, topic_name: 'Release' }],
  ])
  expect(c.replies.get('A')).toBe(before)
  await c.sync.close()
})

it('moves at the applied live Reply version once the gap after the chain page closes', async () => {
  const c = await client(root())
  const liveReply = reply(23)
  const moved = { ...receipt(25), operation_id: 'operation-1' }
  c.transport.mockImplementationOnce(async (_channel, _anchor, body) =>
    body.expected_version === liveReply.version ? ok(moved) : http(409, 'version_conflict'),
  )
  try {
    c.event(liveReply)
    expect(c.replies.get('A').messages).toContainEqual(liveReply)
    expect(c.replies.get('A').chainVersion).toBe(20)

    c.event(record(21))
    c.event(record(22))
    c.event(record(24))
    expect(c.sync.get().channels.A.cursor).toBe(1)
    expect(c.replies.get('A').chainVersion).toBe(liveReply.version)
    c.listReplyChain.mockResolvedValueOnce(ok({
      history_generation, as_of_seq: 20, chain_version: 20, root_id: 'id1', messages: [reply(20)], has_more: false,
    }))
    await c.replies.loadMore('A')
    expect(c.listReplyChain).toHaveBeenLastCalledWith('A', root().id, {
      history_generation, as_of_seq: 20, after_seq: anchor.created_seq,
    })

    await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'moved', receipt: moved })
    expect(c.transport).toHaveBeenCalledExactlyOnceWith('A', anchor.id, {
      history_generation, operation_id: 'operation-1', expected_version: liveReply.version, topic_id: 'T',
    })
  } finally {
    await c.sync.close()
  }
})

it('keeps the Move baseline until a buffered Reply enters the retained window', async () => {
  const c = await client(false)
  const page = {
    history_generation, as_of_seq: REPLY_MESSAGE_LIMIT, chain_version: REPLY_MESSAGE_LIMIT, root_id: 'id1', has_more: false,
    messages: [root(), ...Array.from({ length: REPLY_MESSAGE_LIMIT - 1 }, (_, i) => reply(i + 2))],
  }
  const liveReply = reply(REPLY_MESSAGE_LIMIT + 1)
  try {
    c.listReplyChain.mockResolvedValueOnce(ok(page))
    await c.replies.open('A', root())
    c.replies.setPinned('A', false)
    c.event(liveReply)
    expect(c.replies.get('A')).toMatchObject({ chainVersion: page.chain_version, hasNewer: true })
    expect(c.replies.get('A').messages).not.toContainEqual(liveReply)

    c.listReplyChain.mockResolvedValueOnce(ok({ ...page, messages: [] }))
    await c.replies.loadLatest('A')
    expect(c.replies.get('A').messages).toContainEqual(liveReply)
    expect(c.replies.get('A').chainVersion).toBe(liveReply.version)
  } finally {
    await c.sync.close()
  }
})

it.each([
  ['Move', false], ['Move', true], ['loadOlder', false], ['loadOlder', true],
] as const)('keeps the page version when %s drops a Reply during restart (evicted: %s)', async (route, evicted) => {
  const c = await client(false)
  const page = { history_generation, as_of_seq: 3, chain_version: 3, root_id: 'id1', messages: [root(), reply(2)], has_more: true }
  const restartPage = deferred<Result<ReplyChainPage>>()
  try {
    c.event(reply(2))
    c.event(reply(3))
    c.listReplyChain.mockResolvedValueOnce(ok(page)).mockReturnValueOnce(restartPage.promise)
    await c.replies.open('A', root())

    let older: Promise<void> | undefined
    if (route === 'Move') c.handlers[0].onEvent(moveEvent(4, 'other'))
    else {
      c.event(record(4))
      older = c.replies.loadOlder('A')
    }
    await flush()
    expect(c.listReplyChain).toHaveBeenCalledTimes(2)
    expect(c.replies.get('A').chainVersion).toBeUndefined()

    const missed = reply(5)
    c.event(missed)
    const next = evicted ? 6 + MAIN_MESSAGE_LIMIT : 6
    for (let seq = 6; seq < next; seq++) c.event(record(seq))
    expect(c.sync.get().channels.A.messages.some(m => m.id === missed.id)).toBe(!evicted)

    restartPage.resolve(ok({ ...page, as_of_seq: 4 }))
    await older
    await flush()
    expect(c.replies.get('A')).toMatchObject({ chainVersion: 3, hasNewer: !evicted })
    const later = reply(next)
    c.event(later)
    expect(c.sync.get().channels.A.cursor).toBe(next)
    expect(c.replies.get('A').messages).toContainEqual(later)
    expect(c.replies.get('A').messages).not.toContainEqual(missed)
    expect(c.replies.get('A').chainVersion).toBe(3)
  } finally {
    await c.sync.close()
  }
})

it('does not count a bounded Channel bootstrap as events after the Reply page', async () => {
  const c = replyClient()
  const latest = deferred<Result<MessagePage>>()
  c.listMessages.mockReturnValueOnce(latest.promise)
  try {
    await c.sync.start()
    c.handlers[0].onReady()
    const watching = c.sync.watch('A')
    expect(c.sync.get().channels.A.cursor).toBeNull()
    c.listReplyChain.mockResolvedValueOnce(ok({
      history_generation, as_of_seq: 10, chain_version: 5, root_id: 'id1', messages: [root(), reply(5)], has_more: false,
    }))
    await c.replies.open('A', root())
    expect(c.replies.get('A').chainVersion).toBe(5)

    latest.resolve(ok({ history_generation, as_of_seq: 20, messages: [record(20)], has_more: true }))
    await watching
    await flush()
    c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 20, history_generation })
    const later = reply(21)
    c.event(later)
    expect(c.sync.get().channels.A).toMatchObject({ cursor: 21, streamBase: 20, mutationSeq: 0 })
    expect(c.replies.get('A').messages).toContainEqual(later)
    expect(c.replies.get('A').chainVersion).toBe(5)
  } finally {
    await c.sync.close()
  }
})

it('keeps the page version after a missed buffered Reply and its newer badge are gone', async () => {
  const c = await client(false)
  const w = REPLY_MESSAGE_LIMIT
  const page = {
    history_generation, as_of_seq: w, chain_version: w, root_id: 'id1', has_more: false,
    messages: [root(), ...Array.from({ length: w - 1 }, (_, i) => reply(i + 2))],
  }
  try {
    c.listReplyChain.mockResolvedValueOnce(ok(page))
    await c.replies.open('A', root())
    c.replies.setPinned('A', false)
    c.event(reply(w + 1))
    expect(c.replies.get('A').hasNewer).toBe(true)
    const next = w + 2 + MAIN_MESSAGE_LIMIT
    for (let seq = w + 2; seq < next; seq++) c.event(record(seq))
    c.listReplyChain.mockResolvedValueOnce(ok({ ...page, messages: [] }))
    await c.replies.loadLatest('A')
    expect(c.replies.get('A').hasNewer).toBe(false)
    expect(c.sync.get().channels.A.messages).not.toContainEqual(reply(w + 1))

    c.event(reply(next))
    expect(c.replies.get('A').messages).toContainEqual(reply(next))
    expect(c.replies.get('A').messages).not.toContainEqual(reply(w + 1))
    expect(c.replies.get('A').chainVersion).toBe(w)
  } finally {
    await c.sync.close()
  }
})

it('keeps the page version when an Edit after W precedes a held live Reply', async () => {
  const c = await client(root())
  try {
    const edited = { ...anchor, version: 21, body: 'edited Reply' }
    c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 21, message: edited })
    c.event(reply(22))
    expect(c.replies.get('A').messages).toEqual([root(), edited, reply(22)])
    expect(c.sync.get().channels.A.mutationSeq).toBe(21)
    expect(c.replies.get('A').chainVersion).toBe(20)
  } finally {
    await c.sync.close()
  }
})

it.each([
  ['a hydrated Edit', { ...reply(21), version: 22, body: 'edited Reply' }],
  ['a tombstone', { ...reply(21), deleted: true, body: undefined }],
] as const)('rejects %s as a live Create candidate even without the mutation floor', async (_kind, message) => {
  const c = await client(root())
  const get = c.source.get.bind(c.source)
  // Isolate the per-Message check from the core's mutation floor. The tombstone
  // also matches its Create sequence so deletion is the only failing predicate.
  const view = vi.spyOn(c.source, 'get').mockImplementation(() => {
    const state = get()
    return { ...state, channels: { ...state.channels, A: { ...state.channels.A, mutationSeq: 0 } } }
  })
  try {
    c.event(message)
    if (!message.deleted) c.handlers[0].onEvent({ type: 'message', kind: 'edit', seq: 22, message })
    expect(c.replies.get('A').messages.at(-1)).toMatchObject({ id: message.id, version: message.version, deleted: message.deleted })
    expect(c.replies.get('A').chainVersion).toBe(20)
  } finally {
    view.mockRestore()
    await c.sync.close()
  }
})

it('ignores a conflicting chain version on a fixed-W continuation', async () => {
  const c = await client()
  try {
    c.listReplyChain.mockResolvedValueOnce(ok({
      history_generation, as_of_seq: 20, chain_version: 21, root_id: 'id1', messages: [reply(20)], has_more: false,
    }))
    await c.replies.loadMore('A')
    expect(c.listReplyChain).toHaveBeenLastCalledWith('A', anchor.id, { history_generation, as_of_seq: 20, after_seq: 3 })
    expect(c.replies.get('A').messages).toContainEqual(reply(20))
    expect(c.replies.get('A').chainVersion).toBe(20)
  } finally {
    await c.sync.close()
  }
})

it('requires a covering baseline for the requested anchor before allocating an operation', async () => {
  const c = await client(false)
  await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'baseline_unavailable' })
  c.listReplyChain.mockResolvedValueOnce(chainPage(20))
  await c.replies.open('A', anchor)
  await expect(c.move('A', 'other-chain', { topicId: 'T' })).resolves.toEqual({ kind: 'baseline_unavailable' })
  expect(c.newId).not.toHaveBeenCalled()
  expect(c.transport).not.toHaveBeenCalled()
  await c.sync.close()
})

it('retries an unknown Move with the original key and version and shares concurrent retries', async () => {
  const c = await client()
  const answer = deferred<Result<MoveChainResponse>>()
  c.transport.mockResolvedValueOnce({ ok: false, kind: 'network', retryAfterMs: 2000 }).mockReturnValueOnce(answer.promise)
  const result = await c.move('A', anchor.id, { topicId: 'T' })
  expect(result).toMatchObject({ kind: 'unknown', retryAfterMs: 2000 })
  if (result.kind !== 'unknown') throw new Error('expected an unknown outcome')
  const retry = result.retry()
  expect(result.retry()).toBe(retry)
  answer.resolve(ok(receipt()))
  await expect(retry).resolves.toEqual({ kind: 'moved', receipt: receipt() })
  await expect(result.retry()).resolves.toEqual({ kind: 'moved', receipt: receipt() })
  expect(c.transport.mock.calls).toHaveLength(2)
  expect(c.transport.mock.calls[1]).toEqual(c.transport.mock.calls[0])
  expect(c.newId).toHaveBeenCalledTimes(1)
  await c.sync.close()
})

it('submitting the same Move after a timeout and a fresh chain read reuses the original POST', async () => {
  vi.useFakeTimers()
  const c = await client()
  const late = deferred<Result<MoveChainResponse>>()
  c.transport.mockReturnValueOnce(late.promise)
  const pending = c.move('A', anchor.id, { topicName: 'Release' })
  await vi.advanceTimersByTimeAsync(20)
  await expect(pending).resolves.toMatchObject({ kind: 'unknown' })

  c.replies.dismiss('A')
  c.listReplyChain.mockResolvedValueOnce(chainPage(30))
  await c.replies.open('A', root())
  expect(c.replies.get('A').chainVersion).toBe(30)
  await expect(c.move('A', root().id, { topicName: 'release' })).resolves.toMatchObject({ kind: 'moved' })
  const original = ['A', anchor.id, { history_generation, operation_id: 'operation-1', expected_version: 20, topic_name: 'Release' }]
  expect(c.transport.mock.calls).toEqual([original, original])
  expect(c.newId).toHaveBeenCalledTimes(1)
  await c.sync.close()
})

it.each([{ topicId: 'T' }, { topicName: 'Release' }])(
  'refreshes and allocates a fresh Move after a replayed receipt reports an intervening Move (%j)',
  async destination => {
    const c = await client()
    const replay = { ...receipt(), topic_id: 'C', chain_version: 22 }
    c.transport.mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok(replay))
    c.listReplyChain.mockResolvedValueOnce(ok({
      history_generation, as_of_seq: 22, root_id: 'id1', chain_version: 22, has_more: false,
      messages: [{ ...root('C'), version: 22 }, { ...anchor, topic_id: 'C', version: 22 }],
    }))
    try {
      await expect(c.move('A', anchor.id, destination)).resolves.toMatchObject({ kind: 'unknown' })
      await expect(c.move('A', anchor.id, destination)).resolves.toEqual({
        kind: 'conflict', error: 'version_conflict', refreshed: true,
      })
      expect(c.transport.mock.calls[1]).toEqual(c.transport.mock.calls[0])
      expect(c.replies.get('A')).toMatchObject({ topicId: 'C', chainVersion: 22 })

      c.transport.mockResolvedValueOnce(ok({ ...receipt(23), operation_id: 'operation-2' }))
      await expect(c.move('A', anchor.id, destination)).resolves.toMatchObject({ kind: 'moved' })
      expect(c.transport.mock.calls[2][2]).toEqual({
        ...c.transport.mock.calls[0][2], operation_id: 'operation-2', expected_version: 22,
      })
    } finally {
      await c.sync.close()
    }
  },
)

it('allocates a fresh Move after a different destination is confirmed for the same chain', async () => {
  const c = await client()
  const movedToC = {
    ...receipt(22), operation_id: 'operation-2', destination_topic_id: 'C', topic_id: 'C',
  }
  c.transport.mockResolvedValueOnce({ ok: false, kind: 'network' }).mockResolvedValueOnce(ok(movedToC))

  async function reopenAt(topicId: string, version: number) {
    c.replies.dismiss('A')
    c.listReplyChain.mockResolvedValueOnce(ok({
      history_generation, as_of_seq: version, root_id: 'id1', chain_version: version, has_more: false,
      messages: [{ ...root(topicId), version }, { ...anchor, topic_id: topicId, version }],
    }))
    await c.replies.open('A', anchor)
    expect(c.replies.get('A')).toMatchObject({ topicId, chainVersion: version })
  }

  try {
    await expect(c.move('A', anchor.id, { topicId: 'B' })).resolves.toMatchObject({ kind: 'unknown' })
    await reopenAt('B', 21)
    await expect(c.move('A', anchor.id, { topicId: 'C' })).resolves.toEqual({ kind: 'moved', receipt: movedToC })
    expect(c.transport).toHaveBeenLastCalledWith('A', anchor.id, {
      history_generation, operation_id: 'operation-2', expected_version: 21, topic_id: 'C',
    })

    await reopenAt('C', 22)
    await c.move('A', anchor.id, { topicId: 'B' })
    expect(c.transport).toHaveBeenLastCalledWith('A', anchor.id, {
      history_generation, operation_id: 'operation-3', expected_version: 22, topic_id: 'B',
    })
  } finally {
    await c.sync.close()
  }
})

it('posts a fresh Move in the recovered history generation', async () => {
  const c = await client()
  const nextGeneration = '00000000-0000-4000-8000-000000000516'
  const recoveredRoot = { ...root(), history_generation: nextGeneration }
  const recoveredAnchor = { ...anchor, history_generation: nextGeneration }
  c.transport.mockResolvedValueOnce({ ok: false, kind: 'network' })
  try {
    await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toMatchObject({ kind: 'unknown' })

    c.listMessages.mockResolvedValue(ok({
      history_generation: nextGeneration, as_of_seq: 1, messages: [recoveredRoot], has_more: false,
    }))
    c.sync.observeHistoryGeneration(nextGeneration)
    await flush()
    c.handlers.at(-1)!.onReady()
    c.handlers.at(-1)!.onEvent({
      type: 'subscribed', channel_id: 'A', caught_up_seq: 1, history_generation: nextGeneration,
    })
    await flush()
    c.listReplyChain.mockResolvedValueOnce(ok({
      history_generation: nextGeneration, as_of_seq: 7, root_id: recoveredRoot.id, chain_version: 7,
      messages: [recoveredRoot, recoveredAnchor], has_more: false,
    }))
    await c.replies.open('A', recoveredAnchor)
    expect(c.replies.get('A').chainVersion).toBe(7)

    const epoch = c.sync.get().historyEpoch
    const moved = { ...receipt(8), history_generation: nextGeneration, operation_id: 'operation-2' }
    c.transport.mockImplementationOnce(async (_channel, _anchor, body) =>
      body.history_generation === nextGeneration ? ok(moved)
        : http(409, 'history_generation_changed'),
    )
    await expect(c.move('A', recoveredAnchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'moved', receipt: moved })
    expect(c.transport).toHaveBeenLastCalledWith('A', recoveredAnchor.id, {
      history_generation: nextGeneration, operation_id: 'operation-2', expected_version: 7, topic_id: 'T',
    })
    expect(c.sync.get().historyEpoch).toBe(epoch)
  } finally {
    await c.sync.close()
  }
})

it('reports a committed receipt when the Reply chain is dismissed during the POST', async () => {
  const c = await client()
  const answer = deferred<Result<MoveChainResponse>>()
  c.transport.mockReturnValueOnce(answer.promise)
  const pending = c.move('A', anchor.id, { topicId: 'T' })
  await flush()
  expect(c.transport).toHaveBeenCalledTimes(1)
  c.replies.dismiss('A')
  answer.resolve(ok(receipt()))
  await expect(pending).resolves.toEqual({ kind: 'moved', receipt: receipt() })
  await c.sync.close()
})

it('reports an unknown outcome when the Reply chain is dismissed during a failed POST', async () => {
  const c = await client()
  const answer = deferred<Result<MoveChainResponse>>()
  c.transport.mockReturnValueOnce(answer.promise)
  const pending = c.move('A', anchor.id, { topicId: 'T' })
  await flush()
  expect(c.transport).toHaveBeenCalledTimes(1)
  c.replies.dismiss('A')
  answer.resolve({ ok: false, kind: 'network' })
  await expect(pending).resolves.toMatchObject({ kind: 'unknown' })
  await c.sync.close()
})

it('a timed-out or thrown Move can retry with the same request until the chain is dismissed', async () => {
  vi.useFakeTimers()
  const c = await client()
  const late = deferred<Result<MoveChainResponse>>()
  c.transport.mockReturnValueOnce(late.promise).mockRejectedValueOnce(new Error('connection lost'))
  const pending = c.move('A', anchor.id, { topicId: 'T' })
  await vi.advanceTimersByTimeAsync(20)
  const first = await pending
  if (first.kind !== 'unknown') throw new Error('expected timeout')
  const second = await first.retry()
  if (second.kind !== 'unknown') throw new Error('expected network error')
  c.replies.dismiss('A')
  late.resolve(ok(receipt())); await flush()
  await expect(second.retry()).resolves.toMatchObject({ kind: 'unknown' })
  expect(c.transport.mock.calls).toHaveLength(2)
  expect(c.transport.mock.calls[1]).toEqual(c.transport.mock.calls[0])
  await c.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('Move conflicts refresh the full-chain baseline before a new operation', async () => {
  for (const error of ['version_conflict', 'operation_conflict']) {
    const c = await client()
    c.transport.mockResolvedValueOnce(http(409, error))
    c.listReplyChain.mockResolvedValueOnce(chainPage(30))
    await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'conflict', error, refreshed: true })
    expect(c.listReplyChain).toHaveBeenLastCalledWith('A', anchor.id, { history_generation, as_of_seq: undefined, after_seq: 0 })
    expect(c.replies.get('A')).toMatchObject({ chainVersion: 30, topicId: null })
    expect(c.sync.get().channels.A.cursor).toBe(1)
    await c.move('A', anchor.id, { topicId: 'T' })
    expect(c.transport).toHaveBeenLastCalledWith('A', anchor.id, expect.objectContaining({ operation_id: 'operation-2', expected_version: 30 }))
    await c.sync.close()
  }
})

it('reports a failed chain read after a Move version conflict and allows reading again', async () => {
  const c = await client()
  c.transport.mockResolvedValueOnce(http(409, 'version_conflict'))
  c.listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toEqual({
    kind: 'conflict', error: 'version_conflict', refreshed: false,
  })
  expect(c.listReplyChain).toHaveBeenCalledTimes(2)
  expect(c.replies.get('A')).toMatchObject({ chainVersion: undefined, error: true })
  c.listReplyChain.mockResolvedValueOnce(chainPage(30))
  await c.replies.loadMore('A')
  expect(c.replies.get('A')).toMatchObject({ chainVersion: 30, error: false })
  expect(c.transport).toHaveBeenCalledTimes(1)
  await c.sync.close()
})

it('maps Move refusals without changing projections', async () => {
  const c = await client()
  const before = c.replies.get('A'), sync = c.sync.get()
  for (const [status, error, kind] of [
    [409, 'chain_too_large', 'too_large'], [403, 'move_not_allowed', 'denied'], [404, 'topic_not_found', 'not_found'],
    [404, 'reply_chain_not_found', 'not_found'], [409, 'snapshot_expired', 'snapshot_expired'], [400, 'invalid_input', 'failed'],
  ] as const) {
    c.transport.mockResolvedValueOnce(http(status, error))
    const result = await c.move('A', anchor.id, { topicId: 'T' })
    expect(result, error).toEqual(kind === 'failed' ? { kind, status, error } : { kind })
    expect(c.replies.get('A')).toBe(before)
    expect(c.sync.get()).toBe(sync)
  }
  expect(c.listReplyChain).toHaveBeenCalledTimes(1)
  await c.sync.close()
})

it('routes stale Move generations through the existing history reset', async () => {
  const c = await client()
  c.transport.mockResolvedValueOnce(http(409, 'history_generation_changed'))
  const epoch = c.sync.get().historyEpoch
  await expect(c.move('A', anchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'history_generation_changed' })
  expect(c.sync.get().historyEpoch).toBe(epoch + 1)
  expect(c.replies.get('A').chainVersion).toBeUndefined()
  await c.sync.close()
})
