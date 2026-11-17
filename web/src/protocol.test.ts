import { describe, expect, it } from 'vitest'
import { partitionScenarios, runClientScenario } from '../scripts/realtime-fixtures'
import { scenarios as all, protocolClient } from './protocol-test-helpers'

// Proposed fixtures (not implemented yet) and controller-only ones (the client's own Membership check) are listed as skipped.
const { running, proposed } = partitionScenarios(all)
const scenarios = running.filter(s => s.layer !== 'controller')
const controllerOnly = running.filter(s => s.layer === 'controller')
describe('pure protocol shared client fixtures', () => {
  it.each(scenarios)('$id', scenario => {
    expect(runClientScenario(scenario, protocolClient())).toEqual([])
  })
  it.skip.each(proposed.map(s => ({ ...s, owners: s.proposed!.owner.join(', ') })))('proposed: $id (owner $owners)', () => {})
  it.skip.each(controllerOnly)('controller only: $id', () => {})
  it('runs every implemented protocol-layer client fixture against the protocol', () => {
    expect(scenarios.length).toBeGreaterThan(0)
    for (const scenario of scenarios) expect(runClientScenario(scenario, protocolClient()), scenario.id).toEqual([])
  })
})

import { initialState, step, type Input, type Effect, type State } from './protocol-driver'
import { record } from './protocol-test-helpers'

it('keeps duplicate Mention arrays stable and accepts a refreshed display name', () => {
  const d = boot()
  const input = (name: string): Input => ({ type: 'event', connection: d.connection,
    event: { type: 'message', kind: 'create', seq: ({ ...record(100), mentions: [{ member_id: 'target', name }] }).created_seq, message: { ...record(100), mentions: [{ member_id: 'target', name }] } } })
  const accepted = step(d.get(), input('Original')).state
  const duplicate = step(accepted, input('Original'))
  expect(duplicate.state).toBe(accepted)
  expect(duplicate.changedChannels.size).toBe(0)
  const renamed = step(accepted, input('Renamed'))
  expect(renamed.changedChannels).toEqual(new Set(['A']))
  expect(renamed.state.channels.A.messages[0].mentions![0].name).toBe('Renamed')
})

function boot(seq = 100) {
  let state = initialState('me')
  const feed = (input: Input) => {
    if (input.type === "history_result" && state.requests[input.request]?.type === "history" && (state.requests[input.request] as { page: string }).page === "after") input = { type: "events_result", request: input.request, page: { events: input.page.messages.map(message => ({ type: "message", seq: message.created_seq, kind: "create", message })), has_more: input.page.has_more } }
    const out = step(state, input)
    state = out.state
    return out.effects
  }
  feed({ type: 'session_start', selfId: 'me' })
  const connection = state.connection!
  feed({ type: 'connection_ready', connection })
  const latest = feed({ type: 'watch', channel: 'A' }).find(e => e.type === 'fetch_history')!
  feed({ type: 'history_result', request: latest.id, page: { messages: [record(seq)], has_more: true } })
  feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: seq } })
  const event = (seq: number) => feed({ type: 'event', connection: state.connection!, event: { type: 'message', kind: 'create', seq: (record(seq)).created_seq, message: record(seq) } })
  return { feed, event, get: () => state, connection }
}
function id(effects: Effect[], type: 'fetch_history' | 'wait' | 'send' | 'connect'): number {
  const effect = effects.find(e => e.type === type)
  if (!effect || !('id' in effect)) throw new Error(`missing ${type}`)
  return effect.id
}

it('429 waits without resending early, re-arms with a new delay and preserves the entire request', () => {
  for (const target of [{}, { topic_name: 'Release' }, { reply_to: 'parent' }]) {
    const d = boot()
    const original = { channel: 'A', clientMessageId: 'c1', body: '  original\nbody  ', ...target }
    const send = id(d.feed({ type: 'user_send', ...original }), 'send')
    const waits = d.feed({ type: 'send_failed', request: send, status: 429, retryAfterMs: 2000 })
    const timer = id(waits, 'wait')
    expect(waits).toEqual([{ type: 'wait', id: timer, purpose: 'send_retry', channel: 'A', delayMs: 2000 }])
    expect(d.get().channels.A.pending[0]).toMatchObject({ clientMessageId: 'c1', body: original.body, ...target, state: 'throttled' })
    expect(d.feed({ type: 'user_retry', channel: 'A', clientMessageId: 'c1' })).toEqual([])
    d.event(101)
    const retry = d.feed({ type: 'timer_elapsed', id: timer })
    expect(retry).toEqual([{ type: 'send', id: expect.any(Number), channel: 'A', client_message_id: 'c1', body: original.body, ...target }])
    const again = d.feed({ type: 'send_failed', request: id(retry, 'send'), status: 429, retryAfterMs: 4000 })
    expect(again).toEqual([{ type: 'wait', id: expect.any(Number), purpose: 'send_retry', channel: 'A', delayMs: 4000 }])
    expect(d.feed({ type: 'timer_elapsed', id: timer })).toEqual([])
    expect(Object.keys(d.get().timers)).toHaveLength(1)
  }
})

