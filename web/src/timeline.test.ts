import { afterEach, expect, it, vi } from 'vitest'
import { createSync } from './sync'
import { createDraftStore } from './drafts'
import { fakeNetwork, ok, sentBy, settle } from './adapter-test-helpers.svelte'
import type { Message, MessagePage, Result } from './api'
import { sendMessage } from './api'
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
  expect(a.composer.get().draft).toBe('')
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
  expect(a.composer.get().draft).toBe('')
  expect(drafts.hasDrafts()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([400, 403, 404, 409, 413, 415, 200, 'network', 429, 503] as const)(
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
    const deletion = vi.spyOn(Map.prototype, 'delete')
    let removed: boolean
    try {
      send.resolve(status === 200 ? ok(sentBy('me', 1, send.body.client_message_id, send.body.body))
        : status === 'network' || status === 503 ? { ok: false, kind: 'network' } : { ok: false, kind: 'http', status })
      await settle()
      removed = deletion.mock.calls.some(([key], index) => key === send.body.client_message_id && deletion.mock.results[index]?.value === true)
    } finally {
      deletion.mockRestore()
    }
    expect(removed).toBe(true)
    const expected = typeof status === 'number' && [400, 403, 404, 409, 413, 415].includes(status) ? '送信する本文' : ''
    expect(drafts.get({ organizationId: 'o', channelId: 'A' })).toBe(expected)
    expect(a.get().messages).toEqual([])
    expect(a.get().pending).toEqual([])
  },
)

it.each([429, 503])('close during a same-key retry after HTTP %s retains the unedited draft restore', async status => {
  vi.useFakeTimers()
  for (const refusal of [400, 403, 404, 409, 413, 415]) {
    for (const edit of ['untouched', 'typed then cleared', 'new text'] as const) {
      const drafts = createDraftStore()
      const net = fakeNetwork()
      const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts })
      await sync.start()
      await sync.watch('A')
      const a = sync.getTimeline('A')
      a.setDraft('送信する本文')
      a.setTopicDraft('Release')
      const sending = a.submit()
      const original = net.sends[0].body
      const retryable: Result<Message> = status === 429
        ? { ok: false, kind: 'http', status, retryAfterMs: 1000 }
        : { ok: false, kind: 'network', retryAfterMs: 1000 }
      net.sends[0].resolve(retryable)
      expect(await sending).toBe(true)
      // Repeated responses must keep the restore for the entire same-key retry sequence.
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (status === 429) await vi.advanceTimersByTimeAsync(1000)
        else void a.retry(original.client_message_id)
        await settle()
        expect(net.sends).toHaveLength(attempt + 1)
        expect(net.sends[attempt].body).toEqual(original)
        if (attempt === 1) {
          net.sends[attempt].resolve(retryable)
          await settle()
        }
      }
      if (edit !== 'untouched') a.setDraft('送信後の新しい下書き')
      if (edit === 'typed then cleared') a.setDraft('')
      await sync.close()
      expect(vi.getTimerCount()).toBe(0)
      net.sends[2].resolve({ ok: false, kind: 'http', status: refusal })
      await settle()
      const target = { organizationId: 'o', channelId: 'A' }
      expect(drafts.get(target)).toBe(edit === 'untouched' ? original.body : edit === 'new text' ? '送信後の新しい下書き' : '')
      expect(drafts.getTopicDraft(target)).toBe(edit === 'untouched' ? 'Release' : '')
      expect(a.get().pending).toEqual([])
      expect(a.get().messages).toEqual([])
      expect(net.sends).toHaveLength(3)
    }
  }
})

