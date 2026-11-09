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

// A stale request stays recorded until its late result arrives, so a late 401 can still mean Sign in (C6/C8).
const live = (state: ReturnType<ReturnType<typeof boot>['get']>) =>
  ({ ...state, requests: Object.fromEntries(Object.entries(state.requests).filter(([, r]) => !r.stale)) })

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
    { type: 'timer_elapsed', id: grace }, { type: 'timer_elapsed', id: backoff },
  ] satisfies Input[]) expect(d.feed(input)).toEqual([])
  expect(live(d.get())).toEqual(live(snapshot))
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

it('async channel_not_found terminates a confirmed generation until explicit reselect', () => {
  const d = boot()
  const subscription = d.get().channels.A.subscription!.id
  expect(d.feed({ type: 'event', connection: d.connection, subscription,
    event: { type: 'error', channel_id: 'A', code: 'channel_not_found' } }))
    .toEqual([{ type: 'unsubscribe', channel: 'A' }])
  expect(d.get().channels.A.state).toBe('unavailable')
  expect(d.event(101)).toEqual([])
  expect(d.feed({ type: 'load_older', channel: 'A' })).toEqual([])
  expect(d.feed({ type: 'watch', channel: 'A' })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', after_seq: 100 }))
  const current = d.get().channels.A.subscription!.id
  d.feed({ type: 'event', connection: d.connection, subscription,
    event: { type: 'error', channel_id: 'A', code: 'channel_not_found' } })
  expect(d.get().channels.A.subscription!.id).toBe(current)
  expect(d.get().channels.A.state).toBe('loading')
})

it('clamp preserves failed and unknown sends and invalidates only pre-clamp sending attempts', () => {
  const d = boot()
  const send = (key: string) => id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: key, body: key }), 'send')
  const failed = send('failed')
  d.feed({ type: 'send_failed', request: failed, status: 413 })
  const unknown = send('unknown')
  d.feed({ type: 'send_failed', request: unknown, status: 'timeout' })
  const old = send('old')
  d.feed({ type: 'unwatch', channel: 'A' })
  d.feed({ type: 'watch', channel: 'A' })
  const subscription = d.get().channels.A.subscription!.id
  const effects = d.feed({ type: 'event', connection: d.connection, subscription,
    event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 60 } })
  expect(effects).toContainEqual({ type: 'unsubscribe', channel: 'A' })
  expect(d.get().channels.A.pending.map(p => [p.clientMessageId, p.state]))
    .toEqual([['failed', 'failed'], ['unknown', 'unknown'], ['old', 'unknown']])
  expect(d.feed({ type: 'user_retry', channel: 'A', clientMessageId: 'failed' })).toEqual([])
  const retry = id(d.feed({ type: 'user_retry', channel: 'A', clientMessageId: 'unknown' }), 'send')
  const valid = send('new')
  const snapshot = d.get()
  for (const input of [
    { type: 'ack', request: old, message: { ...record(101), sender: 'me', client_message_id: 'old' } },
    { type: 'send_failed', request: old, status: 403 },
    { type: 'event', connection: d.connection, subscription,
      event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 0 } },
  ] satisfies Input[]) expect(d.feed(input)).toEqual([])
  expect(live(d.get())).toEqual(live(snapshot))
  d.feed({ type: 'history_result', request: id(effects, 'fetch_history'), page: { messages: [record(60)], has_more: true } })
  expect(d.get().channels.A.pending.find(p => p.clientMessageId === 'new')).toMatchObject({ state: 'sending', request: valid })
  expect(d.get().channels.A.pending.find(p => p.clientMessageId === 'unknown')).toMatchObject({ state: 'sending', request: retry })
  d.feed({ type: 'ack', request: valid, message: { ...record(61), sender: 'me', client_message_id: 'new', body: 'server' } })
  d.feed({ type: 'send_failed', request: retry, status: 409 })
  expect(d.get().channels.A.pending.map(p => [p.clientMessageId, p.state]))
    .toEqual([['failed', 'failed'], ['unknown', 'failed'], ['old', 'unknown']])
  expect(d.get().channels.A.messages.at(-1)?.body).toBe('server')
})

