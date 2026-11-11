import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message, ReplyChainPage, Result } from './api'
import { createReplySync } from './reply-sync'
import { topicClient } from './topic-test-helpers'
import { deferred, ok, reply, replyClient, root } from './reply-test-helpers'
import { flush } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('pages the root and siblings from root and descendant anchors without cursor or gap evidence', async () => {
  for (const anchor of [root(), reply(3, 'id2')]) {
    const c = replyClient(); await c.boot()
    await c.replies.open(anchor)
    const read = deferred<Result<ReplyChainPage>>()
    c.listReplyChain.mockReturnValueOnce(read.promise)
    const loading = c.replies.loadMore('A')
    await flush()
    c.event(reply(2)); c.event(reply(3, 'id2')); c.event(recordOther(4)); c.event(reply(5, 'unloaded-parent'))
    read.resolve(ok({ root_id: 'id1', messages: [reply(5, 'unloaded-parent'), reply(7)], has_more: true }))
    await loading
    expect(c.listReplyChain).toHaveBeenLastCalledWith('A', anchor.id, { after_seq: 3 })
    expect(c.replies.get('A').messages.map(m => m.seq)).toEqual([1, 2, 3, 5, 7])
    expect(c.sync.get().channels.A).toMatchObject({ cursor: 5, advancing: [], wait: undefined })
    expect(c.sync.get().channels.A.messages.map(m => m.seq)).toEqual([1, 2, 3, 4, 5])
    c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [reply(9)], has_more: false }))
    await c.replies.loadMore('A')
    expect(c.listReplyChain).toHaveBeenLastCalledWith('A', anchor.id, { after_seq: 7 })
    await c.replies.loadMore('A'); expect(c.listReplyChain).toHaveBeenCalledTimes(3)
    expect(c.replies.get('A').hasMore).toBe(false)
    await c.sync.close()
  }
})
const recordOther = (seq: number): Message => ({ ...root(), seq, id: `other${seq}` })

it('live append during an initial page never skips unpaged siblings', async () => {
  const c = replyClient(); await c.boot()
  const read = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(read.promise)
  const opening = c.replies.open(root()); await flush()
  c.event(reply(2)); c.event(recordOther(3)); c.event(reply(4, 'unloaded-parent'))
  read.resolve(ok({ root_id: 'id1', messages: [root(), reply(2)], has_more: true })); await opening
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [reply(4, 'id2')], has_more: false }))
  await c.replies.loadMore('A')
  expect(c.listReplyChain).toHaveBeenLastCalledWith('A', 'id1', { after_seq: 2 })
  expect(c.replies.get('A').messages.map(m => m.seq)).toEqual([1, 2, 4])
  await c.sync.close()
})

it('ACK page and echo overlap settle only matching own sends and keep canonical copies', async () => {
  const c = replyClient(); await c.boot()
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [root()], has_more: true }))
  await c.replies.open(root())
  const send = deferred<Result<Message>>()
  c.sendMessage.mockReturnValueOnce(send.promise)
  const sending = c.replies.send('A', 'local'); await flush()
  const canonical = { ...reply(2), sender: 'me', client_message_id: 'send1', body: 'canonical' }
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [canonical], has_more: true }))
  await c.replies.loadMore('A')
  expect(c.sync.get().channels.A.pending).toEqual([])
  expect(c.sync.get().channels.A.cursor).toBe(1)
  expect(c.sync.get().channels.A.messages).toEqual([root()])
  c.event(canonical); send.resolve(ok(canonical)); await sending
  expect(c.replies.get('A').messages.filter(m => m.id === canonical.id)).toEqual([canonical])
  expect(c.replies.get('A').pending).toEqual([])
  await c.sync.close()
})

it('retry preserves client id body and reply target after timeout even when another chain is opened', async () => {
  const c = replyClient(10); await c.boot(); await c.replies.open(reply(3, 'id2', 'T'))
  const send = deferred<Result<Message>>()
  c.sendMessage.mockReturnValueOnce(send.promise)
  const sending = c.replies.send('A', 'hello')
  await vi.advanceTimersByTimeAsync(10); await sending
  expect(c.replies.get('A').pending[0]).toMatchObject({ state: 'unknown', reply_to: 'id3' })
  await c.replies.open(root('T')); await c.replies.retry('A', 'send1')
  expect(c.sendMessage.mock.calls.map(call => call[1])).toEqual([
    { client_message_id: 'send1', body: 'hello', reply_to: 'id3' },
    { client_message_id: 'send1', body: 'hello', reply_to: 'id3' },
  ])
  send.resolve({ ok: false, kind: 'network' }); await flush()
  expect(c.sync.get().channels.A.pending).toEqual([])
  expect(await c.replies.send('A', 'hello', 'optimistic-id')).toBe(false)
  expect(await c.replies.send('A', '\0')).toBe(false)
  await c.sync.close()
})

