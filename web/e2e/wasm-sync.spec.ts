import { expect, test } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

function gate() {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  return { held, release }
}

// Startup can read the Channel list and one Timeline while the sync core is loading.
const startupChannelList = (url: URL, org: string) => url.pathname === `/api/v1/orgs/${org}/channels` && !url.search
const syncRead = (url: URL, org: string) => !startupChannelList(url, org) &&
  ['/channels', '/timeline', '/messages', '/unread', '/dms'].some(part => url.pathname.includes(part))

test('wasm init failure shows an error and never starts sync', async ({ page }) => {
  const org = await signInOwner(page.request)
  await createChannel(page.request, org, `failed-core-${crypto.randomUUID().slice(0, 8)}`)
  const sync: string[] = [], sockets: string[] = []
  const timelines: string[] = []
  let listed = false
  page.on('request', request => {
    const url = new URL(request.url())
    if (startupChannelList(url, org)) listed = true
    if (url.pathname.endsWith('/timeline')) timelines.push(url.pathname)
    else if (syncRead(url, org)) sync.push(url.pathname)
  })
  page.on('websocket', socket => sockets.push(socket.url()))
  const core = gate()
  await page.route('**/*.wasm', async route => { await core.held; await route.abort() })
  try {
    await page.goto(`/o/${org}`, { waitUntil: 'commit' })
    await expect.poll(() => listed).toBe(true)
    await expect.poll(() => timelines.length).toBe(1)
    core.release()
    await expect(page.getByRole('alert')).toHaveText('アプリを起動できませんでした。ページを再読み込みしてください。')
    expect(sync).toEqual([])
    expect(sockets).toEqual([])
    await expect(page.getByRole('textbox')).toHaveCount(0)
  } finally { core.release() }
})

test('a slow core delays only sync: the Organization check runs first and sync starts once after it loads', async ({ page }) => {
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `slow-core-${crypto.randomUUID().slice(0, 8)}`)
  const sent = await secretSafe(() => page.request.post(`/api/v1/orgs/${org}/channels/${channel.id}/messages`, {
    data: { client_message_id: crypto.randomUUID(), body: channel.name },
  }))
  expect(sent.status()).toBe(201)
  // Keep periodic reconciliation outside the startup observation window.
  await page.addInitScript(() => { Math.random = () => 0.5 })
  const sync: string[] = [], sockets: string[] = []
  let checked = false, lists = 0
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === `/api/v1/orgs/${org}/me`) checked = true
    if (request.method() === 'GET' && url.pathname === `/api/v1/orgs/${org}/channels` && !url.searchParams.has('archived')) lists++
    if (syncRead(url, org)) sync.push(url.pathname)
  })
  page.on('websocket', socket => sockets.push(socket.url()))
  const { release, held } = gate()
  const timeline = `/api/v1/orgs/${org}/channels/${channel.id}/timeline`
  const response = page.waitForResponse(r => new URL(r.url()).pathname === timeline, { timeout: 5_000 })
  await page.route('**/*.wasm', async route => { await held; await route.continue() })
  try {
    await page.goto(`/o/${org}/c/${channel.id}`, { waitUntil: 'commit' })
    await expect.poll(() => checked).toBe(true)
    await expect.poll(() => lists).toBe(1)
    expect((await response).status()).toBe(200)
    expect(sync).toEqual([timeline])
    expect(sockets).toEqual([])
    const duringWasm = `${channel.name} (after snapshot)`
    const committed = await secretSafe(() => page.request.post(`/api/v1/orgs/${org}/channels/${channel.id}/messages`, {
      data: { client_message_id: crypto.randomUUID(), body: duringWasm },
    }))
    expect(committed.status()).toBe(201)
    release()
    await expect(page.getByRole('article').getByText(channel.name, { exact: true })).toBeVisible()
    await expect(page.getByRole('article').getByText(duringWasm, { exact: true })).toBeVisible()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    // Allow the 200 ms activity_ready refresh to run before checking the startup total.
    await page.waitForTimeout(1_000)
    expect(sockets).toHaveLength(1)
    expect(lists).toBeLessThanOrEqual(2)
    expect(sync.filter(path => path.endsWith('/timeline'))).toEqual([timeline])
  } finally { release() }
})

for (const status of [200, 403]) test(`wasm fences an old history generation after re-selection (${status})`, async ({ page }) => {
  const org = await signInOwner(page.request)
  const a = await createChannel(page.request, org, `generation-a-${crypto.randomUUID().slice(0, 8)}`)
  const b = await createChannel(page.request, org, `generation-b-${crypto.randomUUID().slice(0, 8)}`)
  const base = `/api/v1/orgs/${org}/channels`
  for (const channel of [a, b]) {
    const response = await secretSafe(() => page.request.post(`${base}/${channel.id}/messages`, {
      data: { client_message_id: crypto.randomUUID(), body: channel.name },
    }))
    expect(response.status()).toBe(201)
  }
  const { release, held } = gate()
  let first = true, snapshotReady = false
  const core = gate()
  await page.route('**/*.wasm', async route => { await core.held; await route.continue() })
  await page.route(`**${base}/${a.id}/timeline*`, async route => {
    if (!first) return route.continue()
    first = false
    const response = await secretSafe(() => route.fetch())
    const data = await response.json() as components['schemas']['TimelinePage']
    for (const item of data.items) if (item.kind === 'message') item.message.body = 'stale generation text'
    snapshotReady = true
    await held
    await route.fulfill({ status, json: status === 200 ? data : { error: 'channel_not_found' } })
  })
  try {
    await page.goto(`/o/${org}/c/${a.id}`)
    await expect.poll(() => snapshotReady).toBe(true)
    core.release()
    await page.locator('#channel-content button').filter({ hasText: b.name }).first().click()
    await expect(page.getByRole('article').filter({ hasText: b.name })).toBeVisible()
    await page.locator('#channel-content button').filter({ hasText: a.name }).first().click()
    await expect(page.getByRole('article').filter({ hasText: a.name })).toBeVisible()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const late = page.waitForResponse(response => response.url().includes(`${a.id}/timeline`))
    release(); await late
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByRole('article').filter({ hasText: a.name })).toBeVisible()
    await expect(page.getByText('stale generation text')).toHaveCount(0)
    await expect(page.getByText('このチャンネルは利用できません。', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  } finally { release(); core.release() }
})