it('watch clamp unwatch releases every server slot before the replacement bootstrap completes', () => {
  const d = boot()
  const active = new Set<string>(['A'])
  for (let n = 0; n < 257; n++) {
    const channel = `clamp-${n}`
    const apply = (input: Input) => {
      const effects = d.feed(input)
      for (const e of effects) {
        if (e.type === 'subscribe') active.add(e.channel)
        if (e.type === 'unsubscribe') active.delete(e.channel)
      }
      return effects
    }
    const latest = id(apply({ type: 'watch', channel }), 'fetch_history')
    apply({ type: 'history_result', request: latest, page: { messages: [record(100, channel)], has_more: false } })
    expect(active.size).toBe(2)
    apply({ type: 'event', connection: d.connection, subscription: d.get().channels[channel].subscription!.id,
      event: { type: 'subscribed', channel_id: channel, caught_up_seq: 0 } })
    apply({ type: 'unwatch', channel })
    expect(active).toEqual(new Set(['A']))
    expect(d.get().channels[channel]).toMatchObject({ watched: false, cursor: null, subscription: undefined })
  }
})

it('one Channel update shares untouched Channels and unrelated message and pending arrays', () => {
  const d = boot()
  const history = id(d.feed({ type: 'watch', channel: 'B' }), 'fetch_history')
  d.feed({ type: 'history_result', request: history, page: { messages: [record(1, 'B')], has_more: false } })
  d.feed({ type: 'user_send', channel: 'B', clientMessageId: 'b', body: 'b' })
  const before = d.get()
  // An unrelated window/pending queue must not even be traversed, regardless of its size.
  for (const key of ['messages', 'pending', 'advancing'] as const) {
    Object.defineProperty(before.channels.B, key, { get: () => { throw new Error(`read unrelated ${key}`) } })
  }
  const after = step(before, { type: 'event', connection: d.connection, event: { type: 'message', message: record(101) } }).state
  expect(after.channels.B).toBe(before.channels.B)
  expect(after.channels.A).not.toBe(before.channels.A)
  expect(after.channels.A.messages[0]).toBe(before.channels.A.messages[0])
  expect(after.channels.A.pending).toBe(before.channels.A.pending)
  expect(after.channels.A.subscription).toBe(before.channels.A.subscription)
  expect(before.channels.A.messages).toEqual([record(100)])
})

it('unchanged protocol input keeps state identity and duplicate merge never copies the loaded window', () => {
  const d = boot()
  const before = d.get()
  const original = before.channels.A.messages
  before.channels.A.messages = new Proxy(original, {
    get(target, key, receiver) {
      if (key === 'map' || key === 'slice' || key === Symbol.iterator || key === 'sort')
        throw new Error('copied or traversed duplicate window')
      return Reflect.get(target, key, receiver)
    },
  })
  for (const input of [
    { type: 'watch', channel: 'A' },
    { type: 'user_discard', channel: 'A', clientMessageId: 'absent' },
    { type: 'user_retry', channel: 'A', clientMessageId: 'absent' },
    { type: 'event', connection: d.connection, event: { type: 'message', message: { ...record(100) } } },
    { type: 'event', connection: d.connection, subscription: before.channels.A.subscription!.id,
      event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 100 } },
    { type: 'history_failed', request: -1, status: 404 },
    { type: 'send_failed', request: -1, status: 401 },
    { type: 'timer_elapsed', id: -1 },
  ] satisfies Input[]) {
    const result = step(before, input)
    expect(result.state).toBe(before)
    expect(result.effects).toEqual([])
  }
})

