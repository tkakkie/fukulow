import { afterEach, expect, it, vi } from 'vitest'
import { moveChain, type MoveChainResponse, type Result } from './api'
import { createMoveChain, type MoveChainApi } from './move-chain'
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

async function client(open = true) {
  const c = replyClient()
  const transport = vi.fn<MoveChainApi>(async () => ok(receipt()))
  let seq = 0
  const newId = vi.fn(() => `operation-${++seq}`)
  const move = createMoveChain(c.sync, c.replies, { api: transport, newId, requestTimeoutMs: 20 })
  await c.boot()
  if (open) {
    c.listReplyChain.mockResolvedValueOnce(chainPage(20))
    await c.replies.open('A', anchor)
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
