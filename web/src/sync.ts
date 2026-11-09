import * as api from './api'
import type { ListMessagesQuery, Message, MessagePage, Result, SendMessageRequest } from './api'
import { connectRealtime, type Connection, type RealtimeHandlers } from './realtime'
import { initialState, step, type ChannelState, type Effect, type Input } from './protocol'

export type TimelineApi = {
  listMessages(channel: string, query?: ListMessagesQuery): Promise<Result<MessagePage>>
  sendMessage(channel: string, body: SendMessageRequest): Promise<Result<Message>>
}
type Wait = Extract<Effect, { type: 'wait' }>
export type SyncOptions = {
  selfId: string
  api?: TimelineApi
  connect?: (handlers: RealtimeHandlers) => Connection
  newId?: () => string
  onSessionEnded?: () => void
  graceMs?: number
  delay?: (attempt: number) => number
  requestTimeoutMs?: number
  schedule?: (fn: () => void, ms: number, effect: Wait) => unknown
  cancel?: (handle: unknown) => void
}
export type TimelineState = {
  status: 'loading' | 'ready' | 'error'
  messages: Message[]
  pending: { clientMessageId: string; body: string; status: 'sending' | 'failed'; retryable: boolean }[]
  hasOlder: boolean
  loadingOlder: boolean
}

