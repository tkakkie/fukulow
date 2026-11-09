import { describe, expect, it } from 'vitest'
import { runClientScenario } from '../scripts/realtime-fixtures'
import { scenarios, protocolClient } from './protocol-test-helpers'

describe('pure protocol shared client fixtures', () => {
  it.each(scenarios)('$id', scenario => {
    expect(runClientScenario(scenario, protocolClient())).toEqual([])
  })
  it('runs every client fixture against the protocol', () => {
    expect(scenarios.length).toBeGreaterThan(0)
    for (const scenario of scenarios) expect(runClientScenario(scenario, protocolClient()), scenario.id).toEqual([])
  })
})

import { initialState, step, type Input, type Effect, type State } from './protocol'
import { record } from './protocol-test-helpers'

function boot() {
  let state = initialState('me')
  const feed = (input: Input) => {
    const out = step(state, input)
    state = out.state
    return out.effects
  }
  feed({ type: 'session_start', selfId: 'me' })
  const connection = state.connection!
  feed({ type: 'connection_ready', connection })
  const latest = feed({ type: 'watch', channel: 'A' }).find(e => e.type === 'fetch_history')!
  feed({ type: 'history_result', request: latest.id, page: { messages: [record(100)], has_more: true } })
  feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 100 } })
  const event = (seq: number) => feed({ type: 'event', connection: state.connection!, event: { type: 'message', message: record(seq) } })
  return { feed, event, get: () => state, connection }
}
function id(effects: Effect[], type: 'fetch_history' | 'wait' | 'send' | 'connect'): number {
  const effect = effects.find(e => e.type === type)
  if (!effect || !('id' in effect)) throw new Error(`missing ${type}`)
  return effect.id
}

it('ack without an echo keeps the cursor and reconnect replay converges to one canonical Message', () => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'optimistic' }), 'send')
  const message = { ...record(101), sender: 'me', client_message_id: 'c1', body: 'canonical' }
  d.feed({ type: 'ack', request: send, message })
  expect(d.get().channels.A).toMatchObject({ cursor: 100, pending: [] })
  expect(d.get().channels.A.messages).toEqual([record(100), message])
  const wait = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1006 }), 'wait')
  const connection = id(d.feed({ type: 'timer_elapsed', id: wait }), 'connect')
  expect(d.feed({ type: 'connection_ready', connection })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', channel: 'A', after_seq: 100 }),
  )
  d.feed({ type: 'event', connection, event: { type: 'message', message } })
  d.feed({ type: 'event', connection, event: { type: 'message', message } })
  d.feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 101 } })
  expect(d.get().channels.A).toMatchObject({ state: 'ready', cursor: 101, pending: [] })
  expect(d.get().channels.A.messages).toEqual([record(100), message])
})

it('an ack buffered before bootstrap neither establishes nor extends the history base', () => {
  const d = protocolClient()
  d.feed({ type: 'session_start' })
  d.feed({ type: 'connection_ready' })
  const latest = d.feed({ type: 'watch', channel: 'A' }).find(e => e.type === 'fetch_history')!
  const send = d.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' }).find(e => e.type === 'send')!
  const message = { ...record(101), sender: 'me', client_message_id: 'c1' }
  d.feed({ type: 'ack', respond_to: send, message })
  expect(d.get().channels.A).toMatchObject({ cursor: null, pending: [], messages: [message] })
  expect(d.feed({ type: 'history_result', respond_to: latest, messages: [record(100)], has_more: true }))
    .toContainEqual(expect.objectContaining({ type: 'subscribe', after_seq: 100 }))
  expect(d.get().channels.A.cursor).toBe(100)
  expect(d.get().channels.A.messages).toEqual([record(100), message])
  d.feed({ type: 'message', channel: 'A', message })
  expect(d.get().channels.A.cursor).toBe(101)
  expect(d.get().channels.A.messages).toEqual([record(100), message])
})

it('an adjacent live predecessor closes the gap and drains the buffered ack successor', () => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  d.feed({ type: 'ack', request: send, message: { ...record(102), sender: 'me', client_message_id: 'c1' } })
  expect(d.get().channels.A.cursor).toBe(100)
  d.event(101)
  expect(d.get().channels.A.cursor).toBe(102)
  d.event(102)
  expect(d.get().channels.A.cursor).toBe(102)
})

