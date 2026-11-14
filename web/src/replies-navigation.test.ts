import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message, ReplyChainPage, Result } from './api'
import { deferred, ok, reply, replyClient, root } from './reply-test-helpers'
import { flush } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const records = [root(), ...Array.from({ length: 10_000 }, (_, i) => reply(i + 2))]
const seqs = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i)
async function longChain() {
  const c = replyClient()
  c.listReplyChain.mockImplementation(async (_channel?: unknown, _anchor?: unknown, query?: { after_seq?: number }) => {
    const after = query?.after_seq ?? 0
    const messages = records.filter(m => m.seq > after).slice(0, 50)
    return ok({ root_id: 'id1', messages, has_more: messages.at(-1)!.seq < 10_001 })
  })
  await c.boot()
  return c
}

it('cached anchors preserve the continuation and live evidence with zero reads in a 10000-Reply chain', async () => {
  const c = await longChain()
  await c.replies.open('A', root())
  c.replies.setPinned('A', false)
  for (let seq = 2; seq <= 10_001; seq++) c.event(reply(seq))
  const before = c.replies.get('A'), syncBefore = c.sync.get().channels.A
  expect(before.messages).toHaveLength(200)
  expect(before.newerCount).toBeGreaterThan(0)
  c.listReplyChain.mockClear()
  for (const anchor of [reply(100), root(), root()]) {
    await c.replies.open('A', anchor)
    expect(c.listReplyChain).toHaveBeenCalledTimes(0)
    const after = c.replies.get('A')
    expect(after.anchor?.id).toBe(anchor.id)
    expect(after).toEqual({ ...before, anchor })
    expect(after.messages.every((m, i) => m === before.messages[i])).toBe(true)
  }
  expect(c.listReplyChain).toHaveBeenCalledTimes(0)
  // A duplicate live record must not become new evidence after navigation.
  c.event(reply(10_001))
  expect(c.replies.get('A').newerCount).toBe(before.newerCount)
  await c.replies.loadMore('A')
  expect(c.listReplyChain).toHaveBeenCalledExactlyOnceWith('A', 'id1', { after_seq: 50 })
  expect(c.sync.get().channels.A).toBe(syncBefore)
  await c.sync.close()
})

it('uncached and fresh descendant anchors take one contextual read in a 10000-Reply chain', async () => {
  for (const fresh of [false, true]) {
    const c = await longChain()
    if (!fresh) await c.replies.open('A', root())
    const before = c.sync.get().channels.A
    c.listReplyChain.mockClear()
    await c.replies.open('A', reply(9000))
    expect(c.listReplyChain).toHaveBeenCalledExactlyOnceWith('A', 'id9000', { after_seq: 8975 })
    expect(c.replies.get('A')).toMatchObject({ anchor: reply(9000), hasOlder: true, hasMore: true })
    expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(seqs(8976, 50))
    expect(c.sync.get().channels.A).toBe(before)
    await c.sync.close()
  }
})

it('the current anchor and root keep an evicted history window without any reads', async () => {
  const c = await longChain()
  await c.replies.open('A', reply(9000))
  for (let page = 0; page < 5; page++) await c.replies.loadMore('A')
  const before = c.replies.get('A')
  expect(before.messages.some(m => m.id === 'id9000' || m.id === 'id1')).toBe(false)
  c.listReplyChain.mockClear()
  await c.replies.open('A', reply(9000))
  expect(c.replies.get('A')).toEqual(before)
  await c.replies.open('A', root())
  expect(c.replies.get('A')).toEqual({ ...before, anchor: root() })
  expect(c.listReplyChain).toHaveBeenCalledTimes(0)
  await c.sync.close()
})

it('cached navigation preserves an in-flight page and its continuation', async () => {
  const c = await longChain()
  await c.replies.open('A', root())
  const held = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(held.promise)
  const loading = c.replies.loadMore('A'); await flush()
  const calls = c.listReplyChain.mock.calls.length
  await c.replies.open('A', reply(20))
  expect(c.listReplyChain).toHaveBeenCalledTimes(calls)
  expect(c.replies.get('A')).toMatchObject({ loading: true, anchor: reply(20) })
  held.resolve(ok({ root_id: 'id1', messages: records.slice(50, 100), has_more: true }))
  await loading
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(seqs(1, 100))
  await c.replies.loadMore('A')
  expect(c.listReplyChain).toHaveBeenLastCalledWith('A', 'id20', { after_seq: 100 })
  await c.sync.close()
})

