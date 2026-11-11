import type { DraftStore } from './drafts'
import * as api from './api'
import { backoffCap, reconnectDelay } from './reconnect'
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
  drafts?: DraftStore
  organizationId?: string
  checkMembership?: () => Promise<Result<unknown>>
  api?: TimelineApi
  connect?: (handlers: RealtimeHandlers) => Connection
  newId?: () => string
  onSessionEnded?: () => void
  graceMs?: number
  delay?: (attempt: number) => number
  random?: () => number
  requestTimeoutMs?: number
  schedule?: (fn: () => void, ms: number, effect: Wait) => unknown
  cancel?: (handle: unknown) => void
}
export type TimelineState = {
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  messages: Message[]
  pending: { clientMessageId: string; body: string; status: 'sending' | 'failed'; retryable: boolean }[]
  hasOlder: boolean
  loadingOlder: boolean
  olderError: boolean
  draft: string
  composerError: string | null
}

/** Max Message body length in Unicode scalar values (API rule; a test compares it to openapi.json). */
export const MESSAGE_BODY_MAX = 4000

/** Japanese message when the Message body violates API scalar/NUL rules, else null. */
export function messageBodyError(body: string): string | null {
  if (body.includes('\0')) return 'メッセージにNUL文字は含められません。'
  let count = 0
  for (const ch of body) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) return 'メッセージに使用できない文字が含まれています。'
    if (++count > MESSAGE_BODY_MAX) return `メッセージは${MESSAGE_BODY_MAX}文字以内にしてください。`
  }
  return null
}

type ChannelExtra = { olderError: boolean; draft: string; composerError: string | null }
const emptyExtra: ChannelExtra = { olderError: false, draft: '', composerError: null }

