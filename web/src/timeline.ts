import * as defaultApi from './api'
import type { ListMessagesQuery, Message, MessagePage, Result, SendMessageRequest } from './api'

export type TimelineApi = {
  listMessages: (channelId: string, query?: ListMessagesQuery) => Promise<Result<MessagePage>>
  sendMessage: (channelId: string, body: SendMessageRequest) => Promise<Result<Message>>
}

/** A message the user sent that the server has not acknowledged yet. */
export type Pending = {
  clientMessageId: string
  body: string
  status: 'sending' | 'failed'
  /** Failed with a definite server refusal: retrying the same id cannot succeed. */
  retryable: boolean
}

export type TimelineState = {
  status: 'loading' | 'ready' | 'error'
  /** Confirmed messages, ascending seq, unique by seq. */
  messages: Message[]
  pending: Pending[]
  hasOlder: boolean
  loadingOlder: boolean
}

/** Japanese message for a failed send. */
export const sendErrorMessage = (retryable: boolean) =>
  retryable ? '送信できませんでした。再送できます。' : '送信できませんでした。内容を確認してください。'

/** Merge into an ascending list, deduped by seq (unique per channel; client_message_id is only unique per sender). */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const bySeq = new Map<number, Message>()
  for (const m of [...current, ...incoming]) bySeq.set(m.seq, m)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Timeline of one channel's main timeline (messages without a topic): latest page, older pages,
 * and optimistic send. A retry reuses the same client message id, so a lost acknowledgement
 * converges to one entry. Create one instance per selected channel.
 */
/** One timeline per channel, kept alive across channel switches so pending messages survive. */
export function createTimelines(api: TimelineApi = defaultApi, newId?: () => string, selfId?: string) {
  const byChannel = new Map<string, ReturnType<typeof createTimeline>>()
  return {
    get(channelId: string) {
      let t = byChannel.get(channelId)
      if (!t) byChannel.set(channelId, (t = createTimeline(channelId, api, newId, selfId)))
      return t
    },
  }
}

export function createTimeline(
  channelId: string,
  api: TimelineApi = defaultApi,
  newId: () => string = () => crypto.randomUUID(),
  /** The signed-in Member: only their own echo settles a pending message. */
  selfId?: string,
) {
  let state: TimelineState = { status: 'loading', messages: [], pending: [], hasOlder: false, loadingOlder: false }
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<TimelineState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }
  const settle = (clientMessageId: string, m: Message) =>
    set({
      messages: mergeMessages(state.messages, [m]),
      pending: state.pending.filter((p) => p.clientMessageId !== clientMessageId),
    })
  const patchPending = (id: string, patch: Partial<Pending>) =>
    set({ pending: state.pending.map((p) => (p.clientMessageId === id ? { ...p, ...patch } : p)) })

  async function attempt(p: Pending) {
    patchPending(p.clientMessageId, { status: 'sending' })
    const r = await api.sendMessage(channelId, { body: p.body, client_message_id: p.clientMessageId })
    if (r.ok) return settle(p.clientMessageId, r.data)
    // 4xx is a definite refusal; network/5xx may have committed, so the same id stays retryable.
    patchPending(p.clientMessageId, { status: 'failed', retryable: r.kind === 'network' })
  }

  return {
    get: () => state,
    /** Highest seq held (0 = none): the exclusive cursor for WebSocket resume. */
    lastSeq: () => state.messages.reduce((max, m) => Math.max(max, m.seq), 0),
    /** A live or replayed message. Dedupes by seq; an echo of our own pending send settles it. */
    receive(m: Message) {
      const mine = selfId === undefined || m.sender === selfId
      set({
        messages: mergeMessages(state.messages, [m]),
        pending: mine ? state.pending.filter((p) => p.clientMessageId !== m.client_message_id) : state.pending,
      })
    },
    dispose() {
      disposed = true
      listeners.clear()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async loadLatest() {
      set({ status: 'loading' })
      const r = await api.listMessages(channelId)
      if (!r.ok) return set({ status: 'error' })
      set({ status: 'ready', messages: mergeMessages(state.messages, r.data.messages), hasOlder: r.data.has_more })
    },
    async loadOlder() {
      const first = state.messages[0]
      if (!first || !state.hasOlder || state.loadingOlder) return
      set({ loadingOlder: true })
      const r = await api.listMessages(channelId, { before_seq: first.seq })
      if (!r.ok) return set({ loadingOlder: false })
      set({ loadingOlder: false, messages: mergeMessages(state.messages, r.data.messages), hasOlder: r.data.has_more })
    },
    /** Shows the message at once; returns false for an empty body. */
    async send(body: string): Promise<boolean> {
      const text = body.trim()
      if (!text) return false
      const p: Pending = { clientMessageId: newId(), body: text, status: 'sending', retryable: true }
      set({ pending: [...state.pending, p] })
      await attempt(p)
      return true
    },
    async retry(clientMessageId: string) {
      const p = state.pending.find((x) => x.clientMessageId === clientMessageId)
      if (p && p.status === 'failed' && p.retryable) await attempt(p)
    },
    /** Drops a failed message the user gave up on. */
    discard(clientMessageId: string) {
      set({ pending: state.pending.filter((p) => p.clientMessageId !== clientMessageId || p.status !== 'failed') })
    },
  }
}
