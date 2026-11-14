import { expect, test } from '@playwright/test'
import type { ClientMessage, Dm, ServerEvent } from '../src/api-schema.d.ts'
import { createChannelApi, ensureOwnerAndSignIn, inviteAndSignInPeerViaUi } from './helpers.ts'

for (const role of ['member', 'guest'] as const) test(`DM discovery and live Unread reuse one selected conversation for a ${role} peer`, async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peer: Awaited<ReturnType<typeof inviteAndSignInPeerViaUi>> | undefined
  try {
    const owner = await context.newPage()
    const org = await test.step('Sign in the owner', () => ensureOwnerAndSignIn(owner))
    const suffix = crypto.randomUUID().slice(0, 8)
    const channel = await createChannelApi(owner.request, org, `dm-control-${suffix}`)
    peer = await test.step('Invite and sign in the peer', () => inviteAndSignInPeerViaUi(owner, browser, baseURL!, role, suffix))
    const frames: ServerEvent[] = [], subscriptions = new Set<string>()
    peer.page.on('websocket', socket => {
      socket.on('framereceived', ({ payload }) => {
        const event: ServerEvent = JSON.parse(String(payload))
        frames.push(event)
      })
      socket.on('framesent', ({ payload }) => {
        const frame: ClientMessage = JSON.parse(String(payload))
        if (frame.type === 'subscribe') subscriptions.add(frame.channel_id)
        if (frame.type === 'unsubscribe') subscriptions.delete(frame.channel_id)
      })
    })
    await peer.page.goto(role === 'member' ? `/o/${org}/c/${channel.id}` : `/o/${org}`)
    await expect.poll(() => frames.some(frame => frame.type === 'activity_ready')).toBe(true)
    // Start from the Member action; discovery on the peer must not need a Message subscription.
    const details = owner.locator('details.member-list')
    if (!(await details.evaluate((el: HTMLDetailsElement) => el.open))) await details.locator('summary').click()
    const memberRow = details.locator('li').filter({ hasText: peer.name })
    await expect(memberRow).toHaveCount(1)
    // Let the committed notice invalidate list authority before the POST snapshot arrives.
    await owner.route(/\/api\/v1\/orgs\/[^/]+\/dms$/, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      await new Promise(resolve => setTimeout(resolve, 1000))
      await route.fulfill({ response })
    })
    const opened = owner.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/dms'))
    await memberRow.getByRole('button', { name: 'ダイレクトメッセージを開く', exact: true }).click()
    const response = await opened
    expect(response.ok()).toBe(true)
    const dm: Dm = await response.json()
    await expect(owner).toHaveURL(new RegExp(`/c/${dm.id}$`))
    await expect(owner.getByRole('heading', { name: peer.name, exact: true })).toBeVisible()
    await expect(owner.getByRole('textbox', { name: 'トピック名', exact: true })).toHaveCount(0)
    const section = peer.page.getByRole('region', { name: 'ダイレクトメッセージ', exact: true })
    const row = section.locator('button.ui-list-row').filter({ hasText: 'Alice' })
    await expect(row).toHaveCount(1)
    expect(subscriptions.has(dm.id)).toBe(false)
    const body = `DM-first-${suffix}`
    await owner.getByRole('textbox', { name: 'メッセージ', exact: true }).fill(body)
    await owner.getByRole('button', { name: '送信', exact: true }).click()
    await expect(row.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    expect(frames.some(frame => frame.type === 'message' && frame.message.channel_id === dm.id)).toBe(false)
    expect(subscriptions.has(dm.id)).toBe(false)
    await row.click()
    await expect(peer.page.getByRole('heading', { name: 'Alice', exact: true })).toBeVisible()
    await expect(peer.page.locator('main article').filter({ hasText: body })).toHaveCount(1)
    await expect.poll(() => subscriptions.has(dm.id)).toBe(true)
    await expect(row.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(peer.page.getByRole('tab', { name: 'トピック', exact: true })).toHaveCount(0)
    await expect(peer.page.getByRole('textbox', { name: 'メッセージ', exact: true })).toBeFocused()
    await peer.page.setViewportSize({ width: 320, height: 720 })
    expect(await peer.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await expect(peer.page.getByRole('textbox', { name: 'メッセージ', exact: true })).toBeVisible()
    await peer.page.setViewportSize({ width: 1280, height: 800 })
    if (role === 'guest') {
      const members = peer.page.locator('details.member-list')
      await members.locator('summary').click()
      await expect(members.getByRole('button', { name: 'ダイレクトメッセージを開く', exact: true })).toHaveCount(0)
    }
    const reply = `DM-reply-${suffix}`
    await peer.page.locator('main article').filter({ hasText: body }).getByRole('button', { name: /返信/ }).click()
    const panel = peer.page.getByRole('complementary', { name: '返信のつながり', exact: true })
    await panel.getByRole('textbox', { name: 'メッセージ', exact: true }).fill(reply)
    await panel.getByRole('button', { name: '送信', exact: true }).click()
    await expect(owner.locator('main article').filter({ hasText: reply })).toHaveCount(1)
    await peer.page.reload()
    await expect(peer.page.locator('main article').filter({ hasText: body })).toHaveCount(1)
    await expect(peer.page.locator('main article').filter({ hasText: reply })).toHaveCount(1)
    const deactivated = await owner.request.post(`/api/v1/orgs/${org}/members/${peer.memberId}/deactivate`)
    expect(deactivated.status()).toBe(204)
    await expect(owner.getByText('このメンバーは無効化されています。履歴は引き続き閲覧できます。', { exact: true })).toBeVisible({ timeout: 35_000 })
    await expect(owner.getByRole('textbox', { name: 'メッセージ', exact: true })).toBeDisabled()
    await expect(owner.locator('main article').filter({ hasText: body })).toHaveCount(1)
  } finally { await peer?.context.close().catch(() => {}); await context.close().catch(() => {}) }
})
