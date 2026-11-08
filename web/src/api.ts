/** Returns true when the server answers the health check. */
export async function checkHealth(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/v1/health')
    return res.ok
  } catch {
    return false
  }
}

import type { components } from './api-schema'

export type Identity = components['schemas']['Identity']
export type SetupRequest = components['schemas']['SetupRequest']
export type SignInRequest = components['schemas']['SignInRequest']

/** Result of an API call. `network` covers fetch failures and 5xx (retryable, never "signed out"). */
export type Result<T> = { ok: true; data: T } | { ok: false; kind: 'http'; status: number } | { ok: false; kind: 'network' }

async function call<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit,
  parse: boolean,
): Promise<Result<T>> {
  try {
    // Cookie auth only: the HttpOnly session cookie is sent by the browser; no token is stored.
    const res = await fetchFn(path, { credentials: 'same-origin', ...init })
    if (res.status >= 500) return { ok: false, kind: 'network' }
    if (!res.ok) return { ok: false, kind: 'http', status: res.status }
    return { ok: true, data: (parse ? await res.json() : undefined) as T }
  } catch {
    return { ok: false, kind: 'network' }
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** GET /setup is no-store; also ask the browser not to reuse it. */
export const getSetupStatus = (f: typeof fetch = fetch) =>
  call<components['schemas']['SetupStatus']>(f, '/api/v1/setup', { cache: 'no-store' }, true)

export const postSetup = (body: SetupRequest, f: typeof fetch = fetch) =>
  call<unknown>(f, '/api/v1/setup', json(body), true)

export const postSession = (body: SignInRequest, f: typeof fetch = fetch) =>
  call<components['schemas']['SessionResponse']>(f, '/api/v1/session', json(body), true)

export const deleteSession = (f: typeof fetch = fetch) =>
  call<undefined>(f, '/api/v1/session', { method: 'DELETE' }, false)

export const getMe = (f: typeof fetch = fetch) => call<Identity>(f, '/api/v1/me', { cache: 'no-store' }, true)
