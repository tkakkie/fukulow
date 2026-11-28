// Build the deterministic protocol traces for the mixed step measurement.
import type { Message } from '../src/api-schema.d.ts'
import type { Effect, Input } from '../src/protocol-types.ts'
import { FIXTURE_GENERATION, fixtureUuid, normalizeInput } from './client-core-ids.ts'
import { loadClientScenarios, makeProtocolClient } from './measure-fixture-client.ts'
import { partitionScenarios, runClientScenario } from './realtime-fixtures.ts'

export function buildMixedTraces(selfId: string, driver: Pick<typeof import('../src/protocol-driver-test-helpers.ts'), 'initialState' | 'step'>): { id: string; inputs: Input[] }[] {
  const { initialState, step } = driver
  const scenarios = loadClientScenarios()
  const rec = (seq: number, channel = 'A'): Message => ({ history_generation: FIXTURE_GENERATION,
    mentions: [], channel_id: channel, created_seq: seq, version: seq, deleted: false, body: `m${seq}`, id: `id${seq}`, sender: 'other',
    client_message_id: `auto-${seq}`, created_at: '2026-01-01T00:00:00Z', topic_id: null, reply_to: null, reply_root_id: null,
  })
  function makeRecorder(id: string) {
    let state = initialState(selfId)
    const inputs: Input[] = []
    const feed = (raw: Input): Effect[] => {
      const norm = normalizeInput(raw); inputs.push(norm)
      const res = step(state, norm); state = res.state; return res.effects
    }
    return { id, inputs, feed, get: () => state }
  }
  const traces: { id: string; inputs: Input[] }[] = []
  for (const scenario of partitionScenarios(scenarios).running.filter((s) => s.layer !== 'controller')) {
    const d = makeRecorder(scenario.id)
    const errs = runClientScenario(scenario, makeProtocolClient(d.feed, driver))
    if (errs.length > 0) throw new Error(`Fixture ${scenario.id} failed: ${errs.join('; ')}`)
    traces.push({ id: d.id, inputs: d.inputs })
  }
  {
    const d = makeRecorder('retention-ranges-and-reference-identity')
    d.feed({ type: 'session_start', selfId: 'me' })
    const connection = d.get().connection!
    d.feed({ type: 'connection_ready', connection })
    const channel = 'A', view = () => d.get().channels[fixtureUuid(channel)]
    const event = (seq: number) => d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (rec(seq)).created_seq, message: rec(seq) } })
    const page = (request: number, start: number, length: number) =>
      d.feed({ type: 'history_result', request, page: { history_generation: FIXTURE_GENERATION, as_of_seq: start + length - 1,  messages: Array.from({ length }, (_, i) => rec(start + i)), has_more: true } })
    // After-cursor fills answer with Channel events since #515 slice 3; only events advance the cursor.
    const fill = (request: number, start: number, length: number) =>
      d.feed({ type: 'events_result', request, page: { history_generation: FIXTURE_GENERATION, has_more: true,
        events: Array.from({ length }, (_, i) => ({ type: 'message' as const, kind: 'create' as const, seq: start + i, message: rec(start + i) })) } })
    d.feed({ type: 'watch', channel }); page(view().latest!, 1, 200)
    d.feed({ type: 'event', connection, subscription: -1, event: { history_generation: FIXTURE_GENERATION, type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
    d.feed({ type: 'event', connection, event: { history_generation: FIXTURE_GENERATION, type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
    for (let i = 0; i < 425; i++) event(202 + i * 2)
    d.feed({ type: 'timer_elapsed', id: view().wait! })
    while (view().fill !== undefined) fill(view().fill!, view().cursor! + 1, 200)
    if (view().cursor! < 1050 || view().forgottenThrough !== undefined) throw new Error(`Retention trace did not catch up: cursor=${view().cursor}`)
    for (let seq = view().cursor! + 1, end = seq + 450; seq < end; seq++) event(seq)
    const duplicate = rec(view().cursor!)
    d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (duplicate).created_seq, message: duplicate } })
    d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (duplicate).created_seq, message: duplicate } })
    d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (duplicate).created_seq, message: duplicate }, refreshMentionNames: true })
    for (const name of ['Retained', 'Retained', 'Renamed']) {
      d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: ({ ...duplicate, mentions: [{ member_id: 'target', name }] }).created_seq, message: { ...duplicate, mentions: [{ member_id: 'target', name }] } } })
    }
    d.feed({ type: 'load_older', channel }); page(view().older!, 1, 200); d.feed({ type: 'refresh', channel })
    d.feed({ type: 'history_result', request: view().latest!, page: { history_generation: FIXTURE_GENERATION, as_of_seq: 1901,  messages: [rec(1901), rec(1900), { ...rec(1901), body: 'canonical' }], has_more: false } })
    d.feed({ type: 'user_send', channel, clientMessageId: 'reply', body: 'pending', reply_to: 'parent', replyRootId: 'root' })
    d.feed({ type: 'user_send', channel, clientMessageId: 'reply', body: 'same key' }); d.feed({ type: 'unwatch', channel })
    for (const ch of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) {
      d.feed({ type: 'watch', channel: ch })
      const c = d.get().channels[fixtureUuid(ch)]
      d.feed({ type: 'history_result', request: c.latest!, page: { history_generation: FIXTURE_GENERATION, as_of_seq: 200,  messages: Array.from({ length: 200 }, (_, i) => rec(i + 1, ch)), has_more: true } })
      d.feed({ type: 'unwatch', channel: ch })
    }
    d.feed({ type: 'watch', channel })
    d.feed({ type: 'event', connection, event: { history_generation: FIXTURE_GENERATION, type: 'subscribed', channel_id: channel, caught_up_seq: 2 } })
    traces.push({ id: d.id, inputs: d.inputs })
  }
  for (const seed of [1, 42, 464, 0xdeadbeef]) {
    const d = makeRecorder(`generated-${seed}`)
    let rng = seed
    const random = (n: number) => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n }
    const channels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    const boot = () => {
      d.feed({ type: 'session_start', selfId: 'me' }); d.feed({ type: 'connection_ready', connection: d.get().connection! })
      for (const ch of channels) {
        const req = d.feed({ type: 'watch', channel: ch }).find((e) => e.type === 'fetch_history')!
        if (req.type !== 'fetch_history') throw new Error('missing bootstrap')
        d.feed({ type: 'history_result', request: req.id, page: { history_generation: FIXTURE_GENERATION, as_of_seq: 200,  messages: Array.from({ length: 200 }, (_, i) => rec(i + 1, ch)), has_more: true } })
        d.feed({ type: 'event', connection: d.get().connection!, event: { history_generation: FIXTURE_GENERATION, type: 'subscribed', channel_id: ch, caught_up_seq: 200 } })
      }
    }
    boot()
    for (let index = 0; index < 1600; index++) {
      const state = d.get(), ch = channels[random(channels.length)], c = state.channels[fixtureUuid(ch)]
      const requests = Object.entries(state.requests), request = requests[random(requests.length)], timers = Object.keys(state.timers)
      const pending = c?.pending[random(c.pending.length)], connection = state.connection ?? 999_999
      const seq = random(3) === 0 ? (c?.cursor ?? 200) + 1 : 1 + random(1300)
      const message = {
        ...rec(seq, ch), ...(random(4) === 0 ? { sender: 'me', client_message_id: pending?.clientMessageId ?? 'c1' } : {}),
        mentions: random(3) === 0 ? [{ member_id: 'mention', name: `name${random(3)}` }] : [],
      }
      const choices: Input[] = [
        { type: 'watch', channel: ch }, { type: 'unwatch', channel: ch }, { type: 'refresh', channel: ch },
        { type: 'load_older', channel: ch }, { type: 'channel_unavailable', channel: ch },
        { type: 'user_send', channel: ch, clientMessageId: `c${random(4)}`, body: ['hello', '  ', '\ufeff', '\u0085'][random(4)],
          ...(random(3) === 0 ? { reply_to: 'parent', replyRootId: 'root' } : random(2) === 0 ? { topic_name: 'Topic' } : {}) },
        { type: 'user_retry', channel: ch, clientMessageId: pending?.clientMessageId ?? 'c1' },
        { type: 'user_discard', channel: ch, clientMessageId: pending?.clientMessageId ?? 'c1' },
        { type: 'event', connection, event: { type: 'message', kind: 'create', seq: (message).created_seq, message }, ...(random(5) === 0 ? { refreshMentionNames: true } : {}) },
        { type: 'event', connection, event: { history_generation: FIXTURE_GENERATION, type: 'subscribed', channel_id: ch, caught_up_seq: random(500) }, ...(random(3) === 0 ? { subscription: 99999 } : {}) },
        { type: 'event', connection, event: { type: 'error', channel_id: ch, code: ['channel_not_found', 'subscription_limit', 'unknown'][random(3)] } },
        { type: 'event', connection, event: { type: 'channel_access_lost', channel_id: ch } },
        { type: 'settle_history', channel: ch, messages: [message] },
        { type: 'connection_ready', connection },
        { type: 'timer_elapsed', id: timers.length ? Number(timers[random(timers.length)]) : 99999 },
      ]
      if (request) {
        const [token, r] = request
        if (r.type === 'history') {
          const hasMore = random(2) === 0
          const messages = Array.from({ length: random(8) }, (_, i) => ({ ...rec((r.seq ?? 190) + i + 1, r.channel), ...(random(5) === 0 ? { sender: 'me', client_message_id: 'c1' } : {}) }))
          choices.push(r.page === 'after'
            ? { type: 'events_result', request: Number(token), page: { history_generation: FIXTURE_GENERATION, has_more: hasMore,
              events: messages.map((m) => ({ type: 'message' as const, kind: 'create' as const, seq: m.created_seq, message: m })) } }
            : { type: 'history_result', request: Number(token), page: { history_generation: FIXTURE_GENERATION, as_of_seq: messages.at(-1)?.created_seq ?? 0, messages, has_more: hasMore } })
          choices.push({ type: 'history_failed', request: Number(token), status: [401, 403, 404, 500, 'network', 'timeout'][random(6)] as 401 })
        } else {
          choices.push({ type: 'ack', request: Number(token), message: { ...message, channel_id: r.channel, sender: 'me', client_message_id: r.clientMessageId } })
          choices.push({ type: 'send_failed', request: Number(token), status: [400, 401, 403, 404, 409, 413, 415, 429, 503, 'network', 'timeout'][random(11)] as 400,
            retryAfterMs: [0, 1000.5, 2000, Number.MAX_SAFE_INTEGER, 1e16][random(5)], error: 'refused' })
        }
      }
      if (index % 71 === 0) d.feed({ type: 'socket_closed', connection, code: [1006, 4008, 4029, 4001, 4003][random(5)] })
      else if (index % 127 === 0) d.feed({ type: 'organization_unavailable' })
      else if (index % 173 === 0) { d.feed({ type: 'stop' }); d.feed({ type: 'stop' }); boot() }
      else if (index % 89 === 0 || !state.running) { d.feed({ type: 'session_replaced', selfId: 'me' }); d.feed({ type: 'connection_ready', connection: d.get().connection! }) }
      else d.feed(choices[random(choices.length)])
    }
    traces.push({ id: d.id, inputs: d.inputs })
  }
  return traces
}