it('a live predecessor before the ack leaves the cursor at the live seq, never past a gap, and reconnect replay converges', () => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  d.event(101)
  d.feed({ type: 'ack', request: send, message: { ...record(102), sender: 'me', client_message_id: 'c1' } })
  expect(d.get().channels.A.cursor).toBe(101)
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([100, 101, 102])
  const wait = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1006 }), 'wait')
  const connection = id(d.feed({ type: 'timer_elapsed', id: wait }), 'connect')
  expect(d.feed({ type: 'connection_ready', connection })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', channel: 'A', after_seq: 101 }),
  )
  d.feed({ type: 'event', connection, event: { type: 'message', message: { ...record(102), sender: 'me', client_message_id: 'c1' } } })
  d.feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 102 } })
  expect(d.get().channels.A.cursor).toBe(102)
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([100, 101, 102])
})

it.each([101, 102])('a gap above ack seq %s is detected and filled from the unchanged cursor', ackSeq => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  const message = { ...record(ackSeq), sender: 'me', client_message_id: 'c1' }
  d.feed({ type: 'ack', request: send, message })
  d.event(103)
  expect(d.get().channels.A.cursor).toBe(100)
  const effects = d.feed({ type: 'timer_elapsed', id: d.get().channels.A.wait! })
  expect(effects).toContainEqual(expect.objectContaining({ type: 'fetch_history', page: 'after', seq: 100 }))
  d.feed({ type: 'history_result', request: id(effects, 'fetch_history'), page: {
    messages: [101, 102, 103].map(seq => seq === ackSeq ? message : record(seq)), has_more: false,
  } })
  expect(d.get().channels.A).toMatchObject({ cursor: 103, pending: [], wait: undefined, fill: undefined })
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([100, 101, 102, 103])
  expect(d.get().channels.A.messages.find(m => m.seq === ackSeq)).toEqual(message)
})

it('directional has_more never lets an after page erase older pagination', () => {
  const d = boot()
  const timer = id(d.event(103), 'wait')
  const fill = id(d.feed({ type: 'timer_elapsed', id: timer }), 'fetch_history')
  d.feed({ type: 'history_result', request: fill, page: { messages: [record(101), record(102), record(103)], has_more: false } })
  expect(d.get().channels.A.hasOlder).toBe(true)
  const older = id(d.feed({ type: 'load_older', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_result', request: older, page: { messages: [record(1)], has_more: false } })
  expect(d.get().channels.A.hasOlder).toBe(false)
  const refreshed = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_result', request: refreshed, page: { messages: [record(103)], has_more: true } })
  expect(d.get().channels.A.hasOlder).toBe(false)
  expect(d.get().channels.A.cursor).toBe(103)
})

it('before and nonadjacent latest records extend the window without becoming cursor evidence', () => {
  const d = boot()
  const older = id(d.feed({ type: 'load_older', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_result', request: older, page: { messages: [record(99)], has_more: false } })
  expect(d.get().channels.A.cursor).toBe(100)
  const latest = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_result', request: latest, page: { messages: [record(103), record(104)], has_more: true } })
  expect(d.get().channels.A.cursor).toBe(100)
  d.event(101); d.event(102)
  expect(d.get().channels.A.cursor).toBe(102)
})

it('rejects stale connection readiness, events, closes and subscription completions', () => {
  const d = boot()
  const timer = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1011 }), 'wait')
  const next = id(d.feed({ type: 'timer_elapsed', id: timer }), 'connect')
  d.feed({ type: 'connection_ready', connection: next })
  const snapshot = d.get()
  for (const input of [
    { type: 'connection_ready', connection: d.connection },
    { type: 'socket_closed', connection: d.connection, code: 4001 },
    { type: 'event', connection: d.connection, event: { type: 'message', message: record(101) } },
    { type: 'event', connection: next, subscription: -1, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 0 } },
  ] satisfies Input[]) expect(d.feed(input)).toEqual([])
  expect(d.get()).toEqual(snapshot)
})

it('channel reset fences old latest, send completion, reorder timer and fill backoff', () => {
  const d = boot()
  const latest = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  const sending = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  const grace = id(d.event(103), 'wait')
  const fill = id(d.feed({ type: 'timer_elapsed', id: grace }), 'fetch_history')
  const backoff = id(d.feed({ type: 'history_failed', request: fill, status: 'network' }), 'wait')
  const reconnect = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1006 }), 'wait')
  const conn = id(d.feed({ type: 'timer_elapsed', id: reconnect }), 'connect')
  d.feed({ type: 'connection_ready', connection: conn })
  d.feed({ type: 'event', connection: conn, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 60 } })
  const snapshot = d.get()
  for (const input of [
    { type: 'history_result', request: latest, page: { messages: [record(200)], has_more: false } },
    { type: 'ack', request: sending, message: { ...record(101), sender: 'me', client_message_id: 'c1' } },
    { type: 'send_failed', request: sending, status: 401 },
    { type: 'timer_elapsed', id: grace }, { type: 'timer_elapsed', id: backoff },
  ] satisfies Input[]) expect(d.feed(input)).toEqual([])
  expect(d.get()).toEqual(snapshot)
  expect(d.get().channels.A.messages).toEqual([])
  expect(d.get().channels.A.pending[0].state).toBe('unknown')
})