it.each([undefined, NaN, Infinity, -1000, 0, 1, 1000.5])('429 delay %s falls back to one second', retryAfterMs => {
  const d = boot()
  const request = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  expect(d.feed({ type: 'send_failed', request, status: 429, retryAfterMs }))
    .toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'send_retry', delayMs: 1000 }))
})

it('throttled sends cancel waits on canonical settlement, discard, access loss and lifecycle changes', () => {
  for (const end of ['echo', 'history', 'projection', 'discard', 'access', 'C10', 'stop', 'replacement', 'clamp'] as const) {
    const d = boot()
    const request = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
    const timer = id(d.feed({ type: 'send_failed', request, status: 429, retryAfterMs: 3000 }), 'wait')
    const own = { ...record(99), sender: 'me', client_message_id: 'c1' }
    let effects: Effect[]
    if (end === 'echo') effects = d.feed({ type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: (own).created_seq, message: own } })
    else if (end === 'history') {
      const history = id(d.feed({ type: 'load_older', channel: 'A' }), 'fetch_history')
      effects = d.feed({ type: 'history_result', request: history, page: { messages: [own], has_more: false } })
    } else if (end === 'projection') effects = d.feed({ type: 'settle_history', channel: 'A', messages: [own] })
    else if (end === 'discard') effects = d.feed({ type: 'user_discard', channel: 'A', clientMessageId: 'c1' })
    else if (end === 'access') effects = d.feed({ type: 'channel_unavailable', channel: 'A' })
    else if (end === 'C10') effects = d.feed({ type: 'organization_unavailable' })
    else if (end === 'stop') effects = d.feed({ type: 'stop' })
    else if (end === 'replacement') effects = d.feed({ type: 'session_replaced', selfId: 'other' })
    else {
      d.feed({ type: 'unwatch', channel: 'A' }); d.feed({ type: 'watch', channel: 'A' })
      effects = d.feed({ type: 'event', connection: d.connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 60 } })
      expect(d.get().channels.A.pending[0]).toMatchObject({ clientMessageId: 'c1', state: 'unknown', retryWait: undefined })
    }
    expect(effects, end).toContainEqual({ type: 'cancel_timer', id: timer })
    expect(d.get().timers[timer], end).toBeUndefined()
    expect(d.feed({ type: 'timer_elapsed', id: timer }), end).toEqual([])
  }
})

it('settlement before a late 429 never resurrects a send or arms a timer', () => {
  const d = boot()
  const request = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hello' }), 'send')
  d.feed({ type: 'settle_history', channel: 'A', messages: [{ ...record(99), sender: 'me', client_message_id: 'c1' }] })
  expect(d.feed({ type: 'send_failed', request, status: 429, retryAfterMs: 2000 })).toEqual([])
  expect(d.get().channels.A.pending).toEqual([])
  expect(d.get().timers).toEqual({})
})

