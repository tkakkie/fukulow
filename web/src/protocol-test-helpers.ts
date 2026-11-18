/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, ServerEvent } from './api'
import { defaultDir, type ClientScenario, type Effect as FixtureEffect, type Observed, type ResolvedInput } from '../scripts/realtime-fixtures'
import { initialState, step, type Input, type State, type SyncView } from './protocol-driver'

export const scenarios: ClientScenario[] = readdirSync(join(defaultDir, 'client')).filter(n => n.endsWith('.json')).sort()
  .flatMap(n => (JSON.parse(readFileSync(join(defaultDir, 'client', n), 'utf8')) as { scenarios: ClientScenario[] }).scenarios)
export const message = (m: ResolvedInput['message'], channel: string): Message => ({ mentions: [], ...m!, channel_id: channel, topic_id: m?.topic ?? null, reply_to: m?.reply_to ?? null, reply_root_id: m?.reply_root_id ?? null })
export const record = (seq: number, channel = 'A'): Message => ({ history_generation: '00000000-0000-4000-8000-000000000515', mentions: [], channel_id: channel, created_seq: seq, version: seq, deleted: false, body: `m${seq}`, id: `id${seq}`,
  sender: 'other', client_message_id: `auto-${seq}`, created_at: '2026-01-01T00:00:00Z', topic_id: null, reply_to: null, reply_root_id: null })
export const moveEvent = (seq: number, root = 'id1', channel = 'A'): Extract<ServerEvent, { kind: 'move' }> => ({
  type: 'message', kind: 'move', seq, version: seq, channel_id: channel, root_id: root,
  history_generation: record(seq, channel).history_generation, source_topic_id: null,
  destination_topic_id: 'destination', operation_id: `move-${seq}`,
})
export function observe(state: SyncView): Observed {
  return { session: state.session, organization: state.organization, channels: Object.fromEntries(Object.entries(state.channels).map(([id, c]) => [id, {
    state: c.state, cursor: c.cursor, messages: c.messages,
    pending: c.pending.map(p => ({ client_message_id: p.clientMessageId, state: p.state })),
  }])) }
}
export function protocolClient(onInput?: (input: Input) => void) {
  let state = initialState('me')
  return {
    get: () => state,
    observe: () => observe(state),
    feed(i: ResolvedInput): FixtureEffect[] {
      const e = i.respond_to
      const channel = (i.channel ?? e?.channel ?? Object.entries(state.channels)
        .find(([, c]) => c.pending.some(p => p.clientMessageId === i.client_message_id))?.[0] ?? 'A') as string
      const msg = () => message(i.message, channel)
      let input: Input
      switch (i.type) {
        case 'organization_refused': input = { type: 'organization_unavailable' }; break
        case 'session_start': case 'session_replaced': input = { type: i.type, selfId: 'me' }; break
        case 'connection_ready': input = { type: i.type, connection: state.connection! }; break
        case 'socket_closed': input = { type: i.type, connection: state.connection!, code: i.code as number }; break
        case 'message': input = { type: 'event', connection: state.connection!, event: { type: 'message', kind: (i.kind ?? 'create') as 'create', seq: typeof i.seq === 'number' ? i.seq : msg().created_seq, message: msg() } }; break
        case 'subscribed': input = { type: 'event', connection: state.connection!, subscription: e?.id as number | undefined,
          event: { history_generation: (i.history_generation as string | undefined) ?? '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: channel, caught_up_seq: i.caught_up_seq as number } }; break
        case 'channel_access_lost': input = { type: 'event', connection: state.connection!, event: { type: 'channel_access_lost', channel_id: channel } }; break
        case 'error_event': input = { type: 'event', connection: state.connection!, event: { type: 'error', channel_id: channel,
          code: i.code as string } }; break
        case 'events_result': input = { type: 'events_result', request: e!.id as number,
          page: { history_generation: (i.history_generation as string | undefined) ?? '00000000-0000-4000-8000-000000000515', events: (i.events as { seq: number; kind: 'create'; message: ResolvedInput['message'] }[]).map(e => ({ type: 'message', seq: e.seq, kind: e.kind, message: message(e.message, channel) })), has_more: i.has_more as boolean } }; break
        case 'history_result': input = { type: i.type, request: e!.id as number,
          page: { history_generation: (i.history_generation as string | undefined) ?? '00000000-0000-4000-8000-000000000515', as_of_seq: (i.as_of_seq as number | undefined) ?? i.messages!.at(-1)?.created_seq ?? 0,  messages: i.messages!.map(m => message(m, channel)), has_more: i.has_more as boolean } }; break
        case 'send_failed': input = { type: i.type, request: e!.id as number,
          status: i.status as number | 'network' | 'timeout', retryAfterMs: i.retry_after_ms as number | undefined }; break
        case 'history_failed': input = { type: i.type, request: e!.id as number,
          status: i.status as number | 'network' | 'timeout', error: i.error as string | undefined }; break
        case 'ack': input = { type: i.type, request: e!.id as number, message: msg() }; break
        case 'timer_elapsed': input = { type: i.type, id: e!.id as number }; break
        case 'user_send': input = { type: i.type, channel, clientMessageId: i.client_message_id as string, body: i.body as string ?? 'hello' }; break
        case 'user_retry': case 'user_discard': input = { type: i.type, channel, clientMessageId: i.client_message_id as string }; break
        case 'watch': case 'unwatch': case 'refresh': case 'load_older': input = { type: i.type, channel }; break
        default: throw new Error(`unhandled fixture input ${i.type}`)
      }
      onInput?.(input)
      const result = step(state, input)
      state = result.state
      return result.effects.map(e => ({ ...e }))
    },
  }
}