/** One controller per signed-in session; subscribers only observe, never control its lifetime. */
export function createSync(options: SyncOptions) {
  const transport = options.api ?? api
  const connect = options.connect ?? connectRealtime
  const newId = options.newId ?? (() => crypto.randomUUID())
  const delay = options.delay ?? (n => Math.min(10_000, 500 * 2 ** Math.min(n, 5)))
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let state = initialState(options.selfId)
  let socket: { transport: Connection; subscriptions: Map<string, number[]> } | undefined
  const timers = new Map<number, unknown>()
  const requests = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  const channelListeners = new Map<string, Set<() => void>>()
  const timelines = new Map<string, ReturnType<typeof timeline>>()

  function dispatch(input: Input): Promise<void> {
    const previous = state
    const result = step(state, input)
    state = result.state
    if (state !== previous) {
      listeners.forEach(l => l())
      channelListeners.forEach((listeners, channel) => {
        if (state.channels[channel] !== previous.channels[channel]) listeners.forEach(l => l())
      })
    }
    return Promise.all(result.effects.map(execute)).then(() => {})
  }

  // A transport that never answers is an unknown outcome, rather than a permanently sending entry.
  // Deadlines/cancellation fence results but do not abort HTTP; a retry may overlap the underlying request.
  async function request<T>(id: number, run: () => Promise<Result<T>>): Promise<Result<T>> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const cancelled = new Promise<Result<T>>(resolve => {
        requests.set(id, () => resolve({ ok: false, kind: 'network' }))
        timeout = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
      })
      return await Promise.race([run(), cancelled])
    } catch { return { ok: false, kind: 'network' } }
    finally {
      if (timeout !== undefined) clearTimeout(timeout)
      requests.delete(id)
    }
  }

  async function execute(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'connect': {
        socket?.transport.close()
        try {
          const subscriptions = new Map<string, number[]>()
          const confirmed = new Map<string, number>()
          const transport = connect({
            onReady: () => { void dispatch({ type: 'connection_ready', connection: effect.id }) },
            onEvent: event => {
              const isReply = event.type === 'subscribed' || (event.type === 'error' &&
                (event.code === 'channel_not_found' || event.code === 'subscription_limit'))
              let subscription: number | undefined
              if (isReply && event.channel_id) {
                const channel = event.channel_id
                const pending = subscriptions.get(channel)
                if (event.type === 'error' && event.code === 'channel_not_found') {
                  // With no pending control this belongs to the confirmed generation, even after unwatch.
                  // With no prior confirmation, ordered replies pair with queued subscribe generations.
                  // A prior confirmed subscription plus a pending subscribe is ambiguous: the wire has
                  // no generation id, so this could be an old async error or the new refusal. Do not
                  // consume a reply or invalidate either generation; reconnect to establish a wire fence.
                  // The server serializes controls/live delivery: a new subscribed handoff ends that ambiguity.
                  if (confirmed.has(channel) && pending?.length) {
                    if (state.connection === effect.id && state.connected) {
                      const own = socket?.transport
                      void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 })
                      own?.close()
                    }
                    return
                  }
                  subscription = pending?.shift() ?? confirmed.get(channel) ?? -1
                  confirmed.delete(channel)
                } else {
                  subscription = pending?.shift() ?? -1
                  if (event.type === 'subscribed' && subscription !== -1) confirmed.set(channel, subscription)
                }
              }
              void dispatch({ type: 'event', connection: effect.id, event, subscription })
            },
            onClose: code => { void dispatch({ type: 'socket_closed', connection: effect.id, code }) },
          })
          socket = { transport, subscriptions }
        } catch { void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 }) }
        break
      }
      case 'close':
        socket?.transport.close(); socket = undefined
        requests.forEach(cancel => cancel())
        break
      case 'subscribe':
      case 'unsubscribe':
        try {
          if (effect.type === 'subscribe' && socket) {
            const pending = socket.subscriptions.get(effect.channel) ?? []
            pending.push(effect.id)
            socket.subscriptions.set(effect.channel, pending)
          }
          socket?.transport.send(effect.type === 'subscribe'
            ? { type: 'subscribe', channel_id: effect.channel, after_seq: effect.after_seq }
            : { type: 'unsubscribe', channel_id: effect.channel })
        } catch {
          if (state.connection !== null) void dispatch({ type: 'socket_closed', connection: state.connection, code: 1006 })
        }
        break
      case 'fetch_history': {
        const query = effect.page === 'after' ? { after_seq: effect.seq } : { before_seq: effect.seq }
        const result = await request(effect.id, () => effect.page === 'latest'
          ? transport.listMessages(effect.channel) : transport.listMessages(effect.channel, query))
        await dispatch(result.ok ? { type: 'history_result', request: effect.id, page: result.data }
          : { type: 'history_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network' })
        break
      }
      case 'send': {
        const result = await request(effect.id, () => transport.sendMessage(effect.channel,
          { client_message_id: effect.client_message_id, body: effect.body }))
        await dispatch(result.ok ? { type: 'ack', request: effect.id, message: result.data }
          : { type: 'send_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network' })
        break
      }
      case 'wait': {
        const ms = effect.purpose === 'reorder_grace' ? options.graceMs ?? 100 : delay(effect.attempt)
        timers.set(effect.id, schedule(() => {
          timers.delete(effect.id)
          void dispatch({ type: 'timer_elapsed', id: effect.id })
        }, ms, effect))
        break
      }
      case 'cancel_timer':
        if (timers.has(effect.id)) { cancel(timers.get(effect.id)); timers.delete(effect.id) }
        break
      case 'sign_in': options.onSessionEnded?.(); break
    }
  }

  function timeline(channel: string) {
    let snapshot: TimelineState
    let last: ChannelState | undefined | null = null
    const listeners = new Set<() => void>()
    channelListeners.set(channel, listeners)
    return {
      get(): TimelineState {
        const c = state.channels[channel]
        if (last === c) return snapshot
        last = c
        snapshot = {
          // Content visibility depends on the base; subscription confirmation drives the separate live indicator.
          status: c?.state === 'unavailable' || c?.historyError ? 'error' : c && c.cursor !== null ? 'ready' : 'loading',
          messages: c?.messages ?? [],
          pending: (c?.pending ?? []).map(p => ({ clientMessageId: p.clientMessageId, body: p.body,
            status: p.state === 'sending' ? 'sending' : 'failed', retryable: p.state !== 'failed' })),
          hasOlder: c?.hasOlder ?? false, loadingOlder: c?.older !== undefined,
        }
        return snapshot
      },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      loadLatest: () => dispatch({ type: 'refresh', channel }),
      loadOlder: () => dispatch({ type: 'load_older', channel }),
      async send(body: string) {
        const text = body.trim()
        if (!text) return false
        const clientMessageId = newId()
        const completion = dispatch({ type: 'user_send', channel, clientMessageId, body: text })
        const accepted = state.channels[channel]?.pending.some(p => p.clientMessageId === clientMessageId) ?? false
        await completion
        return accepted
      },
      retry: (clientMessageId: string) => dispatch({ type: 'user_retry', channel, clientMessageId }),
      discard: (clientMessageId: string) => { void dispatch({ type: 'user_discard', channel, clientMessageId }) },
    }
  }

  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => dispatch({ type: 'session_start', selfId: options.selfId }),
    replaceSession: (selfId: string) => dispatch({ type: 'session_replaced', selfId }),
    watch: (channel: string) => dispatch({ type: 'watch', channel }),
    unwatch: (channel: string) => dispatch({ type: 'unwatch', channel }),
    close: () => dispatch({ type: 'stop' }),
    getTimeline(channel: string) {
      let t = timelines.get(channel)
      if (!t) { t = timeline(channel); timelines.set(channel, t) }
      return t
    },
  }
}