it('channel_unavailable fences history, refuses sends and retries, and recovers only on watch after reconnect', () => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'unknown' }), 'send')
  d.feed({ type: 'send_failed', request: send, status: 'network' })
  const history = id(d.feed({ type: 'load_older', channel: 'A' }), 'fetch_history')
  expect(d.feed({ type: 'channel_unavailable', channel: 'A' })).toContainEqual({ type: 'unsubscribe', channel: 'A' })
  expect(d.get().channels.A.state).toBe('unavailable')
  expect(d.get().channels.A.pending[0].state).toBe('failed')
  d.feed({ type: 'history_result', request: history, page: { messages: [record(99)], has_more: false } })
  expect(d.get().channels.A.messages).toEqual([record(100)])
  expect(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c2', body: 'refused' })).toEqual([])
  expect(d.feed({ type: 'user_retry', channel: 'A', clientMessageId: 'c1' })).toEqual([])
  const wait = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1006 }), 'wait')
  const connection = id(d.feed({ type: 'timer_elapsed', id: wait }), 'connect')
  expect(d.feed({ type: 'connection_ready', connection })).toEqual([])
  expect(d.get().channels.A.state).toBe('unavailable')
  expect(d.feed({ type: 'watch', channel: 'A' })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', channel: 'A', after_seq: 100 }),
  )
  expect(d.get().channels.A.state).toBe('loading')
  d.feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 100 } })
  expect(d.get().channels.A.state).toBe('ready')
  expect(d.feed({ type: 'user_retry', channel: 'A', clientMessageId: 'c1' })).toEqual([])
})

it('projection settlement matches Channel and sender without changing the window, cursor, evidence or effects', () => {
  const d = boot()
  d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'optimistic' })
  const before = d.get().channels.A
  const own = { ...record(102), sender: 'me', client_message_id: 'c1' }
  for (const message of [{ ...own, channel_id: 'B' }, { ...own, sender: 'other' }]) {
    expect(d.feed({ type: 'settle_history', channel: 'A', messages: [message] })).toEqual([])
    expect(d.get().channels.A).toBe(before)
  }
  expect(d.feed({ type: 'settle_history', channel: 'A', messages: [own] })).toEqual([])
  expect(d.get().channels.A).toMatchObject({ pending: [], cursor: 100 })
  expect(d.get().channels.A.messages).toBe(before.messages)
  expect(d.get().channels.A.advancing).toBe(before.advancing)
  d.event(101)
  expect(d.get().channels.A.cursor).toBe(101)
})

it('projection settlement cannot change sends for an unwatched or C9-unavailable Channel', () => {
  for (const denial of ['unwatch', 'C9'] as const) {
    const d = boot()
    d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'optimistic' })
    if (denial === 'unwatch') d.feed({ type: 'unwatch', channel: 'A' })
    else d.feed({ type: 'event', connection: d.connection,
      event: { type: 'error', channel_id: 'A', code: 'channel_not_found' } })
    const before = d.get()
    expect(d.feed({ type: 'settle_history', channel: 'A', messages: [{ ...record(99), sender: 'me', client_message_id: 'c1' }] })).toEqual([])
    expect(d.get()).toBe(before)
  }
})

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
  d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (message).created_seq, message } })
  d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (message).created_seq, message } })
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
  d.feed({ type: 'message', kind: 'create', seq: (message).created_seq, channel: 'A', message })
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
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([100, 101, 102])
  const wait = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1006 }), 'wait')
  const connection = id(d.feed({ type: 'timer_elapsed', id: wait }), 'connect')
  expect(d.feed({ type: 'connection_ready', connection })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', channel: 'A', after_seq: 101 }),
  )
  d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: ({ ...record(102), sender: 'me', client_message_id: 'c1' }).created_seq, message: { ...record(102), sender: 'me', client_message_id: 'c1' } } })
  d.feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 102 } })
  expect(d.get().channels.A.cursor).toBe(102)
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([100, 101, 102])
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
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([100, 101, 102, 103])
  expect(d.get().channels.A.messages.find(m => m.created_seq === ackSeq)).toEqual(message)
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

it('backs off longer on each 4029 rate-limit close until a subscription is confirmed', () => {
  const d = boot()
  const first = d.feed({ type: 'socket_closed', connection: d.connection, code: 4029 })
  expect(first).toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'reconnect_backoff', attempt: 0 }))
  expect(d.get().session).not.toBe('sign_in_required')
  const connection = id(d.feed({ type: 'timer_elapsed', id: id(first, 'wait') }), 'connect')
  d.feed({ type: 'connection_ready', connection })
  const second = d.feed({ type: 'socket_closed', connection, code: 4029 })
  expect(second).toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'reconnect_backoff', attempt: 1 }))
})

it('reconnects with backoff after a 1001 idle-timeout close', () => {
  const d = boot()
  const timer = id(d.feed({ type: 'socket_closed', connection: d.connection, code: 1001 }), 'wait')
  const next = id(d.feed({ type: 'timer_elapsed', id: timer }), 'connect')
  expect(next).toBeDefined()
})