it('a Topic Message opens and sends through the same controller with inherited Topic intent', async () => {
  const c = topicClient(); await c.boot(); await c.topics.loadTopic('A', 'T')
  const anchor = c.topics.get('A').topic('T').messages[0]
  const listReplyChain = vi.fn(async () => ok({ root_id: anchor.id, messages: [anchor], has_more: false }))
  const composed = createReplySync({ selfId: 'me', repliesApi: { listReplyChain } }, c.sync)
  await composed.replies.open(anchor)
  expect(composed.replies.get('A').topicId).toBe('T')
  await composed.replies.send('A', 'hello')
  expect(c.sendMessage).toHaveBeenLastCalledWith('A', expect.objectContaining({ reply_to: anchor.id, body: 'hello' }))
  expect(c.sendMessage.mock.calls.at(-1)![1]).not.toHaveProperty('topic_name')
  await composed.sync.close()
  expect(c.topics.get('A').lines).toEqual([])
})

it('current chain 403 and 404 cause Channel-only C9 and refuse sends retries and automatic reads', async () => {
  for (const status of [403, 404]) {
    const c = replyClient(); await c.boot(); await c.sync.watch('B')
    await c.replies.open(root())
    c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
    await c.replies.send('A', 'unknown outcome')
    c.listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'http', status })
    await c.replies.open(root())
    expect(c.sync.get().channels.A.state).toBe('unavailable')
    expect(c.sync.get().channels.B.state).not.toBe('unavailable')
    const calls = c.listReplyChain.mock.calls.length
    await c.replies.loadMore('A'); await c.replies.open(root()); await c.replies.retry('A', 'send1')
    expect(await c.replies.send('A', 'hello')).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.listReplyChain).toHaveBeenCalledTimes(calls)
    expect(c.sendMessage).toHaveBeenCalledTimes(1)
    expect(c.sync.get().channels.A.pending[0].state).toBe('unknown')
    await c.sync.watch('A'); await c.replies.open(root())
    expect(c.replies.get('A').messages.length).toBeGreaterThan(0)
    await c.sync.close()
  }
})

it('organization_unavailable is C10 and never C9 even when the C10 handler is delayed', async () => {
  const c = replyClient(); await c.boot()
  const unavailable = vi.spyOn(c.source, 'unavailable').mockImplementation(async () => {})
  c.listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  await c.replies.open(root())
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(c.sync.get().channels.A.state).toBe('ready')
  unavailable.mockRestore(); await c.sync.unavailable()
  expect(c.sync.get().organization).toBe('unavailable')
  expect(await c.replies.send('A', 'hello')).toBe(false)
  await c.sync.close()
})

it('superseded reads cannot apply pages or late C9 denials to another chain', async () => {
  for (const response of [ok({ root_id: 'id1', messages: [reply(9)], has_more: false }),
    { ok: false, kind: 'http', status: 403 } as const]) {
    const c = replyClient(); await c.boot()
    const old = deferred<Result<ReplyChainPage>>()
    c.listReplyChain.mockReturnValueOnce(old.promise)
    const first = c.replies.open(root()); await flush()
    await c.replies.open(reply(3))
    old.resolve(response); await first
    expect(c.replies.get('A').anchor?.id).toBe('id3')
    expect(c.replies.get('A').messages.map(m => m.seq)).toEqual([1, 3])
    expect(c.sync.get().channels.A.state).toBe('ready')
    await c.sync.close()
  }
})

it('session replacement fences pages settlement C9 C10 and late 401 before sync resets', async () => {
  for (const response of [ok({ root_id: 'id1', messages: [reply(2)], has_more: false }),
    { ok: false, kind: 'http', status: 403 } as const,
    { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' } as const,
    { ok: false, kind: 'http', status: 401 } as const]) {
    const c = replyClient(); await c.boot()
    const read = deferred<Result<ReplyChainPage>>()
    c.listReplyChain.mockReturnValueOnce(read.promise)
    const opening = c.replies.open(root()); await flush()
    await c.sync.replaceSession('new-self')
    const settle = vi.spyOn(c.source, 'settleHistory')
    read.resolve(response); await opening; await flush()
    expect(c.replies.get('A').messages).toEqual([])
    expect(c.sync.get()).toMatchObject({ running: true, organization: 'available', selfId: 'new-self' })
    expect(c.onSessionEnded).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled()
    await c.sync.close(); expect(vi.getTimerCount()).toBe(0)
  }
})

it('timeout allows explicit retry and fences a late page or C9 but same-session late 401 still ends the session', async () => {
  const c = replyClient(10); await c.boot()
  const read = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(read.promise)
  const opening = c.replies.open(root()); await vi.advanceTimersByTimeAsync(10); await opening
  expect(c.replies.get('A')).toMatchObject({ error: true, loading: false })
  await c.replies.loadMore('A')
  read.resolve({ ok: false, kind: 'http', status: 401 }); await flush()
  expect(c.onSessionEnded).toHaveBeenCalledTimes(1)
  expect(c.sync.get().running).toBe(false)
  await c.sync.close()
})

it('clamp clears the chain and fences old pages while pending Reply intent survives', async () => {
  const c = replyClient(); await c.boot(); await c.replies.open(root())
  c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.replies.send('A', 'hello')
  const read = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(read.promise)
  const loading = c.replies.loadMore('A'); await flush()
  c.handlers[0].onClose(1006); await vi.advanceTimersByTimeAsync(1000)
  c.handlers.at(-1)!.onReady()
  c.handlers.at(-1)!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 0 }); await flush()
  read.resolve(ok({ root_id: 'id1', messages: [reply(9)], has_more: false })); await loading
  expect(c.replies.get('A').messages).toEqual([])
  expect(c.sync.get().channels.A.pending[0]).toMatchObject({ state: 'unknown', reply_to: 'id1' })
  expect(c.sendMessage).toHaveBeenCalledTimes(1)
  await c.sync.close()
})