/** One controller per signed-in session; subscribers only observe, never control its lifetime. */
export function createSync(options: SyncOptions) {
  const transport = options.api ?? {
    listMessages: (channel: string, query?: ListMessagesQuery) => api.listMessages(options.organizationId ?? '', channel, query),
    sendMessage: (channel: string, body: SendMessageRequest) => api.sendMessage(options.organizationId ?? '', channel, body),
  }
  const connect = options.connect ?? (handlers => connectRealtime(handlers, undefined, options.organizationId))
  const newId = options.newId ?? (() => crypto.randomUUID())
  const fillDelay = options.delay ?? backoffCap
  const random = options.random ?? Math.random
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let state = initialState(options.selfId)
  let socket: { transport: Connection; subscriptions: Map<string, number[]> } | undefined
  const timers = new Map<number, unknown>()
  const requests = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  const channelListeners = new Map<string, Set<() => void>>()
  const timelines = new Map<string, ReturnType<typeof timeline>>()
  const extras = new Map<string, ChannelExtra>()

  const draftTarget = (channel: string) => ({ organizationId: options.organizationId ?? '', channelId: channel })
  const getExtra = (channel: string): ChannelExtra => {
    const existing = extras.get(channel)
    if (existing) return existing
    const draft = options.drafts?.get(draftTarget(channel)) ?? ''
    if (!draft) return emptyExtra
    const extra = { ...emptyExtra, draft }
    extras.set(channel, extra)
    return extra
  }
  function putExtra(channel: string, patch: Partial<ChannelExtra>): boolean {
    const prev = getExtra(channel)
    if (
      (patch.olderError === undefined || patch.olderError === prev.olderError) &&
      (patch.draft === undefined || patch.draft === prev.draft) &&
      (patch.composerError === undefined || patch.composerError === prev.composerError)
    ) {
      return false
    }
    const olderError = patch.olderError ?? prev.olderError
    const draft = patch.draft ?? prev.draft
    if (patch.draft !== undefined) options.drafts?.set(draftTarget(channel), draft)
    const composerError = patch.composerError !== undefined ? patch.composerError : prev.composerError
    if (!olderError && draft === '' && composerError === null) extras.delete(channel)
    else extras.set(channel, { olderError, draft, composerError })
    return true
  }
  function setExtra(channel: string, patch: Partial<ChannelExtra>) {
    if (putExtra(channel, patch)) channelListeners.get(channel)?.forEach(l => l())
  }
  function clearOlderError(channel: string, prev: ChannelState | undefined, next: ChannelState | undefined): boolean {
    return ((prev?.older === undefined && next?.older !== undefined) ||
      !next?.watched || next.state === 'unavailable' || next.cursor === null || !next.hasOlder) &&
      putExtra(channel, { olderError: false })
  }

  function dispatch(input: Input): Promise<void> {
    const previous = state
    const result = step(state, input)
    state = result.state
    const extraChanged = new Set<string>()
    if (input.type === 'session_start' || input.type === 'session_replaced' || input.type === 'stop') {
      for (const channel of extras.keys()) extraChanged.add(channel)
      extras.clear()
    } else {
      if (input.type === 'history_failed') {
        const req = previous.requests[input.request]
        if (req?.type === 'history' && req.page === 'before' && !req.stale) {
          const next = state.channels[req.channel]
          if (state.running && next && next.state !== 'unavailable' && putExtra(req.channel, { olderError: true })) {
            extraChanged.add(req.channel)
          }
        }
      }
      for (const channel of result.changedChannels) {
        if (clearOlderError(channel, previous.channels[channel], state.channels[channel])) {
          extraChanged.add(channel)
        }
      }
    }
    if (state !== previous) listeners.forEach(l => l())
    for (const channel of result.changedChannels) {
      channelListeners.get(channel)?.forEach(l => l())
    }
    for (const channel of extraChanged) {
      if (!result.changedChannels.has(channel)) channelListeners.get(channel)?.forEach(l => l())
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
          let opened = false
          const subscriptions = new Map<string, number[]>()
          const confirmed = new Map<string, number>()
          const transport = connect({
            onReady: () => { opened = true; void dispatch({ type: 'connection_ready', connection: effect.id }) },
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
            onClose: code => {
              if (opened || !options.checkMembership) {
                void dispatch({ type: 'socket_closed', connection: effect.id, code }); return
              }
              // Browsers hide rejected upgrade responses. Only REST can establish Membership loss.
              void request(effect.id, options.checkMembership).then(result => {
                if (state.connection !== effect.id || !state.running) return
                if (api.isOrganizationUnavailable(result)) void dispatch({ type: 'organization_unavailable' })
                else if (!result.ok && result.kind === 'http' && result.status === 401) void dispatch({ type: 'socket_closed', connection: effect.id, code: 4001 })
                else void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 })
              }, () => { void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 }) })
            },
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
          { client_message_id: effect.client_message_id, body: effect.body,
            ...(effect.reply_to ? { reply_to: effect.reply_to } : {}) }))
        await dispatch(result.ok ? { type: 'ack', request: effect.id, message: result.data }
          : { type: 'send_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network' })
        break
      }
      case 'wait': {
        const ms = effect.purpose === 'reorder_grace' ? options.graceMs ?? 100
          : effect.purpose === 'reconnect_backoff' ? reconnectDelay(effect.attempt, random) : fillDelay(effect.attempt)
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
    let lastExtra: ChannelExtra | null = null
    const listeners = new Set<() => void>()
    channelListeners.set(channel, listeners)
    async function send(body: string, target: Pick<SendMessageRequest, 'reply_to'> = {}) {
      if (!body.trim() || messageBodyError(body) !== null || !state.running || state.organization === 'unavailable') {
        return false
      }
      const clientMessageId = newId()
      const before = state.channels[channel]?.pending
      const completion = dispatch({ type: 'user_send', channel, clientMessageId, body, ...target })
      const accepted = state.channels[channel]?.pending !== before
      await completion
      return accepted
    }
    return {
      get(): TimelineState {
        const c = state.channels[channel]
        const extra = getExtra(channel)
        if (last === c && lastExtra === extra) return snapshot
        last = c
        lastExtra = extra
        snapshot = {
          // Content visibility depends on the base; subscription confirmation drives the separate live indicator.
          status: c?.state === 'unavailable' ? 'unavailable' : c?.historyError ? 'error' : c && c.cursor !== null ? 'ready' : 'loading',
          messages: c?.messages ?? [],
          pending: (c?.pending ?? []).map(p => ({ clientMessageId: p.clientMessageId, body: p.body,
            status: p.state === 'sending' ? 'sending' : 'failed', retryable: p.state !== 'failed' })),
          hasOlder: c?.hasOlder ?? false, loadingOlder: c?.older !== undefined,
          olderError: extra.olderError,
          draft: extra.draft,
          composerError: extra.composerError,
        }
        return snapshot
      },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      loadLatest: () => dispatch({ type: 'refresh', channel }),
      loadOlder: () => dispatch({ type: 'load_older', channel }),
      setDraft(draft: string) {
        if (draft === getExtra(channel).draft) return
        setExtra(channel, { draft, composerError: null })
      },
      async submit() {
        const text = getExtra(channel).draft
        if (!text.trim()) return false
        const error = messageBodyError(text)
        if (error !== null) {
          setExtra(channel, { composerError: error })
          return false
        }
        if (!state.running || state.organization === 'unavailable' || state.channels[channel]?.state === 'unavailable') {
          return false
        }
        putExtra(channel, { draft: '', composerError: null })
        const accepted = await send(text)
        if (!accepted && getExtra(channel).draft === '') setExtra(channel, { draft: text })
        return accepted
      },
      send,
      retry: (clientMessageId: string) => dispatch({ type: 'user_retry', channel, clientMessageId }),
      restore(clientMessageId: string): boolean {
        if (!state.running) return false
        const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
        if (p?.state !== 'failed') return false
        const current = getExtra(channel).draft
        putExtra(channel, { draft: current ? `${current}\n${p.body}` : p.body, composerError: null })
        void dispatch({ type: 'user_discard', channel, clientMessageId })
        return true
      },
      discard: (clientMessageId: string) => { void dispatch({ type: 'user_discard', channel, clientMessageId }) },
    }
  }

  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => dispatch({ type: 'session_start', selfId: options.selfId }),
    replaceSession: (selfId: string) => dispatch({ type: 'session_replaced', selfId }),
    watch: (channel: string) => dispatch({ type: 'watch', channel }),
    channelUnavailable: (channel: string) => dispatch({ type: 'channel_unavailable', channel }),
    unwatch: (channel: string) => dispatch({ type: 'unwatch', channel }),
    close: () => dispatch({ type: 'stop' }),
    unavailable: () => dispatch({ type: 'organization_unavailable' }),
    settleHistory: (channel: string, messages: Message[]) => dispatch({ type: 'settle_history', channel, messages }),
    hasUnsavedChanges(): boolean {
      if (options.drafts?.hasDrafts()) return true
      for (const extra of extras.values()) {
        if (extra.draft.length > 0) return true
      }
      for (const c of Object.values(state.channels)) {
        if (c.pending.length > 0) return true
      }
      return false
    },
    getTimeline(channel: string) {
      let t = timelines.get(channel)
      if (!t) { t = timeline(channel); timelines.set(channel, t) }
      return t
    },
  }
}
