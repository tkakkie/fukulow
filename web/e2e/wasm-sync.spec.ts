import { expect, test } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

// #466: the shell and the Organization check (C10) no longer wait for the core; sync never starts without it.
const syncPath = (path: string) => ['/channels', '/timeline', '/messages', '/unread', '/dms'].some(part => path.includes(part))
test('wasm init failure shows an error and never starts sync', async ({ page }) => {
  const org = await signInOwner(page.request)
  const sync: string[] = [], sockets: string[] = []
  page.on('request', request => { const path = new URL(request.url()).pathname; if (syncPath(path)) sync.push(path) })
  page.on('websocket', socket => sockets.push(socket.url()))
  await page.route('**/*.wasm', route => route.abort())
  await page.goto(`/o/${org}`)
  await expect(page.getByRole('alert')).toHaveText('アプリを起動できませんでした。ページを再読み込みしてください。')
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)))
  expect(sync).toEqual([])
  expect(sockets).toEqual([])
  await expect(page.getByRole('textbox')).toHaveCount(0)
})

test('a slow core delays only sync: the Organization check runs first and sync starts once after it loads', async ({ page }) => {
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `slow-core-${crypto.randomUUID().slice(0, 8)}`)
  const sent = await secretSafe(() => page.request.post(`/api/v1/orgs/${org}/channels/${channel.id}/messages`, {
    data: { client_message_id: crypto.randomUUID(), body: channel.name },
  }))
  expect(sent.status()).toBe(201)
  const sync: string[] = [], sockets: string[] = []
  let checked = false
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path === `/api/v1/orgs/${org}/me`) checked = true
    if (syncPath(path)) sync.push(path)
  })
  page.on('websocket', socket => sockets.push(socket.url()))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/*.wasm', async route => { await held; await route.continue() })
  try {
    await page.goto(`/o/${org}/c/${channel.id}`)
    await expect.poll(() => checked).toBe(true)
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)))
    expect(sync).toEqual([])
    expect(sockets).toEqual([])
    release()
    await expect(page.getByRole('article').filter({ hasText: channel.name })).toBeVisible()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    expect(sockets).toHaveLength(1)
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
  let release!: () => void, requested!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { requested = resolve })
  let first = true
  await page.route(`**${base}/${a.id}/timeline*`, async route => {
    if (!first) return route.continue()
    first = false
    const response = await secretSafe(() => route.fetch())
    const data = await response.json() as components['schemas']['TimelinePage']
    for (const item of data.items) if (item.kind === 'message') item.message.body = 'stale generation text'
    requested()
    await held
    await route.fulfill({ status, json: status === 200 ? data : { error: 'channel_not_found' } })
  })
  try {
    await page.goto(`/o/${org}/c/${a.id}`)
    await ready
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
  } finally { release() }
})