it('Reply pages do not settle another sender or Channel and definite refusals never retry', async () => {
  const c = replyClient(); await c.boot()
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [root()], has_more: true }))
  await c.replies.open(root())
  c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await c.replies.send('A', 'hello')
  const canonical = { ...reply(2), sender: 'me', client_message_id: 'send1' }
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [
    { ...canonical, sender: 'someone-else' }, { ...canonical, channel_id: 'B', seq: 4, id: 'foreign' },
  ], has_more: true }))
  await c.replies.loadMore('A')
  expect(c.sync.get().channels.A.pending[0].state).toBe('unknown')
  expect(c.replies.get('A').messages.some(m => m.id === 'foreign')).toBe(false)
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [{ ...canonical, seq: 5, id: 'id5' }], has_more: false }))
  await c.replies.loadMore('A')
  expect(c.sync.get().channels.A.pending).toEqual([])
  await c.sync.close()
  for (const status of [400, 403, 404, 409, 413, 415]) {
    const denied = replyClient(); await denied.boot(); await denied.replies.open(root())
    denied.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'http', status })
    await denied.replies.send('A', 'hello'); await denied.replies.retry('A', 'send1')
    expect(denied.sendMessage).toHaveBeenCalledTimes(1)
    expect(denied.replies.get('A').pending[0].state).toBe('failed')
    await denied.sync.close()
  }
})

it('timed-out or unwatched reads cannot restore pages or cause late C9 after a fresh selection', async () => {
  for (const invalidate of ['timeout', 'unwatch', 'dismiss']) {
    for (const response of [ok({ root_id: 'id1', messages: [reply(99)], has_more: false }),
      { ok: false, kind: 'http', status: 404 } as const]) {
      const c = replyClient(10); await c.boot()
      const read = deferred<Result<ReplyChainPage>>()
      c.listReplyChain.mockReturnValueOnce(read.promise)
      const opening = c.replies.open(root()); await flush()
      if (invalidate === 'timeout') await vi.advanceTimersByTimeAsync(10)
      else if (invalidate === 'unwatch') { await c.sync.unwatch('A'); await c.sync.watch('A') }
      else c.replies.dismiss('A')
      await c.replies.open(root())
      read.resolve(response); await opening
      expect(c.replies.get('A').messages.map(m => m.seq)).toEqual([1, 3])
      expect(c.sync.get().channels.A.state).not.toBe('unavailable')
      await c.sync.close()
    }
  }
})

it('same-session C10 after a timed-out read terminates only its Organization', async () => {
  const c = replyClient(10), other = replyClient(); await c.boot(); await other.boot()
  const read = deferred<Result<ReplyChainPage>>()
  c.listReplyChain.mockReturnValueOnce(read.promise)
  const opening = c.replies.open(root()); await vi.advanceTimersByTimeAsync(10); await opening
  read.resolve({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' }); await flush()
  expect(c.sync.get()).toMatchObject({ organization: 'unavailable', running: false })
  await other.replies.open(root()); expect(await other.replies.send('A', 'hello')).toBe(true)
  expect(other.sync.get()).toMatchObject({ organization: 'available', running: true })
  await c.sync.close(); await other.sync.close()
})

it('identifies a live Reply by reply_root_id when its parent is outside all loaded windows', async () => {
  const c = replyClient()
  c.listMessages.mockResolvedValueOnce(ok({ messages: [{ ...root(), seq: 10, id: 'id10' }], has_more: true }))
  await c.sync.start(); c.handlers[0].onReady(); await c.sync.watch('A')
  c.handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 })
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: 'id1', messages: [root()], has_more: false }))
  await c.replies.open(root())
  c.event(reply(11, 'id2'))
  expect(c.replies.get('A').messages.map(m => m.id)).toEqual(['id1', 'id11'])
  expect(c.sync.get().channels.A.messages.map(m => m.id)).toEqual(['id10', 'id11'])
  expect(c.sync.get().channels.A.cursor).toBe(11)
  await c.sync.close()
})
