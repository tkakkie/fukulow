import type { components, ServerEvent } from './api-schema'

type Message = components['schemas']['Message']
type MessagePage = components['schemas']['MessagePage']
export type Failure = number | 'network' | 'timeout'
export type Purpose = 'reorder_grace' | 'fill_backoff' | 'reconnect_backoff'
export type Pending = { clientMessageId: string; body: string; state: 'sending' | 'unknown' | 'failed'; request: number }
export type ChannelState = {
  state: 'loading' | 'ready' | 'unavailable'
  watched: boolean
  cursor: number | null
  messages: Message[]
  /** Buffered stream/ack/after seqs; only adjacent stream/after input may advance the cursor. */
  advancing: number[]
  pending: Pending[]
  hasOlder: boolean
  historyError: boolean
  latest?: number
  older?: number
  fill?: number
  wait?: number
  fillAttempt: number
  subscription?: { id: number; after: number; confirmed: boolean; watermark: number }
}
type Request =
  | { type: 'history'; channel: string; page: 'latest' | 'before' | 'after'; seq?: number }
  | { type: 'send'; channel: string; clientMessageId: string }
type Timer = { purpose: Purpose; channel?: string }
export type State = {
  selfId: string
  session: 'signed_in' | 'sign_in_required'
  running: boolean
  next: number
  connection: number | null
  connected: boolean
  reconnectAttempt: number
  overflows: number
  reconnectWait?: number
  channels: Record<string, ChannelState>
  requests: Record<number, Request>
  timers: Record<number, Timer>
}
export type Effect =
  | { type: 'connect'; id: number }
  | { type: 'close' }
  | { type: 'subscribe'; id: number; channel: string; after_seq: number }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'fetch_history'; id: number; channel: string; page: 'latest' | 'after' | 'before'; seq?: number }
  | { type: 'send'; id: number; channel: string; client_message_id: string; body: string }
  | { type: 'wait'; id: number; purpose: Purpose; channel?: string; attempt: number }
  | { type: 'cancel_timer'; id: number }
  | { type: 'sign_in' }
export type Input =
  | { type: 'session_start' | 'session_replaced'; selfId: string }
  | { type: 'stop' }
  | { type: 'connection_ready'; connection: number }
  | { type: 'socket_closed'; connection: number; code: number }
  | { type: 'event'; connection: number; event: ServerEvent; subscription?: number }
  | { type: 'watch' | 'unwatch' | 'refresh' | 'load_older'; channel: string }
  | { type: 'user_send'; channel: string; clientMessageId: string; body: string }
  | { type: 'user_retry' | 'user_discard'; channel: string; clientMessageId: string }
  | { type: 'history_result'; request: number; page: MessagePage }
  | { type: 'history_failed'; request: number; status: Failure }
  | { type: 'send_failed'; request: number; status: Failure }
  | { type: 'ack'; request: number; message: Message }
  | { type: 'timer_elapsed'; id: number }

export function initialState(selfId = ''): State {
  return { selfId, session: 'signed_in', running: false, next: 1, connection: null, connected: false,
    reconnectAttempt: 0, overflows: 0, channels: {}, requests: {}, timers: {} }
}
const emptyChannel = (): ChannelState => ({ state: 'loading', watched: false, cursor: null, messages: [],
  advancing: [], pending: [], hasOlder: false, historyError: false, fillAttempt: 0 })

