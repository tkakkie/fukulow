import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runClientScenarioAsync } from '../scripts/realtime-fixtures'
import { scenarios, controllerClient } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('controller shared client fixtures with fake transport and timers', () => {
  it.each(scenarios)('$id', async scenario => {
    const client = controllerClient()
    expect(await runClientScenarioAsync(scenario, client)).toEqual([])
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('runs every client fixture through controller transports and timers', async () => {
    expect(scenarios.length).toBeGreaterThan(0)
    for (const scenario of scenarios) {
      const client = controllerClient()
      expect(await runClientScenarioAsync(scenario, client), scenario.id).toEqual([])
      await client.sync.close()
    }
  })
})

import { flush, record } from './sync-test-helpers'
import { connectRealtime, type SocketLike } from './realtime'

async function ready(client: ReturnType<typeof controllerClient>) {
  await client.feed({ type: 'session_start' })
  await client.feed({ type: 'connection_ready' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
}

it('controller resumes from the pre-ack cursor after a lost echo and replay converges to one Message', async () => {
  const client = controllerClient()
  await ready(client)
  const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1', body: 'optimistic' }))
    .find(e => e.type === 'send')!
  const message = { ...record(101), sender: 'me', client_message_id: 'c1', body: 'canonical' }
  await client.feed({ type: 'ack', respond_to: send, message })
  expect(client.sync.get().channels.A).toMatchObject({ cursor: 100, pending: [] })
  const timeline = client.sync.getTimeline('A')
  expect(timeline.get()).toMatchObject({ status: 'ready', messages: [record(100), message], pending: [] })
  const wait = (await client.feed({ type: 'socket_closed', code: 1006 })).find(e => e.type === 'wait')!
  await client.feed({ type: 'timer_elapsed', respond_to: wait })
  expect(await client.feed({ type: 'connection_ready' })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', channel: 'A', after_seq: 100 }),
  )
  await client.feed({ type: 'message', channel: 'A', message })
  await client.feed({ type: 'message', channel: 'A', message })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 101 })
  expect(client.sync.get().channels.A).toMatchObject({ state: 'ready', cursor: 101, pending: [] })
  expect(timeline.get()).toMatchObject({ status: 'ready', messages: [record(100), message], pending: [] })
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('controller ignores malformed wire events and processes later valid events on the same socket', async () => {
  const socket: SocketLike = { send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null }
  const client = controllerClient({ connect: handlers => connectRealtime(handlers, () => socket) })
  await client.sync.start()
  socket.onopen?.()
  const latest = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: latest, messages: [record(100)], has_more: true })
  const snapshot = client.sync.get()
  for (const event of [
    { type: 'message' }, { type: 'message', message: null }, { type: 'message', message: {} },
    { type: 'message', message: { ...record(101), seq: '101' } },
    { type: 'subscribed', channel_id: 'A' },
    { type: 'subscribed', channel_id: 'A', caught_up_seq: '100' },
    { type: 'error', channel_id: 'A' },
    { type: 'error', channel_id: {}, code: 'channel_not_found' },
  ]) {
    expect(() => socket.onmessage?.({ data: JSON.stringify(event) })).not.toThrow()
    await flush()
    expect(client.sync.get()).toEqual(snapshot)
  }
  expect(socket.close).not.toHaveBeenCalled()
  socket.onmessage?.({ data: JSON.stringify({ type: 'subscribed', channel_id: 'A', caught_up_seq: 100 }) })
  socket.onmessage?.({ data: JSON.stringify({ type: 'message', message: record(101) }) })
  await flush()
  expect(client.sync.get().channels.A).toMatchObject({ state: 'ready', cursor: 101, messages: [record(100), record(101)] })
  expect(client.sync.get().connected).toBe(true)
  await client.sync.close()
  expect(socket.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('controller rejects saved callbacks from closed connections and cancelled reconnect timers', async () => {
  const client = controllerClient()
  await ready(client)
  const old = client.sockets[0]
  const wait = (await client.feed({ type: 'socket_closed', code: 1006 })).find(e => e.type === 'wait')!
  await client.feed({ type: 'timer_elapsed', respond_to: wait })
  await client.feed({ type: 'connection_ready' })
  const snapshot = client.sync.get()
  old.onReady(); old.onClose(4001); old.onEvent({ type: 'message', message: record(999) })
  await client.feed({ type: 'timer_elapsed', respond_to: wait })
  expect(client.sync.get()).toEqual(snapshot)
  expect(client.sockets).toHaveLength(2)
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('controller fences prior Organization/session HTTP, socket and timer work including a 401', async () => {
  const ended = vi.fn()
  const client = controllerClient({ onSessionEnded: ended })
  await ready(client)
  const old = client.sockets[0]
  const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
  const grace = (await client.feed({ type: 'message', channel: 'A', message: record(103) })).find(e => e.type === 'wait')!
  const history = (await client.feed({ type: 'refresh', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.sync.replaceSession('new-member')
  await flush()
  expect(send.completed).toBe(false)
  expect(history.completed).toBe(false)
  old.onClose(4001); old.onReady(); old.onEvent({ type: 'message', message: record(999) })
  await client.feed({ type: 'send_failed', respond_to: send, status: 401 })
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(999)], has_more: false })
  expect(send.completed).toBe(true)
  expect(history.completed).toBe(true)
  await client.feed({ type: 'timer_elapsed', respond_to: grace })
  expect(client.sync.get().selfId).toBe('new-member')
  expect(client.sync.get().channels).toEqual({})
  expect(ended).not.toHaveBeenCalled()
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('request timeout becomes unknown and same-key retry settles; late completion cannot resurrect it', async () => {
  const client = controllerClient({ requestTimeoutMs: 1000 })
  await ready(client)
  const first = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1', body: 'hello' })).find(e => e.type === 'send')!
  await vi.advanceTimersByTimeAsync(1000)
  expect(client.sync.get().channels.A.pending[0].state).toBe('unknown')
  const retry = (await client.feed({ type: 'user_retry', client_message_id: 'c1' })).find(e => e.type === 'send')!
  expect(retry.client_message_id).toBe(first.client_message_id)
  await client.feed({ type: 'ack', respond_to: retry, message: { ...record(101), sender: 'me', client_message_id: 'c1' } })
  expect(first.completed).toBe(false)
  await client.feed({ type: 'send_failed', respond_to: first, status: 413 })
  expect(first.completed).toBe(true)
  expect(client.sync.get().channels.A.pending).toEqual([])
  expect(client.sync.get().channels.A.messages.at(-1)?.seq).toBe(101)
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([400, 403, 404, 409, 413, 415, 402, 408, 422, 429, 499, 500])(
  'only C6 definite refusals prevent delegate resend after HTTP %s', async status => {
    const client = controllerClient()
    await ready(client)
    const t = client.sync.getTimeline('A')
    const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
    await client.feed({ type: 'send_failed', respond_to: send, status })
    const retryable = ![400, 403, 404, 409, 413, 415].includes(status)
    expect(t.get().pending).toMatchObject([{ clientMessageId: 'c1', status: 'failed', retryable }])
    const effects = await client.feed({ type: 'user_retry', client_message_id: 'c1' })
    expect(effects.filter(e => e.type === 'send')).toHaveLength(retryable ? 1 : 0)
    if (retryable) expect(effects.find(e => e.type === 'send')?.client_message_id).toBe(send.client_message_id)
    await client.sync.close()
  },
)

it('scheduled grace and fill backoff execute with fake time, without overlap or tight retries', async () => {
  const client = controllerClient({ graceMs: 40, delay: n => 80 * (n + 1) })
  await ready(client)
  await client.feed({ type: 'message', channel: 'A', message: record(103) })
  const fills = () => client.allEffects.filter(e => e.type === 'fetch_history' && e.page === 'after')
  await vi.advanceTimersByTimeAsync(39)
  expect(fills()).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(fills()).toHaveLength(1)
  await client.feed({ type: 'message', channel: 'A', message: record(104) })
  await client.feed({ type: 'history_failed', respond_to: fills()[0], status: 'network' })
  await vi.advanceTimersByTimeAsync(79)
  expect(fills()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fills()).toHaveLength(2)
  await client.feed({ type: 'history_result', respond_to: fills()[1], messages: [record(101), record(102), record(103), record(104)], has_more: false })
  expect(client.sync.get().channels.A.cursor).toBe(104)
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('history timeout backs off, and shutdown cancels every protocol and request timer', async () => {
  const client = controllerClient({ requestTimeoutMs: 1000 })
  await ready(client)
  const grace = (await client.feed({ type: 'message', channel: 'A', message: record(103) })).find(e => e.type === 'wait')!
  await client.feed({ type: 'timer_elapsed', respond_to: grace })
  await vi.advanceTimersByTimeAsync(1000)
  expect(client.allEffects.some(e => e.type === 'wait' && e.purpose === 'fill_backoff')).toBe(true)
  void client.sync.getTimeline('A').send('still sending')
  await client.sync.close()
  await flush()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.sync.get().running).toBe(false)
})

it('failed connection construction uses bounded reconnect backoff', async () => {
  let attempts = 0
  const client = controllerClient({ connect: () => { attempts++; throw new Error('offline') } })
  await client.sync.start()
  expect(attempts).toBe(1)
  await vi.advanceTimersByTimeAsync(500)
  expect(attempts).toBe(2)
  await vi.advanceTimersByTimeAsync(999)
  expect(attempts).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(attempts).toBe(3)
  await client.sync.close()
})

it('async fixture runner detects incorrect observations instead of accepting an empty client', async () => {
  const scenario = structuredClone(scenarios.find(s => s.id === 'echo-before-ack')!)
  const last = scenario.steps.at(-1)!
  last.observe = { channels: { A: { pending: [{ client_message_id: 'c1', state: 'sending' }] } } }
  const client = controllerClient()
  const failures = await runClientScenarioAsync(scenario, client)
  expect(failures).toHaveLength(1)
  expect(failures[0]).toContain('pending')
  await client.sync.close()
})

it('same-connection stale subscription replies cannot confirm or refuse a later watch', async () => {
  const client = controllerClient()
  await client.feed({ type: 'session_start' })
  await client.feed({ type: 'connection_ready' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  // First subscribe is still awaiting its reply while the user changes selection twice.
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 0 })
  expect(client.sync.get().channels.A.state).toBe('loading')
  expect(client.sync.get().channels.A.cursor).toBe(100)
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(client.sync.get().channels.A.state).toBe('ready')
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  await client.feed({ type: 'error_event', channel: 'A', code: 'channel_not_found' })
  expect(client.sync.get().channels.A.state).toBe('loading')
  await vi.advanceTimersByTimeAsync(500)
  await client.feed({ type: 'connection_ready' })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(client.sync.get().channels.A.state).toBe('ready')
  await client.sync.close()
})

it('an explicit retry after a terminal refusal fetches and subscribes again through the timeline delegate', async () => {
  const client = controllerClient()
  await ready(client)
  await client.feed({ type: 'error_event', channel: 'A', code: 'channel_not_found' })
  const t = client.sync.getTimeline('A')
  expect(t.get().status).toBe('error')
  const history = (await client.feed({ type: 'refresh', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  expect(t.get().status).toBe('ready')
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(t.get().status).toBe('ready')
  await client.sync.close()
})

it('throwing control writes close the failed transport before reconnecting', async () => {
  const client = controllerClient()
  await ready(client)
  const socket = client.sockets[0]
  socket.connection.send = () => { throw new Error('send failed') }
  await client.sync.unwatch('A')
  expect(client.sync.get().connected).toBe(false)
  await vi.advanceTimersByTimeAsync(500)
  expect(socket.closed).toBe(true)
  expect(client.sockets).toHaveLength(2)
  await client.sync.close()
})

it('connection lifetime is independent of observers and an unavailable timeline does not accept a send', async () => {
  const client = controllerClient()
  await ready(client)
  const unsubscribe = client.sync.subscribe(vi.fn())
  unsubscribe()
  expect(client.sockets[0].closed).toBe(false)
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  await client.feed({ type: 'error_event', channel: 'A', code: 'subscription_limit' })
  expect(await client.sync.getTimeline('A').send('keep this text')).toBe(false)
  expect(client.allEffects.filter(e => e.type === 'send')).toEqual([])
  await client.sync.close()
  expect(client.sockets[0].closed).toBe(true)
})

it('controller async channel_not_found marks a confirmed Channel unavailable without automatic recovery', async () => {
  const client = controllerClient()
  await ready(client)
  expect(await client.feed({ type: 'error_event', channel: 'A', code: 'channel_not_found' }))
    .toContainEqual(expect.objectContaining({ type: 'unsubscribe', channel: 'A' }))
  expect(client.sync.get().channels.A.state).toBe('unavailable')
  expect(client.sync.getTimeline('A').get().status).toBe('error')
  const count = client.allEffects.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(client.allEffects).toHaveLength(count)
  expect(await client.feed({ type: 'watch', channel: 'A' })).toContainEqual(
    expect.objectContaining({ type: 'subscribe', after_seq: 100 }))
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(client.sync.get().channels.A.state).toBe('ready')
  await client.sync.close()
})

it('ambiguous async error during rewatch reconnects without attributing it to the new subscription', async () => {
  const client = controllerClient()
  await ready(client)
  const old = client.sockets[0]
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  const subscription = client.sync.get().channels.A.subscription!.id
  const effects = await client.feed({ type: 'error_event', channel: 'A', code: 'channel_not_found' })
  expect(effects).toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'reconnect_backoff' }))
  expect(client.sync.get().channels.A.state).toBe('loading')
  expect(old.closed).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  await client.feed({ type: 'connection_ready' })
  expect(client.sync.get().channels.A.subscription!.id).not.toBe(subscription)
  old.onEvent({ type: 'error', channel_id: 'A', code: 'channel_not_found' })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(client.sync.get().channels.A.state).toBe('ready')
  // A genuine refusal is terminal on the fresh connection, just like an initial subscribe refusal.
  await client.feed({ type: 'error_event', channel: 'A', code: 'channel_not_found' })
  expect(client.sync.get().channels.A.state).toBe('unavailable')
  await client.sync.close()
})

it('controller clamp preserves refusals and same-key retries while fencing old send results', async () => {
  const client = controllerClient({ requestTimeoutMs: 1000 })
  await ready(client)
  const send = async (key: string) => (await client.feed({ type: 'user_send', channel: 'A', client_message_id: key }))
    .find(e => e.type === 'send')!
  const failed = await send('failed')
  await client.feed({ type: 'send_failed', respond_to: failed, status: 413 })
  const unknown = await send('unknown')
  await client.feed({ type: 'send_failed', respond_to: unknown, status: 'network' })
  const old = await send('old')
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  const effects = await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 60 })
  const latest = effects.find(e => e.type === 'fetch_history')!
  expect(effects).toContainEqual(expect.objectContaining({ type: 'unsubscribe', channel: 'A' }))
  expect(client.sync.get().channels.A.pending.map(p => [p.clientMessageId, p.state]))
    .toEqual([['failed', 'failed'], ['unknown', 'unknown'], ['old', 'unknown']])
  expect(await client.feed({ type: 'user_retry', client_message_id: 'failed' })).toEqual([])
  const retry = (await client.feed({ type: 'user_retry', client_message_id: 'unknown' })).find(e => e.type === 'send')!
  expect(retry.client_message_id).toBe(unknown.client_message_id)
  const valid = await send('new')
  await client.feed({ type: 'ack', respond_to: old, message: { ...record(101), sender: 'me', client_message_id: 'old' } })
  expect(client.sync.get().channels.A.messages).toEqual([])
  expect(client.sync.get().channels.A.pending.find(p => p.clientMessageId === 'new')?.state).toBe('sending')
  await client.feed({ type: 'ack', respond_to: valid, message: { ...record(61), sender: 'me', client_message_id: 'new' } })
  await client.feed({ type: 'send_failed', respond_to: retry, status: 409 })
  await client.feed({ type: 'history_result', respond_to: latest, messages: [record(60)], has_more: true })
  expect(client.sync.get().channels.A.pending.map(p => [p.clientMessageId, p.state]))
    .toEqual([['failed', 'failed'], ['unknown', 'failed'], ['old', 'unknown']])
  expect(client.sync.get().channels.A.messages.map(m => m.seq)).toEqual([60, 61])
  await client.sync.close()
})

it('controller send failure and timeout during re-bootstrap preserve newer send state', async () => {
  const client = controllerClient({ requestTimeoutMs: 1000 })
  await ready(client)
  const old = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 60 })
  const retry = (await client.feed({ type: 'user_retry', client_message_id: 'c1' })).find(e => e.type === 'send')!
  await client.feed({ type: 'send_failed', respond_to: old, status: 401 })
  expect(client.sync.get().session).toBe('signed_in')
  expect(client.sync.get().channels.A.pending[0].state).toBe('sending')
  await vi.advanceTimersByTimeAsync(1000)
  expect(client.sync.get().channels.A.pending[0].state).toBe('unknown')
  const again = (await client.feed({ type: 'user_retry', client_message_id: 'c1' })).find(e => e.type === 'send')!
  await client.feed({ type: 'send_failed', respond_to: retry, status: 413 })
  expect(client.sync.get().channels.A.pending[0].state).toBe('sending')
  await client.feed({ type: 'send_failed', respond_to: again, status: 403 })
  expect(client.sync.get().channels.A.pending[0].state).toBe('failed')
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('controller repeated watch clamp unwatch stays below the 256 server subscription limit', async () => {
  const client = controllerClient()
  await ready(client)
  const active = new Set(['A'])
  const socket = client.sockets[0].connection
  const write = socket.send
  socket.send = message => {
    if (message.type === 'subscribe') active.add(message.channel_id)
    else active.delete(message.channel_id)
    expect(active.size).toBeLessThanOrEqual(256)
    write(message)
  }
  for (let n = 0; n < 257; n++) {
    const channel = `clamp-${n}`
    const latest = (await client.feed({ type: 'watch', channel })).find(e => e.type === 'fetch_history')!
    await client.feed({ type: 'history_result', respond_to: latest, messages: [record(100, channel)], has_more: false })
    expect(active.size).toBe(2)
    await client.feed({ type: 'subscribed', channel, caught_up_seq: 0 })
    await client.sync.unwatch(channel)
    expect(active).toEqual(new Set(['A']))
  }
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})