it('settled or superseded requests cannot overwrite a newer history request or retry', () => {
  const d = boot()
  const first = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_result', request: first, page: { messages: [], has_more: false } })
  const second = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  expect(d.feed({ type: 'history_failed', request: first, status: 404 })).toEqual([])
  expect(d.get().channels.A.latest).toBe(second)
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  d.feed({ type: 'send_failed', request: send, status: 'network' })
  d.feed({ type: 'user_retry', channel: 'A', clientMessageId: 'c1' })
  d.feed({ type: 'send_failed', request: send, status: 413 })
  expect(d.get().channels.A.pending[0].state).toBe('sending')
})

it.each(['channel_not_found', 'subscription_limit', 403, 404] as const)('terminal denial %s cancels recovery and fences late pages until user action', refusal => {
  const d = boot()
  const grace = id(d.event(103), 'wait')
  const fill = id(d.feed({ type: 'timer_elapsed', id: grace }), 'fetch_history')
  const effects = d.feed(typeof refusal === 'number' ? { type: 'history_failed', request: fill, status: refusal }
    : { type: 'event', connection: d.connection, event: { type: 'error', channel_id: 'A', code: refusal } })
  expect(effects.some(e => ['wait', 'fetch_history', 'subscribe'].includes(e.type))).toBe(false)
  expect(d.get().channels.A.state).toBe('unavailable')
  expect(d.feed({ type: 'history_result', request: fill, page: { messages: [record(101), record(102)], has_more: false } })).toEqual([])
  expect(d.feed({ type: 'timer_elapsed', id: grace })).toEqual([])
  d.event(104)
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([100, 103])
  expect(d.feed({ type: 'refresh', channel: 'A' }).some(e => e.type === 'fetch_history')).toBe(true)
})

it('pending matching requires channel and signed-in sender even for acknowledgements', () => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'optimistic' }), 'send')
  d.feed({ type: 'ack', request: send, message: { ...record(101, 'B'), sender: 'me', client_message_id: 'c1' } })
  expect(d.get().channels.A.pending).toHaveLength(1)
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([100])
  d.feed({ type: 'event', connection: d.connection, event: { type: 'message', message: { ...record(101), client_message_id: 'c1' } } })
  expect(d.get().channels.A.pending).toHaveLength(1)
  d.feed({ type: 'event', connection: d.connection, event: { type: 'message', message: { ...record(102), client_message_id: 'c1', sender: 'me', body: 'canonical' } } })
  expect(d.get().channels.A.pending).toEqual([])
  expect(d.get().channels.A.messages.at(-1)?.body).toBe('canonical')
})

it('step is deterministic and does not mutate frozen input state or server records', () => {
  const d = boot()
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    Object.values(value).forEach(freeze); Object.freeze(value)
  }
  const state: State = d.get()
  const input: Input = { type: 'event', connection: d.connection, event: { type: 'message', message: record(101) } }
  freeze(state); freeze(input)
  const first = step(state, input)
  expect(step(state, input)).toEqual(first)
  expect(state.channels.A.cursor).toBe(100)
  expect(first.state.channels.A.cursor).toBe(101)
})

it('an older-page failure preserves the ready timeline and allows a user retry', () => {
  const d = boot()
  const older = id(d.feed({ type: 'load_older', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_failed', request: older, status: 'network' })
  expect(d.get().channels.A).toMatchObject({ state: 'ready', historyError: false, older: undefined, cursor: 100 })
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([100])
  expect(d.feed({ type: 'load_older', channel: 'A' }).some(e => e.type === 'fetch_history')).toBe(true)
})
