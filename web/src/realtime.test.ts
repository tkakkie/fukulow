import { expect, it, vi } from 'vitest'
import { connectRealtime, type SocketLike } from './realtime'

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
