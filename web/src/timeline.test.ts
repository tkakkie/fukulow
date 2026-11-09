import { afterEach, expect, it, vi } from 'vitest'
import { createSync } from './timeline'
import type { Message, Result } from './api'
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
  expect(a.get().pending).toEqual([{ clientMessageId: 'c1', body: 'hi', status: 'failed', retryable: true }])
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
