import { expect, it, vi } from 'vitest'
import { fakeNetwork, ok } from './adapter-test-helpers.svelte'
import * as api from './api'
import { accessOutcome } from './core-wasm'
import type { AccessLifetime } from './protocol-types'
import { createSession } from './session'

it('matches the previous Session REST decisions through the Wasm bridge', () => {
  const lifetimes: AccessLifetime[] = ['current', 'retired_organization', 'replaced_session']
  const failures: Extract<api.Result<unknown>, { ok: false }>[] = [
    { ok: false, kind: 'http', status: 401 },
    { ok: false, kind: 'http', status: 403, error: 'forbidden' },
    { ok: false, kind: 'http', status: 403, error: 'organization_unavailable' },
    { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' },
    { ok: false, kind: 'http', status: 404, error: 'channel not found' },
    { ok: false, kind: 'http', status: 404 },
    { ok: false, kind: 'network', error: 'organization_unavailable' },
    { ok: false, kind: 'network' },
  ]
  for (const result of failures) {
    for (const lifetime of lifetimes) {
      const previous = api.isSessionEnded(result) && lifetime !== 'replaced_session' ? 'account_ended'
        : lifetime !== 'current' ? 'ignored'
        : api.isOrganizationUnavailable(result) ? 'organization_unavailable' : 'local_outcome'
      expect(accessOutcome('organization', lifetime, api.normalizedFailure(result)), lifetime + ' ' + JSON.stringify(result)).toBe(previous)
    }
  }
})

it('matches the previous capabilities terminal predicate through the Wasm bridge', () => {
  const httpStatuses = Array.from({ length: 500 }, (_, index) => index + 100)
  for (const status of [...httpStatuses, 'network'] as const) {
    for (const error of [undefined, 'organization_unavailable', 'forbidden', 'channel not found']) {
      const result: Extract<api.Result<unknown>, { ok: false }> = status === 'network'
        ? { ok: false, kind: 'network', error }
        : { ok: false, kind: 'http', status, error }
      const previous = !result.ok && result.kind === 'http' && (api.isSessionEnded(result) || result.error === 'organization_unavailable')
      const outcome = accessOutcome('capabilities', 'current', api.normalizedFailure(result))
      expect(outcome !== 'local_outcome', JSON.stringify(result)).toBe(previous)
    }
  }
})

it.each([
  { error: 'organization_unavailable', reads: 1 },
  { error: 'rate_limited', reads: 2 },
])('makes $reads capabilities reads after a 429 with $error', async ({ error, reads }) => {
  vi.useFakeTimers()
  const getMe = vi.spyOn(api, 'getOrganizationMe').mockResolvedValue({ ok: false, kind: 'http', status: 429, error, retryAfterMs: 1_000 })
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
  try {
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    net.socket.onEvent({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(1_200)
    expect(getMe).toHaveBeenCalledTimes(reads)
  } finally {
    session.close()
    getMe.mockRestore()
    vi.useRealTimers()
  }
})

it('keeps HTTP status authoritative when the error body contains a non-string code', async () => {
  for (const [status, expected] of [[401, 'account_ended'], [404, 'local_outcome']] as const) {
    const result = await api.getOrganizationMe('org', async () => Response.json({ error: ['organization_unavailable'] }, { status }))
    if (result.ok) throw new Error('Expected an HTTP failure')
    expect(accessOutcome('organization', 'current', api.normalizedFailure(result))).toBe(expected)
  }
})
