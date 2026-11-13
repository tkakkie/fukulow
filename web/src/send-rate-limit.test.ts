import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from './api'
import { controllerClient, flush, record } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function ready(client: ReturnType<typeof controllerClient>) {
  await client.feed({ type: 'session_start' })
  await client.feed({ type: 'connection_ready' })
  const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [record(100)], has_more: true })
  await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
}

it('429 retries the full request after each header delay without an early send', async () => {
  for (const target of [{}, { topic_name: 'Release' }, { reply_to: 'parent' }]) {
    const message = { ...record(101), sender: 'me', client_message_id: 'c1', body: '  original\nbody  ' }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [record(100)], has_more: true })))
      .mockResolvedValueOnce(new Response('{"error":"send_rate_limited"}', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('{"error":"send_rate_limited"}', { status: 429, headers: { 'Retry-After': '4' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(message), { status: 201 }))
    const client = controllerClient({ newId: () => 'c1', api: {
      listMessages: (channel, query) => api.listMessages('o', channel, query, fetcher),
      sendMessage: (channel, body) => api.sendMessage('o', channel, body, fetcher),
    } })
    await client.sync.start()
    await client.feed({ type: 'connection_ready' })
    await client.sync.watch('A')
    await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
    const timeline = client.sync.getTimeline('A')
    await timeline.send(message.body, target)
    expect(timeline.get().pending[0]).toMatchObject({ status: 'throttled', body: message.body })
    await timeline.retry('c1')
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(timeline.get().pending[0].status).toBe('throttled')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(3999)
    expect(fetcher).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(4)
    for (const [url, init] of fetcher.mock.calls.slice(1)) {
      expect(url).toBe('/api/v1/orgs/o/channels/A/messages')
      expect(JSON.parse(init!.body as string)).toEqual({ client_message_id: 'c1', body: message.body, ...target })
    }
    expect(timeline.get().pending).toEqual([])
    expect(timeline.get().messages).toContainEqual(message)
    expect(vi.getTimerCount()).toBe(0)
    await client.sync.close()
  }
})

