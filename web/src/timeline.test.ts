import { describe, expect, it, vi } from 'vitest'
import type { Message, Result } from './api'
import { createTimeline, createTimelines, mergeMessages } from './timeline'

const msg = (seq: number, cid = `c${seq}`, body = `m${seq}`): Message => ({
  id: `id${seq}`, client_message_id: cid, created_at: '2026-01-01T00:00:00Z', sender: 's', seq, topic_id: null, body,
}) as Message
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = <T>(kind: 'network' | 'http' = 'network', status = 400): Result<T> =>
  kind === 'network' ? { ok: false, kind } : { ok: false, kind, status }
const ids = () => { let n = 0; return () => `cid${++n}` }

describe('mergeMessages', () => {
  it('sorts ascending and dedupes by seq', () => {
    const out = mergeMessages([msg(2), msg(3)], [msg(1), msg(2), msg(3)])
    expect(out.map((m) => m.seq)).toEqual([1, 2, 3])
  })
  it('keeps messages from different senders that share a client_message_id', () => {
    const a = { ...msg(1, 'same'), sender: 'alice' }
    const b = { ...msg(2, 'same'), sender: 'bob' }
    expect(mergeMessages([a], [b]).map((m) => m.sender)).toEqual(['alice', 'bob'])
    expect(mergeMessages([b, a], [a, b]).map((m) => m.seq)).toEqual([1, 2])
  })
})

describe('paging', () => {
  it('loads the latest page then older pages with before_seq', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [msg(3), msg(4)], has_more: true }))
      .mockResolvedValueOnce(ok({ messages: [msg(1), msg(2)], has_more: false }))
    const t = createTimeline('ch', { listMessages, sendMessage: vi.fn() })
    await t.loadLatest()
    expect(listMessages).toHaveBeenNthCalledWith(1, 'ch')
    expect(t.get()).toMatchObject({ status: 'ready', hasOlder: true })
    await t.loadOlder()
    expect(listMessages).toHaveBeenNthCalledWith(2, 'ch', { before_seq: 3 })
    expect(t.get().messages.map((m) => m.seq)).toEqual([1, 2, 3, 4])
    expect(t.get().hasOlder).toBe(false)
    await t.loadOlder()
    expect(listMessages).toHaveBeenCalledTimes(2)
  })
  it('latest page failure -> error; older failure keeps messages', async () => {
    const t = createTimeline('ch', { listMessages: async () => fail(), sendMessage: vi.fn() })
    await t.loadLatest()
    expect(t.get().status).toBe('error')
  })
  it('does not request older pages concurrently', async () => {
    let release!: (r: Result<{ messages: Message[]; has_more: boolean }>) => void
    const listMessages = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [msg(5)], has_more: true }))
      .mockReturnValueOnce(new Promise((r) => (release = r)))
    const t = createTimeline('ch', { listMessages, sendMessage: vi.fn() })
    await t.loadLatest()
    const a = t.loadOlder()
    await t.loadOlder()
    expect(listMessages).toHaveBeenCalledTimes(2)
    release(ok({ messages: [msg(4)], has_more: false }))
    await a
    expect(t.get().messages).toHaveLength(2)
  })
})

describe('optimistic send', () => {
  it('shows pending at once, then replaces it with the acknowledged message', async () => {
    let release!: (r: Result<Message>) => void
    const sendMessage = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage }, ids())
    const p = t.send('  hello ')
    expect(t.get().pending).toEqual([{ clientMessageId: 'cid1', body: 'hello', status: 'sending', retryable: true }])
    expect(sendMessage).toHaveBeenCalledWith('ch', { body: 'hello', client_message_id: 'cid1' })
    release(ok(msg(1, 'cid1', 'hello')))
    await p
    expect(t.get().pending).toEqual([])
    expect(t.get().messages.map((m) => m.body)).toEqual(['hello'])
  })
  it('ignores an empty body', async () => {
    const sendMessage = vi.fn()
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage }, ids())
    expect(await t.send('   ')).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })
  it('lost ack: retry with the same id converges to one entry', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok(msg(7, 'cid1', 'hi')))
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage }, ids())
    await t.send('hi')
    expect(t.get().pending[0]).toMatchObject({ status: 'failed', retryable: true })
    await t.retry('cid1')
    expect(sendMessage.mock.calls.map((c) => c[1].client_message_id)).toEqual(['cid1', 'cid1'])
    expect(t.get().pending).toEqual([])
    expect(t.get().messages).toHaveLength(1)
  })
  it('a page that already contains the committed message does not duplicate it', async () => {
    const sendMessage = vi.fn().mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok(msg(7, 'cid1', 'hi')))
    const listMessages = vi.fn().mockResolvedValue(ok({ messages: [msg(7, 'cid1', 'hi')], has_more: false }))
    const t = createTimeline('ch', { listMessages, sendMessage }, ids())
    await t.send('hi')
    await t.loadLatest()
    await t.retry('cid1')
    expect(t.get().messages).toHaveLength(1)
    expect(t.get().pending).toEqual([])
  })
  it('definite refusal (4xx) is not retryable and can be discarded', async () => {
    const sendMessage = vi.fn().mockResolvedValue(fail('http', 409))
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage }, ids())
    await t.send('x')
    expect(t.get().pending[0]).toMatchObject({ status: 'failed', retryable: false })
    await t.retry('cid1')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    t.discard('cid1')
    expect(t.get().pending).toEqual([])
  })
  it('discard does not drop a message still sending', async () => {
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage: () => new Promise(() => {}) }, ids())
    void t.send('x')
    t.discard('cid1')
    expect(t.get().pending).toHaveLength(1)
  })
  it('after dispose, late responses change nothing', async () => {
    let release!: (r: Result<Message>) => void
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage: () => new Promise((r) => (release = r)) }, ids())
    const p = t.send('x')
    t.dispose()
    release(ok(msg(1, 'cid1', 'x')))
    await p
    expect(t.get().messages).toEqual([])
  })
})

