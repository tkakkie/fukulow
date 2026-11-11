import { afterEach, expect, it, vi } from 'vitest'
import { createSync, putExtra, type ChannelExtra } from './sync'
import type { Message, MessagePage, Result } from './api'
import { record } from './protocol-test-helpers'

afterEach(() => vi.useRealTimers())
it('timeline delegates preserve pending across selection and settle history before retry', async () => {
  vi.useFakeTimers()
  const sendMessage = vi.fn().mockResolvedValue({ ok: false, kind: 'network' })
  const listMessages = vi.fn().mockResolvedValue({ ok: true, data: { messages: [{ ...record(7), sender: 'me', client_message_id: 'c1' }], has_more: false } })
  const sync = createSync({ selfId: 'me', newId: () => 'c1', connect: () => ({ send() {}, close() {} }), api: { listMessages, sendMessage } })
  await sync.start()
  const a = sync.getTimeline('A')
  expect(await a.send('   ')).toBe(false)
  await a.send(' hi ')
  expect(sendMessage).toHaveBeenCalledWith('A', { client_message_id: 'c1', body: ' hi ' })
  expect(a.get().pending).toEqual([{ clientMessageId: 'c1', body: ' hi ', status: 'failed', retryable: true }])
  sync.getTimeline('B')
  expect(sync.getTimeline('A')).toBe(a)
  await a.loadLatest()
  expect(a.get().pending).toEqual([])
  await a.retry('c1')
  expect(sendMessage).toHaveBeenCalledOnce()
  expect(a.get().messages).toHaveLength(1)
  await sync.close()
})

it('timeline delegates notify, retain sending entries on discard and fence dispose', async () => {
  vi.useFakeTimers()
  let ack!: (r: Result<Message>) => void
  const sync = createSync({ selfId: 'me', newId: () => 'c1', connect: () => ({ send() {}, close() {} }),
    api: { listMessages: vi.fn(), sendMessage: () => new Promise(r => { ack = r }) } })
  await sync.start()
  const t = sync.getTimeline('A')
  const listener = vi.fn()
  const unsubscribe = t.subscribe(listener)
  const sending = t.send('hi')
  expect(t.get().pending[0].status).toBe('sending')
  t.discard('c1')
  expect(t.get().pending).toHaveLength(1)
  unsubscribe()
  const calls = listener.mock.calls.length
  await sync.close()
  ack({ ok: true, data: { ...record(1), sender: 'me', client_message_id: 'c1' } })
  await sending
  expect(listener).toHaveBeenCalledTimes(calls)
  expect(t.get().messages).toEqual([])
})

it('validates whitespace-only bodies with trim but sends surrounding whitespace unchanged', async () => {
  const sendMessage = vi.fn().mockImplementation(async (_channel, req) => ({
    ok: true,
    data: { ...record(1), sender: 'me', client_message_id: req.client_message_id, body: req.body },
  }))
  let id = 0
  const sync = createSync({
    selfId: 'me',
    newId: () => `c${++id}`,
    connect: () => ({ send() {}, close() {} }),
    api: { listMessages: vi.fn(), sendMessage },
  })
  await sync.start()
  const t = sync.getTimeline('A')

  for (const blank of ['', '   ', '\t\n\u3000']) {
    expect(await t.send(blank)).toBe(false)
    t.setDraft(blank)
    expect(await t.submit()).toBe(false)
  }
  expect(sendMessage).not.toHaveBeenCalled()

  const untrimmed = '\u3000  hello\nworld  \t'
  t.setDraft(untrimmed)
  expect(await t.submit()).toBe(true)
  expect(sendMessage).toHaveBeenCalledWith('A', { client_message_id: 'c1', body: untrimmed })
  expect(t.get().draft).toBe('')
  await sync.close()
})