it.each([4008, 4029, 1001, 1011, 1006])('defers a pending fill backoff after close %s until reconnected and resubscribed', code => {
  const d = boot()
  const grace = id(d.event(103), 'wait')
  const fill = id(d.feed({ type: 'timer_elapsed', id: grace }), 'fetch_history')
  const backoff = d.feed({ type: 'history_failed', request: fill, status: 'network' })
  expect(backoff).toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'fill_backoff' }))
  const closed = d.feed({ type: 'socket_closed', connection: d.connection, code })
  expect(closed).toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'reconnect_backoff' }))
  expect(closed.some(e => e.type === 'fetch_history' || e.type === 'connect')).toBe(false)
  expect(d.feed({ type: 'timer_elapsed', id: id(backoff, 'wait') })).toEqual([])
  expect(d.get().channels.A.fill).toBeUndefined()

  const connection = id(d.feed({ type: 'timer_elapsed', id: id(closed, 'wait') }), 'connect')
  const ready = d.feed({ type: 'connection_ready', connection })
  expect(ready).toContainEqual(expect.objectContaining({ type: 'subscribe', channel: 'A', after_seq: 100 }))
  expect(ready.some(e => e.type === 'fetch_history')).toBe(false)
  // Replay may arrive before its handoff confirmation; give it a chance to close the gap first.
  expect(d.event(104)).toEqual([])
  const resumed = d.feed({ type: 'event', connection,
    event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 104 } })
  expect(resumed).toContainEqual(expect.objectContaining({ type: 'fetch_history', channel: 'A', page: 'after', seq: 100 }))
  d.feed({ type: 'history_result', request: id(resumed, 'fetch_history'),
    page: { messages: [101, 102, 103, 104].map(seq => record(seq)), has_more: false } })
  expect(d.get().channels.A).toMatchObject({ cursor: 104, fill: undefined, wait: undefined })
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
    { type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: (record(101)).created_seq, message: record(101) } },
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
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([100, 103])
  expect(d.feed({ type: 'refresh', channel: 'A' }).some(e => e.type === 'fetch_history')).toBe(true)
})

it('pending matching requires channel and signed-in sender even for acknowledgements', () => {
  const d = boot()
  const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'optimistic' }), 'send')
  d.feed({ type: 'ack', request: send, message: { ...record(101, 'B'), sender: 'me', client_message_id: 'c1' } })
  expect(d.get().channels.A.pending).toHaveLength(1)
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([100])
  d.feed({ type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: ({ ...record(101), client_message_id: 'c1' }).created_seq, message: { ...record(101), client_message_id: 'c1' } } })
  expect(d.get().channels.A.pending).toHaveLength(1)
  d.feed({ type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: ({ ...record(102), client_message_id: 'c1', sender: 'me', body: 'canonical' }).created_seq, message: { ...record(102), client_message_id: 'c1', sender: 'me', body: 'canonical' } } })
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
  const input: Input = { type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: (record(101)).created_seq, message: record(101) } }
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
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([100])
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
  const after = step(before, { type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: (record(101)).created_seq, message: record(101) } }).state
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
    { type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: ({ ...record(100) }).created_seq, message: { ...record(100) } } },
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
  const canonical = { ...record(99), version: 200, sender: 'me', client_message_id: 'match', body: 'canonical' }
  d.feed({ type: 'history_result', request: older, page: {
    messages: [record(99), record(97), record(98), canonical, { ...record(96), client_message_id: 'other' }], has_more: false,
  } })
  expect(d.get().channels.A.messages).toEqual([{ ...record(96), client_message_id: 'other' }, record(97), record(98), canonical, old])
  expect(d.get().channels.A.messages.at(-1)).toBe(old)
  expect(d.get().channels.A.pending).toEqual(pending.slice(1))
  expect(d.get().channels.A.pending[0]).toBe(pending[1])
  expect(d.get().channels.A.cursor).toBe(100)
  // Refresh overlaps existing records and contains out-of-order versions: the highest state version wins.
  const latest = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  const changed = { ...record(100), version: 201, body: 'server replacement' }
  d.feed({ type: 'history_result', request: latest, page: {
    messages: [record(103), record(100), record(102), changed, record(101), record(103)], has_more: false,
  } })
  expect(d.get().channels.A.messages.map(m => m.created_seq)).toEqual([96, 97, 98, 99, 100, 101, 102, 103])
  expect(d.get().channels.A.messages.find(m => m.created_seq === 100)).toBe(changed)
  expect(d.get().channels.A.cursor).toBe(100)
  d.event(103); d.event(101); d.event(102)
  expect(d.get().channels.A.cursor).toBe(103)
})

