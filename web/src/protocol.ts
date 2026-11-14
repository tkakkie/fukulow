import type { components, ServerEvent } from './api-schema.d.ts'

type Message = components['schemas']['Message']
type MessagePage = components['schemas']['MessagePage']
type SendTarget = Pick<components['schemas']['SendMessageRequest'], 'reply_to' | 'topic_name'>
export type Failure = number | 'network' | 'timeout'
export type Purpose = 'reorder_grace' | 'fill_backoff' | 'reconnect_backoff' | 'send_retry'
export type Pending = SendTarget & { clientMessageId: string; body: string; state: 'sending' | 'throttled' | 'unknown' | 'failed'; request: number; retryWait?: number }
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
/** `stale`: invalidated by a history-generation change (unwatch, unavailable, clamp). Its late result never changes
 *  Channel state, but a 401 still means Sign in because the session is the same (C6/C8). */
type Request =
  | { type: 'history'; channel: string; page: 'latest' | 'before' | 'after'; seq?: number; stale?: true }
  | { type: 'send'; channel: string; clientMessageId: string; stale?: true }
type Timer = { purpose: Purpose; channel?: string; clientMessageId?: string }
export type State = {
  selfId: string
  organization: 'available' | 'unavailable'
  session: 'signed_in' | 'sign_in_required'
  running: boolean
  next: number
  connection: number | null
  connected: boolean
  reconnectAttempt: number
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
  | (SendTarget & { type: 'send'; id: number; channel: string; client_message_id: string; body: string })
  | { type: 'wait'; id: number; purpose: Exclude<Purpose, 'send_retry'>; channel?: string; attempt: number }
  | { type: 'wait'; id: number; purpose: 'send_retry'; channel: string; delayMs: number }
  | { type: 'cancel_timer'; id: number }
  | { type: 'sign_in' }
export type Input =
  | { type: 'session_start' | 'session_replaced'; selfId: string }
  | { type: 'stop' | 'organization_unavailable' }
  | { type: 'connection_ready'; connection: number }
  | { type: 'socket_closed'; connection: number; code: number }
  | { type: 'event'; connection: number; event: ServerEvent; subscription?: number }
  | { type: 'watch' | 'unwatch' | 'channel_unavailable' | 'refresh' | 'load_older'; channel: string }
  | (SendTarget & { type: 'user_send'; channel: string; clientMessageId: string; body: string })
  | { type: 'user_retry' | 'user_discard'; channel: string; clientMessageId: string }
  | { type: 'history_result'; request: number; page: MessagePage }
  | { type: 'history_failed'; request: number; status: Failure }
  | { type: 'settle_history'; channel: string; messages: Message[] }
  | { type: 'send_failed'; request: number; status: Failure; retryAfterMs?: number }
  | { type: 'ack'; request: number; message: Message }
  | { type: 'timer_elapsed'; id: number }

export function initialState(selfId = ''): State {
  return { selfId, organization: 'available', session: 'signed_in', running: false, next: 1, connection: null, connected: false,
    reconnectAttempt: 0, channels: {}, requests: {}, timers: {} }
}
const emptyChannel = (): ChannelState => ({ state: 'loading', watched: false, cursor: null, messages: [],
  advancing: [], pending: [], hasOlder: false, historyError: false, fillAttempt: 0 })
const sameFields = <T extends object>(a: T, b: T) => {
  const keys = Object.keys(a) as (keyof T)[]
  return keys.every(key => a[key] === b[key]) && (Object.keys(b) as (keyof T)[]).every(key => a[key] === b[key])
}

/** All policy lives here. Tokens are deterministic local generations, never wire ids. */
export function step(previous: State, input: Input): { state: State; effects: Effect[]; changedChannels: ReadonlySet<string> } {
  let state: State = { ...previous, requests: { ...previous.requests }, timers: { ...previous.timers } }
  const touched = new Set<string>()
  const effects: Effect[] = []
  const token = () => state.next++
  const channel = (id: string) => {
    if (!touched.has(id)) {
      if (state.channels === previous.channels) state.channels = { ...previous.channels }
      state.channels[id] = state.channels[id] ? { ...state.channels[id] } : emptyChannel()
      touched.add(id)
    }
    return state.channels[id]
  }
  const clearChannels = () => {
    for (const id of Object.keys(previous.channels)) touched.add(id)
    state.channels = touched.size ? {} : previous.channels
  }
  const finish = () => {
    for (const id of touched) {
      const before = previous.channels[id]
      const after = state.channels[id]
      if (before === after || (before && after && sameFields(before, after))) {
        if (after) state.channels[id] = before
        touched.delete(id)
      }
    }
    if (touched.size === 0) state.channels = previous.channels
    if (sameFields(previous.requests, state.requests)) state.requests = previous.requests
    if (sameFields(previous.timers, state.timers)) state.timers = previous.timers
    return { state: sameFields(previous, state) ? previous : state, effects, changedChannels: touched }
  }
  const cancel = (id: number | undefined) => {
    if (id === undefined || !state.timers[id]) return
    delete state.timers[id]
    effects.push({ type: 'cancel_timer', id })
  }
  const wait = (purpose: Exclude<Purpose, 'send_retry'>, id?: string, attempt = 0) => {
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
      if (!r.stale && r.channel === id && (sends || r.type === 'history')) state.requests[Number(key)] = { ...r, stale: true }
    }
  }
  const stop = (signIn: boolean) => {
    for (const id of Object.keys(state.timers)) cancel(Number(id))
    state.running = state.connected = false
    state.connection = null
    state.requests = {}
    clearChannels()
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
    ((c.messages.at(-1)?.seq ?? 0) > c.cursor + 1 || (c.subscription?.confirmed && c.subscription.watermark > c.cursor))
  const reconcile = (id: string, immediate = false) => {
    const c = channel(id)
    if (!c.watched || c.state === 'unavailable' || c.cursor === null) return
    // Let reconnect replay finish before timers or HTTP completions start another fill (C4).
    if (!state.connected || !c.subscription?.confirmed) return
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
  const settle = (id: string, records: Message[]) => {
    const c = channel(id)
    const settled = new Set(records.filter(m => m.channel_id === id && m.sender === state.selfId).map(m => m.client_message_id))
    if (c.pending.some(p => settled.has(p.clientMessageId))) {
      for (const p of c.pending) if (settled.has(p.clientMessageId)) cancel(p.retryWait)
      c.pending = c.pending.filter(p => !settled.has(p.clientMessageId))
    }
  }
  const merge = (id: string, records: Message[], source: 'window' | 'ack' | 'stream') => {
    const c = channel(id)
    const valid = records.filter(m => m.channel_id === id)
    // Sort/deduplicate only the incoming page. Find changes in the existing sorted window without
    // rebuilding an index or sorting it; allocate one replacement array only when a record changes.
    const incoming = valid.length < 2 ? valid : [...new Map(valid.map(m => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq)
    let merged: Message[] | undefined
    let offset = 0
    for (const m of incoming) {
      let lo = 0, hi = c.messages.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (c.messages[mid].seq < m.seq) lo = mid + 1
        else hi = mid
      }
      const existing = c.messages[lo]
      if (existing?.seq === m.seq && sameFields(existing, m)) continue
      if (!merged) merged = c.messages.slice(0, lo)
      else for (; offset < lo; offset++) merged.push(c.messages[offset])
      merged.push(m)
      offset = lo + (existing?.seq === m.seq ? 1 : 0)
    }
    if (merged) {
      for (; offset < c.messages.length; offset++) merged.push(c.messages[offset])
      c.messages = merged
    }
    settle(id, valid)
    if (source !== 'window') {
      const added = valid.map(m => m.seq).filter(n => (c.cursor === null || n > c.cursor) && !c.advancing.includes(n))
      if (added.length) c.advancing = [...new Set([...c.advancing, ...added])]
    }
    if (source === 'stream' && c.cursor !== null && valid.some(m => m.seq === c.cursor! + 1)) {
      const eligible = new Set(c.advancing)
      while (eligible.has(c.cursor + 1)) c.cursor++
      c.advancing = c.advancing.filter(n => n > c.cursor!)
    }
  }
  const attempt = (id: string, p: Pending) => {
    cancel(p.retryWait)
    const n = token()
    const c = channel(id)
    const sending: Pending = { ...p, state: 'sending', request: n, retryWait: undefined }
    c.pending = c.pending.includes(p) ? c.pending.map(entry => entry === p ? sending : entry) : [...c.pending, sending]
    state.requests[n] = { type: 'send', channel: id, clientMessageId: p.clientMessageId }
    effects.push({ type: 'send', id: n, channel: id, client_message_id: p.clientMessageId, body: p.body,
      ...(p.reply_to ? { reply_to: p.reply_to } : {}),
      ...(p.topic_name ? { topic_name: p.topic_name } : {}) })
  }
  const unavailable = (id: string) => {
    invalidate(id)
    const c = channel(id)
    if (c.subscription && state.connected) effects.push({ type: 'unsubscribe', channel: id })
    c.subscription = undefined
    c.state = 'unavailable'
    c.pending = c.pending.map(p => {
      cancel(p.retryWait)
      return { ...p, state: 'failed', retryWait: undefined }
    })
    for (const [key, request] of Object.entries(state.requests)) {
      if (request.channel === id && request.type === 'send') state.requests[Number(key)] = { ...request, stale: true }
    }
  }

  if (input.type === 'session_start' || input.type === 'session_replaced') {
    if (state.running) stop(false)
    else clearChannels()
    state = { ...initialState(input.selfId), next: state.next, running: true }
    connect()
    return { state, effects, changedChannels: touched }
  }
  if (input.type === 'stop') { stop(false); return { state, effects, changedChannels: touched } }
  if (input.type === 'organization_unavailable' || (input.type === 'socket_closed' &&
    input.connection === state.connection && input.code === 4003)) {
    if (!state.running) return finish()
    for (const id of Object.keys(state.timers)) cancel(Number(id))
    state.organization = 'unavailable'
    state.running = state.connected = false
    state.connection = null
    state.requests = {}
    for (const id of Object.keys(state.channels)) {
      const c = channel(id)
      c.state = 'unavailable'; c.subscription = undefined
      c.pending = c.pending.map(p => ({ ...p, state: 'failed', retryWait: undefined }))
    }
    effects.push({ type: 'close' })
    return finish()
  }
  if (input.type === 'user_discard' && (state.running || state.organization === 'unavailable')) {
    const c = state.channels[input.channel]
    if (c?.pending.some(p => p.clientMessageId === input.clientMessageId && p.state !== 'sending')) {
      for (const p of c.pending) if (p.clientMessageId === input.clientMessageId) cancel(p.retryWait)
      channel(input.channel).pending = c.pending.filter(p => p.clientMessageId !== input.clientMessageId || p.state === 'sending')
    }
    return finish()
  }
  if (!state.running) return finish()

  switch (input.type) {
    case 'settle_history':
      // Projection pages settle C5 without entering the sync window or contiguity evidence (P1).
      if (state.channels[input.channel]?.watched && state.channels[input.channel].state !== 'unavailable')
        settle(input.channel, input.messages)
      break
    case 'connection_ready':
      if (input.connection !== state.connection || state.connected) break
      state.connected = true
      for (const id of Object.keys(state.channels)) subscribe(id)
      break
    case 'socket_closed':
      if (input.connection !== state.connection) break
      state.connection = null; state.connected = false
      for (const id of Object.keys(state.channels)) {
        if (state.channels[id].subscription) channel(id).subscription = undefined
      }
      if (input.code === 4001) { stop(true); break }
      state.reconnectWait = wait('reconnect_backoff', undefined, state.reconnectAttempt++)
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
    case 'channel_unavailable':
      unavailable(input.channel)
      break
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
      if (!input.body.trim() || (input.reply_to && input.topic_name)) break
      const c = channel(input.channel)
      if (c.state === 'unavailable' || c.pending.some(p => p.clientMessageId === input.clientMessageId)) break
      const p: Pending = { clientMessageId: input.clientMessageId, body: input.body, state: 'sending', request: 0,
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
        ...(input.topic_name ? { topic_name: input.topic_name } : {}) }
      attempt(input.channel, p)
      break
    }
    case 'user_retry': {
      const c = channel(input.channel)
      const p = c.pending.find(p => p.clientMessageId === input.clientMessageId)
      if (p?.state === 'unknown' && c.state !== 'unavailable') attempt(input.channel, p)
      break
    }
    case 'event': {
      if (input.connection !== state.connection || !state.connected) break
      const e = input.event
      if (e.type !== 'message' && e.type !== 'subscribed' && e.type !== 'channel_access_lost' && e.type !== 'error') break
      const id = e.type === 'message' ? e.message.channel_id : e.channel_id
      if (!id) break
      let c = state.channels[id]
      if (!c?.watched || c.state === 'unavailable' || !c.subscription) break
      if (e.type !== 'message' && input.subscription !== undefined && input.subscription !== c.subscription.id) break
      c = channel(id)
      if (e.type === 'message') { merge(id, [e.message], 'stream'); reconcile(id) }
      else if (e.type === 'channel_access_lost') unavailable(id)
      else if (e.type === 'error') {
        if (e.code === 'channel_not_found' || e.code === 'subscription_limit') unavailable(id)
      } else if (e.type === 'subscribed') {
        if (e.caught_up_seq < c.subscription!.after) {
          // The server still owns this slot while the replacement latest request is in flight.
          effects.push({ type: 'unsubscribe', channel: id })
          invalidate(id, true)
          // Pre-clamp HTTP results may refer to the discarded history generation. Only those
          // sending/throttled attempts become unknown; definite refusals and unknown outcomes keep their state.
          // Sends started during the new bootstrap remain valid until completion/timeout or another clamp.
          const pending = c.pending.map(p => {
            cancel(p.retryWait)
            return p.state === 'sending' || p.state === 'throttled' ? { ...p, state: 'unknown' as const, retryWait: undefined } : p
          })
          state.channels[id] = { ...emptyChannel(), watched: true, pending }
          history(id, 'latest')
        } else {
          if (!c.subscription!.confirmed || c.subscription!.watermark !== e.caught_up_seq)
            c.subscription = { ...c.subscription!, confirmed: true, watermark: e.caught_up_seq }
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
      if (r.stale) { if (input.type === 'history_failed' && input.status === 401) stop(true); break }
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
      if (r.stale) { if (input.type === 'send_failed' && input.status === 401) stop(true); break }
      const c = channel(r.channel)
      if (input.type === 'ack') { merge(r.channel, [input.message], 'ack'); reconcile(r.channel) }
      else {
        if (input.status === 401) { stop(true); break }
        const p = c.pending.find(p => p.clientMessageId === r.clientMessageId && p.request === input.request)
        if (p) {
          if (input.status === 429) {
            cancel(p.retryWait)
            const n = token()
            const delay = input.retryAfterMs ?? 1000
            const delayMs = Number.isSafeInteger(delay) && delay >= 1000 ? delay : 1000
            state.timers[n] = { purpose: 'send_retry', channel: r.channel, clientMessageId: p.clientMessageId }
            c.pending = c.pending.map(entry => entry === p ? { ...p, state: 'throttled', retryWait: n } : entry)
            effects.push({ type: 'wait', id: n, purpose: 'send_retry', channel: r.channel, delayMs })
            break
          }
          const outcome = typeof input.status === 'number' && [400, 403, 404, 409, 413, 415].includes(input.status) ? 'failed' : 'unknown'
          if (p.state !== outcome) c.pending = c.pending.map(entry => entry === p ? { ...p, state: outcome } : entry)
        }
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
      } else if (t.purpose === 'send_retry' && t.channel) {
        const c = channel(t.channel)
        const p = c.pending.find(p => p.clientMessageId === t.clientMessageId && p.retryWait === input.id)
        if (p?.state === 'throttled' && c.state !== 'unavailable') attempt(t.channel, p)
      } else if (t.channel) {
        const c = channel(t.channel)
        if (c.wait !== input.id) break
        c.wait = undefined; reconcile(t.channel, true)
      }
      break
    }
  }
  return finish()
}