describe('timelines per channel', () => {
  it('failed send survives switching channels; retry reuses the same client_message_id', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(ok(msg(1, 'cid1', 'hi')))
    const timelines = createTimelines({ listMessages: vi.fn(), sendMessage }, ids())
    await timelines.get('a').send('hi')
    expect(timelines.get('a').get().pending[0]).toMatchObject({ clientMessageId: 'cid1', status: 'failed' })
    timelines.get('b') // switch away
    const back = timelines.get('a') // and back
    expect(back.get().pending).toEqual([{ clientMessageId: 'cid1', body: 'hi', status: 'failed', retryable: true }])
    await back.retry('cid1')
    expect(sendMessage.mock.calls[1]).toEqual(['a', { body: 'hi', client_message_id: 'cid1' }])
    expect(sendMessage.mock.calls[0][1].client_message_id).toBe(sendMessage.mock.calls[1][1].client_message_id)
    expect(back.get().pending).toEqual([])
    expect(back.get().messages).toHaveLength(1)
  })
})

describe('real-time receive', () => {
  const me = 'me'
  const mine = (seq: number, cid: string) => ({ ...msg(seq, cid), sender: me })

  it('echo before the acknowledgement settles the pending message; the late ack adds nothing', async () => {
    let ack!: (r: Result<Message>) => void
    const sendMessage = vi.fn(() => new Promise<Result<Message>>((res) => (ack = res)))
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage }, ids(), me)
    const sending = t.send('hi')
    expect(t.get().pending).toHaveLength(1)
    t.receive(mine(5, 'cid1'))
    expect(t.get().pending).toEqual([])
    ack(ok(mine(5, 'cid1')))
    await sending
    expect(t.get().messages.map((m) => m.seq)).toEqual([5])
  })

  it('lost acknowledgement: retry with the same id, then replay and late echo converge to one entry', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(fail('network'))
      .mockResolvedValueOnce(ok(mine(5, 'cid1')))
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage }, ids(), me)
    await t.send('hi')
    expect(t.get().pending[0]).toMatchObject({ status: 'failed', retryable: true })
    await t.retry('cid1')
    expect(sendMessage.mock.calls.map((c: any[]) => c[1].client_message_id)).toEqual(['cid1', 'cid1'])
    t.receive(mine(5, 'cid1')) // replay after reconnect
    t.receive(mine(5, 'cid1'))
    expect(t.get().messages).toHaveLength(1)
    expect(t.get().pending).toEqual([])
  })

  it('replay settles a failed pending message that was in fact committed', async () => {
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage: vi.fn().mockResolvedValue(fail('network')) }, ids(), me)
    await t.send('hi')
    t.receive(mine(8, 'cid1'))
    expect(t.get().pending).toEqual([])
    expect(t.get().messages.map((m) => m.seq)).toEqual([8])
  })

  it("another member's message with the same client id does not settle my pending", async () => {
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage: vi.fn().mockResolvedValue(fail('network')) }, ids(), me)
    await t.send('hi')
    t.receive({ ...msg(9, 'cid1'), sender: 'other' })
    expect(t.get().pending).toHaveLength(1)
    expect(t.get().messages).toHaveLength(1)
  })

  it('lastSeq is the resume cursor', () => {
    const t = createTimeline('ch', { listMessages: vi.fn(), sendMessage: vi.fn() })
    expect(t.lastSeq()).toBe(0)
    t.receive(msg(4))
    t.receive(msg(2))
    expect(t.lastSeq()).toBe(4)
  })
})
