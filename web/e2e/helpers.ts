import { expect, type APIRequestContext } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'

export const owner = { email: 'owner@example.com', password: 'correct horse battery' }

// Keep the API bootstrap shared with navigation tests; auth.spec.ts still tests UI setup.
export async function signInOwner(request: APIRequestContext): Promise<string> {
  const setup = await request.get('/api/v1/setup')
  expect(setup.ok()).toBe(true)
  if (((await setup.json()) as components['schemas']['SetupStatus']).setup_required) {
    const response = await request.post('/api/v1/setup', { data: {
      organization_name: 'Acme', name: 'Alice', ...owner,
      setup_token: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
    } })
    expect(response.ok()).toBe(true)
  }
  const login = await request.post('/api/v1/session', { data: owner })
  expect(login.ok()).toBe(true)
  const session = await login.json() as components['schemas']['SessionResponse']
  return session.identity.organizations[0].organization_id
}

export async function createChannel(request: APIRequestContext, org: string, name: string) {
  const data: components['schemas']['CreateChannelRequest'] = { name, visibility: 'public' }
  const response = await request.post(`/api/v1/orgs/${org}/channels`, { data })
  expect(response.status()).toBe(201)
  return await response.json() as components['schemas']['Channel']
}
