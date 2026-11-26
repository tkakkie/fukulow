import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeNetwork } from './adapter-test-helpers.svelte'
import type { Result } from './api'
import { createSync } from './sync'
import { controllerClient, flush, record } from './sync-test-helpers'
import { deferred } from './topic-test-helpers'
import { createTopics } from './topics'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('4003 is terminal for only its Organization, fails pending sends and starts no reconnect or retry', async () => {
  const a = controllerClient(), b = controllerClient()
  for (const client of [a, b]) {
    await client.feed({ type: 'session_start' })
    await client.feed({ type: 'connection_ready' })
    const request = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
    await client.feed({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  type: 'history_result', respond_to: request, messages: [record(100)], has_more: false })
    await client.feed({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel: 'A', caught_up_seq: 100 })
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
  expect(a.sync.timer(a.sync.get().reconnectWait ?? -1)).toBeUndefined()
  expect(a.allEffects.filter(e => e.type === 'wait')).toEqual([])
  expect(b.sync.get().connected).toBe(true)
  await a.sync.close(); await b.sync.close()
})

it.each([
  { ok: false, kind: 'network' } as const,
  { ok: false, kind: 'http', status: 503 } as const,
  { ok: false, kind: 'http', status: 403, error: 'origin_not_allowed' } as const,
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
  expect([client.sync.timer(client.sync.get().reconnectWait!)]).toEqual([{ purpose: 'reconnect_backoff' }])
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
  expect(client.sync.get()).toMatchObject({ organization: 'unavailable', running: false })
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
  expect(client.sync.get()).toMatchObject({ session: 'sign_in_required', running: false, connected: false })
  expect(client.sockets[0].closed).toBe(true)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(client.sockets).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
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

const membershipLost = { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' } as const

it.each([
  { name: '401', result: { ok: false, kind: 'http', status: 401 } as const, organization: 'available', ended: 1 },
  { name: 'Membership loss', result: membershipLost, organization: 'unavailable', ended: 0 },
])('handles late Topics $name through the default sync access reporter', async ({ result, organization, ended }) => {
  const net = fakeNetwork()
  const options = net.options()
  const onSessionEnded = vi.fn()
  const sync = createSync({ ...options.sync, selfId: 'me', onSessionEnded })
  const response = deferred<Result<never>>()
  const listTopics = vi.fn(() => response.promise)
  const requestTimeoutMs = 100
  const topics = createTopics(sync, { api: { ...options.topicsApi!, listTopics }, requestTimeoutMs })
  try {
    await sync.start()
    net.socket.onReady()
    await sync.watch('A')
    const load = topics.loadList('A')
    await vi.advanceTimersByTimeAsync(requestTimeoutMs)
    await load
    expect(listTopics).toHaveBeenCalledOnce()
    expect(sync.get()).toMatchObject({ organization: 'available', running: true })
    expect(onSessionEnded).not.toHaveBeenCalled()

    response.resolve(result)
    await flush()

    expect(sync.get()).toMatchObject({ organization, running: false, connected: false })
    expect(net.socket.closed).toBe(true)
    expect(onSessionEnded).toHaveBeenCalledTimes(ended)
  } finally {
    topics.close()
    await sync.close()
  }
})

it('applies Membership probe loss through the default Organization-unavailable reporter', async () => {
  const net = fakeNetwork()
  const checkMembership = vi.fn(async () => membershipLost)
  const sync = createSync({ ...net.options().sync, selfId: 'me', checkMembership })
  try {
    await sync.start()
    net.socket.onClose(1006)
    await flush()

    expect(checkMembership).toHaveBeenCalledOnce()
    expect(sync.get()).toMatchObject({ organization: 'unavailable', running: false, connected: false })
    expect(net.socket.closed).toBe(true)
  } finally { await sync.close() }
})

it('applies WebSocket close 4003 through the default Organization-unavailable reporter', async () => {
  const net = fakeNetwork()
  const sync = createSync({ ...net.options().sync, selfId: 'me' })
  try {
    await sync.start()
    net.socket.onReady()
    expect(sync.get()).toMatchObject({ organization: 'available', connected: true })

    net.socket.onClose(4003)
    await flush()

    expect(sync.get()).toMatchObject({ organization: 'unavailable', running: false, connected: false })
    expect(net.socket.closed).toBe(true)
  } finally { await sync.close() }
})
