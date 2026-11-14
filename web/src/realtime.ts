import type { ClientMessage, Message, ServerEvent } from './api'

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

function defaultOpen(organizationId: string): SocketLike {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/orgs/${encodeURIComponent(organizationId)}/ws`)
  const socket: SocketLike = { send: d => ws.send(d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null }
  ws.onopen = () => socket.onopen?.()
  ws.onmessage = e => socket.onmessage?.(e)
  ws.onclose = e => socket.onclose?.(e)
  return socket
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isSequence = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum

function isMessage(value: unknown): value is Message {
  return isObject(value) && typeof value.channel_id === 'string' && isSequence(value.seq, 1) &&
    typeof value.id === 'string' && typeof value.sender === 'string' &&
    typeof value.client_message_id === 'string' && typeof value.body === 'string' &&
    typeof value.created_at === 'string' && (value.topic_id === null || typeof value.topic_id === 'string') &&
    (value.reply_to === null || typeof value.reply_to === 'string') &&
    (value.reply_root_id === null || typeof value.reply_root_id === 'string')
}

function isServerEvent(value: unknown): value is ServerEvent {
  if (!isObject(value)) return false
  switch (value.type) {
    case 'activity_ready': case 'activity_reset': case 'channel_list_changed': case 'members_changed':
      return Object.keys(value).every(k => k === 'type')
    case 'channel_activity': return typeof value.channel_id === 'string' && isSequence(value.seq, 1) && Object.keys(value).every(k => ['type', 'channel_id', 'seq'].includes(k))
    case 'read_position_changed': return typeof value.channel_id === 'string' && (value.topic_id === null || typeof value.topic_id === 'string') && isSequence(value.read_seq, 0) && Object.keys(value).every(k => ['type', 'channel_id', 'topic_id', 'read_seq'].includes(k))
    case 'channel_access_gained': case 'channel_access_revoked': case 'channel_members_changed':
      return typeof value.channel_id === 'string' && Object.keys(value).every(k => k === 'type' || k === 'channel_id')
    case 'message': return isMessage(value.message)
    case 'channel_access_lost': return typeof value.channel_id === 'string' && Object.keys(value).every(k => k === 'type' || k === 'channel_id')
    case 'subscribed': return typeof value.channel_id === 'string' && isSequence(value.caught_up_seq, 0)
    case 'error': return typeof value.code === 'string' &&
      (value.channel_id === undefined || value.channel_id === null || typeof value.channel_id === 'string')
    default: return false
  }
}

/** Delivery can repeat; the protocol establishes gap-free resume cursors across HTTP/socket races. */
export function connectRealtime(handlers: RealtimeHandlers, open: () => SocketLike = () => defaultOpen(organizationId), organizationId = ''): Connection {
  const socket = open()
  socket.onopen = handlers.onReady
  socket.onclose = e => handlers.onClose(e.code)
  socket.onmessage = e => {
    if (typeof e.data !== 'string') return
    let event: unknown
    try { event = JSON.parse(e.data) } catch { return }
    if (isServerEvent(event)) handlers.onEvent(event)
  }
  return {
    send: message => socket.send(JSON.stringify(message)),
    close() {
      socket.onopen = socket.onmessage = socket.onclose = null
      socket.close()
    },
  }
}
