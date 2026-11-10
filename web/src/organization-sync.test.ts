import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Result } from './api'
import { controllerClient, flush, record } from './sync-test-helpers'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('4003 is terminal for only its Organization, fails pending sends and starts no reconnect or retry', async () => {
  const a = controllerClient(), b = controllerClient()
  for (const client of [a, b]) {
    await client.feed({ type: 'session_start' })
    await client.feed({ type: 'connection_ready' })
    const request = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
    await client.feed({ type: 'history_result', respond_to: request, messages: [record(100)], has_more: false })
    await client.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 100 })
    await client.feed({ type: 'user_send', channel: 'A', client_message_id: 'pending', body: 'unsent' })
  }
  await a.feed({ type: 'socket_closed', code: 4003 })
  expect(a.sync.get()).toMatchObject({ organization: 'unavailable', connected: false, running: false,
    channels: { A: { pending: [{ state: 'failed' }] } } })
  expect(a.sync.getTimeline('A').get().pending[0].retryable).toBe(false)
  expect(b.sync.get()).toMatchObject({ organization: 'available', connected: true })
  await a.sync.getTimeline('A').retry('pending')
  await a.sync.watch('A')
  expect(await a.sync.getTimeline('A').send('again')).toBe(false)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(a.sockets).toHaveLength(1)
  expect(a.allEffects.filter(e => e.type === 'send')).toHaveLength(1)
  expect(a.sync.get().timers).toEqual({})
  expect(b.sync.get().connected).toBe(true)
  await a.sync.close(); await b.sync.close()
})

it.each([
  { ok: false, kind: 'network' } as const,
  { ok: false, kind: 'http', status: 503 } as const,
  { ok: false, kind: 'http', status: 403, error: 'origin_rejected' } as const,
  { ok: false, kind: 'http', status: 404, error: 'channel_not_found' } as const,
  { ok: true, data: {} } as const,
])('a failed handshake with REST result %j backs off without inferring Membership loss', async result => {
  const probe = vi.fn(async () => result)
  const client = controllerClient({ checkMembership: probe })
  await client.sync.start()
  client.sockets[0].onClose(1006) // No open event: actual handshake outcome is hidden from JavaScript.
  await flush()
  expect(probe).toHaveBeenCalledOnce()
  expect(client.sync.get().organization).toBe('available')
  expect(Object.values(client.sync.get().timers)).toEqual([{ purpose: 'reconnect_backoff' }])
  await vi.advanceTimersByTimeAsync(500)
  expect(client.sockets).toHaveLength(2)
  await client.sync.close()
})

it('only REST-confirmed organization_unavailable terminates a rejected handshake', async () => {
  const client = controllerClient({ checkMembership: async () =>
    ({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' }) })
  await client.sync.start()
  client.sockets[0].onClose(1006)
  await flush()
  expect(client.sync.get()).toMatchObject({ organization: 'unavailable', running: false, timers: {} })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(client.sockets).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('a pre-connect failure never assigns the terminal meaning of 4003 without REST confirmation', async () => {
  const client = controllerClient({ checkMembership: async () => ({ ok: false, kind: 'network' }) })
  await client.sync.start()
  client.sockets[0].onClose(4003)
  await flush()
  expect(client.sync.get().organization).toBe('available')
  await client.sync.close()
})

it('an ordinary 1011 close of an open socket reconnects without a Membership probe', async () => {
  const probe = vi.fn(async (): Promise<Result<unknown>> => ({ ok: false, kind: 'network' }))
  const client = controllerClient({ checkMembership: probe })
  await client.sync.start()
  client.sockets[0].onReady()
  client.sockets[0].onClose(1011)
  await flush()
  expect(probe).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  expect(client.sockets).toHaveLength(2)
  await client.sync.close()
})

it('a REST 401 after a handshake failure ends the Account Session', async () => {
  const onSessionEnded = vi.fn()
  const client = controllerClient({ onSessionEnded,
    checkMembership: async () => ({ ok: false, kind: 'http', status: 401 }) })
  await client.sync.start()
  client.sockets[0].onClose(1006)
  await flush()
  expect(onSessionEnded).toHaveBeenCalledOnce()
  await client.sync.close()
})

it('a Membership probe that never answers times out and reconnects instead of hanging or becoming terminal', async () => {
  const client = controllerClient({ requestTimeoutMs: 100,
    checkMembership: () => new Promise(() => {}) })
  await client.sync.start()
  client.sockets[0].onClose(1006)
  await vi.advanceTimersByTimeAsync(100)
  expect(client.sync.get().organization).toBe('available')
  await vi.advanceTimersByTimeAsync(500)
  expect(client.sockets).toHaveLength(2)
  await client.sync.close()
  expect(vi.getTimerCount()).toBe(0)
})
