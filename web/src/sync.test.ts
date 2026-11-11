import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { partitionScenarios, runClientScenarioAsync } from '../scripts/realtime-fixtures'
import { scenarios as all, controllerClient } from './sync-test-helpers'

// Proposed fixtures (not implemented yet) are validated by realtime-fixtures and listed here as skipped.
const { running: scenarios, proposed } = partitionScenarios(all)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('controller shared client fixtures with fake transport and timers', () => {
  it.each(scenarios)('$id', async scenario => {
    const client = controllerClient({}, scenario.steps.some(s => s.input.type === 'load_main_timeline' || s.input.type === 'open_topic'),
      scenario.steps.some(s => s.input.type === 'open_reply_chain'))
    expect(await runClientScenarioAsync(scenario, client)).toEqual([])
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.skip.each(proposed.map(s => ({ ...s, owners: s.proposed!.owner.join(', ') })))('proposed: $id (owner $owners)', () => {})
  it('runs every implemented client fixture through controller transports and timers', async () => {
    expect(scenarios.length).toBeGreaterThan(0)
    for (const scenario of scenarios) {
      const client = controllerClient({}, scenario.steps.some(s => s.input.type === 'load_main_timeline' || s.input.type === 'open_topic'),
        scenario.steps.some(s => s.input.type === 'open_reply_chain'))
      expect(await runClientScenarioAsync(scenario, client), scenario.id).toEqual([])
      await client.sync.close()
    }
  })
  it('fails the Membership-check fixtures for a controller that never checks after a handshake failure', async () => {
    const checks = scenarios.filter(s => s.steps.some(step => step.input.type === 'membership_check_result'))
    expect(checks.length).toBeGreaterThan(0)
    for (const scenario of checks) {
      const client = controllerClient({ checkMembership: undefined })
      expect((await runClientScenarioAsync(scenario, client)).join('\n'), scenario.id).toContain('membership_check')
      await client.sync.close()
    }
  })
})

import { flush, record } from './sync-test-helpers'
import { connectRealtime, type SocketLike } from './realtime'
import * as api from './api'

async function ready(client: ReturnType<typeof controllerClient>) {
  await client.feed({ type: 'session_start' })
  await client.feed({ type: 'connection_ready' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
}

it('reconnect full jitter stays in range and capped across repeated failures including the first 4008', async () => {
  for (const random of [0, 0.25, 0.999999]) {
    const client = controllerClient({ random: () => random })
    await ready(client)
    for (let attempt = 0; attempt < 12; attempt++) {
      const count = client.sockets.length
      const effects = await client.feed({ type: 'socket_closed', code: 4008 })
      const wait = effects.find(e => e.type === 'wait')!
      const cap = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5))
      expect(wait).toMatchObject({ purpose: 'reconnect_backoff', ms: Math.floor(random * cap) })
      expect(Number(wait.ms)).toBeGreaterThanOrEqual(0)
      expect(Number(wait.ms)).toBeLessThan(cap)
      expect(client.sockets).toHaveLength(count)
      await client.feed({ type: 'timer_elapsed', respond_to: wait })
      await client.feed({ type: 'connection_ready' })
    }
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('reconnect jitter resets only on confirmed subscription and cancels timers on terminal close or replacement', async () => {
  for (const end of ['close', 'replace', '4001', '4003']) {
    const client = controllerClient({ random: () => 0.5 })
    await ready(client)
    for (const ms of [250, 500, 1000]) {
      const wait = (await client.feed({ type: 'socket_closed', code: 1001 })).find(e => e.type === 'wait')!
      expect(wait.ms).toBe(ms)
      await client.feed({ type: 'timer_elapsed', respond_to: wait })
      await client.feed({ type: 'connection_ready' })
    }
    await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
    const wait = (await client.feed({ type: 'socket_closed', code: 1011 })).find(e => e.type === 'wait')!
    expect(wait.ms).toBe(250)
    if (end === 'close') await client.sync.close()
    else if (end === 'replace') await client.sync.replaceSession('other')
    else {
      await client.feed({ type: 'timer_elapsed', respond_to: wait })
      await client.feed({ type: 'connection_ready' })
      const effects = await client.feed({ type: 'socket_closed', code: Number(end) })
      expect(effects.some(e => e.type === 'wait' || e.type === 'connect')).toBe(false)
    }
    const count = client.sockets.length
    await client.feed({ type: 'timer_elapsed', respond_to: wait })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.sockets).toHaveLength(count)
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('injected reconnect randomness never changes deterministic fill backoff', async () => {
  const random = vi.fn(() => 0.125)
  const client = controllerClient({ random })
  await ready(client)
  const grace = (await client.feed({ type: 'message', channel: 'A', message: record(102) })).find(e => e.type === 'wait')!
  const fill = (await client.feed({ type: 'timer_elapsed', respond_to: grace })).find(e => e.type === 'fetch_history')!
  const wait = (await client.feed({ type: 'history_failed', respond_to: fill, status: 'network' })).find(e => e.type === 'wait')!
  expect(wait).toMatchObject({ purpose: 'fill_backoff', ms: 500 })
  expect(random).not.toHaveBeenCalled()
  await client.sync.close()
})

it('controller keeps admission 503 retryable and retries manually with the same key', async () => {
  const message = { ...record(101), sender: 'me', client_message_id: 'c1', body: 'hello' }
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [record(100)], has_more: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'send admission unavailable' }), {
      status: 503, headers: { 'Retry-After': '3' },
    }))
    .mockResolvedValueOnce(new Response(JSON.stringify(message), { status: 201 }))
  const client = controllerClient({ api: {
    listMessages: (channel, query) => api.listMessages('o', channel, query, fetchMock),
    sendMessage: (channel, body) => api.sendMessage('o', channel, body, fetchMock),
  } })
  await client.sync.start()
  await client.feed({ type: 'connection_ready' })
  await client.sync.watch('A')
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1', body: 'hello' })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(client.sync.get().channels.A.pending[0].state).toBe('unknown')
  expect(client.sync.getTimeline('A').get().pending[0]).toMatchObject({ clientMessageId: 'c1', retryable: true })
  await vi.advanceTimersByTimeAsync(3_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await client.sync.getTimeline('A').retry('c1')
  expect(fetchMock).toHaveBeenCalledTimes(3)
  for (const [path, init] of fetchMock.mock.calls.slice(1)) {
    expect(path).toBe('/api/v1/orgs/o/channels/A/messages')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ client_message_id: 'c1', body: 'hello' })
  }
  expect(client.sync.getTimeline('A').get().pending).toEqual([])
  expect(client.sync.getTimeline('A').get().messages).toContainEqual(message)
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

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
  const client = controllerClient({ random: () => 0.999999, connect: () => { attempts++; throw new Error('offline') } })
  await client.sync.start()
  expect(attempts).toBe(1)
  await vi.advanceTimersByTimeAsync(499)
  expect(attempts).toBe(2)
  await vi.advanceTimersByTimeAsync(998)
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
  expect(t.get().status).toBe('unavailable')
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
  expect(client.sync.getTimeline('A').get().status).toBe('unavailable')
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
  await client.feed({ type: 'send_failed', respond_to: old, status: 403 })
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

it('controller notifies only changed Channels and preserves unrelated timeline snapshots', async () => {
  const client = controllerClient()
  await ready(client)
  const history = (await client.feed({ type: 'watch', channel: 'B' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(1, 'B')], has_more: false })
  await client.feed({ type: 'subscribed', channel: 'B', caught_up_seq: 1 })
  const a = client.sync.getTimeline('A'), b = client.sync.getTimeline('B')
  const global = vi.fn(), changed = vi.fn(), unrelated = vi.fn()
  client.sync.subscribe(global)
  a.subscribe(changed)
  b.subscribe(unrelated)
  const before = client.sync.get(), snapshot = b.get()
  await client.feed({ type: 'message', channel: 'A', message: record(101) })
  expect(client.sync.get().channels.B).toBe(before.channels.B)
  expect(b.get()).toBe(snapshot)
  expect(b.get().messages).toBe(snapshot.messages)
  expect(b.get().pending).toBe(snapshot.pending)
  expect(global).toHaveBeenCalledTimes(1)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(unrelated).not.toHaveBeenCalled()
  const after = client.sync.get(), aSnapshot = a.get()
  await client.feed({ type: 'message', channel: 'A', message: { ...record(101) } })
  await client.feed({ type: 'watch', channel: 'A' })
  await client.feed({ type: 'user_retry', channel: 'A', client_message_id: 'absent' })
  await client.feed({ type: 'user_discard', channel: 'A', client_message_id: 'absent' })
  client.sockets[0].onReady()
  expect(client.sync.get()).toBe(after)
  expect(a.get()).toBe(aSnapshot)
  expect(global).toHaveBeenCalledTimes(1)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(unrelated).not.toHaveBeenCalled()
  await client.sync.close()
  expect(unrelated).toHaveBeenCalledTimes(1)
  expect(b.get().messages).toEqual([])
})

it('controller incremental history merge preserves canonical records and pending identity', async () => {
  const client = controllerClient()
  await ready(client)
  await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'match', body: 'optimistic' })
  await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'keep', body: 'keep' })
  const keep = client.sync.get().channels.A.pending[1]
  const older = (await client.feed({ type: 'load_older', channel: 'A' })).find(e => e.type === 'fetch_history')!
  const canonical = { ...record(99), sender: 'me', client_message_id: 'match', body: 'canonical' }
  await client.feed({ type: 'history_result', respond_to: older, messages: [record(99), record(97), canonical, record(98)], has_more: false })
  expect(client.sync.get().channels.A.messages).toEqual([record(97), record(98), canonical, record(100)])
  expect(client.sync.get().channels.A.pending).toEqual([keep])
  expect(client.sync.get().channels.A.pending[0]).toBe(keep)
  expect(client.sync.get().channels.A.cursor).toBe(100)
  await client.feed({ type: 'message', channel: 'A', message: record(103) })
  const grace = client.allEffects.at(-1)!
  await client.feed({ type: 'timer_elapsed', respond_to: grace })
  const fill = client.allEffects.at(-1)!
  await client.feed({ type: 'message', channel: 'A', message: record(101) })
  await client.feed({ type: 'history_result', respond_to: fill,
    messages: [record(103), record(102), record(101), record(103)], has_more: false })
  expect(client.sync.get().channels.A.cursor).toBe(103)
  expect(client.sync.get().channels.A.messages.map(m => m.seq)).toEqual([97, 98, 99, 100, 101, 102, 103])
  expect(client.sync.get().channels.A.pending[0]).toBe(keep)
  await client.sync.close()
})