it('restores only non-retryable failed sends into the Composer draft for editing and resending', async () => {
  let id = 0
  const sendMessage = vi.fn()
    .mockResolvedValueOnce({ ok: false, kind: 'http', status: 400 })
    .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503 })
    .mockImplementationOnce(async (_channel, req) => ({
      ok: true,
      data: { ...record(1), sender: 'me', client_message_id: req.client_message_id, body: req.body },
    }))
  const sync = createSync({
    selfId: 'me',
    newId: () => `c${++id}`,
    connect: () => ({ send() {}, close() {} }),
    api: { listMessages: vi.fn(), sendMessage },
  })
  await sync.start()
  const t = sync.getTimeline('A')

  await t.send('rejected text')
  await t.send('unknown outcome')
  expect(t.get().pending).toEqual([
    { clientMessageId: 'c1', body: 'rejected text', status: 'failed', retryable: false },
    { clientMessageId: 'c2', body: 'unknown outcome', status: 'failed', retryable: true },
  ])

  // Same-key retryable (unknown) sends must not be restored under a new id (C6).
  expect(t.restore('c2')).toBe(false)
  expect(t.get().draft).toBe('')

  t.setDraft('prefix')
  expect(t.restore('c1')).toBe(true)
  expect(t.get().draft).toBe('prefix\nrejected text')
  expect(t.get().pending).toEqual([
    { clientMessageId: 'c2', body: 'unknown outcome', status: 'failed', retryable: true },
  ])

  t.setDraft('edited text')
  expect(await t.submit()).toBe(true)
  expect(sendMessage).toHaveBeenLastCalledWith('A', { client_message_id: 'c3', body: 'edited text' })
  await sync.close()
})

it('reports loadOlder failures in olderError and clears olderError on retry', async () => {
  let resolveRetry!: (r: Result<MessagePage>) => void
  const listMessages = vi.fn()
    .mockResolvedValueOnce({ ok: true, data: { messages: [record(10)], has_more: true } })
    .mockResolvedValueOnce({ ok: false, kind: 'network' })
    .mockImplementationOnce(() => new Promise(r => { resolveRetry = r }))
  const sync = createSync({
    selfId: 'me',
    connect: () => ({ send() {}, close() {} }),
    api: { listMessages, sendMessage: vi.fn() },
  })
  await sync.start()
  await sync.watch('A')
  const t = sync.getTimeline('A')
  expect(t.get()).toMatchObject({ status: 'ready', hasOlder: true, olderError: false, messages: [record(10)] })

  await t.loadOlder()
  expect(t.get()).toMatchObject({ status: 'ready', hasOlder: true, olderError: true, messages: [record(10)] })

  const retry = t.loadOlder()
  expect(t.get()).toMatchObject({ status: 'ready', hasOlder: true, loadingOlder: true, olderError: false })
  resolveRetry({ ok: true, data: { messages: [record(9)], has_more: true } })
  await retry
  expect(t.get()).toMatchObject({
    status: 'ready',
    hasOlder: true,
    loadingOlder: false,
    olderError: false,
    messages: [record(9), record(10)],
  })
  await sync.close()
})

it('putExtra returns early without allocating and keeps ChannelExtra object identity on a no-op patch', () => {
  let spreads = 0
  let reads: (string | symbol)[] = []
  const initial = new Proxy(
    { olderError: true, draft: 'hello', composerError: 'err' } satisfies ChannelExtra,
    {
      get(target, prop, receiver) {
        reads.push(prop)
        return Reflect.get(target, prop, receiver)
      },
      ownKeys(target) {
        spreads++
        return Reflect.ownKeys(target)
      },
    },
  )
  const extras = new Map<string, ChannelExtra>([['B', initial]])

  expect(putExtra(extras, 'B', {})).toBe(false)
  expect(extras.get('B')).toBe(initial)
  expect(reads).toEqual([])
  expect(spreads).toBe(0)

  reads = []
  expect(putExtra(extras, 'B', { olderError: true })).toBe(false)
  expect(extras.get('B')).toBe(initial)
  expect(reads).toEqual(['olderError'])
  expect(spreads).toBe(0)

  reads = []
  expect(putExtra(extras, 'B', { olderError: true, draft: 'hello', composerError: 'err' })).toBe(false)
  expect(extras.get('B')).toBe(initial)
  expect(spreads).toBe(0)

  expect(putExtra(extras, 'C', { olderError: false })).toBe(false)
  expect(putExtra(extras, 'C', { draft: '' })).toBe(false)
  expect(putExtra(extras, 'C', { composerError: null })).toBe(false)
  expect(extras.has('C')).toBe(false)

  expect(putExtra(extras, 'B', { olderError: false })).toBe(true)
  const updated = extras.get('B')
  expect(updated).toEqual({ olderError: false, draft: 'hello', composerError: 'err' })
  expect(updated).not.toBe(initial)

  expect(putExtra(extras, 'B', { draft: '', composerError: null })).toBe(true)
  expect(extras.has('B')).toBe(false)
})
