import { expect, it } from 'vitest'
import { initialState, step, type Effect, type Input } from './protocol-driver-test-helpers'
import { record } from './protocol-test-helpers'

function effectId(effects: Effect[], type: 'fetch_history' | 'wait' | 'send'): number {
  const effect = effects.find(effect => effect.type === type)
  if (!effect || !('id' in effect)) throw new Error(`Missing ${type} effect`)
  return effect.id
}

function boot() {
  let state = initialState('me')
  const feed = (input: Input) => {
    const result = step(state, input)
    state = result.state
    return result.effects
  }
  feed({ type: 'session_start', selfId: 'me' })
  const connection = state.connection!
  feed({ type: 'connection_ready', connection })
  const request = effectId(feed({ type: 'watch', channel: 'A' }), 'fetch_history')
  const message = record(100)
  const history_generation = message.history_generation
  feed({ type: 'history_result', request, page: { history_generation, as_of_seq: 100, messages: [message], has_more: false } })
  feed({ type: 'event', connection, event: { type: 'subscribed', channel_id: 'A', history_generation, caught_up_seq: 100 } })
  return { feed, get: () => state, connection }
}

function teardownTimers(d: ReturnType<typeof boot>): Effect[] {
  const reorder = effectId(d.feed({ type: 'event', connection: d.connection,
    event: { type: 'message', kind: 'create', seq: 102, message: record(102) },
  }), 'wait')
  const send = effectId(d.feed({ type: 'user_send', channel: 'A', clientMessageId: 'throttled', body: 'hello' }), 'send')
  const retry = effectId(d.feed({ type: 'send_failed', request: send, status: 429 }), 'wait')
  return [
    { type: 'cancel_timer', id: reorder },
    { type: 'cancel_timer', id: retry },
  ]
}

it('Session stop cancels every timer before Close and emits SignIn last when required', () => {
  for (const end of ['stop', '4001', 'history 401', 'send 401', 'stale history 401', 'stale send 401']) {
    const d = boot()
    const cancellations = teardownTimers(d)
    const history = effectId(d.feed({ type: 'watch', channel: 'B' }), 'fetch_history')
    const send = effectId(d.feed({ type: 'user_send', channel: 'B', clientMessageId: 'sending', body: 'hello' }), 'send')
    const request = end.includes('history') ? history : send
    if (end.startsWith('stale')) d.feed({ type: 'channel_unavailable', channel: 'B' })
    expect(d.get().requests[request]?.stale ?? false, end).toBe(end.startsWith('stale'))

    let input: Input
    if (end === 'stop') input = { type: 'stop' }
    else if (end === '4001') input = { type: 'socket_closed', connection: d.connection, code: 4001 }
    else if (end.includes('history')) input = { type: 'history_failed', request, status: 401 }
    else input = { type: 'send_failed', request, status: 401 }

    const expected: Effect[] = [...cancellations, { type: 'close' }]
    if (end !== 'stop') expected.push({ type: 'sign_in' })
    expect(d.feed(input), end).toEqual(expected)
    expect(d.get(), end).toMatchObject({
      running: false, connected: false, connection: null,
      session: end === 'stop' ? 'signed_in' : 'sign_in_required',
    })
    expect(d.get().channels, end).toEqual({})
    expect(d.get().requests, end).toEqual({})
    expect(d.get().timers, end).toEqual({})
  }
})

it('Organization loss cancels every timer before Close and retains unavailable Channels', () => {
  for (const input of [{ type: 'organization_unavailable' }, { type: 'socket_closed', code: 4003 }] as const) {
    const d = boot()
    const cancellations = teardownTimers(d)
    d.feed({ type: 'watch', channel: 'B' })
    d.feed({ type: 'user_send', channel: 'B', clientMessageId: 'sending', body: 'hello' })
    const end = input.type === 'socket_closed' ? { ...input, connection: d.connection } : input

    expect(d.feed(end)).toEqual([...cancellations, { type: 'close' }])
    expect(d.get()).toMatchObject({
      running: false, connected: false, connection: null, session: 'signed_in', organization: 'unavailable',
      channels: {
        A: { state: 'unavailable', messages: [record(100), record(102)], pending: [{ state: 'failed', retryWait: undefined }] },
        B: { state: 'unavailable', pending: [{ state: 'failed' }] },
      },
    })
    expect(d.get().channels.A.subscription).toBeUndefined()
    expect(d.get().requests).toEqual({})
    expect(d.get().timers).toEqual({})
  }
})