it('incremental merge matches a full-window reference across deterministic overlapping pages', () => {
  const d = boot()
  const expected = new Map(d.get().channels.A.messages.map(m => [m.created_seq, m]))
  for (let batch = 0; batch < 60; batch++) {
    const records = Array.from({ length: 13 }, (_, i) => ({ ...record((batch * 17 + i * 31) % 151 + 1), version: 200 + batch * 2, body: `batch-${batch}-${i}` }))
    records.push({ ...records[3], version: 201 + batch * 2, body: 'highest version wins' }, { ...records[5] })
    const request = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
    for (const message of records) { const old = expected.get(message.created_seq); if (!old || message.version > old.version) expected.set(message.created_seq, message) }
    d.feed({ type: 'history_result', request, page: { messages: records, has_more: false } })
    expect(d.get().channels.A.messages).toEqual([...expected.values()].sort((a, b) => a.created_seq - b.created_seq))
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

it('step reports only added, modified and removed Channel IDs in changedChannels', () => {
  const d = boot()
  const added = step(d.get(), { type: 'watch', channel: 'B' })
  expect(added.changedChannels).toEqual(new Set(['B']))
  const bHistory = id(added.effects, 'fetch_history')
  let state = step(added.state, { type: 'history_result', request: bHistory, page: { messages: [record(1, 'B')], has_more: false } }).state
  state = step(state, { type: 'event', connection: d.connection, event: { type: 'subscribed', channel_id: 'B', caught_up_seq: 1 } }).state

  const noop = step(state, { type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: ({ ...record(100) }).created_seq, message: { ...record(100) } } })
  expect(noop.changedChannels).toEqual(new Set())

  const updated = step(state, { type: 'event', connection: d.connection, event: { type: 'message', kind: 'create', seq: (record(101)).created_seq, message: record(101) } })
  expect(updated.changedChannels).toEqual(new Set(['A']))

  const send = step(updated.state, { type: 'user_send', channel: 'A', clientMessageId: 'c1', body: 'hi' })
  const sendReq = id(send.effects, 'send')
  expect(step(send.state, { type: 'send_failed', request: sendReq, status: 401 }).changedChannels)
    .toEqual(new Set(['A', 'B']))
  expect(step(updated.state, { type: 'socket_closed', connection: d.connection, code: 4001 }).changedChannels)
    .toEqual(new Set(['A', 'B']))
  expect(step(updated.state, { type: 'stop' }).changedChannels).toEqual(new Set(['A', 'B']))
  expect(step(updated.state, { type: 'session_replaced', selfId: 'other' }).changedChannels)
    .toEqual(new Set(['A', 'B']))
})

it('access loss fails sending unknown and refused sends only in that Channel and leaves only discard', () => {
  const d = boot()
  for (const key of ['sending', 'unknown', 'refused']) {
    const request = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: key, body: key }), 'send')
    if (key !== 'sending') d.feed({ type: 'send_failed', request, status: key === 'unknown' ? 'network' : 400 })
  }
  d.feed({ type: 'watch', channel: 'B' })
  d.feed({ type: 'user_send', channel: 'B', clientMessageId: 'other', body: 'other' })
  const other = d.get().channels.B
  d.feed({ type: 'event', connection: d.connection, event: { type: 'channel_access_lost', channel_id: 'A' } })
  expect(d.get().channels.A.pending.map(p => [p.body, p.state])).toEqual([
    ['sending', 'failed'], ['unknown', 'failed'], ['refused', 'failed'],
  ])
  expect(d.get().channels.B).toBe(other)
  for (const key of ['sending', 'unknown', 'refused']) {
    expect(d.feed({ type: 'user_retry', channel: 'A', clientMessageId: key })).toEqual([])
    d.feed({ type: 'user_discard', channel: 'A', clientMessageId: key })
  }
  expect(d.get().channels.A.pending).toEqual([])
})