it('incremental merge handles unordered duplicates and history pages with canonical pending settlement', () => {
  const d = boot()
  for (const key of ['match', 'other', 'unsettled'])
    d.feed({ type: 'user_send', channel: 'A', clientMessageId: key, body: 'optimistic' })
  const pending = d.get().channels.A.pending
  const old = d.get().channels.A.messages[0]
  const older = id(d.feed({ type: 'load_older', channel: 'A' }), 'fetch_history')
  const canonical = { ...record(99), sender: 'me', client_message_id: 'match', body: 'canonical', id: 'server-99' }
  d.feed({ type: 'history_result', request: older, page: {
    messages: [record(99), record(97), record(98), canonical, { ...record(96), client_message_id: 'other' }], has_more: false,
  } })
  expect(d.get().channels.A.messages).toEqual([{ ...record(96), client_message_id: 'other' }, record(97), record(98), canonical, old])
  expect(d.get().channels.A.messages.at(-1)).toBe(old)
  expect(d.get().channels.A.pending).toEqual(pending.slice(1))
  expect(d.get().channels.A.pending[0]).toBe(pending[1])
  expect(d.get().channels.A.cursor).toBe(100)
  // Refresh overlaps existing records and contains out-of-order repeated seqs: last server record wins.
  const latest = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  const changed = { ...record(100), body: 'server replacement' }
  d.feed({ type: 'history_result', request: latest, page: {
    messages: [record(103), record(100), record(102), changed, record(101), record(103)], has_more: false,
  } })
  expect(d.get().channels.A.messages.map(m => m.seq)).toEqual([96, 97, 98, 99, 100, 101, 102, 103])
  expect(d.get().channels.A.messages.find(m => m.seq === 100)).toBe(changed)
  expect(d.get().channels.A.cursor).toBe(100)
  d.event(103); d.event(101); d.event(102)
  expect(d.get().channels.A.cursor).toBe(103)
})

it('incremental merge matches a full-window reference across deterministic overlapping pages', () => {
  const d = boot()
  const expected = new Map(d.get().channels.A.messages.map(m => [m.seq, m]))
  for (let batch = 0; batch < 60; batch++) {
    const records = Array.from({ length: 13 }, (_, i) => ({ ...record((batch * 17 + i * 31) % 151 + 1), body: `batch-${batch}-${i}` }))
    records.push({ ...records[3], body: 'last duplicate wins' }, { ...records[5] })
    const request = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
    for (const message of records) expected.set(message.seq, message)
    d.feed({ type: 'history_result', request, page: { messages: records, has_more: false } })
    expect(d.get().channels.A.messages).toEqual([...expected.values()].sort((a, b) => a.seq - b.seq))
    expect(d.get().channels.A.cursor).toBe(100)
  }
})

it.each(['send', 'history'] as const)('a late 401 from a stale %s request in the same session means Sign in', kind => {
  const d = boot()
  let late: Input
  if (kind === 'send') {
    const sending = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
    late = { type: 'send_failed', request: sending, status: 401 }
  } else {
    const fetch = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
    late = { type: 'history_failed', request: fetch, status: 401 }
  }
  if (kind === 'send') {
    // Clamp (C8) is the generation change that invalidates sends.
    d.feed({ type: 'unwatch', channel: 'A' })
    d.feed({ type: 'watch', channel: 'A' })
    const subscription = d.get().channels.A.subscription!.id
    d.feed({ type: 'event', connection: d.connection, subscription,
      event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 0 } })
  } else d.feed({ type: 'unwatch', channel: 'A' })
  expect(Object.values(d.get().requests).some(r => r.stale)).toBe(true)
  expect(d.feed(late)).toEqual([{ type: 'close' }, { type: 'sign_in' }])
  expect(d.get().session).toBe('sign_in_required')
})

it('a late non-401 result of a stale request is ignored and a 401 from a replaced session never signs in', () => {
  const d = boot()
  const old = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  const other = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c2', body: 'again' }), 'send')
  d.feed({ type: 'unwatch', channel: 'A' })
  expect(d.feed({ type: 'send_failed', request: old, status: 403 })).toEqual([])
  d.feed({ type: 'session_replaced', selfId: 'other' })
  expect(d.get().requests).toEqual({})
  expect(d.feed({ type: 'send_failed', request: other, status: 401 })).toEqual([])
  expect(d.get().session).toBe('signed_in')
})
