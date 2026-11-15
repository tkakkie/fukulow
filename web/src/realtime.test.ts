import { expect, it, vi } from 'vitest'
import { connectRealtime, type SocketLike } from './realtime'
import { record } from './protocol-test-helpers'

it('transports generated controls and events without owning reconnection policy', () => {
  const socket: SocketLike = { send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null }
  const handlers = { onReady: vi.fn(), onEvent: vi.fn(), onClose: vi.fn() }
  const open = vi.fn(() => socket)
  const connection = connectRealtime(handlers, open)
  socket.onopen?.()
  expect(handlers.onReady).toHaveBeenCalledOnce()
  connection.send({ type: 'subscribe', channel_id: 'a', after_seq: 100 })
  expect(socket.send).toHaveBeenCalledWith('{"type":"subscribe","channel_id":"a","after_seq":100}')
  for (const data of [null, 'bad json', '{"x":1}']) socket.onmessage?.({ data })
  expect(handlers.onEvent).not.toHaveBeenCalled()
  const event = { type: 'subscribed', channel_id: 'a', caught_up_seq: 100 }
  socket.onmessage?.({ data: JSON.stringify(event) })
  expect(handlers.onEvent).toHaveBeenCalledWith(event)
  socket.onclose?.({ code: 4008 })
  expect(handlers.onClose).toHaveBeenCalledWith(4008)
  expect(open).toHaveBeenCalledOnce()
  const lateMessage = socket.onmessage
  connection.close()
  expect(socket.close).toHaveBeenCalledOnce()
  expect(socket.onmessage).toBeNull()
  // Any saved callback still carries its controller generation.
  expect(lateMessage).not.toBeNull()
})

it('ignores malformed payloads for every forwarded event without throwing or closing the socket', () => {
  const socket: SocketLike = { send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null }
  const handlers = { onReady: vi.fn(), onEvent: vi.fn(), onClose: vi.fn() }
  const connection = connectRealtime(handlers, () => socket)
  const message = record(101)
  const malformed: unknown[] = [null, [], true, 123, 'message', {}, { type: 'unknown' },
    { type: 'message' }, { type: 'message', message: null }, { type: 'message', message: [] },
    { type: 'message', message: 'message' },
    { type: 'subscribed' }, { type: 'subscribed', channel_id: 'A' },
    { type: 'subscribed', channel_id: 1, caught_up_seq: 100 },
    ...['100', null, -1, 1.5, Infinity].map(caught_up_seq => ({ type: 'subscribed', channel_id: 'A', caught_up_seq })),
    { type: 'error' }, { type: 'error', code: 404 }, { type: 'error', code: 'channel_not_found', channel_id: {} },
  ]
  for (const field of Object.keys(message)) {
    const missing: Record<string, unknown> = { ...message }
    delete missing[field]
    malformed.push({ type: 'message', message: missing })
    malformed.push({ type: 'message', message: { ...message, [field]: field === 'seq' ? '101' : 123 } })
  }
  for (const seq of [null, 0, -1, 1.5, Infinity]) malformed.push({ type: 'message', message: { ...message, seq } })
  for (const mentions of [null, {}, [null], [{}], [{ member_id: 'target' }], [{ member_id: 1, name: 'Name' }]])
    malformed.push({ type: 'message', message: { ...message, mentions } })
  for (const data of [undefined, 1, {}, 'bad json', ...malformed.map(value => JSON.stringify(value)),
    '{"type":"message","message":{"seq":1e999}}',
    '{"type":"subscribed","channel_id":"A","caught_up_seq":1e999}']) {
    expect(() => socket.onmessage?.({ data }), String(data)).not.toThrow()
  }
  expect(handlers.onEvent).not.toHaveBeenCalled()
  expect(handlers.onClose).not.toHaveBeenCalled()
  expect(socket.close).not.toHaveBeenCalled()
  for (const event of [
    { type: 'message', message },
    { type: 'subscribed', channel_id: 'A', caught_up_seq: 0 },
    { type: 'error', code: 'invalid_control' },
    { type: 'error', code: 'invalid_control', channel_id: null },
    { type: 'error', code: 'channel_not_found', channel_id: 'A' },
  ]) {
    socket.onmessage?.({ data: JSON.stringify(event) })
    expect(handlers.onEvent).toHaveBeenLastCalledWith(event)
  }
  expect(handlers.onEvent).toHaveBeenCalledTimes(5)
  connection.close()
})

it('forwards Topic Messages without losing their generated topic_id', () => {
  const socket: SocketLike = { send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null }
  const handlers = { onReady: vi.fn(), onEvent: vi.fn(), onClose: vi.fn() }
  connectRealtime(handlers, () => socket)
  const event = { type: 'message', message: { ...record(1), topic_id: '01955bc2-4fd1-4000-8000-000000000001' } }
  socket.onmessage?.({ data: JSON.stringify(event) })
  expect(handlers.onEvent).toHaveBeenCalledWith(event)
})

it('forwards Reply chain membership when the parent is not loaded and rejects malformed Reply fields', () => {
  const socket: SocketLike = { send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null }
  const handlers = { onReady: vi.fn(), onEvent: vi.fn(), onClose: vi.fn() }
  connectRealtime(handlers, () => socket)
  const event = { type: 'message', message: { ...record(20), reply_to: 'unloaded-parent', reply_root_id: 'root' } }
  socket.onmessage?.({ data: JSON.stringify(event) })
  expect(handlers.onEvent).toHaveBeenCalledWith(event)
  handlers.onEvent.mockClear()
  for (const field of ['reply_to', 'reply_root_id']) {
    const missing: Record<string, unknown> = { ...event.message }
    delete missing[field]
    for (const message of [missing, { ...event.message, [field]: 123 }]) socket.onmessage?.({ data: JSON.stringify({ type: 'message', message }) })
  }
  expect(handlers.onEvent).not.toHaveBeenCalled()
})

it('validates the channel-only access-loss event and rejects missing, malformed or extra fields', () => {
  const socket: SocketLike = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null }
  const onEvent = vi.fn(); const connection = connectRealtime({ onReady() {}, onClose() {}, onEvent }, () => socket)
  for (const event of [{ type: 'channel_access_lost' }, { type: 'channel_access_lost', channel_id: null },
    { type: 'channel_access_lost', channel_id: 'A', name: 'protected' }]) socket.onmessage?.({ data: JSON.stringify(event) })
  expect(onEvent).not.toHaveBeenCalled()
  socket.onmessage?.({ data: JSON.stringify({ type: 'channel_access_lost', channel_id: 'A' }) })
  expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'channel_access_lost', channel_id: 'A' }); connection.close()
})