it('bounds mutation version evidence, fences retired reads and keeps tombstones after body eviction', () => {
  const d = boot()
  const stale = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  for (let start = 1; start <= 1501; start += 200) d.feed({ type: 'settle_history', channel: 'A',
    messages: Array.from({ length: Math.min(200, 1502 - start) }, (_, i) => ({ ...record(start + i), version: 10_000 + start + i,
      ...(start + i === 1 ? { deleted: true, body: undefined, mentions: undefined } : {}) })) })
  const c = d.get().channels.A
  expect(Object.keys(c.versions)).toHaveLength(1500)
  expect(c.versionEpoch).toBeGreaterThan(stale)
  const before = c.messages
  d.feed({ type: 'history_result', request: stale, page: { messages: [record(1)], has_more: false } })
  d.event(1)
  expect(d.get().channels.A.messages).toBe(before)
  expect(d.get().channels.A.cursor).toBe(100)
  const fresh = d.get().channels.A.latest!
  d.feed({ type: 'history_result', request: fresh, page: {
    messages: [{ ...record(1), version: 20_000, deleted: true }], has_more: false,
  } })
  const tombstone = d.get().channels.A.messages.find(m => m.id === 'id1')!
  expect(tombstone).toMatchObject({ version: 20_000, deleted: true })
  expect(tombstone).not.toHaveProperty('body')
  expect(tombstone).not.toHaveProperty('mentions')
  d.event(1)
  expect(d.get().channels.A.messages.find(m => m.id === 'id1')).toBe(tombstone)
  d.feed({ type: 'unwatch', channel: 'A' })
  expect(Object.keys(d.get().channels.A.versions)).toHaveLength(50)
})


it('retirement fences only covered identities and admits a never-mutated create below retired mutation versions', () => {
  const d = boot()
  for (let start = 1; start <= 1501; start += 200) d.feed({ type: 'settle_history', channel: 'A',
    messages: Array.from({ length: Math.min(200, 1502 - start) }, (_, i) => ({ ...record(1000 + start + i), version: 10_000 + start + i })) })
  const result = step(d.get(), { type: 'event', connection: d.connection,
    event: { type: 'message', seq: 101, kind: 'create', message: record(101) } })
  expect(result.state.channels.A.messages).toContainEqual(record(101))
  expect(result.records.get('A')).toContainEqual(record(101))
  expect(result.state.channels.A.cursor).toBe(101)
})

it('each evidence retirement increments its fence even when no request or timer token was allocated', () => {
  const d = boot()
  const retire = (start: number) => d.feed({ type: 'settle_history', channel: 'A', messages:
    Array.from({ length: 1501 }, (_, i) => ({ ...record(start + i), version: 10_000 + start + i })) })
  retire(1)
  const first = d.get().channels.A.versionEpoch
  retire(1502)
  const c = d.get().channels.A
  expect(c.versionEpoch).toBeGreaterThan(first)
  expect(c.retiredVersions.length).toBeLessThanOrEqual(400)
})

it('event pages emit one final accepted state per Message identity', () => {
  const d = boot()
  d.event(103)
  const request = id(d.feed({ type: 'timer_elapsed', id: d.get().channels.A.wait! }), 'fetch_history')
  const result = step(d.get(), { type: 'events_result', request, page: { has_more: false, events: [
    { type: 'message', seq: 101, kind: 'edit', message: { ...record(1), version: 101, body: 'edited' } },
    { type: 'message', seq: 102, kind: 'delete', message: { ...record(1), version: 102, deleted: true } },
  ] } })
  expect(result.state.channels.A.cursor).toBe(103)
  expect(result.records.get('A')).toHaveLength(1)
  expect(result.records.get('A')![0]).toMatchObject({ id: 'id1', version: 102, deleted: true })
  expect(result.records.get('A')![0]).not.toHaveProperty('body')
})

it('creation-ordered after history never proves event contiguity', () => {
  const d = boot()
  d.event(102)
  const request = id(d.feed({ type: 'timer_elapsed', id: d.get().channels.A.wait! }), 'fetch_history')
  const result = step(d.get(), { type: 'history_result', request, page: { messages: [record(101), record(102)], has_more: false } })
  expect(result.state.channels.A.cursor).toBe(100)
  expect(result.state.channels.A.messages).toContainEqual(record(101))
})