it('unsettled and failed Replies stay visible retryable and discardable through cached and uncached navigation', async () => {
  const c = await longChain()
  await c.replies.open('A', root())
  const held = deferred<Result<Message>>()
  c.sendMessage.mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce({ ok: false, kind: 'network' })
    .mockResolvedValueOnce({ ok: false, kind: 'http', status: 400 })
  const sending = c.replies.send('A', 'unsettled', 'id20')
  await flush()
  await c.replies.send('A', 'unknown', 'id20')
  await c.replies.send('A', 'refused', 'id20')
  const pending = c.replies.get('A').pending
  expect(pending.map(p => p.state)).toEqual(['sending', 'unknown', 'failed'])
  c.listReplyChain.mockClear()
  await c.replies.open('A', reply(30))
  expect(c.listReplyChain).toHaveBeenCalledTimes(0)
  expect(c.replies.get('A').pending).toEqual(pending)
  await c.replies.open('A', reply(9000))
  expect(c.listReplyChain).toHaveBeenCalledExactlyOnceWith('A', 'id9000', { after_seq: 8975 })
  expect(c.replies.get('A').pending).toEqual(pending)
  expect(c.replies.get('A').messages.some(m => m.id === 'id20')).toBe(false)
  c.sendMessage.mockResolvedValue({ ok: false, kind: 'network' })
  await c.replies.retry('A', 'send2')
  expect(c.sendMessage).toHaveBeenLastCalledWith('A', { client_message_id: 'send2', body: 'unknown', reply_to: 'id20' })
  // In-flight sends become retryable/discardable when their outcome is unknown (C6).
  await vi.advanceTimersByTimeAsync(30_000); await sending
  expect(c.replies.get('A').pending[0].state).toBe('unknown')
  for (const p of pending) c.sync.getTimeline('A').discard(p.clientMessageId)
  expect(c.replies.get('A').pending).toEqual([])
  held.resolve({ ok: false, kind: 'network' }); await sending
  expect(c.replies.get('A').pending).toEqual([])
  await c.sync.close()
})

it('older and newer pages remain contiguous and bounded after a far jump despite a cached live suffix', async () => {
  const c = await longChain()
  for (let seq = 9802; seq <= 10_001; seq++) c.event(reply(seq))
  await c.replies.open('A', root())
  await c.replies.open('A', reply(9000))
  expect(c.listReplyChain).toHaveBeenCalledTimes(2)
  for (let page = 0; page < 5; page++) {
    const after = 9025 + page * 50
    await c.replies.loadMore('A')
    expect(c.listReplyChain).toHaveBeenLastCalledWith('A', 'id9000', { after_seq: after })
    const count = Math.min(100 + page * 50, 200)
    expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(seqs(after + 51 - count, count))
  }
  await c.replies.loadOlder('A')
  expect(c.listReplyChain).toHaveBeenLastCalledWith('A', 'id9000', { after_seq: 0 })
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(seqs(1, 50))
  expect(c.replies.get('A').hasOlder).toBe(false)
  for (let page = 1; page < 4; page++) await c.replies.loadMore('A')
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual(seqs(1, 200))
  await c.sync.close()
})

it('uncached jumps fence superseded same-chain pages and C9 without losing late 401 or C10', async () => {
  for (const response of [ok({ root_id: 'id1', messages: [reply(2)], has_more: false }),
    { ok: false, kind: 'http', status: 403 } as const,
    { ok: false, kind: 'http', status: 401 } as const,
    { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' } as const]) {
    const c = await longChain()
    const held = deferred<Result<ReplyChainPage>>()
    c.listReplyChain.mockReturnValueOnce(held.promise)
    const opening = c.replies.open('A', root()); await flush()
    await c.replies.open('A', reply(9000))
    const snapshot = c.replies.get('A')
    held.resolve(response); await opening; await flush()
    if (!response.ok && response.kind === 'http' && response.status === 401) expect(c.onSessionEnded).toHaveBeenCalledTimes(1)
    else if (!response.ok && response.kind === 'http' && response.status === 404) expect(c.sync.get().organization).toBe('unavailable')
    else {
      expect(c.replies.get('A')).toBe(snapshot)
      expect(c.sync.get().channels.A.state).toBe('ready')
    }
    await c.sync.close()
  }
})
