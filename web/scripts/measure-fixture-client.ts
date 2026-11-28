// Fixture protocol client: maps contract/realtime/client scenario inputs to protocol `Input`s on an
// injected driver. The only copy (#866): the #466 measurement harness records its inputs as traces, and
// web/src/protocol-test-helpers.ts wraps it for the protocol tests.
// Kept outside measure-wasm-core.ts (which runs on import) so a test can prove every
// fixture input type is handled (#545).
import type { components } from '../src/api-schema.d.ts'
import type { Input, SyncView } from '../src/protocol-types.ts'
import { FIXTURE_GENERATION } from './client-core-ids.ts'
import { fixtureEvents, fixtureMove, type Effect as FixtureEffect, type Observed, type ResolvedInput } from './realtime-fixtures.ts'

export { loadClientScenarios } from './realtime-fixtures.ts'

type Message = components['schemas']['Message']

export const msgFromFixture = (m: ResolvedInput['message'], channel: string): Message => ({
  mentions: [], ...m!, channel_id: channel, topic_id: m?.topic ?? null, reply_to: m?.reply_to ?? null, reply_root_id: m?.reply_root_id ?? null,
})

export const observe = (state: SyncView): Observed => ({
  session: state.session, organization: state.organization,
  channels: Object.fromEntries(Object.entries(state.channels).map(([id, c]) => [id, {
    state: c.state, cursor: c.cursor, messages: c.messages,
    pending: c.pending.map((p) => ({ client_message_id: p.clientMessageId, state: p.state })),
  }])),
})

export function makeProtocolClient(onInput: (input: Input) => void, { initialState, step }: Pick<typeof import('../src/protocol-driver-test-helpers.ts'), 'initialState' | 'step'>) {
  let state = initialState('me')
  return {
    get: () => state, observe: () => observe(state),
    feed(i: ResolvedInput): FixtureEffect[] {
      const e = i.respond_to
      const channel = (i.channel ?? e?.channel ?? Object.entries(state.channels)
        .find(([, c]) => c.pending.some((p) => p.clientMessageId === i.client_message_id))?.[0] ?? 'A') as string
      const msg = () => msgFromFixture(i.message, channel)
      const generation = (i.history_generation as string | undefined) ?? FIXTURE_GENERATION
      let input: Input
      switch (i.type) {
        case 'organization_refused': input = { type: 'organization_unavailable' }; break
        case 'session_start': case 'session_replaced': input = { type: i.type, selfId: 'me' }; break
        case 'connection_ready': input = { type: i.type, connection: state.connection! }; break
        case 'socket_closed': input = { type: i.type, connection: state.connection!, code: i.code as number }; break
        case 'message': input = { type: 'event', connection: state.connection!,
          event: { type: 'message', kind: (i.kind ?? 'create') as 'create', seq: typeof i.seq === 'number' ? i.seq : msg().created_seq, message: msg() } }; break
        case 'move': input = { type: 'event', connection: state.connection!, event: fixtureMove(i.move!, channel, generation) }; break
        case 'subscribed': input = { type: 'event', connection: state.connection!, subscription: e?.id as number | undefined,
          event: { history_generation: generation, type: 'subscribed', channel_id: channel, caught_up_seq: i.caught_up_seq as number } }; break
        case 'channel_access_lost': input = { type: 'event', connection: state.connection!, event: { type: 'channel_access_lost', channel_id: channel } }; break
        case 'error_event': input = { type: 'event', connection: state.connection!, event: { type: 'error', channel_id: channel, code: i.code as string } }; break
        case 'events_result': input = { type: i.type, request: e!.id as number,
          page: { history_generation: generation, has_more: i.has_more as boolean,
            events: fixtureEvents(i, channel, generation, msgFromFixture) } }; break
        case 'history_result': input = { type: i.type, request: e!.id as number,
          page: { history_generation: generation, as_of_seq: (i.as_of_seq as number | undefined) ?? i.messages!.at(-1)?.created_seq ?? 0,
            messages: i.messages!.map((m) => msgFromFixture(m, channel)), has_more: i.has_more as boolean } }; break
        case 'send_failed': input = { type: i.type, request: e!.id as number,
          status: i.status as number | 'network' | 'timeout', retryAfterMs: i.retry_after_ms as number | undefined }; break
        case 'history_failed': input = { type: i.type, request: e!.id as number,
          status: i.status as number | 'network' | 'timeout', error: i.error as string | undefined }; break
        case 'ack': input = { type: i.type, request: e!.id as number, message: msg() }; break
        case 'timer_elapsed': input = { type: i.type, id: e!.id as number }; break
        case 'user_send': input = { type: i.type, channel, clientMessageId: i.client_message_id as string, body: (i.body as string) ?? 'hello' }; break
        case 'user_retry': case 'user_discard': input = { type: i.type, channel, clientMessageId: i.client_message_id as string }; break
        case 'watch': case 'unwatch': case 'refresh': case 'load_older': input = { type: i.type, channel }; break
        default: throw new Error(`unhandled fixture input ${i.type}`)
      }
      onInput(input)
      const result = step(state, input); state = result.state
      return result.effects.map((ef) => ({ ...ef }))
    },
  }
}
