import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type WebSocket as ObservedWebSocket } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { secretSafe } from '../e2e/helpers.ts'

export { secretSafe }

export type AcceptInviteRequest = components['schemas']['AcceptInviteRequest']
export type AccountIdentity = components['schemas']['AccountIdentity']
export type AddChannelMemberRequest = components['schemas']['AddChannelMemberRequest']
export type Channel = components['schemas']['Channel']
export type CreateChannelRequest = components['schemas']['CreateChannelRequest']
export type CreateInviteRequest = components['schemas']['CreateInviteRequest']
export type Identity = components['schemas']['Identity']
export type InviteResponse = components['schemas']['InviteResponse']
export type Message = components['schemas']['Message']
export type Role = components['schemas']['Role']
export type SendMessageRequest = components['schemas']['SendMessageRequest']
export type SetupStatus = components['schemas']['SetupStatus']

export const owner = { email: 'owner@example.com', password: 'correct horse battery' }

export function requireSetupToken(): string {
  if (!process.env.E2E_SETUP_TOKEN) throw new Error('Set E2E_SETUP_TOKEN for the disposable stack')
  return process.env.E2E_SETUP_TOKEN
}

/**
 * Ensures the single Owner setup has completed on the stack (through the product UI if still needed)
 * and signs `page` in as the Owner (`Alice` in `Acme`), returning the Organization ID.
 */
export async function ensureOwnerAndSignIn(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 800 })
  const statusRes = await secretSafe(() => page.request.get('/api/v1/setup'))
  expect(statusRes.ok()).toBe(true)
  const { setup_required } = (await secretSafe(() => statusRes.json())) as SetupStatus

  await page.goto('/')
  if (setup_required) {
    await page.getByLabel('組織名', { exact: true }).fill('Acme')
    await page.getByLabel('オーナーの名前', { exact: true }).fill('Alice')
    await page.getByLabel('メールアドレス', { exact: true }).fill(owner.email)
    await page.getByLabel('パスワード（12文字以上）', { exact: true }).fill(owner.password)
    const token = requireSetupToken()
    await secretSafe(() => page.getByLabel('セットアップトークン').fill(token))
    await page.getByRole('button', { name: 'セットアップして開始', exact: true }).click()
  } else {
    await page.getByLabel('メールアドレス', { exact: true }).fill(owner.email)
    await page.getByLabel('パスワード', { exact: true }).fill(owner.password)
    await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  }
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()

  const meRes = await secretSafe(() => page.request.get('/api/v1/me'))
  expect(meRes.ok()).toBe(true)
  const me = (await secretSafe(() => meRes.json())) as AccountIdentity
  return me.organizations[0].organization_id
}

export async function signInPage(page: Page, creds: { email: string; password: string }, expectedSummary: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.getByLabel('メールアドレス', { exact: true }).fill(creds.email)
  await page.getByLabel('パスワード', { exact: true }).fill(creds.password)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByText(expectedSummary)).toBeVisible()
}

export async function installSocketCloseHook(page: Page): Promise<ObservedWebSocket[]> {
  const sockets: ObservedWebSocket[] = []
  page.on('websocket', (socket) => {
    expect(new URL(socket.url()).protocol).toBe('wss:')
    sockets.push(socket)
  })
  await page.addInitScript(() => {
    const tracked: WebSocket[] = []
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        tracked.push(this)
      }
    }
    Object.assign(window, {
      closeTestSockets: () => tracked.forEach((socket) => socket.close(4008, 'E2E reconnect')),
    })
  })
  return sockets
}

export async function closePageSockets(page: Page, sockets: ObservedWebSocket[]): Promise<void> {
  const oldSocket = sockets.at(-1)!
  const count = sockets.length
  const closed = new Promise<void>((resolve) => oldSocket.once('close', () => resolve()))
  await page.evaluate(() => (window as typeof window & { closeTestSockets: () => void }).closeTestSockets())
  await closed
  await expect.poll(() => sockets.length).toBeGreaterThan(count)
}

export async function createChannelApi(
  request: APIRequestContext,
  orgId: string,
  name: string,
  visibility: 'public' | 'private' = 'public',
): Promise<Channel> {
  const data: CreateChannelRequest = { name, visibility }
  const res = await secretSafe(() => request.post(`/api/v1/orgs/${orgId}/channels`, { data }))
  expect(res.status()).toBe(201)
  return (await secretSafe(() => res.json())) as Channel
}

export async function sendApiMessage(
  request: APIRequestContext,
  orgId: string,
  channelId: string,
  body: Omit<SendMessageRequest, 'client_message_id'>,
): Promise<Message> {
  const data: SendMessageRequest = {
    client_message_id: crypto.randomUUID(),
    ...body,
  }
  const res = await secretSafe(() =>
    request.post(`/api/v1/orgs/${orgId}/channels/${channelId}/messages`, { data }),
  )
  expect(res.status()).toBe(201)
  return (await secretSafe(() => res.json())) as Message
}

export async function inviteAndSignInPeerViaUi(
  ownerPage: Page,
  browser: Browser,
  baseURL: string,
  role: Role,
  suffix: string,
): Promise<{
  context: BrowserContext
  page: Page
  email: string
  password: string
  name: string
  memberId: string
}> {
  const email = `peer-${role}-${suffix}@example.invalid`
  const name = `Peer-${role}-${suffix}`
  const password = `peer password ${suffix}`

  const memberDetails = ownerPage.locator('details.member-list')
  if (!(await memberDetails.evaluate((el: HTMLDetailsElement) => el.open))) {
    await memberDetails.locator('summary').click()
  }
  await memberDetails.getByLabel('メールアドレス', { exact: true }).fill(email)
  await memberDetails.getByLabel('招待するロール', { exact: true }).selectOption(role)
  const inviteResPromise = ownerPage.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/invites'),
  )
  await memberDetails.getByRole('button', { name: '招待リンクを作成', exact: true }).click()
  expect((await inviteResPromise).ok()).toBe(true)

  const linkInput = memberDetails.getByLabel('招待リンク（7日間有効・1回限り）', { exact: true })
  await expect(linkInput).toBeVisible()
  const link = await secretSafe(() => linkInput.inputValue())

  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1280, height: 800 })
  await secretSafe(() => page.goto(link))

  const invitation = page.getByRole('region', { name: '招待を受ける', exact: true })
  await invitation.getByLabel('招待先のメールアドレス', { exact: true }).fill(email)
  await invitation.getByLabel('組織での名前', { exact: true }).fill(name)
  await invitation.getByLabel('新しいアカウントのパスワード（12文字以上）', { exact: true }).fill(password)
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('招待を受けました。ログインしてください。')

  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByText(`Acme / ${name} さん`)).toBeVisible()

  const meRes = await secretSafe(() => page.request.get('/api/v1/me'))
  expect(meRes.ok()).toBe(true)
  const me = (await secretSafe(() => meRes.json())) as AccountIdentity
  const orgId = me.organizations[0].organization_id
  const orgMeRes = await secretSafe(() => page.request.get(`/api/v1/orgs/${orgId}/me`))
  expect(orgMeRes.ok()).toBe(true)
  const identity = (await secretSafe(() => orgMeRes.json())) as Identity

  return { context, page, email, password, name, memberId: identity.member.id }
}