it('controller uses one second for invalid 429 delays', async () => {
  for (const retry_after_ms of [undefined, NaN, Infinity, -1, 0, 500, 1000.5]) {
    const client = controllerClient()
    await ready(client)
    const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
    await client.feed({ type: 'send_failed', respond_to: send, status: 429, retry_after_ms })
    await vi.advanceTimersByTimeAsync(999)
    expect(client.allEffects.filter(e => e.type === 'send')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.allEffects.filter(e => e.type === 'send')).toHaveLength(2)
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('controller cancels throttled retry on settlement, discard, denial, lifecycle change and clamp', async () => {
  for (const end of ['echo', 'latest', 'older', 'projection', 'discard', 'channel loss', 'history 403', 'history 404',
    '4003', 'C10', 'close', 'session replacement', '4001', '401', 'clamp'] as const) {
    const client = controllerClient()
    await ready(client)
    const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
    const effects = await client.feed({ type: 'send_failed', respond_to: send, status: 429, retry_after_ms: 3000 })
    const wait = effects.find(e => e.type === 'wait')!
    const own = { ...record(99), sender: 'me', client_message_id: 'c1' }
    const t = client.sync.getTimeline('A')
    if (end === 'echo') await client.feed({ type: 'message', channel: 'A', message: own })
    else if (end === 'projection') await client.sync.settleHistory('A', [own])
    else if (end === 'latest' || end === 'older' || end === 'history 403' || end === 'history 404') {
      const history = (await client.feed({ type: end === 'older' ? 'load_older' : 'refresh', channel: 'A' }))
        .find(e => e.type === 'fetch_history')!
      if (end === 'latest' || end === 'older') await client.feed({ type: 'history_result', respond_to: history, messages: [own], has_more: false })
      else await client.feed({ type: 'history_failed', respond_to: history, status: end === 'history 403' ? 403 : 404 })
    } else if (end === 'discard') t.discard('c1')
    else if (end === 'channel loss') await client.feed({ type: 'channel_access_lost', channel: 'A' })
    else if (end === '4003' || end === '4001') await client.feed({ type: 'socket_closed', code: end === '4003' ? 4003 : 4001 })
    else if (end === 'C10') await client.sync.unavailable()
    else if (end === 'close') await client.sync.close()
    else if (end === 'session replacement') await client.sync.replaceSession('other')
    else if (end === '401') {
      const history = (await client.feed({ type: 'refresh', channel: 'A' })).find(e => e.type === 'fetch_history')!
      await client.feed({ type: 'history_failed', respond_to: history, status: 401 })
    } else {
      await client.sync.unwatch('A'); await client.sync.watch('A')
      const clamped = await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 60 })
      expect(t.get().pending[0]).toMatchObject({ clientMessageId: 'c1', status: 'failed', retryable: true })
      const bootstrap = clamped.find(e => e.type === 'fetch_history')!
      await client.feed({ type: 'history_result', respond_to: bootstrap, messages: [record(60)], has_more: false })
    }
    await flush()
    expect(Object.values(client.sync.get().timers).filter(t => t.purpose === 'send_retry')).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    const savedCallback = wait.fn as () => void
    savedCallback()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.allEffects.filter(e => e.type === 'send')).toHaveLength(1)
    if (end === 'clamp') {
      void t.retry('c1')
      await flush()
      const retry = client.allEffects.filter(e => e.type === 'send').at(-1)!
      expect(retry).toMatchObject({ client_message_id: 'c1', body: 'hello' })
    }
    await client.sync.close()
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('clamp fences old 429 while new bootstrap sends may wait and retry', async () => {
  const client = controllerClient()
  await ready(client)
  const old = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'old' })).find(e => e.type === 'send')!
  await client.sync.unwatch('A')
  await client.sync.watch('A')
  const clamped = await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 60 })
  expect(client.sync.get().channels.A.pending[0].state).toBe('unknown')
  const fresh = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'new', body: 'new body' }))
    .find(e => e.type === 'send')!
  await client.feed({ type: 'send_failed', respond_to: fresh, status: 429, retry_after_ms: 2000 })
  const before = client.sync.get()
  await client.feed({ type: 'send_failed', respond_to: old, status: 429, retry_after_ms: 1000 })
  expect(client.sync.get().channels).toBe(before.channels)
  expect(client.sync.get().timers).toBe(before.timers)
  await vi.advanceTimersByTimeAsync(1999)
  expect(client.allEffects.filter(e => e.type === 'send')).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  const retry = client.allEffects.filter(e => e.type === 'send').at(-1)!
  expect(retry).toMatchObject({ client_message_id: 'new', body: 'new body' })
  await client.feed({ type: 'ack', respond_to: retry, message: { ...record(61), sender: 'me', client_message_id: 'new' } })
  await client.feed({ type: 'history_result', respond_to: clamped.find(e => e.type === 'fetch_history'), messages: [record(60)], has_more: false })
  expect(client.sync.get().channels.A.pending).toMatchObject([{ clientMessageId: 'old', state: 'unknown' }])
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('controller keeps other Channel waits active on C9 and ignores late 429 after settlement', async () => {
  const client = controllerClient()
  await ready(client)
  const history = (await client.feed({ type: 'watch', channel: 'B' })).find(e => e.type === 'fetch_history')!
  await client.feed({ type: 'history_result', respond_to: history, messages: [], has_more: false })
  await client.feed({ type: 'subscribed', channel: 'B', caught_up_seq: 0 })
  for (const channel of ['A', 'B']) {
    const send = (await client.feed({ type: 'user_send', channel, client_message_id: channel })).find(e => e.type === 'send')!
    await client.feed({ type: 'send_failed', respond_to: send, status: 429, retry_after_ms: 2000 })
  }
  await client.feed({ type: 'channel_access_lost', channel: 'A' })
  await vi.advanceTimersByTimeAsync(2000)
  const sends = client.allEffects.filter(e => e.type === 'send')
  expect(sends.map(e => e.channel)).toEqual(['A', 'B', 'B'])
  await client.sync.settleHistory('B', [{ ...record(1, 'B'), sender: 'me', client_message_id: 'B' }])
  await client.feed({ type: 'send_failed', respond_to: sends.at(-1), status: 429, retry_after_ms: 5000 })
  expect(client.sync.getTimeline('B').get().pending).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  await client.sync.close()
})

it('long 429 waits cannot overflow the browser timer into an early retry and remain cancellable', async () => {
  const client = controllerClient()
  await ready(client)
  const send = (await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'c1' })).find(e => e.type === 'send')!
  const delay = 2_147_484_000
  const waits = await client.feed({ type: 'send_failed', respond_to: send, status: 429, retry_after_ms: delay })
  expect(waits.find(e => e.type === 'wait')?.ms).toBe(2_147_483_647)
  await vi.advanceTimersByTimeAsync(delay - 1)
  expect(client.allEffects.filter(e => e.type === 'send')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(1)
  client.sync.getTimeline('A').discard('c1')
  await vi.advanceTimersByTimeAsync(1)
  expect(client.allEffects.filter(e => e.type === 'send')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
  await client.sync.close()
})
