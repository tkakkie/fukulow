import { appendFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { partitionScenarios, runClientScenario } from '../scripts/realtime-fixtures'
import { protocolClient, record, scenarios } from './protocol-test-helpers'
import { initialState, step, type Input, type State } from './protocol'
import { fixtureUuid, normalizeInput } from '../scripts/client-core-ids'

type Trace = { id: string; steps: number }
function recorder(id: string) {
  let state = initialState(fixtureUuid('me'))
  const trace: Trace = { id, steps: 0 }
  function feed(raw: Input) {
    const input = normalizeInput(raw)
    const result = step(state, input)
    const { channels, requests, timers, ...session } = result.state
    if (process.env.CLIENT_CORE_TRACE_FILE) appendFileSync(process.env.CLIENT_CORE_TRACE_FILE, JSON.stringify({ trace: id, input, expected: {
      effects: result.effects, changedChannels: [...result.changedChannels], records: [...result.records],
      stateChanged: result.state !== state, channels, session, requests, timers,
    } }) + '\n')
    trace.steps++
    state = result.state
    return result.effects
  }
  return { feed, trace, get: (): State => state }
}

function generated(seed: number): Trace {
  const d = recorder(`generated-${seed}`)
  let rng = seed
  const random = (n: number) => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n }
  const channels = ['A','B','C','D','E','F','G','H']
  const boot = () => {
    d.feed({ type: 'session_start', selfId: 'me' })
    d.feed({ type: 'connection_ready', connection: d.get().connection! })
    for (const channel of channels) {
      const effects = d.feed({ type: 'watch', channel })
      const request = effects.find(e => e.type === 'fetch_history')!
      if (request.type !== 'fetch_history') throw new Error('missing bootstrap')
      d.feed({ type: 'history_result', request: request.id, page: {
        messages: Array.from({ length: 200 }, (_,i) => record(i + 1, channel)), has_more: true } })
      d.feed({ type: 'event', connection: d.get().connection!, event: { type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
    }
  }
  boot()
  for (let index = 0; index < 1600; index++) {
    const state = d.get()
    const channel = channels[random(channels.length)]
    const c = state.channels[fixtureUuid(channel)]
    const requests = Object.entries(state.requests)
    const request = requests[random(requests.length)]
    const timers = Object.keys(state.timers)
    const pending = c?.pending[random(c.pending.length)]
    const connection = state.connection ?? 999_999
    const seq = random(3) === 0 ? (c?.cursor ?? 200) + 1 : 1 + random(1300)
    const message = { ...record(seq, channel), ...(random(4) === 0 ? { sender: 'me', client_message_id: pending?.clientMessageId ?? 'c1' } : {}),
      mentions: random(3) === 0 ? [{ member_id: 'mention', name: `name${random(3)}` }] : [] }
    const choices: Input[] = [
      { type: 'watch', channel }, { type: 'unwatch', channel }, { type: 'refresh', channel },
      { type: 'load_older', channel }, { type: 'channel_unavailable', channel },
      { type: 'user_send', channel, clientMessageId: `c${random(4)}`, body: ['hello','  ','\ufeff','\u0085'][random(4)],
        ...(random(3) === 0 ? { reply_to: 'parent', replyRootId: 'root' } : random(2) === 0 ? { topic_name: 'Topic' } : {}) },
      { type: 'user_retry', channel, clientMessageId: pending?.clientMessageId ?? 'c1' },
      { type: 'user_discard', channel, clientMessageId: pending?.clientMessageId ?? 'c1' },
      { type: 'event', connection, event: { type: 'message', message }, ...(random(5) === 0 ? { refreshMentionNames: true } : {}) },
      { type: 'event', connection, event: { type: 'subscribed', channel_id: channel, caught_up_seq: random(500) },
        ...(random(3) === 0 ? { subscription: 99999 } : {}) },
      { type: 'event', connection, event: { type: 'error', channel_id: channel, code: ['channel_not_found','subscription_limit','unknown'][random(3)] } },
      { type: 'event', connection, event: { type: 'channel_access_lost', channel_id: channel } },
      { type: 'settle_history', channel, messages: [message] },
      { type: 'connection_ready', connection },
      { type: 'timer_elapsed', id: timers.length ? Number(timers[random(timers.length)]) : 99999 },
    ]
    if (request) {
      const [token,r] = request
      if (r.type === 'history') {
        choices.push({ type: 'history_result', request: Number(token), page: { has_more: random(2) === 0,
          messages: Array.from({ length: random(8) },(_,i) => ({ ...record((r.seq ?? 190) + i + 1, r.channel),
            ...(random(5) === 0 ? { sender: 'me', client_message_id: 'c1' } : {}) })) } })
        choices.push({ type: 'history_failed', request: Number(token), status: [401,403,404,500,'network','timeout'][random(6)] as 401 })
      } else {
        choices.push({ type: 'ack', request: Number(token), message: { ...message, channel_id: r.channel, sender: 'me', client_message_id: r.clientMessageId } })
        choices.push({ type: 'send_failed', request: Number(token), status: [400,401,403,404,409,413,415,429,503,'network','timeout'][random(11)] as 400,
          retryAfterMs: [0,1000.5,2000,Number.MAX_SAFE_INTEGER,1e16][random(5)], error: 'refused' })
      }
    }
    if (index % 71 === 0) d.feed({ type: 'socket_closed', connection, code: [1006,4008,4029,4001,4003][random(5)] })
    else if (index % 127 === 0) d.feed({ type: 'organization_unavailable' })
    else if (index % 173 === 0) { d.feed({ type: 'stop' }); d.feed({ type: 'stop' }); boot() }
    else if (index % 89 === 0 || !state.running) { d.feed({ type: 'session_replaced', selfId: 'me' }); d.feed({ type: 'connection_ready', connection: d.get().connection! }) }
    else d.feed(choices[random(choices.length)])
  }
  return d.trace
}

function retentionAndIdentity(): Trace {
  const d = recorder('retention-ranges-and-reference-identity')
  d.feed({ type: 'session_start', selfId: 'me' })
  const connection = d.get().connection!
  d.feed({ type: 'connection_ready', connection })
  const channel = 'A'
  const view = () => d.get().channels[fixtureUuid(channel)]
  const event = (seq: number) => d.feed({ type: 'event', connection, event: { type: 'message', message: record(seq) } })
  const page = (request: number, start: number, length: number) => d.feed({ type: 'history_result', request,
    page: { messages: Array.from({ length }, (_,i) => record(start + i)), has_more: true } })
  d.feed({ type: 'watch', channel })
  page(view().latest!, 1, 200)
  d.feed({ type: 'event', connection, subscription: -1, event: { type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
  d.feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
  for (let i = 0; i < 425; i++) event(202 + i * 2)
  expect(view().advancing).toHaveLength(400)
  expect(view().forgottenThrough).toBeGreaterThan(1000)
  d.feed({ type: 'timer_elapsed', id: view().wait! })
  while (view().fill !== undefined) page(view().fill!, view().cursor! + 1, 200)
  for (let seq = view().cursor! + 1, end = seq + 450; seq < end; seq++) event(seq)
  const duplicate = record(view().cursor!)
  d.feed({ type: 'event', connection, event: { type: 'message', message: duplicate } })
  const unchanged = d.get()
  d.feed({ type: 'event', connection, event: { type: 'message', message: duplicate } })
  expect(d.get()).toBe(unchanged)
  d.feed({ type: 'event', connection, event: { type: 'message', message: duplicate }, refreshMentionNames: true })
  expect(d.get()).not.toBe(unchanged)
  const mentions = [{ member_id: 'target', name: 'Retained' }]
  for (const name of ['Retained','Retained','Renamed']) d.feed({ type: 'event', connection,
    event: { type: 'message', message: { ...duplicate, mentions: [{ ...mentions[0], name }] } } })
  d.feed({ type: 'load_older', channel })
  page(view().older!, 1, 200)
  d.feed({ type: 'refresh', channel })
  // Unsorted, repeated seqs exercise last-record-wins dedup and original records order.
  d.feed({ type: 'history_result', request: view().latest!, page: {
    messages: [record(1901), record(1900), { ...record(1901), body: 'canonical' }], has_more: false } })
  d.feed({ type: 'user_send', channel, clientMessageId: 'reply', body: 'pending', reply_to: 'parent', replyRootId: 'root' })
  d.feed({ type: 'user_send', channel, clientMessageId: 'reply', body: 'same key' })
  d.feed({ type: 'unwatch', channel })
  for (const channel of ['B','C','D','E','F','G','H']) {
    d.feed({ type: 'watch', channel })
    const c = d.get().channels[fixtureUuid(channel)]
    d.feed({ type: 'history_result', request: c.latest!, page: {
      messages: Array.from({ length: 200 },(_,i) => record(i+1,channel)), has_more: true } })
    d.feed({ type: 'unwatch', channel })
  }
  const retained = Object.values(d.get().channels).filter(c => c.messages.length > 0)
  expect(retained).toHaveLength(5)
  expect(retained.every(c => c.messages.length === 50)).toBe(true)
  expect(view().pending).toHaveLength(1)
  d.feed({ type: 'watch', channel })
  d.feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: channel, caught_up_seq: 2 } })
  return d.trace
}

it('normalizes symbolic identities consistently without changing payloads or numeric generations', () => {
  expect(fixtureUuid('me')).toBe(fixtureUuid('me'))
  expect(fixtureUuid(fixtureUuid('me'))).toBe(fixtureUuid('me'))
  const symbols = ['A','B','me','other','parent','root','mention',...Array.from({length: 2000},(_,i) => `id${i}`)]
  expect(new Set(symbols.map(fixtureUuid)).size).toBe(symbols.length)
  const input: Input = { type: 'user_send', channel: 'A', clientMessageId: 'A', body: 'A' }
  expect(normalizeInput(input)).toEqual({ ...input, channel: fixtureUuid('A'), clientMessageId: fixtureUuid('A') })
})
it('records live per-step references for every implemented core fixture and seeded sequences', () => {
  if (process.env.CLIENT_CORE_TRACE_FILE) writeFileSync(process.env.CLIENT_CORE_TRACE_FILE, '')
  const traces: Trace[] = []
  for (const scenario of partitionScenarios(scenarios).running.filter(s => s.layer !== 'controller')) {
    const d = recorder(scenario.id)
    expect(runClientScenario(scenario, protocolClient(d.feed)),scenario.id).toEqual([])
    traces.push(d.trace)
  }
  traces.push(retentionAndIdentity(), ...[1,42,464,0xdeadbeef].map(generated))
  expect(traces.reduce((count, trace) => count + trace.steps, 0)).toBeGreaterThan(6000)
}, 60_000)
