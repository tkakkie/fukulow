import type { components, ServerEvent } from './api-schema.d.ts'

type Message = components['schemas']['Message']
type MessagePage = components['schemas']['MessagePage']
type SendTarget = Pick<components['schemas']['SendMessageRequest'], 'reply_to' | 'topic_name'>
export const MAIN_MESSAGE_LIMIT = 400
export const TOPIC_MESSAGE_LIMIT = 300
export const REPLY_MESSAGE_LIMIT = 200
export const INACTIVE_CHANNEL_MESSAGE_LIMIT = 50
export const INACTIVE_CHANNEL_LIMIT = 5
export const TOTAL_MESSAGE_LIMIT = 1500
export const SYNC_MESSAGE_LIMIT = TOTAL_MESSAGE_LIMIT - MAIN_MESSAGE_LIMIT - TOPIC_MESSAGE_LIMIT - REPLY_MESSAGE_LIMIT
export type Failure = number | 'network' | 'timeout'
export type Purpose = 'reorder_grace' | 'fill_backoff' | 'reconnect_backoff' | 'send_retry'
export type Pending = SendTarget & { replyRootId?: string; clientMessageId: string; body: string; state: 'sending' | 'throttled' | 'unknown' | 'failed'; request: number; retryWait?: number; failureCode?: string }
export type ChannelState = {
  state: 'loading' | 'ready' | 'unavailable'
  watched: boolean
  cursor: number | null
  messages: Message[]
  /** Buffered stream/ack/after seqs; only adjacent stream/after input may advance the cursor. */
  advancing: { start: number; end: number }[]
  heldThrough?: number
  forgottenThrough?: number
  lastUsed?: number
  retainedCount?: number
  streamBase?: number
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
export type Request =
  | { type: 'history'; channel: string; page: 'latest' | 'before' | 'after'; seq?: number; stale?: true }
  | { type: 'send'; channel: string; clientMessageId: string; stale?: true }
export type Timer = { purpose: Purpose; channel?: string; clientMessageId?: string }
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
export type Input = (
  | { type: 'session_start' | 'session_replaced'; selfId: string }
  | { type: 'stop' | 'organization_unavailable' }
  | { type: 'connection_ready'; connection: number }
  | { type: 'socket_closed'; connection: number; code: number }
  | { type: 'event'; connection: number; event: ServerEvent; subscription?: number }
  | { type: 'watch' | 'unwatch' | 'channel_unavailable' | 'refresh' | 'load_older'; channel: string }
  | (SendTarget & { replyRootId?: string; type: 'user_send'; channel: string; clientMessageId: string; body: string })
  | { type: 'user_retry' | 'user_discard'; channel: string; clientMessageId: string }
  | { type: 'history_result'; request: number; page: MessagePage }
  | { type: 'history_failed'; request: number; status: Failure }
  | { type: 'settle_history'; channel: string; messages: Message[] }
  | { type: 'send_failed'; request: number; status: Failure; retryAfterMs?: number; error?: string }
  | { type: 'ack'; request: number; message: Message }
  | { type: 'timer_elapsed'; id: number }
) & { refreshMentionNames?: true }


export type SyncView = Omit<State, "requests" | "timers">
export type CoreResult = { effects: Effect[]; changedChannels: ReadonlySet<string>; records: ReadonlyMap<string, Message[]>; stateChanged: boolean }
export interface SyncCore {
  get(): SyncView
  request(id: number): Request | undefined
  timer(id: number): Timer | undefined
  hasPending(): boolean
  step(input: Input): CoreResult
}
