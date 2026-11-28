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
export type AccessEndpoint = 'organization' | 'capabilities' | 'history' | 'send'
export type AccessLifetime = 'current' | 'stale_request' | 'retired_organization' | 'replaced_session'
export type AccessOutcome = 'ignored' | 'account_ended' | 'organization_unavailable' | 'channel_unavailable' | 'local_refusal' | 'local_outcome'
export type Purpose = 'reorder_grace' | 'fill_backoff' | 'reconnect_backoff' | 'send_retry'
export type Pending = SendTarget & { replyRootId?: string; clientMessageId: string; body: string; state: 'sending' | 'throttled' | 'unknown' | 'failed'; request: number; retryWait?: number; failureCode?: string }
export type ChannelState = {
  state: 'loading' | 'ready' | 'unavailable'
  watched: boolean
  cursor: number | null
  snapshotSeq?: number
  mutationSeq: number
  moveSeq?: number
  moveEpoch?: number
  messages: Message[]
  versions: Record<string, [number, boolean, number]>
  retiredVersions: { start: number; end: number }[]
  retiredThrough?: number
  versionEpoch: number
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
  | { type: 'history'; mutationSeq: number; channel: string; page: 'latest' | 'before' | 'after'; seq?: number; stale?: true }
  | { type: 'send'; channel: string; clientMessageId: string; stale?: true }
export type Timer = { purpose: Purpose; channel?: string; clientMessageId?: string }
export type State = {
  selfId: string
  historyGeneration?: string
  historyEpoch: number
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
  | { type: 'check_membership'; connection: number }
  | { type: 'report_organization_unavailable'; socket?: { connection: number; code: number } }
  | { type: 'close' }
  | { type: 'close_connection'; connection: number }
  | { type: 'subscribe'; history_generation?: string; id: number; channel: string; after_seq: number }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'fetch_history'; history_generation?: string; as_of_seq?: number; id: number; channel: string; page: 'latest' | 'after' | 'before'; seq?: number }
  | (SendTarget & { type: 'send'; history_generation?: string; id: number; channel: string; client_message_id: string; body: string })
  | { type: 'wait'; id: number; purpose: Exclude<Purpose, 'send_retry'>; channel?: string; attempt: number }
  | { type: 'wait'; id: number; purpose: 'send_retry'; channel: string; delayMs: number }
  | { type: 'cancel_timer'; id: number }
  | { type: 'sign_in' }
export type Input = (
  | { type: 'session_start' | 'session_replaced'; selfId: string }
  | { type: 'history_generation'; generation?: string }
  | { type: 'stop' | 'organization_unavailable' }
  | { type: 'connection_ready'; connection: number }
  | { type: 'socket_closed'; connection: number; code: number }
  | { type: 'socket_disconnected'; connection: number; code: number; opened: boolean; opaque: boolean }
  | { type: 'membership_checked'; connection: number; status?: Failure; error?: string }
  | { type: 'event'; connection: number; event: ServerEvent; subscription?: number }
  | { type: 'socket_frame'; connection: number; event: ServerEvent }
  | { type: 'watch' | 'unwatch' | 'channel_unavailable' | 'refresh' | 'load_older'; channel: string }
  | (SendTarget & { replyRootId?: string; type: 'user_send'; channel: string; clientMessageId: string; body: string })
  | { type: 'user_retry' | 'user_discard'; channel: string; clientMessageId: string }
  | { type: 'events_result'; request: number; page: components['schemas']['ChannelEventPage'] }
  | { type: 'history_result'; request: number; page: MessagePage }
  | { type: 'history_failed'; request: number; status: Failure; error?: string }
  | { type: 'settle_history'; channel: string; messages: Message[] }
  | { type: 'send_failed'; request: number; status: Failure; retryAfterMs?: number; error?: string }
  | { type: 'ack'; request: number; message: Message }
  | { type: 'timer_elapsed'; id: number }
) & { refreshMentionNames?: true }


export type SyncView = Omit<State, "requests" | "timers">
export type MoveVersion = Pick<Extract<ServerEvent, { kind: 'move' }>, 'channel_id' | 'root_id' | 'version' | 'destination_topic_id'>
type SocketDelivery = { type: 'sync'; subscription?: number } | { type: 'activity' }
export type CoreResult = {
  effects: Effect[]; changedChannels: ReadonlySet<string>; records: ReadonlyMap<string, Message[]>
  moves?: readonly MoveVersion[]; stateChanged: boolean; socketDelivery?: SocketDelivery
}
export interface SyncCore {
  get(): SyncView
  request(id: number): Request | undefined
  timer(id: number): Timer | undefined
  hasPending(): boolean
  subscribeIssued(connection: number, channel: string, id: number): void
  step(input: Input): CoreResult
}
