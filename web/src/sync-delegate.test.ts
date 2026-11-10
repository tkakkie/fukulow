import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { controllerClient, record } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function bootstrap(client: ReturnType<typeof controllerClient>, open = true) {
  await client.feed({ type: 'session_start' })
  if (open) await client.feed({ type: 'connection_ready' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  return client.sync.getTimeline('A')
}

it('delegate keeps history and pending entries visible throughout reconnect before subscription confirmation', async () => {
  const client = controllerClient()
  const t = await bootstrap(client)
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1', body: 'sending' })
  const content = t.get()
  expect(content).toMatchObject({ status: 'ready', messages: [record(100)],
    pending: [{ clientMessageId: 'c1', body: 'sending', status: 'sending' }] })
  const wait = (await client.feed({ type: 'socket_closed', code: 1006 })).find(e => e.type === 'wait')!
  expect(t.get()).toEqual(content)
  await client.feed({ type: 'timer_elapsed', respond_to: wait })
  expect(t.get()).toEqual(content)
  await client.feed({ type: 'connection_ready' })
  expect(t.get()).toEqual(content)
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  expect(t.get()).toEqual(content)
  await client.sync.close()
})

it('delegate shows fetched history and acknowledged and pending sends when the socket never opens', async () => {
  const client = controllerClient()
  const t = await bootstrap(client, false)
  expect(t.get()).toMatchObject({ status: 'ready', messages: [record(100)] })
  const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
  const acknowledged = { ...record(101), sender: 'me', client_message_id: 'c1' }
  await client.feed({ type: 'ack', respond_to: send, message: acknowledged })
  await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c2', body: 'pending' })
  expect(t.get()).toMatchObject({ status: 'ready', messages: [record(100), acknowledged],
    pending: [{ clientMessageId: 'c2', body: 'pending', status: 'sending' }] })
  expect(client.allEffects.filter(e => e.type === 'subscribe')).toEqual([])
  await client.sync.close()
})

it('delegate shows cached Channel content immediately after unwatch and re-select', async () => {
  const client = controllerClient()
  const t = await bootstrap(client)
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
  await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })
  const content = t.get()
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  expect(client.sync.getTimeline('A')).toBe(t)
  expect(t.get()).toEqual(content)
  expect(t.get().status).toBe('ready')
  expect(client.allEffects.filter(e => e.type === 'fetch_history')).toHaveLength(1)
  await client.sync.close()
})

it('delegate stays loading without a bootstrap base even with an acknowledgement, then shows an empty-page base', async () => {
  const client = controllerClient()
  const t = client.sync.getTimeline('A')
  expect(t.get().status).toBe('loading')
  await client.feed({ type: 'session_start' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  expect(t.get().status).toBe('loading')
  const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
  await client.feed({ type: 'ack', respond_to: send, message: { ...record(1), sender: 'me', client_message_id: 'c1' } })
  expect(t.get().status).toBe('loading')
  await client.feed({ type: 'history_result', respond_to: history, messages: [], has_more: false })
  expect(t.get()).toMatchObject({ status: 'ready', messages: [{ seq: 1 }], pending: [] })
  await client.sync.close()
})

it.each(['channel_not_found', 'subscription_limit', 403, 404, 500] as const)(
  'delegate shows error for %s even with an established base and cached content', async refusal => {
    const client = controllerClient()
    const t = await bootstrap(client)
    expect(t.get()).toMatchObject({ status: 'ready', messages: [record(100)] })
    t.setDraft('unsent draft')
    if (typeof refusal === 'number') {
      const history = (await client.feed({ type: 'refresh', channel: 'A' })).find(e => e.type === 'fetch_history')!
      await client.feed({ type: 'history_failed', respond_to: history, status: refusal })
    } else await client.feed({ type: 'error_event', channel: 'A', code: refusal })
    expect(t.get()).toMatchObject({
      status: refusal === 500 ? 'error' : 'unavailable',
      messages: [record(100)],
      draft: 'unsent draft',
    })
    await client.sync.close()
  },
)
