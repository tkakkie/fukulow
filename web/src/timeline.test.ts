import { afterEach, expect, it, vi } from 'vitest'
import { createSync } from './sync'
import { createDraftStore } from './drafts'
import { fakeNetwork, ok, sentBy, settle } from './adapter-test-helpers.svelte'
import type { Message, MessagePage, Result } from './api'
import { record } from './protocol-test-helpers'

afterEach(() => vi.useRealTimers())
it('a timed-out send cannot restore its draft after stop and a late 409', async () => {
  vi.useFakeTimers()
  const drafts = createDraftStore()
  const net = fakeNetwork()
  const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts, requestTimeoutMs: 1000 })
  await sync.start()
  await sync.watch('A')
  const a = sync.getTimeline('A')
  a.setDraft('送信する本文')
  const sending = a.submit()
  await vi.advanceTimersByTimeAsync(1000)
  expect(await sending).toBe(true)
  const pending = sync.get().channels.A.pending[0]
  expect(pending.state).toBe('unknown')
  expect(sync.get().requests[pending.request]).toBeUndefined()
  await sync.close()
  net.sends[0].resolve({ ok: false, kind: 'http', status: 409 })
  await settle()
  expect(a.get().draft).toBe('')
  expect(drafts.hasDrafts()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('a stalled transport drops its submitted draft entry at the deadline and cannot restore later', async () => {
  vi.useFakeTimers()
  const drafts = createDraftStore()
  const net = fakeNetwork()
  const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts, requestTimeoutMs: 1000 })
  await sync.start()
  await sync.watch('A')
  const a = sync.getTimeline('A')
  a.setDraft('送信する本文')
  const sending = a.submit()
  const id = net.sends[0].body.client_message_id
  // Observe release before the underlying transport settles, without exposing controller internals.
  const deletion = vi.spyOn(Map.prototype, 'delete')
  let removed: boolean
  try {
    await vi.advanceTimersByTimeAsync(1000)
    removed = deletion.mock.calls.some(([key], index) => key === id && deletion.mock.results[index]?.value === true)
  } finally {
    deletion.mockRestore()
  }
  expect(removed).toBe(true)
  expect(await sending).toBe(true)
  expect(a.get().pending).toMatchObject([{ clientMessageId: id, status: 'failed', retryable: true }])
  await sync.close()
  net.sends[0].resolve({ ok: false, kind: 'http', status: 409 })
  await settle()
  expect(a.get().draft).toBe('')
  expect(drafts.hasDrafts()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([400, 403, 404, 409, 413, 415, 200, 'network', 503] as const)(
  'Organization close cancels submit and restores only a late definite refusal: %s', async status => {
    vi.useFakeTimers()
    const drafts = createDraftStore()
    const net = fakeNetwork()
    const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts })
    await sync.start()
    await sync.watch('A')
    const a = sync.getTimeline('A')
    a.setDraft('送信する本文')
    const sending = a.submit()
    await sync.close()
    expect(await sending).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(drafts.hasDrafts()).toBe(false)
    const send = net.sends[0]
    send.resolve(status === 200 ? ok(sentBy('me', 1, send.body.client_message_id, send.body.body))
      : status === 'network' ? { ok: false, kind: 'network' } : { ok: false, kind: 'http', status })
    await settle()
    const expected = typeof status === 'number' && [400, 403, 404, 409, 413, 415].includes(status) ? '送信する本文' : ''
    expect(drafts.get({ organizationId: 'o', channelId: 'A' })).toBe(expected)
    expect(a.get().messages).toEqual([])
    expect(a.get().pending).toEqual([])
  },
)

it('a send ACK, refusal and late refusal after settlement preserve text typed after submit in the Account Session store', async () => {
  for (const edit of ['untouched', 'typed then cleared', 'new text'] as const) {
    for (const outcome of ['ACK', 'refusal', 'late refusal'] as const) {
      const drafts = createDraftStore()
      const net = fakeNetwork()
      const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts })
      await sync.start()
      await sync.watch('A')
      const a = sync.getTimeline('A')
      a.setDraft('送信する本文')
      const sending = a.submit()
      expect(a.get().draft).toBe('')
      if (edit !== 'untouched') a.setDraft('送信後の新しい下書き')
      if (edit === 'typed then cleared') a.setDraft('')
      const message = sentBy('me', 1, net.sends[0].body.client_message_id, '送信する本文')
      if (outcome === 'late refusal') await sync.settleHistory('A', [message])
      net.sends[0].resolve(outcome === 'ACK' ? ok(message) : { ok: false, kind: 'http', status: 400 })
      expect(await sending).toBe(true)
      await settle()
      const expected = edit === 'new text' ? '送信後の新しい下書き' : ''
      expect(a.get().draft, outcome).toBe(expected)
      expect(drafts.get({ organizationId: 'o', channelId: 'A' }), outcome).toBe(expected)
      expect(drafts.hasDrafts(), outcome).toBe(expected !== '')
      expect(a.get().pending, outcome).toHaveLength(outcome === 'refusal' ? 1 : 0)
      await sync.close()
    }
  }
})