it('real API admission 503 preserves the draft through close during a same-key retry and a late refusal', async () => {
  vi.useFakeTimers()
  const drafts = createDraftStore()
  const net = fakeNetwork()
  let refuse!: (response: Response) => void
  const retryResponse = new Promise<Response>(resolve => { refuse = resolve })
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{"error":"send_admission_unavailable"}', {
      status: 503, headers: { 'Retry-After': '3' },
    }))
    .mockReturnValueOnce(retryResponse)
  const options = net.options().sync!
  const send = vi.fn((channel: string, body: Parameters<typeof sendMessage>[2]) => sendMessage('o', channel, body, fetchMock))
  const sync = createSync({ selfId: 'me', ...options, organizationId: 'o', drafts,
    api: { ...options.api!, sendMessage: send },
  })
  await sync.start()
  await sync.watch('A')
  const a = sync.getTimeline('A')
  a.setDraft('送信する本文')
  expect(await a.submit()).toBe(true)
  expect(await send.mock.results[0].value).toEqual({ ok: false, kind: 'network', retryAfterMs: 3000 })
  const original = send.mock.calls[0][1]
  const retrying = a.retry(original.client_message_id)
  expect(send.mock.calls[1][1]).toEqual(original)
  expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0])
  await sync.close()
  await retrying
  const deletion = vi.spyOn(Map.prototype, 'delete')
  let removed: boolean
  try {
    refuse(new Response('{"error":"conflict"}', { status: 409 }))
    await settle()
    removed = deletion.mock.calls.some(([key], index) => key === original.client_message_id && deletion.mock.results[index]?.value === true)
  } finally {
    deletion.mockRestore()
  }
  expect(drafts.get({ organizationId: 'o', channelId: 'A' })).toBe(original.body)
  expect(removed).toBe(true)
  expect(a.get().pending).toEqual([])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['ACK', 'echo', 'history', 'discard', 'refusal', 'close', 'session start', 'session replacement'] as const)(
  'releases the submitted draft restore after a retryable response and %s', async end => {
    vi.useFakeTimers()
    for (const status of [429, 503, 'fetch error'] as const) {
      const drafts = createDraftStore()
      const net = fakeNetwork()
      const sync = createSync({ selfId: 'me', ...net.options().sync, organizationId: 'o', drafts })
      await sync.start()
      net.socket.onReady()
      await sync.watch('A')
      net.subscribed('A', 0)
      const a = sync.getTimeline('A')
      a.setDraft('送信する本文')
      const sending = a.submit()
      const original = net.sends[0].body
      const id = original.client_message_id
      net.sends[0].resolve(status === 429 ? { ok: false, kind: 'http', status, retryAfterMs: 1000 }
        : status === 503 ? { ok: false, kind: 'network', retryAfterMs: 1000 }
          : await sendMessage('o', 'A', original, async () => { throw new TypeError('fetch failed') }))
      expect(await sending).toBe(true)
      if (end === 'ACK' || end === 'refusal') {
        if (status === 429) await vi.advanceTimersByTimeAsync(1000)
        else void a.retry(id)
        await settle()
        expect(net.sends).toHaveLength(2)
      }
      const message = sentBy('me', 1, id, original.body)
      // Only a successful deletion proves release; no HTTP response follows discard/echo/history.
      const deletion = vi.spyOn(Map.prototype, 'delete')
      let removed: boolean
      try {
        if (end === 'ACK') net.sends[1].resolve(ok(message))
        else if (end === 'refusal') net.sends[1].resolve({ ok: false, kind: 'http', status: 409 })
        else if (end === 'echo') net.event({ type: 'message', message })
        else if (end === 'history') await sync.settleHistory('A', [message])
        else if (end === 'discard') a.discard(id)
        else if (end === 'close') await sync.close()
        else if (end === 'session start') await sync.start()
        else await sync.replaceSession('other')
        await settle()
        removed = deletion.mock.calls.some(([key], index) => key === id && deletion.mock.results[index]?.value === true)
      } finally {
        deletion.mockRestore()
      }
      expect(removed).toBe(true)
      expect(a.get().pending).toHaveLength(end === 'refusal' ? 1 : 0)
      expect(drafts.hasDrafts()).toBe(false)
      await sync.close()
      expect(vi.getTimerCount()).toBe(0)
    }
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
      expect(a.composer.get().draft).toBe('')
      if (edit !== 'untouched') a.setDraft('送信後の新しい下書き')
      if (edit === 'typed then cleared') a.setDraft('')
      const message = sentBy('me', 1, net.sends[0].body.client_message_id, '送信する本文')
      if (outcome === 'late refusal') await sync.settleHistory('A', [message])
      net.sends[0].resolve(outcome === 'ACK' ? ok(message) : { ok: false, kind: 'http', status: 400 })
      expect(await sending).toBe(true)
      await settle()
      const expected = edit === 'new text' ? '送信後の新しい下書き' : ''
      expect(a.composer.get().draft, outcome).toBe(expected)
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
    expect(a.composer.get().draft).toBe(expected)
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
  expect(t.composer.get().draft).toBe('')
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
  expect(t.composer.get().draft).toBe('')

  t.setDraft('prefix')
  expect(t.restore('c1')).toBe(true)
  expect(t.composer.get().draft).toBe('prefix\nrejected text')
  expect(t.get().pending).toEqual([
    { clientMessageId: 'c2', body: 'unknown outcome', status: 'failed', retryable: true },
  ])

  t.setDraft('edited text')
  expect(await t.submit()).toBe(true)
  expect(sendMessage).toHaveBeenLastCalledWith('A', { client_message_id: 'c3', body: 'edited text' })
  await sync.close()
})

