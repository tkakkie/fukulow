import { expect, type APIRequestContext } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'

export const owner = { email: 'owner@example.com', password: 'correct horse battery' }

// Password literals in these public fixtures are not secrets. Generated Invite /
// Session tokens and E2E_SETUP_TOKEN are secrets, including in failure call logs.
export async function secretSafe<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation() }
  catch { throw new Error('Credential-bearing operation failed (details omitted)') }
}

// Keep the API bootstrap shared with navigation tests; auth.spec.ts still tests UI setup.
export async function signInOwner(request: APIRequestContext): Promise<string> {
  const setup = await secretSafe(() => request.get('/api/v1/setup'))
  expect(setup.ok()).toBe(true)
  if (((await secretSafe(() => setup.json())) as components['schemas']['SetupStatus']).setup_required) {
    const response = await secretSafe(() => request.post('/api/v1/setup', { data: {
      organization_name: 'Acme', name: 'Alice', ...owner,
      setup_token: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
    } }))
    expect(response.ok()).toBe(true)
  }
  const login = await secretSafe(() => request.post('/api/v1/session', { data: owner }))
  expect(login.ok()).toBe(true)
  const session = await secretSafe(() => login.json()) as components['schemas']['SessionResponse']
  return session.identity.organizations[0].organization_id
}

export async function createChannel(request: APIRequestContext, org: string, name: string) {
  const data: components['schemas']['CreateChannelRequest'] = { name, visibility: 'public' }
  const response = await secretSafe(() => request.post(`/api/v1/orgs/${org}/channels`, { data }))
  expect(response.status()).toBe(201)
  return await secretSafe(() => response.json()) as components['schemas']['Channel']
}