it.each(['untouched', 'typed then cleared', 'new text'] as const)(
  'a refused submit restores only an unedited draft: %s', async edit => {
    const drafts = createDraftStore()
    const net = fakeNetwork()
    const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts,
      // Refuse admission between submit's availability check and user_send.
      newId: () => { void sync.channelUnavailable('A'); return 'refused' },
    })
    await sync.start()
    await sync.watch('A')
    const a = sync.getTimeline('A')
    a.setDraft('送信する本文')
    const sending = a.submit()
    if (edit !== 'untouched') a.setDraft('送信後の新しい下書き')
    if (edit === 'typed then cleared') a.setDraft('')
    expect(await sending).toBe(false)
    const expected = edit === 'untouched' ? '送信する本文' : edit === 'new text' ? '送信後の新しい下書き' : ''
    expect(a.get().draft).toBe(expected)
    expect(drafts.get({ organizationId: 'o', channelId: 'A' })).toBe(expected)
    expect(drafts.hasDrafts()).toBe(expected !== '')
    expect(net.sends).toHaveLength(0)
    await sync.close()
  },
)

it('an admission refusal cannot restore a draft after the Account Session store was cleared', async () => {
  const drafts = createDraftStore()
  const net = fakeNetwork()
  const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts: drafts.scope(),
    newId: () => { void sync.channelUnavailable('A'); return 'refused' },
  })
  await sync.start()
  await sync.watch('A')
  const a = sync.getTimeline('A')
  a.setDraft('送信する本文')
  const pending = a.submit()
  drafts.clear()
  expect(await pending).toBe(false)
  expect(drafts.hasDrafts()).toBe(false)
  expect(drafts.scope().get({ organizationId: 'o', channelId: 'A' })).toBe('')
  await sync.close()
})

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

it('tracks unsaved drafts and pending sends across all Channels for session-level beforeunload checks', async () => {
  const sendMessage = vi.fn().mockResolvedValue({ ok: false, kind: 'network' })
  const sync = createSync({
    selfId: 'me',
    newId: () => 'c1',
    connect: () => ({ send() {}, close() {} }),
    api: { listMessages: vi.fn().mockResolvedValue({ ok: true, data: { messages: [], has_more: false } }), sendMessage },
  })
  await sync.start()
  const a = sync.getTimeline('A')
  const b = sync.getTimeline('B')

  expect(sync.hasUnsavedChanges()).toBe(false)

  // Draft in Channel A while viewing Channel B still marks the session dirty
  a.setDraft('書きかけのメッセージ')
  await sync.watch('B')
  expect(b.get().draft).toBe('')
  expect(b.get().pending).toEqual([])
  expect(sync.hasUnsavedChanges()).toBe(true)

  a.setDraft('')
  expect(sync.hasUnsavedChanges()).toBe(false)

  // Failed/pending send in Channel A while Channel B is active still marks the session dirty
  await a.send('未送信メッセージ')
  await sync.unwatch('A')
  expect(a.get().pending).toHaveLength(1)
  expect(b.get().pending).toEqual([])
  expect(sync.hasUnsavedChanges()).toBe(true)

  a.discard('c1')
  expect(sync.hasUnsavedChanges()).toBe(false)
  await sync.close()
})

it('no-op extra patches and dispatches leaving olderError false notify no Channel listener and keep extra-state identity', async () => {
  let closeSocket!: (code: number) => void
  const listMessages = vi.fn().mockImplementation(async (channel: string) => ({
    ok: true,
    data: { messages: [record(1, channel)], has_more: false },
  }))
  const sync = createSync({
    selfId: 'me',
    connect: handlers => {
      closeSocket = handlers.onClose
      handlers.onReady()
      return { send() {}, close() {} }
    },
    api: { listMessages, sendMessage: vi.fn() },
  })
  await sync.start()
  await sync.watch('B')

  const b = sync.getTimeline('B')
  b.setDraft('bad\0')
  expect(await b.submit()).toBe(false)
  const bSnapshot = b.get()
  expect(bSnapshot.composerError).not.toBeNull()
  const bListener = vi.fn()
  b.subscribe(bListener)

  await sync.watch('A')
  expect(await b.submit()).toBe(false)
  b.setDraft('bad\0')
  expect(bListener).not.toHaveBeenCalled()
  expect(b.get()).toBe(bSnapshot)

  b.setDraft('fixed')
  expect(b.get()).toMatchObject({ draft: 'fixed', composerError: null })

  const c = sync.getTimeline('C')
  c.setDraft('draft C')
  const cBeforeWatch = c.get()
  const d = sync.getTimeline('D')
  const dEmpty = d.get()
  d.setDraft('temp')
  d.setDraft('')

  await sync.watch('C')
  closeSocket(4001)
  expect(c.get()).toBe(cBeforeWatch)
  expect(d.get()).toBe(dEmpty)
  await sync.close()
})
