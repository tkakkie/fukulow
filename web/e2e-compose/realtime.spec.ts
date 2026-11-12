import { expect, test, type Page, type WebSocket as ObservedWebSocket } from '@playwright/test'
import type { components, ServerEvent } from '../src/api-schema.d.ts'
import { owner, secretSafe, type SetupStatus } from './helpers.ts'

type Message = components['schemas']['Message']

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('メールアドレス', { exact: true }).fill(owner.email)
  await page.getByLabel('パスワード', { exact: true }).fill(owner.password)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
}

test('HTTPS SPA loads and WebSocket reconnects under CSP, with live delivery and sign-out', async ({ browser, baseURL }) => {
  expect(new URL(baseURL!).protocol).toBe('https:')
  const channelName = `general-${crypto.randomUUID().slice(0, 8)}`
  // Browser A and B are independent contexts (own cookies, own sessions).
  const a = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage()
  const b = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage()
  const cspErrors: string[] = []
  const sockets: ObservedWebSocket[] = []
  const signIns: Promise<unknown>[] = []
  for (const page of [a, b]) {
    page.on('console', message => { if (/content.security.policy|violates.*directive/i.test(message.text())) cspErrors.push(message.text()) })
    page.on('pageerror', error => cspErrors.push(error.message))
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/v1/session' && response.request().method() === 'POST') {
        signIns.push(response.json().then(body => {
          expect(Object.keys(body).sort()).toEqual(['expires_in', 'identity'])
          expect(response.headers()['cache-control']).toBe('no-store')
        }))
      }
    })
    await page.addInitScript(() => {
      const sockets: WebSocket[] = []
      const Original = window.WebSocket
      // Preserve the native browser constructor and network/CSP enforcement; retain only a test close hook.
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this) }
      }
      Object.assign(window, { closeTestSockets: () => sockets.forEach(socket => socket.close(4008, 'E2E reconnect')) })
    })
  }
  a.on('websocket', socket => { expect(new URL(socket.url()).protocol).toBe('wss:'); sockets.push(socket) })
  const echoes: Message[] = []
  a.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const event = JSON.parse(String(payload)) as ServerEvent
    if (event.type === 'message') echoes.push(event.message)
  }))

  // A: fresh or already set-up instance -> setup or sign-in -> channel through the product UI.
  const setupRes = await secretSafe(() => a.request.get('/api/v1/setup'))
  expect(setupRes.ok()).toBe(true)
  const { setup_required } = (await secretSafe(() => setupRes.json())) as SetupStatus

  const first = await a.goto('/')
  const headers = first!.headers()
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['content-security-policy']).toContain('wss://' + new URL(baseURL!).host)
  expect(headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/)
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname)
  expect(headers['strict-transport-security']).toBe(loopback ? undefined : 'max-age=31536000')
  expect(headers['cache-control']).toBe('no-cache')
  for (const path of ['/index.html', '/channels/general', '/favicon.svg']) {
    expect((await secretSafe(() => a.request.get(path))).headers()['cache-control']).toBe('no-cache')
  }
  const files = await a.locator('script[src], link[rel="stylesheet"]').evaluateAll(elements => elements.map(element => element.getAttribute('src') ?? element.getAttribute('href')!))
  expect(files.length).toBeGreaterThan(0)
  for (const path of files) {
    const response = await secretSafe(() => a.request.get(path, { headers: { 'Accept-Encoding': 'gzip' } }))
    expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(response.headers()['content-encoding']).toBe('gzip')
  }
  if (setup_required) {
    await a.getByLabel('組織名', { exact: true }).fill('Acme')
    await a.getByLabel('オーナーの名前', { exact: true }).fill('Alice')
    await a.getByLabel('メールアドレス', { exact: true }).fill(owner.email)
    await a.getByLabel('パスワード（12文字以上）', { exact: true }).fill(owner.password)
    if (!process.env.E2E_SETUP_TOKEN) throw new Error('Set E2E_SETUP_TOKEN for the disposable stack')
    await secretSafe(() => a.getByLabel('セットアップトークン').fill(process.env.E2E_SETUP_TOKEN!))
    await a.getByRole('button', { name: 'セットアップして開始', exact: true }).click()
  } else {
    await a.getByLabel('メールアドレス', { exact: true }).fill(owner.email)
    await a.getByLabel('パスワード', { exact: true }).fill(owner.password)
    await a.getByRole('button', { name: 'ログイン', exact: true }).click()
  }
  await expect(a.getByText('Acme / Alice さん')).toBeVisible()
  await a.getByLabel('チャンネル名', { exact: true }).fill(channelName)
  await a.getByRole('button', { name: 'チャンネルを作成', exact: true }).click()
  await expect(a.getByRole('heading', { name: channelName, exact: true })).toBeVisible()

  // B: own session, same channel; wait until its WebSocket is subscribed before A posts.
  await signIn(b)
  await b.getByRole('button', { name: `# ${channelName}`, exact: true }).click()
  await expect(b.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  await expect(a.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  const oldSocket = sockets.at(-1)!
  const count = sockets.length
  const closed = new Promise<void>(resolve => oldSocket.once('close', () => resolve()))
  await a.evaluate(() => (window as typeof window & { closeTestSockets: () => void }).closeTestSockets())
  await closed
  await expect.poll(() => sockets.length).toBeGreaterThan(count)
  await expect(a.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  const cookies = await a.context().cookies()
  const session = cookies.find(cookie => cookie.name === '__Host-fukulow_session')!
  await secretSafe(() => expect(session).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' }))
  expect(cookies.some(cookie => cookie.name === 'fukulow_session')).toBe(false)

  const historyAfterPost: string[] = []
  b.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('/messages') && r.method() === 'GET') historyAfterPost.push(r.url())
  })

  // Exceed Caddy's compression threshold to verify that API responses stay uncompressed.
  const text = `live ${Date.now()} ${'message '.repeat(128)}`
  await a.getByLabel('メッセージ').fill(text)
  const acknowledgement = a.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith('/messages') && response.request().method() === 'POST')
  await a.getByRole('button', { name: '送信' }).click()

  // No reload, no refetch trigger: only the WebSocket can deliver this.
  await expect(b.locator('.body', { hasText: text })).toHaveCount(1)
  const response = await acknowledgement
  expect(response.status()).toBe(201)
  expect(response.headers()['content-encoding']).toBeUndefined()
  const canonical = await response.json() as Message
  await expect.poll(() => echoes.filter(m => m.client_message_id === canonical.client_message_id)).toEqual([canonical])
  await expect(a.locator('li[data-status]')).toHaveCount(0)
  await expect(a.locator('.body', { hasText: text })).toHaveCount(1) // Both echo and ack have completed.
  expect(historyAfterPost).toEqual([])
  await Promise.all(signIns)
  expect(signIns).toHaveLength(2)
  await a.getByRole('button', { name: 'ログアウト' }).click()
  await expect(a.getByRole('heading', { name: 'ログイン' })).toBeVisible()
  expect((await a.context().cookies()).some(cookie => cookie.name.endsWith('fukulow_session'))).toBe(false)
  await a.reload()
  await expect(a.getByRole('heading', { name: 'ログイン' })).toBeVisible()
  expect(cspErrors).toEqual([])
  await a.context().close()
  await b.context().close()
})
