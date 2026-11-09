import type { ClientMessage, ServerEvent } from './api'

/** The transport has no reconnect, subscription or cursor policy; sync owns its lifetime. */
export type SocketLike = {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
}
export type RealtimeHandlers = {
  onReady: () => void
  onEvent: (event: ServerEvent) => void
  onClose: (code: number) => void
}
export type Connection = { send(message: ClientMessage): void; close(): void }

function defaultOpen(): SocketLike {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`)
  const socket: SocketLike = { send: d => ws.send(d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null }
  ws.onopen = () => socket.onopen?.()
  ws.onmessage = e => socket.onmessage?.(e)
  ws.onclose = e => socket.onclose?.(e)
  return socket
}

/** Delivery can repeat; the protocol establishes gap-free resume cursors across HTTP/socket races. */
export function connectRealtime(handlers: RealtimeHandlers, open = defaultOpen): Connection {
  const socket = open()
  socket.onopen = handlers.onReady
  socket.onclose = e => handlers.onClose(e.code)
  socket.onmessage = e => {
    if (typeof e.data !== 'string') return
    let event: ServerEvent
    try { event = JSON.parse(e.data) as ServerEvent } catch { return }
    if (event && ['message', 'subscribed', 'error'].includes(event.type)) handlers.onEvent(event)
  }
  return {
    send: message => socket.send(JSON.stringify(message)),
    close() {
      socket.onopen = socket.onmessage = socket.onclose = null
      socket.close()
    },
  }
}
