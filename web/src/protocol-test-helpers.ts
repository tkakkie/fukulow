/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from './api'
import { defaultDir, type ClientScenario, type Effect as FixtureEffect, type Observed, type ResolvedInput } from '../scripts/realtime-fixtures'
import { initialState, step, type Input, type State } from './protocol'

export const scenarios: ClientScenario[] = readdirSync(join(defaultDir, 'client')).filter(n => n.endsWith('.json')).sort()
  .flatMap(n => (JSON.parse(readFileSync(join(defaultDir, 'client', n), 'utf8')) as { scenarios: ClientScenario[] }).scenarios)
export const message = (m: ResolvedInput['message'], channel: string): Message => ({ ...m!, channel_id: channel, topic_id: m?.topic ?? null })
export const record = (seq: number, channel = 'A'): Message => ({ channel_id: channel, seq, body: `m${seq}`, id: `id${seq}`,
  sender: 'other', client_message_id: `auto-${seq}`, created_at: '2026-01-01T00:00:00Z', topic_id: null })
export function observe(state: State): Observed {
  return { session: state.session, organization: state.organization, channels: Object.fromEntries(Object.entries(state.channels).map(([id, c]) => [id, {
    state: c.state, cursor: c.cursor, messages: c.messages,
    pending: c.pending.map(p => ({ client_message_id: p.clientMessageId, state: p.state })),
  }])) }
}
export function protocolClient() {
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
        case 'message': input = { type: 'event', connection: state.connection!, event: { type: 'message', message: msg() } }; break
        case 'subscribed': input = { type: 'event', connection: state.connection!, subscription: e?.id as number | undefined,
          event: { type: 'subscribed', channel_id: channel, caught_up_seq: i.caught_up_seq as number } }; break
        case 'error_event': input = { type: 'event', connection: state.connection!, event: { type: 'error', channel_id: channel,
          code: i.code as string } }; break
        case 'history_result': input = { type: i.type, request: e!.id as number,
          page: { messages: i.messages!.map(m => message(m, channel)), has_more: i.has_more as boolean } }; break
        case 'history_failed': case 'send_failed': input = { type: i.type, request: e!.id as number,
          status: i.status as number | 'network' | 'timeout' }; break
        case 'ack': input = { type: i.type, request: e!.id as number, message: msg() }; break
        case 'timer_elapsed': input = { type: i.type, id: e!.id as number }; break
        case 'user_send': input = { type: i.type, channel, clientMessageId: i.client_message_id as string, body: i.body as string ?? 'hello' }; break
        case 'user_retry': case 'user_discard': input = { type: i.type, channel, clientMessageId: i.client_message_id as string }; break
        case 'watch': case 'unwatch': case 'refresh': case 'load_older': input = { type: i.type, channel }; break
        default: throw new Error(`unhandled fixture input ${i.type}`)
      }
      const result = step(state, input)
      state = result.state
      return result.effects.map(e => ({ ...e }))
    },
  }
}