it('controller: a late 401 from a pre-clamp send in the same session means Sign in', async () => {
  const client = controllerClient()
  await ready(client)
  const old = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 60 })
  await client.feed({ type: 'send_failed', respond_to: old, status: 401 })
  expect(client.sync.get().session).toBe('sign_in_required')
  await client.sync.close()
})

it('controller skips unchanged Channels during olderError bookkeeping and keeps unrelated extra state identical', async () => {
  const client = controllerClient()
  await ready(client)
  const bLatest = (await client.feed({ type: 'watch', channel: 'B' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: bLatest, messages: [record(10, 'B')], has_more: true })
  await client.feed({ type: 'subscribed', channel: 'B', caught_up_seq: 10 })
  const bOlder = (await client.feed({ type: 'load_older', channel: 'B' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_failed', respond_to: bOlder, status: 'network' })

  const cLatest = (await client.feed({ type: 'watch', channel: 'C' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: cLatest, messages: [record(1, 'C')], has_more: false })
  await client.feed({ type: 'subscribed', channel: 'C', caught_up_seq: 1 })

  const b = client.sync.getTimeline('B')
  const c = client.sync.getTimeline('C')
  b.setDraft('draft B')
  c.setDraft('draft C')
  const bChannel = client.sync.get().channels.B
  const cChannel = client.sync.get().channels.C
  const bSnapshot = b.get()
  const cSnapshot = c.get()
  expect(bSnapshot).toMatchObject({ olderError: true, draft: 'draft B' })
  expect(cSnapshot).toMatchObject({ olderError: false, draft: 'draft C' })

  let visits = 0
  for (const ch of [bChannel, cChannel]) {
    for (const key of ['older', 'hasOlder'] as const) {
      const value = ch[key]
      Object.defineProperty(ch, key, {
        configurable: true,
        enumerable: true,
        get() { visits++; return value },
      })
    }
  }

  let ownKeysCalls = 0
  let bReads = 0
  let cReads = 0
  const trackChannels = () => {
    const raw = client.sync.get().channels
    client.sync.get().channels = new Proxy(raw, {
      ownKeys(target) {
        ownKeysCalls++
        return Reflect.ownKeys(target)
      },
      get(target, prop, receiver) {
        if (prop === 'B') bReads++
        else if (prop === 'C') cReads++
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  trackChannels()
  await client.feed({ type: 'message', channel: 'A', message: record(101) })
  trackChannels()
  const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1', body: 'hi' }))
    .find(e => e.type === 'send')!
  trackChannels()
  await client.feed({ type: 'ack', respond_to: send, message: { ...record(102), sender: 'me', client_message_id: 'c1', body: 'hi' } })
  trackChannels()
  const grace = (await client.feed({ type: 'message', channel: 'A', message: record(104) })).find(e => e.type === 'wait')!
  trackChannels()
  await client.feed({ type: 'timer_elapsed', respond_to: grace })

  // Each of the 5 dispatches clones previous.channels once inside step; controller dispatch enumerates/reads 0 unchanged keys.
  expect(ownKeysCalls).toBe(5)
  expect(bReads).toBe(5)
  expect(cReads).toBe(5)
  expect(visits).toBe(0)
  expect(client.sync.get().channels.B).toBe(bChannel)
  expect(client.sync.get().channels.C).toBe(cChannel)
  expect(b.get()).toBe(bSnapshot)
  expect(c.get()).toBe(cSnapshot)

  // When a 401 on Channel A empties state.channels, unrelated Channel B removed from previous.channels still clears olderError.
  const send2 = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c2', body: 'bye' }))
    .find(e => e.type === 'send')!
  await client.feed({ type: 'send_failed', respond_to: send2, status: 401 })
  expect(b.get()).toMatchObject({ olderError: false, draft: 'draft B' })
  await client.sync.close()
})

it('controller clears olderError in the same dispatch when a non-stale before fetch fails while unwatched', async () => {
  const client = controllerClient()
  await ready(client)
  const bLatest = (await client.feed({ type: 'watch', channel: 'B' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: bLatest, messages: [record(1, 'B')], has_more: false })
  await client.feed({ type: 'subscribed', channel: 'B', caught_up_seq: 1 })

  const a = client.sync.getTimeline('A')
  const b = client.sync.getTimeline('B')
  const observed: { loadingOlder: boolean; olderError: boolean }[] = []
  const aListener = vi.fn(() => {
    const s = a.get()
    observed.push({ loadingOlder: s.loadingOlder, olderError: s.olderError })
  })
  const bListener = vi.fn()
  a.subscribe(aListener)
  b.subscribe(bListener)

  await client.feed({ type: 'unwatch', channel: 'A' })
  const older = (await client.feed({ type: 'load_older', channel: 'A' }))
    .find(e => e.type === 'fetch_history' && e.page === 'before')!
  expect(a.get()).toMatchObject({ loadingOlder: true, olderError: false })

  await client.feed({ type: 'history_failed', respond_to: older, status: 'network' })
  expect(a.get()).toMatchObject({ status: 'ready', hasOlder: true, loadingOlder: false, olderError: false })
  expect(aListener).toHaveBeenCalledTimes(3)
  expect(observed).toEqual([
    { loadingOlder: false, olderError: false },
    { loadingOlder: true, olderError: false },
    { loadingOlder: false, olderError: false },
  ])
  expect(bListener).not.toHaveBeenCalled()
  await client.sync.close()
})

it('controller clears olderError in the same dispatch when a non-stale before fetch fails after refresh sets hasOlder false', async () => {
  const client = controllerClient()
  await ready(client)
  const bLatest = (await client.feed({ type: 'watch', channel: 'B' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: bLatest, messages: [record(1, 'B')], has_more: false })
  await client.feed({ type: 'subscribed', channel: 'B', caught_up_seq: 1 })

  const a = client.sync.getTimeline('A')
  const b = client.sync.getTimeline('B')
  const observed: { hasOlder: boolean; loadingOlder: boolean; olderError: boolean }[] = []
  const aListener = vi.fn(() => {
    const s = a.get()
    observed.push({ hasOlder: s.hasOlder, loadingOlder: s.loadingOlder, olderError: s.olderError })
  })
  const bListener = vi.fn()
  a.subscribe(aListener)
  b.subscribe(bListener)

  const older = (await client.feed({ type: 'load_older', channel: 'A' }))
    .find(e => e.type === 'fetch_history' && e.page === 'before')!
  const latest = (await client.feed({ type: 'refresh', channel: 'A' }))
    .find(e => e.type === 'fetch_history' && e.page === 'latest')!
  await client.feed({ type: 'history_result', respond_to: latest, messages: [record(100)], has_more: false })
  expect(a.get()).toMatchObject({ hasOlder: false, loadingOlder: true, olderError: false })

  await client.feed({ type: 'history_failed', respond_to: older, status: 'network' })
  expect(a.get()).toMatchObject({ status: 'ready', hasOlder: false, loadingOlder: false, olderError: false })
  expect(aListener).toHaveBeenCalledTimes(4)
  expect(observed).toEqual([
    { hasOlder: true, loadingOlder: true, olderError: false },
    { hasOlder: true, loadingOlder: true, olderError: false },
    { hasOlder: false, loadingOlder: true, olderError: false },
    { hasOlder: false, loadingOlder: false, olderError: false },
  ])
  expect(bListener).not.toHaveBeenCalled()
  await client.sync.close()
})

it('ambiguous access-loss events during pending subscribe or rewatch reconnect with backoff', async () => {
  for (const phase of ['pending', 'rewatch']) {
    const client = controllerClient()
    if (phase === 'rewatch') { await ready(client); await client.sync.unwatch('A'); await client.sync.watch('A') }
    else {
      await client.feed({ type: 'session_start' }); await client.feed({ type: 'connection_ready' })
      const first = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
      await client.feed({ type: 'history_result', respond_to: first, messages: [record(100)], has_more: false })
    }
    const old = client.sockets[0]
    const effects = await client.feed({ type: 'channel_access_lost', channel: 'A' })
    expect(effects).toContainEqual(expect.objectContaining({ type: 'wait', purpose: 'reconnect_backoff' }))
    expect(old.closed).toBe(true); expect(client.sync.get().channels.A.state).not.toBe('unavailable')
    await client.sync.close()
  }
})

it('ignores access loss after unwatch without reconnecting', async () => {
  for (const phase of ['confirmed', 'pending']) {
    const client = controllerClient()
    try {
      await ready(client)
      const bLatest = (await client.feed({ type: 'watch', channel: 'B' })).find(e => e.type === 'fetch_history')!
      await client.feed({ type: 'history_result', respond_to: bLatest, messages: [record(1, 'B')], has_more: false })
      await client.feed({ type: 'subscribed', channel: 'B', caught_up_seq: 1 })
      await client.sync.unwatch('A')
      if (phase === 'pending') {
        await client.sync.watch('A')
        await client.sync.unwatch('A')
      }
      const socket = client.sockets[0]
      const before = client.sync.get()
      expect(before.channels.A).toMatchObject({ watched: false, subscription: undefined })

      expect(await client.feed({ type: 'channel_access_lost', channel: 'A' })).toEqual([])
      expect(client.sync.get()).toBe(before)
      expect(socket.closed).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(client.sockets).toHaveLength(1)
      await client.feed({ type: 'message', channel: 'B', message: record(2, 'B') })
      expect(client.sync.get().channels.B).toMatchObject({ state: 'ready', cursor: 2 })
    } finally {
      await client.sync.close()
    }
  }
})