/** All policy lives here. Tokens are deterministic local generations, never wire ids. */
export function step(previous: State, input: Input): { state: State; effects: Effect[] } {
  let state: State = { ...previous, channels: Object.fromEntries(Object.entries(previous.channels).map(([id, c]) =>
    [id, { ...c, messages: [...c.messages], advancing: [...c.advancing], pending: c.pending.map(p => ({ ...p })),
      subscription: c.subscription && { ...c.subscription } }])), requests: { ...previous.requests }, timers: { ...previous.timers } }
  const effects: Effect[] = []
  const token = () => state.next++
  const channel = (id: string) => state.channels[id] ??= emptyChannel()
  const cancel = (id: number | undefined) => {
    if (id === undefined || !state.timers[id]) return
    delete state.timers[id]
    effects.push({ type: 'cancel_timer', id })
  }
  const wait = (purpose: Purpose, id?: string, attempt = 0) => {
    const n = token()
    state.timers[n] = { purpose, channel: id }
    effects.push({ type: 'wait', id: n, purpose, channel: id, attempt })
    return n
  }
  const connect = () => {
    state.connection = token()
    effects.push({ type: 'connect', id: state.connection })
  }
  const invalidate = (id: string, sends = false) => {
    const c = channel(id)
    cancel(c.wait)
    c.wait = c.fill = c.latest = c.older = undefined
    for (const [key, r] of Object.entries(state.requests)) {
      if (r.channel === id && (sends || r.type === 'history')) delete state.requests[Number(key)]
    }
  }
  const stop = (signIn: boolean) => {
    for (const id of Object.keys(state.timers)) cancel(Number(id))
    state.running = state.connected = false
    state.connection = null
    state.requests = {}
    state.channels = {}
    effects.push({ type: 'close' })
    if (signIn) { state.session = 'sign_in_required'; effects.push({ type: 'sign_in' }) }
  }
  const subscribe = (id: string) => {
    const c = channel(id)
    if (!state.connected || !c.watched || c.state === 'unavailable' || c.cursor === null || c.subscription) return
    const n = token()
    c.state = 'loading'
    c.subscription = { id: n, after: c.cursor, confirmed: false, watermark: c.cursor }
    effects.push({ type: 'subscribe', id: n, channel: id, after_seq: c.cursor })
  }
  const history = (id: string, page: 'latest' | 'before' | 'after', seq?: number) => {
    const c = channel(id)
    const key = page === 'latest' ? 'latest' : page === 'before' ? 'older' : 'fill'
    if (c[key] !== undefined) return
    const n = token()
    c[key] = n
    c.historyError = false
    state.requests[n] = { type: 'history', channel: id, page, seq }
    effects.push({ type: 'fetch_history', id: n, channel: id, page, seq })
  }
  const gap = (c: ChannelState) => c.cursor !== null &&
    (c.messages.some(m => m.seq > c.cursor! + 1) || (c.subscription?.confirmed && c.subscription.watermark > c.cursor))
  const reconcile = (id: string, immediate = false) => {
    const c = channel(id)
    if (!c.watched || c.state === 'unavailable' || c.cursor === null) return
    if (!gap(c)) { cancel(c.wait); c.wait = undefined; return }
    if (c.fill !== undefined) return
    // Backoff cannot be bypassed by further traffic or a handoff watermark.
    if (c.wait !== undefined && state.timers[c.wait]?.purpose === 'fill_backoff') return
    const covered = c.subscription?.confirmed && c.subscription.watermark > c.cursor
    if (immediate || covered) {
      cancel(c.wait); c.wait = undefined
      history(id, 'after', c.cursor)
    } else if (c.wait === undefined) c.wait = wait('reorder_grace', id)
  }
  const merge = (id: string, records: Message[], source: 'window' | 'ack' | 'stream') => {
    const c = channel(id)
    const valid = records.filter(m => m.channel_id === id)
    const bySeq = new Map(c.messages.map(m => [m.seq, m]))
    for (const m of valid) {
      bySeq.set(m.seq, m)
      if (m.sender === state.selfId) c.pending = c.pending.filter(p => p.clientMessageId !== m.client_message_id)
    }
    c.messages = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    if (source !== 'window') c.advancing = [...new Set([...c.advancing, ...valid.map(m => m.seq)])]
    if (source === 'stream' && c.cursor !== null && valid.some(m => m.seq === c.cursor! + 1)) {
      const eligible = new Set(c.advancing)
      while (eligible.has(c.cursor + 1)) c.cursor++
      c.advancing = c.advancing.filter(n => n > c.cursor!)
    }
  }
  const attempt = (id: string, p: Pending) => {
    const n = token()
    p.state = 'sending'; p.request = n
    state.requests[n] = { type: 'send', channel: id, clientMessageId: p.clientMessageId }
    effects.push({ type: 'send', id: n, channel: id, client_message_id: p.clientMessageId, body: p.body })
  }
  const unavailable = (id: string) => {
    invalidate(id)
    const c = channel(id)
    if (c.subscription && state.connected) effects.push({ type: 'unsubscribe', channel: id })
    c.subscription = undefined
    c.state = 'unavailable'
  }

  if (input.type === 'session_start' || input.type === 'session_replaced') {
    if (state.running) stop(false)
    state = { ...initialState(input.selfId), next: state.next, running: true }
    connect()
    return { state, effects }
  }
  if (input.type === 'stop') { stop(false); return { state, effects } }
  if (!state.running) return { state, effects }

  switch (input.type) {
    case 'connection_ready':
      if (input.connection !== state.connection || state.connected) break
      state.connected = true
      for (const id of Object.keys(state.channels)) subscribe(id)
      break
    case 'socket_closed':
      if (input.connection !== state.connection) break
      state.connection = null; state.connected = false
      for (const c of Object.values(state.channels)) c.subscription = undefined
      if (input.code === 4001) { stop(true); break }
      // One immediate overflow retry per session; overflows is intentionally never reset within a session.
      if (input.code === 4008 && state.overflows++ === 0) connect()
      else state.reconnectWait = wait('reconnect_backoff', undefined, state.reconnectAttempt++)
      break
    case 'watch': {
      const c = channel(input.channel)
      if (c.watched && c.state !== 'unavailable') break
      c.watched = true; c.historyError = false
      if (c.state === 'unavailable') { c.state = 'loading'; c.subscription = undefined }
      if (c.cursor === null) history(input.channel, 'latest')
      else { subscribe(input.channel); reconcile(input.channel) }
      break
    }
    case 'unwatch': {
      const c = channel(input.channel)
      if (c.subscription && state.connected) effects.push({ type: 'unsubscribe', channel: input.channel })
      c.watched = false; c.subscription = undefined
      invalidate(input.channel)
      break
    }
    case 'refresh': {
      const c = channel(input.channel)
      if (c.state === 'unavailable') c.state = 'loading'
      history(input.channel, 'latest')
      break
    }
    case 'load_older': {
      const c = channel(input.channel)
      if (c.state !== 'unavailable' && c.hasOlder && c.messages[0]) history(input.channel, 'before', c.messages[0].seq)
      break
    }
    case 'user_send': {
      const c = channel(input.channel)
      if (c.state === 'unavailable' || !input.body.trim() || c.pending.some(p => p.clientMessageId === input.clientMessageId)) break
      const p: Pending = { clientMessageId: input.clientMessageId, body: input.body, state: 'sending', request: 0 }
      c.pending.push(p); attempt(input.channel, p)
      break
    }
    case 'user_retry': {
      const c = channel(input.channel)
      const p = c.pending.find(p => p.clientMessageId === input.clientMessageId)
      if (p?.state === 'unknown' && c.state !== 'unavailable') attempt(input.channel, p)
      break
    }
    case 'user_discard': {
      const c = channel(input.channel)
      c.pending = c.pending.filter(p => p.clientMessageId !== input.clientMessageId || p.state === 'sending')
      break
    }
    case 'event': {
      if (input.connection !== state.connection || !state.connected) break
      const e = input.event
      const id = e.type === 'message' ? e.message.channel_id : e.channel_id
      if (!id) break
      const c = state.channels[id]
      if (!c?.watched || c.state === 'unavailable' || !c.subscription) break
      if (e.type !== 'message' && input.subscription !== undefined && input.subscription !== c.subscription.id) break
      if (e.type === 'message') { merge(id, [e.message], 'stream'); reconcile(id) }
      else if (e.type === 'error') {
        if (e.code === 'channel_not_found' || e.code === 'subscription_limit') unavailable(id)
      } else if (e.type === 'subscribed') {
        if (e.caught_up_seq < c.subscription.after) {
          // The server still owns this slot while the replacement latest request is in flight.
          effects.push({ type: 'unsubscribe', channel: id })
          invalidate(id, true)
          // Pre-clamp HTTP results may refer to the discarded history generation. Only those
          // sending attempts become unknown; definite refusals and same-key retries keep their state.
          // Sends started during the new bootstrap remain valid until completion/timeout or another clamp.
          const pending = c.pending.map(p => p.state === 'sending' ? { ...p, state: 'unknown' as const } : p)
          state.channels[id] = { ...emptyChannel(), watched: true, pending }
          history(id, 'latest')
        } else {
          c.subscription.confirmed = true; c.subscription.watermark = e.caught_up_seq
          // Only a confirmed subscription resets backoff; with no watched Channel it may stay at the cap.
          c.state = 'ready'; c.historyError = false; state.reconnectAttempt = 0
          reconcile(id)
        }
      }
      break
    }
    case 'history_result':
    case 'history_failed': {
      const r = state.requests[input.request]
      if (!r || r.type !== 'history') break
      delete state.requests[input.request]
      const c = channel(r.channel)
      c[r.page === 'latest' ? 'latest' : r.page === 'before' ? 'older' : 'fill'] = undefined
      if (input.type === 'history_failed') {
        if (input.status === 401) stop(true)
        else if (input.status === 403 || input.status === 404) unavailable(r.channel)
        else if (r.page === 'after') {
          if (gap(c)) c.wait = wait('fill_backoff', r.channel, c.fillAttempt++)
        } else if (r.page === 'latest') c.historyError = true
        break
      }
      const before = c.cursor
      const bootstrap = c.cursor === null && r.page === 'latest'
      if (bootstrap) c.cursor = input.page.messages.at(-1)?.seq ?? 0
      merge(r.channel, input.page.messages, r.page === 'after' ? 'stream' : 'window')
      // Latest/before has_more is older; after has_more must never overwrite it.
      if (r.page !== 'after') {
        if (r.page === 'before' || bootstrap || !c.messages[0] ||
          (input.page.messages[0]?.seq ?? Infinity) <= c.messages[0].seq) c.hasOlder = input.page.has_more
      }
      if (bootstrap) {
        subscribe(r.channel) // The sent base comes from this page, never buffered ack/echo records.
      }
      if (r.page === 'after') {
        if (c.cursor === before && gap(c)) c.wait = wait('fill_backoff', r.channel, c.fillAttempt++)
        else { c.fillAttempt = 0; reconcile(r.channel, true) }
      } else { subscribe(r.channel); reconcile(r.channel) }
      break
    }
    case 'ack':
    case 'send_failed': {
      const r = state.requests[input.request]
      if (!r || r.type !== 'send') break
      delete state.requests[input.request]
      const c = channel(r.channel)
      if (input.type === 'ack') { merge(r.channel, [input.message], 'ack'); reconcile(r.channel) }
      else {
        if (input.status === 401) { stop(true); break }
        const p = c.pending.find(p => p.clientMessageId === r.clientMessageId && p.request === input.request)
        if (p) p.state = typeof input.status === 'number' && [400, 403, 404, 409, 413, 415].includes(input.status) ? 'failed' : 'unknown'
      }
      break
    }
    case 'timer_elapsed': {
      const t = state.timers[input.id]
      if (!t) break
      delete state.timers[input.id]
      if (t.purpose === 'reconnect_backoff') {
        if (state.reconnectWait !== input.id) break
        state.reconnectWait = undefined; connect()
      } else if (t.channel) {
        const c = channel(t.channel)
        if (c.wait !== input.id) break
        c.wait = undefined; reconcile(t.channel, true)
      }
      break
    }
  }
  return { state, effects }
}