it('restores a refused send together with its Topic intent and replaces any conflicting Topic-name draft', async () => {
  let id = 0
  const sendMessage = vi.fn().mockResolvedValue({ ok: false, kind: 'http', status: 400 })
  const sync = createSync({
    selfId: 'me',
    newId: () => `c${++id}`,
    connect: () => ({ send() {}, close() {} }),
    api: { listMessages: vi.fn(), sendMessage },
  })
  await sync.start()
  const t = sync.getTimeline('A')

  // 1. Refused Topic send restored while user typed a different Topic name
  t.setTopicDraft('Original topic')
  t.setDraft('body for original')
  expect(await t.submit()).toBe(true)
  expect(t.get().pending).toEqual([
    {
      clientMessageId: 'c1',
      body: 'body for original',
      topicName: 'Original topic',
      status: 'failed',
      retryable: false,
    },
  ])

  t.setTopicDraft('Different topic')
  expect(t.restore('c1')).toBe(true)
  expect(t.composer.get().draft).toBe('body for original')
  expect(t.composer.get().topicDraft).toBe('Original topic')

  // 2. Refused Channel-root send restored while user typed a Topic name clears topicDraft
  t.setTopicDraft('')
  t.setDraft('root body')
  expect(await t.submit()).toBe(true)
  t.setTopicDraft('Different topic')
  t.setDraft('')
  expect(t.restore('c2')).toBe(true)
  expect(t.composer.get().draft).toBe('root body')
  expect(t.composer.get().topicDraft).toBe('')
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
  expect(b.composer.get().draft).toBe('')
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
  const bComposer = b.composer.get()
  expect(bComposer.composerError).not.toBeNull()
  const bListener = vi.fn()
  const bComposerListener = vi.fn()
  b.subscribe(bListener)
  b.composer.subscribe(bComposerListener)

  await sync.watch('A')
  expect(await b.submit()).toBe(false)
  b.setDraft('bad\0')
  expect(bListener).not.toHaveBeenCalled()
  expect(bComposerListener).not.toHaveBeenCalled()
  expect(b.get()).toBe(bSnapshot)
  expect(b.composer.get()).toBe(bComposer)

  b.setDraft('fixed')
  expect(b.composer.get()).toMatchObject({ draft: 'fixed', composerError: null })

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

it('typing in composer notifies composer subscribers without changing timeline state reference or notifying timeline subscribers', async () => {
  const sendMessage = vi.fn().mockImplementation(async (channel: string, body: { client_message_id: string; body: string }) => ({
    ok: true,
    data: { ...record(2, channel), sender: 'me', client_message_id: body.client_message_id, body: body.body },
  }))
  const sync = createSync({
    selfId: 'me',
    newId: () => 'c1',
    connect: handlers => {
      handlers.onReady()
      return { send() {}, close() {} }
    },
    api: {
      listMessages: vi.fn().mockResolvedValue({ ok: true, data: { messages: [record(1, 'A')], has_more: false } }),
      sendMessage,
    },
  })
  await sync.start()
  await sync.watch('A')

  const a = sync.getTimeline('A')
  const before = a.get()
  const timelineListener = vi.fn()
  const composerListener = vi.fn()
  const topicComposerListener = vi.fn()
  const replyComposerListener = vi.fn()
  a.subscribe(timelineListener)
  a.composer.subscribe(composerListener)
  a.topic('T').subscribe(topicComposerListener)
  a.reply('r1', 'T').subscribe(replyComposerListener)

  a.setDraft('hello')
  a.setTopicDraft('Topic Name')
  expect(timelineListener).not.toHaveBeenCalled()
  expect(composerListener).toHaveBeenCalledTimes(2)
  expect(topicComposerListener).not.toHaveBeenCalled()
  expect(replyComposerListener).not.toHaveBeenCalled()
  expect(a.get()).toBe(before)
  expect(a.composer.get()).toEqual({ draft: 'hello', topicDraft: 'Topic Name', composerError: null })

  a.topic('T').setDraft('topic draft')
  expect(timelineListener).not.toHaveBeenCalled()
  expect(composerListener).toHaveBeenCalledTimes(2)
  expect(topicComposerListener).toHaveBeenCalledTimes(1)
  expect(a.get()).toBe(before)

  a.reply('r1', 'T').setDraft('reply draft')
  expect(timelineListener).not.toHaveBeenCalled()
  expect(replyComposerListener).toHaveBeenCalledTimes(1)
  expect(a.get()).toBe(before)

  expect(await a.submit()).toBe(true)
  expect(a.composer.get()).toEqual({ draft: '', topicDraft: '', composerError: null })
  expect(timelineListener).toHaveBeenCalled()
  expect(a.get().messages.map(m => m.seq)).toEqual([1, 2])
  await sync.close()
})

it('Topic and Reply composer listener maps delete their entry after the last unsubscribe and re-register on resubscribe', async () => {
  const sync = createSync({
    selfId: 'me',
    connect: handlers => {
      handlers.onReady()
      return { send() {}, close() {} }
    },
    api: {
      listMessages: vi.fn().mockResolvedValue({ ok: true, data: { messages: [record(1, 'A')], has_more: false } }),
      sendMessage: vi.fn(),
    },
  })
  await sync.start()
  const a = sync.getTimeline('A')
  const topicKey = JSON.stringify(['A', 'T'])
  const replyKey = JSON.stringify(['A', 'T', 'r1'])

  const setSpy = vi.spyOn(Map.prototype, 'set')
  const deleteSpy = vi.spyOn(Map.prototype, 'delete')
  try {
    const tc = a.topic('T')
    const rc = a.reply('r1', 'T')
    // Creating the composer without subscribing does not register a listener map entry.
    expect(setSpy.mock.calls.some(([k, v]) => k === topicKey && v instanceof Set)).toBe(false)
    expect(setSpy.mock.calls.some(([k, v]) => k === replyKey && v instanceof Set)).toBe(false)

    const t1 = vi.fn()
    const t2 = vi.fn()
    const r1 = vi.fn()
    const r2 = vi.fn()
    const unsubT1 = tc.subscribe(t1)
    const unsubT2 = tc.subscribe(t2)
    const unsubR1 = rc.subscribe(r1)
    const unsubR2 = rc.subscribe(r2)

    const topicMapIndex = setSpy.mock.calls.findIndex(([k, v]) => k === topicKey && v instanceof Set)
    const replyMapIndex = setSpy.mock.calls.findIndex(([k, v]) => k === replyKey && v instanceof Set)
    expect(topicMapIndex).toBeGreaterThanOrEqual(0)
    expect(replyMapIndex).toBeGreaterThanOrEqual(0)
    const topicListenerMap = setSpy.mock.instances[topicMapIndex] as Map<string, Set<() => void>>
    const replyListenerMap = setSpy.mock.instances[replyMapIndex] as Map<string, Set<() => void>>
    expect(topicListenerMap.has(topicKey)).toBe(true)
    expect(replyListenerMap.has(replyKey)).toBe(true)

    // First unsubscribe leaves one active listener; entry stays and still receives updates.
    unsubT1()
    unsubR1()
    expect(topicListenerMap.has(topicKey)).toBe(true)
    expect(replyListenerMap.has(replyKey)).toBe(true)
    tc.setDraft('first topic edit')
    rc.setDraft('first reply edit')
    expect(t1).not.toHaveBeenCalled()
    expect(t2).toHaveBeenCalledTimes(1)
    expect(r1).not.toHaveBeenCalled()
    expect(r2).toHaveBeenCalledTimes(1)

    // Last unsubscribe deletes the map entry completely.
    deleteSpy.mockClear()
    unsubT2()
    unsubR2()
    expect(deleteSpy.mock.calls.some(([k], i) => k === topicKey && deleteSpy.mock.results[i]?.value === true)).toBe(true)
    expect(deleteSpy.mock.calls.some(([k], i) => k === replyKey && deleteSpy.mock.results[i]?.value === true)).toBe(true)
    expect(topicListenerMap.has(topicKey)).toBe(false)
    expect(replyListenerMap.has(replyKey)).toBe(false)

    tc.setDraft('unobserved topic edit')
    rc.setDraft('unobserved reply edit')
    expect(t2).toHaveBeenCalledTimes(1)
    expect(r2).toHaveBeenCalledTimes(1)

    // Resubscribing re-registers the map entry and receives subsequent updates.
    const t3 = vi.fn()
    const r3 = vi.fn()
    const unsubT3 = tc.subscribe(t3)
    const unsubR3 = rc.subscribe(r3)
    expect(topicListenerMap.has(topicKey)).toBe(true)
    expect(replyListenerMap.has(replyKey)).toBe(true)

    tc.setDraft('resubscribed topic edit')
    rc.setDraft('resubscribed reply edit')
    expect(t3).toHaveBeenCalledTimes(1)
    expect(r3).toHaveBeenCalledTimes(1)

    unsubT3()
    unsubR3()
    expect(topicListenerMap.has(topicKey)).toBe(false)
    expect(replyListenerMap.has(replyKey)).toBe(false)
  } finally {
    setSpy.mockRestore()
    deleteSpy.mockRestore()
  }
  await sync.close()
})

it('multiple handles for the same Topic or Reply key share one listener Set across subscribe and unsubscribe', async () => {
  const sync = createSync({
    selfId: 'me',
    connect: handlers => {
      handlers.onReady()
      return { send() {}, close() {} }
    },
    api: {
      listMessages: vi.fn().mockResolvedValue({ ok: true, data: { messages: [record(1, 'A')], has_more: false } }),
      sendMessage: vi.fn(),
    },
  })
  await sync.start()
  const a = sync.getTimeline('A')

  const tc1 = a.topic('T')
  const tc2 = a.topic('T')
  const rc1 = a.reply('r1', 'T')
  const rc2 = a.reply('r1', 'T')

  const t1 = vi.fn()
  const t2 = vi.fn()
  const r1 = vi.fn()
  const r2 = vi.fn()
  const unsubT1 = tc1.subscribe(t1)
  const unsubT2 = tc2.subscribe(t2)
  const unsubR1 = rc1.subscribe(r1)
  const unsubR2 = rc2.subscribe(r2)

  tc1.setDraft('first topic draft')
  rc1.setDraft('first reply draft')
  expect(t1).toHaveBeenCalledTimes(1)
  expect(t2).toHaveBeenCalledTimes(1)
  expect(r1).toHaveBeenCalledTimes(1)
  expect(r2).toHaveBeenCalledTimes(1)

  unsubT1()
  unsubR1()
  tc2.setDraft('second topic draft')
  rc2.setDraft('second reply draft')
  expect(t1).toHaveBeenCalledTimes(1)
  expect(t2).toHaveBeenCalledTimes(2)
  expect(r1).toHaveBeenCalledTimes(1)
  expect(r2).toHaveBeenCalledTimes(2)

  unsubT2()
  unsubR2()
  tc1.setDraft('third topic draft')
  rc1.setDraft('third reply draft')
  expect(t1).toHaveBeenCalledTimes(1)
  expect(t2).toHaveBeenCalledTimes(2)
  expect(r1).toHaveBeenCalledTimes(1)
  expect(r2).toHaveBeenCalledTimes(2)

  await sync.close()
})