it('retired identity fences coalesce exactly and overflow schedules an authoritative window', () => {
  const d = boot()
  const retire = [...Array.from({ length: 401 }, (_, i) => 2 * i + 1), 4]
  const retained = Array.from({ length: 1500 }, (_, i) => 1000 + i)
  d.feed({ type: 'settle_history', channel: 'A', messages: [...retire, ...retained].map((seq, i) => ({ ...record(seq), version: 10_000 + i })) })
  expect(d.get().channels.A.retiredVersions).toHaveLength(400)
  expect(d.get().channels.A.retiredVersions.slice(0, 2)).toEqual([{ start: 1, end: 1 }, { start: 3, end: 5 }])
  const overflow = d.feed({ type: 'settle_history', channel: 'A', messages: Array.from({ length: 402 }, (_, i) => ({ ...record(3000 + 2 * i), version: 20_000 + i })) })
  expect(d.get().channels.A.retiredVersions).toEqual([])
  expect(d.get().channels.A.messages).toEqual([])
  expect(d.get().channels.A.cursor).toBe(100)
  const fresh = id(overflow, 'fetch_history')
  d.feed({ type: 'history_result', request: fresh, page: { messages: [record(2)], has_more: false } })
  expect(d.get().channels.A.messages).toContainEqual(record(2))
})

it('retiring odd creations 1 through 801 never silently loses create 2', () => {
  let state = initialState('me')
  const feed = (input: Input) => { const out = step(state, input); state = out.state; return out.effects }
  feed({ type: 'session_start', selfId: 'me' })
  const connection = state.connection!
  feed({ type: 'connection_ready', connection })
  const first = id(feed({ type: 'watch', channel: 'A' }), 'fetch_history')
  feed({ type: 'history_result', request: first, page: { messages: [], has_more: false } })
  feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', caught_up_seq: 0 } })
  const retired = Array.from({ length: 401 }, (_, i) => 2 * i + 1)
  const retained = Array.from({ length: 1500 }, (_, i) => 1000 + i)
  const effects = feed({ type: 'settle_history', channel: 'A', messages: [...retired, ...retained].map((seq, i) => ({ ...record(seq), version: 10_000 + i })) })
  let recovery = id(effects, 'fetch_history')
  expect(state.channels.A.cursor).toBe(0)
  expect(state.channels.A.messages).toEqual([])
  for (const seq of [1, 2]) feed({ type: 'event', connection, event: { type: 'message', seq, kind: 'create', message: record(seq) } })
  expect(state.channels.A.cursor).toBe(2)
  expect(state.requests[recovery]).toMatchObject({ stale: true })
  recovery = state.channels.A.latest!
  const superseded = recovery
  const reretirement = feed({ type: 'settle_history', channel: 'A', messages: [{ ...record(3000), version: 20_000 }] })
  recovery = id(reretirement, 'fetch_history')
  expect(recovery).not.toBe(superseded)
  feed({ type: 'history_result', request: superseded, page: { messages: [record(2)], has_more: false } })
  expect(state.channels.A.messages).toEqual([])
  feed({ type: 'history_result', request: recovery, page: { messages: [record(1), record(2)], has_more: false } })
  expect(state.channels.A.messages).toContainEqual(record(2))
  expect(state.channels.A.cursor).toBe(2)
  expect(state.channels.A.retiredThrough).toBeUndefined()
  expect(feed({ type: 'event', connection, event: { type: 'message', seq: 3, kind: 'create', message: record(3) } }))
    .not.toContainEqual(expect.objectContaining({ type: 'fetch_history', page: 'latest' }))
  expect(state.channels.A.messages).toContainEqual(record(3))
})

it('a rejected mutation fences an already in-flight latest snapshot and requires a replacement', () => {
  const d = boot(22_000)
  d.feed({ type: 'settle_history', channel: 'A', messages: [
    { ...record(19_000), version: 19_500 },
    ...Array.from({ length: 1500 }, (_, i) => ({ ...record(20_000 + i), version: 22_002 + i })),
  ] })
  expect(d.get().channels.A.retiredVersions).toContainEqual({ start: 19_000, end: 19_000 })
  expect(d.get().channels.A.messages.some(m => m.id === 'id19000')).toBe(false)
  const stale = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  const effects = d.feed({ type: 'event', connection: d.connection, event: {
    type: 'message', seq: 22_001, kind: 'delete', message: { ...record(19_000), version: 22_001, deleted: true },
  } })
  const fresh = id(effects, 'fetch_history')
  expect(fresh).not.toBe(stale)
  expect(d.get().requests[stale]).toMatchObject({ stale: true })
  const before = d.get().channels.A.messages
  d.feed({ type: 'history_result', request: stale, page: {
    messages: [{ ...record(19_000), version: 19_500 }, record(22_002)], has_more: false,
  } })
  expect(d.get().channels.A.messages).toBe(before)
  expect(d.get().channels.A.latest).toBe(fresh)
  expect(d.get().channels.A.cursor).toBe(22_001)
  d.feed({ type: 'history_result', request: fresh, page: {
    messages: [{ ...record(19_000), version: 22_001, deleted: true }], has_more: false,
  } })
  expect(d.get().channels.A.latest).toBeUndefined()
  expect(d.get().channels.A.messages.find(m => m.id === 'id19000')).toMatchObject({ version: 22_001, deleted: true })
  expect(d.get().channels.A.messages.find(m => m.id === 'id19000')).not.toHaveProperty('body')
})

