import type { ClientMessage, ServerEvent } from './api'

/** The part of WebSocket this module uses; tests pass a fake. */
export type SocketLike = {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
}

export type RealtimeState = {
  connected: boolean
  /** Channels the server has confirmed (`subscribed`) on the current connection. */
  subscribed: ReadonlySet<string>
}

export type RealtimeOptions = {
  onEvent: (e: ServerEvent) => void
  /** Close code 4001: the session ended; the app goes to Sign in. */
  onSessionEnded: () => void
  /** Last seq held for a channel (0 = none); the resume cursor (exclusive). */
  cursor: (channelId: string) => number
  open?: () => SocketLike
  /** Milliseconds before reconnect attempt n (0-based). */
  delay?: (attempt: number) => number
  schedule?: (fn: () => void, ms: number) => unknown
}

export const SESSION_ENDED = 4001
export const OVERFLOW = 4008

function defaultOpen(): SocketLike {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`)
  const socket: SocketLike = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  }
  ws.onopen = () => socket.onopen?.()
  ws.onmessage = (e) => socket.onmessage?.(e)
  ws.onclose = (e) => socket.onclose?.(e)
  return socket
}
// 4008 means "you were too slow": resume at once. Other closes back off up to 10 s.
const defaultDelay = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt)

/**
 * One WebSocket for the app: subscribes channels from their cursors, resubscribes after every
 * reconnect, and reports 4001 instead of reconnecting. Delivery may repeat messages but never skips.
 */
export function createRealtime(opts: RealtimeOptions) {
  const open = opts.open ?? defaultOpen
  const delay = opts.delay ?? defaultDelay
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const wanted = new Set<string>()
  const listeners = new Set<() => void>()
  let state: RealtimeState = { connected: false, subscribed: new Set() }
  let socket: SocketLike | null = null
  let attempt = 0
  let stopped = false

  const set = (patch: Partial<RealtimeState>) => {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }
  const send = (s: SocketLike, m: ClientMessage) => s.send(JSON.stringify(m))
  const sendSubscribe = (s: SocketLike, channelId: string) =>
    send(s, { type: 'subscribe', channel_id: channelId, after_seq: opts.cursor(channelId) })

  function connect() {
    if (stopped) return
    const s = open()
    socket = s
    s.onopen = () => {
      if (socket !== s) return
      attempt = 0
      set({ connected: true, subscribed: new Set() })
      wanted.forEach((id) => sendSubscribe(s, id))
    }
    s.onmessage = (e) => {
      if (socket !== s) return
      const event = parse(e.data)
      if (!event) return
      if (event.type === 'subscribed') set({ subscribed: new Set(state.subscribed).add(event.channel_id) })
      opts.onEvent(event)
    }
    s.onclose = (e) => {
      if (socket !== s) return
      socket = null
      set({ connected: false, subscribed: new Set() })
      if (stopped) return
      if (e.code === SESSION_ENDED) {
        stopped = true
        return opts.onSessionEnded()
      }
      const wait = e.code === OVERFLOW ? 0 : delay(attempt++)
      schedule(connect, wait)
    }
  }
  connect()

  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    /** Idempotent. Takes effect now if connected, otherwise on (re)connect. */
    watch(channelId: string) {
      if (wanted.has(channelId)) return
      wanted.add(channelId)
      if (socket && state.connected) sendSubscribe(socket, channelId)
    },
    unwatch(channelId: string) {
      if (!wanted.delete(channelId)) return
      if (socket && state.connected) send(socket, { type: 'unsubscribe', channel_id: channelId })
      const subscribed = new Set(state.subscribed)
      if (subscribed.delete(channelId)) set({ subscribed })
    },
    close() {
      stopped = true
      const s = socket
      socket = null
      s?.close()
      listeners.clear()
    },
  }
}

function parse(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null
  try {
    const v = JSON.parse(data)
    return v && typeof v === 'object' && typeof v.type === 'string' ? (v as ServerEvent) : null
  } catch {
    return null
  }
}
