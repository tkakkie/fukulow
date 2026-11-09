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

async function ready(client: ReturnType<typeof controllerClient>) {
  await client.feed({ type: 'session_start' })
  await client.feed({ type: 'connection_ready' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
}

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
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(client.sync.get().channels.A.state).toBe('ready')
  await client.sync.close()
})

it('an explicit retry after a terminal refusal fetches and subscribes again through the timeline delegate', async () => {
  const client = controllerClient()
  await ready(client)
  await client.sync.unwatch('A')
  await client.sync.watch('A')
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