it('an authoritative latest snapshot releases covered overflow fences for late own-send ACKs', () => {
  for (const has_more of [false, true]) {
    const d = boot()
    const send = id(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'late', body: 'late' }), 'send')
    const retired = Array.from({ length: 401 }, (_, i) => 2 * i + 1)
    const retained = Array.from({ length: 1500 }, (_, i) => 1000 + i)
    const recovery = id(d.feed({ type: 'settle_history', channel: 'A', messages:
      [...retired, ...retained].map((seq, i) => ({ ...record(seq), version: 10_000 + i })) }), 'fetch_history')
    expect(d.get().channels.A.retiredThrough).toBe(801)
    d.feed({ type: 'history_result', request: recovery, page: { messages: [record(600), record(802)], has_more } })
    expect(d.get().channels.A.retiredThrough).toBe(has_more ? 599 : undefined)
    const own = { ...record(700), sender: 'me', client_message_id: 'late', body: 'late' }
    const effects = d.feed({ type: 'ack', request: send, message: own })
    expect(d.get().channels.A.pending).toEqual([])
    expect(d.get().channels.A.messages).toContainEqual(own)
    expect(effects).not.toContainEqual(expect.objectContaining({ type: 'fetch_history', page: 'latest' }))
    const older = d.event(2)
    if (has_more) {
      expect(older).toContainEqual(expect.objectContaining({ type: 'fetch_history', page: 'latest' }))
      expect(d.get().channels.A.messages).not.toContainEqual(record(2))
    } else expect(d.get().channels.A.messages).toContainEqual(record(2))
  }
})

it('a held identity accepts version 9 after its version 5 evidence retires', () => {
  const d = boot()
  const latest = id(d.feed({ type: 'refresh', channel: 'A' }), 'fetch_history')
  d.feed({ type: 'history_result', request: latest, page: { messages: [{ ...record(1), version: 5 }], has_more: false } })
  d.feed({ type: 'settle_history', channel: 'A', messages: Array.from({ length: 1500 }, (_, i) => ({ ...record(1000 + i), version: 10_000 + i })) })
  expect(d.get().channels.A.versions.id1).toBeUndefined()
  expect(d.get().channels.A.messages.find(m => m.id === 'id1')?.version).toBe(5)
  d.feed({ type: 'event', connection: d.connection, event: { type: 'message', seq: 101, kind: 'edit', message: { ...record(1), version: 9, body: 'new' } } })
  expect(d.get().channels.A.messages.find(m => m.id === 'id1')).toMatchObject({ version: 9, body: 'new' })
  expect(d.get().channels.A.cursor).toBe(101)
})

it('drops a Create envelope whose seq differs from its created_seq', () => {
  const live = boot()
  live.feed({ type: 'event', connection: live.connection, event: { type: 'message', kind: 'create', seq: 101, message: record(105) } })
  expect(live.get().channels.A.cursor).toBe(100)
  expect(live.get().channels.A.messages.some(m => m.created_seq === 105)).toBe(false)
  const page = boot()
  page.event(103)
  const request = id(page.feed({ type: 'timer_elapsed', id: page.get().channels.A.wait! }), 'fetch_history')
  const result = step(page.get(), { type: 'events_result', request, page: { has_more: false, events: [
    { type: 'message', seq: 101, kind: 'create', message: record(102) },
    { type: 'message', seq: 102, kind: 'create', message: record(102) },
  ] } })
  expect(result.state.channels.A.cursor).toBe(100)
})
