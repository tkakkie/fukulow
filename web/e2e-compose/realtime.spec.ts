import { execFileSync } from 'node:child_process'
import { expect, test, type Page, type WebSocket as ObservedWebSocket } from '@playwright/test'
import type { components, ServerEvent } from '../src/api-schema.d.ts'
import { owner, secretSafe, ensureOwnerAndSignIn, createChannelApi, type SetupStatus } from './helpers.ts'

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
    page.on('console', message => { if (/content.security.policy|violates.*directive|permissions.policy.*(violation|violat|blocked)|violat.*permissions.policy/i.test(message.text())) cspErrors.push(message.text()) })
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
    if (event.type === 'message' && 'message' in event) {
      expect(event.kind).toBe('create')
      expect(event.seq).toBe(event.message.created_seq)
      expect(event.message.version).toBeGreaterThanOrEqual(event.message.created_seq)
      expect(event.message.deleted).toBe(false)
      expect(event.message).not.toHaveProperty('seq')
      echoes.push(event.message)
    }
  }))

  // A: fresh or already set-up instance -> setup or sign-in -> channel through the product UI.
  const setupRes = await secretSafe(() => a.request.get('/api/v1/setup'))
  expect(setupRes.ok()).toBe(true)
  const { setup_required } = (await secretSafe(() => setupRes.json())) as SetupStatus

  const first = await a.goto('/')
  const headers = first!.headers()
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(headers['content-security-policy']).toContain('wss://' + new URL(baseURL!).host)
  expect(headers['content-security-policy']).not.toMatch(/'unsafe-inline'|'unsafe-eval'/)
  expect(headers['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname)
  expect(headers['strict-transport-security']).toBe(loopback && process.env.E2E_EXTERNAL_TLS !== 'true' ? undefined : 'max-age=31536000')
  expect(headers['cache-control']).toBe('no-cache')
  for (const path of ['/index.html', '/channels/general', '/favicon.svg']) {
    expect((await secretSafe(() => a.request.get(path))).headers()['cache-control']).toBe('no-cache')
  }
  const files = await a.locator('script[src], link[rel="stylesheet"]').evaluateAll(elements => elements.map(element => element.getAttribute('src') ?? element.getAttribute('href')!))
  expect(files.length).toBeGreaterThan(0)
  for (const path of files) {
    const response = await secretSafe(() => a.request.get(path, { headers: { 'Accept-Encoding': 'br' } }))
    expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(response.headers()['content-encoding']).toBe('br')
    expect(response.headers()['vary']).toContain('Accept-Encoding')
    const identity = await secretSafe(() => a.request.get(path, { headers: { 'Accept-Encoding': 'br;q=0, gzip' } }))
    expect(identity.headers()['content-encoding']).toBeUndefined()
    expect(identity.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
  }
  const wasmAssets = await a.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.endsWith('.wasm') || /sync-wasm-.*\.js$/.test(name)))
  expect(wasmAssets.filter(name => name.endsWith('.wasm'))).toHaveLength(1)
  expect(wasmAssets.some(name => /sync-wasm-.*\.js$/.test(name))).toBe(true)
  for (const path of wasmAssets) {
    const response = await secretSafe(() => a.request.get(path))
    expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    if (path.endsWith('.wasm')) expect(response.headers()['content-type']).toBe('application/wasm')
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
  const main = a.locator('#main-content')
  await main.getByRole('textbox', { name: 'メッセージ', exact: true }).fill(text)
  const acknowledgement = a.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith('/messages') && response.request().method() === 'POST')
  await main.getByRole('button', { name: '送信', exact: true }).click()

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
  // A fresh authenticated socket resumes the log and receives the identical Message state.
  const replay = await a.evaluate(async ({ url, channel }) => new Promise<ServerEvent[]>((resolve, reject) => {
    const ws = new WebSocket(url), events: ServerEvent[] = []
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Replay handoff timed out')) }, 10_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', channel_id: channel, after_seq: 0 }))
    ws.onerror = () => { clearTimeout(timeout); ws.close(); reject(new Error('Replay socket failed')) }
    ws.onmessage = ({ data }) => {
      const event = JSON.parse(String(data)) as ServerEvent
      if (event.type === 'message' && 'message' in event) events.push(event)
      if (event.type === 'subscribed' && event.channel_id === channel) {
        clearTimeout(timeout); ws.close(); resolve(events)
      }
    }
  }), { url: sockets.at(-1)!.url(), channel: canonical.channel_id })
  expect(replay).toEqual([{ type: 'message', seq: canonical.created_seq, kind: 'create', message: canonical }])
  const orgs = await secretSafe(() => a.request.get('/api/v1/me'))
  const organization = (await orgs.json()).organizations[0].organization_id as string
  const eventPage = await secretSafe(() => a.request.get(`/api/v1/orgs/${organization}/channels/${canonical.channel_id}/events?after_seq=0&limit=1`))
  expect(eventPage.status()).toBe(200)
  expect(eventPage.headers()['cache-control']).toBe('no-store')
  expect(await eventPage.json()).toEqual({ history_generation: canonical.history_generation, events: replay, has_more: false })
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

