import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

async function invite(owner: APIRequestContext, viewer: APIRequestContext, org: string, role: 'member' | 'guest') {
  const email = `early-timeline-${crypto.randomUUID()}@example.invalid`
  const password = 'early Timeline test password'
  const base = `/api/v1/orgs/${org}/invites`
  const created = await secretSafe(() => owner.post(base, { data: { email, role } }))
  expect(created.status()).toBe(201)
  const { token } = await secretSafe(() => created.json()) as components['schemas']['InviteResponse']
  const accepted = await secretSafe(() => viewer.post(`${base}/accept`, { data: { token, email, password, name: 'Timeline viewer' } }))
  expect(accepted.ok()).toBe(true)
  const identity = await secretSafe(() => accepted.json()) as components['schemas']['Identity']
  const signedIn = await secretSafe(() => viewer.post('/api/v1/session', { data: { email, password } }))
  expect(signedIn.ok()).toBe(true)
  return identity.member.id
}

async function holdWasm(page: Page) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/*.wasm', async route => { await gate; await route.continue() })
  return release
}

for (const fallback of [false, true]) for (const denial of ['private Channel non-member', 'ungranted Guest', 'DM non-participant', 'lost Organization Membership'] as const) {
  test(`the early Timeline denies ${denial} with an authorized control${fallback ? ' on fallback' : ''}`, async ({ page: ownerPage, browser, baseURL }) => {
    const owner = ownerPage.request
    const org = await signInOwner(owner)
    const context = await browser.newContext({ baseURL })
    const peer = await browser.newContext({ baseURL })
    try {
      const viewer = await invite(owner, context.request, org, denial === 'ungranted Guest' ? 'guest' : 'member')
      const base = `/api/v1/orgs/${org}`
      const name = `early-access-${crypto.randomUUID()}`
      let id: string
      if (denial === 'private Channel non-member') {
        const created = await secretSafe(() => owner.post(`${base}/channels`, { data: { name, visibility: 'private' } }))
        expect(created.status()).toBe(201)
        id = (await created.json() as components['schemas']['Channel']).id
      } else if (denial === 'DM non-participant') {
        const participant = await invite(owner, peer.request, org, 'member')
        const opened = await secretSafe(() => owner.post(`${base}/dms`, { data: { member_id: participant } }))
        expect(opened.ok()).toBe(true)
        id = (await opened.json() as components['schemas']['Dm']).id
      } else {
        id = (await createChannel(owner, org, name)).id
      }
      const history = `${base}/channels/${id}`
      const sent = await secretSafe(() => owner.post(`${history}/messages`, { data: { body: name, client_message_id: crypto.randomUUID() } }))
      expect(sent.status()).toBe(201)
      const message = await sent.json() as components['schemas']['Message']
      const viewerPage = await context.newPage()
      const releaseOwner = await holdWasm(ownerPage)
      const releaseViewer = await holdWasm(viewerPage)
      const path = `/o/${org}/c/${id}`
      const timeline = `${history}/timeline`
      const startup = `${base}/startup`
      const read = fallback ? timeline : startup
      const response = (page: Page) => page.waitForResponse(r => new URL(r.url()).pathname === read, { timeout: 5_000 })
      if (fallback) {
        for (const page of [ownerPage, viewerPage]) {
          await page.route(url => url.pathname === startup, route => route.fulfill({ status: 503, json: { error: 'unavailable' } }))
        }
      }
      try {
        const authorized = response(ownerPage)
        await ownerPage.goto(path)
        const control = await authorized
        expect(control.status()).toBe(200)
        const data = await control.json()
        expect(fallback ? data : data.timeline.page).toMatchObject({ items: [{ kind: 'message', message: { id: message.id, body: name } }] })

        const lostMembership = denial === 'lost Organization Membership'
        if (lostMembership) {
          // Commit the Membership loss after the successful Organization check, before the selected read hits the server.
          await viewerPage.route(url => url.pathname === read, async route => {
            const deactivated = await secretSafe(() => owner.post(`${base}/members/${viewer}/deactivate`))
            expect(deactivated.ok()).toBe(true)
            await route.continue()
          }, { times: 1 })
        }
        const denied = response(viewerPage)
        await viewerPage.goto(path)
        const result = await denied
        expect(result.status()).toBe(404)
        expect(await result.json()).toEqual({ error: lostMembership ? 'organization_unavailable' : 'channel not found' })
        releaseOwner(); releaseViewer()
        await expect(ownerPage.getByRole('article').filter({ hasText: name })).toBeVisible()
        await expect(viewerPage.getByText(lostMembership ? 'この組織は利用できません。' : 'このチャンネルは利用できません。', { exact: true })).toBeVisible()
        await expect(viewerPage.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0)
      } finally { releaseOwner(); releaseViewer() }
    } finally { await peer.close(); await context.close() }
  })
}
