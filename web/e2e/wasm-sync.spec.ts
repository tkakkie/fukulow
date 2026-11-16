import { expect, test } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

test('wasm init failure shows an error before any controller starts', async ({ page }) => {
  const apiRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.method()) })
  await page.route('**/*.wasm', route => route.abort())
  await page.goto('/')
  await expect(page.getByRole('alert')).toHaveText('アプリを起動できませんでした。ページを再読み込みしてください。')
  expect(apiRequests).toEqual([])
  await expect(page.getByRole('textbox')).toHaveCount(0)
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