test('history generation rotation reboots connected sync and settles a pending send exactly once', async ({ page }) => {
  const network = process.env.E2E_ROTATE_NETWORK
  const image = process.env.E2E_ROTATE_IMAGE
  expect(network).toMatch(/^fukulow-(?:security|e2e)-[a-z0-9_-]+_backend$/)
  expect(image).toBeTruthy()
  const subscriptions: Extract<ServerEvent, { type: 'subscribed' }>[] = []
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const event = JSON.parse(String(frame.payload)) as ServerEvent
      if (event.type === 'subscribed') subscriptions.push(event)
    } catch { /* Ignore non-JSON frames. */ }
  }))
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    const Original = window.WebSocket
    const state = window as unknown as { generationHeldKey?: string; reconnectForGeneration(): void }
    state.reconnectForGeneration = () => sockets.forEach(socket => socket.close())
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); sockets.push(this)
        this.addEventListener('message', event => {
          const value = JSON.parse(String(event.data)) as { type?: string; message?: { client_message_id?: string } }
          if (value.type === 'message' && value.message?.client_message_id === state.generationHeldKey) event.stopImmediatePropagation()
        })
      }
    }
  })
  const organization = await ensureOwnerAndSignIn(page)
  const channel = await createChannelApi(page.request, organization, `generation-${crypto.randomUUID().slice(0, 8)}`)
  await page.getByRole('button', { name: `# ${channel.name}`, exact: true }).click()
  await expect.poll(() => subscriptions.filter(s => s.channel_id === channel.id).length).toBeGreaterThan(0)
  const oldGeneration = subscriptions.find(s => s.channel_id === channel.id)!.history_generation
  const body = `pending-restore-${crypto.randomUUID()}`
  let key = ''
  let writes = 0
  await page.route(`**/channels/${channel.id}/messages`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    writes++
    const input = route.request().postDataJSON() as components['schemas']['SendMessageRequest']
    key = input.client_message_id
    await page.evaluate(key => { (window as unknown as { generationHeldKey: string }).generationHeldKey = key }, key)
    const committed = await route.fetch()
    expect(committed.status()).toBe(201)
    await route.abort('failed')
  })
  await page.locator('#main-content textarea').fill(body)
  await page.getByRole('button', { name: '送信', exact: true }).click()
  await expect(page.getByRole('button', { name: '再送する', exact: true })).toBeVisible()
  // Owner connection is isolated to this disposable Compose network. Runtime credentials cannot rotate.
  await secretSafe(async () => execFileSync('docker', ['run', '--rm', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--network', network!,
    '-e', 'DATABASE_URL=postgres://fukulow:compose-e2e-db-test-only@db:5432/fukulow', image!,
    'rotate-history-generation', organization], { stdio: 'pipe', timeout: 30_000 }))
  await page.evaluate(() => (window as unknown as { reconnectForGeneration(): void }).reconnectForGeneration())
  await expect.poll(() => subscriptions.some(s => s.channel_id === channel.id && s.history_generation !== oldGeneration)).toBe(true)
  await expect(page.getByRole('button', { name: '再送する', exact: true })).toHaveCount(0)
  await expect(page.locator('#main-content [data-message-id]').filter({ hasText: body })).toHaveCount(1)
  const response = await secretSafe(() => page.request.get(`/api/v1/orgs/${organization}/channels/${channel.id}/messages`))
  const history = await secretSafe(() => response.json()) as components['schemas']['MessagePage']
  expect(history.messages.filter(m => m.client_message_id === key)).toHaveLength(1)
  expect(history.history_generation).not.toBe(oldGeneration)
  expect(writes).toBe(1)
})
