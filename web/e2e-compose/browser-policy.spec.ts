import { expect, test } from '@playwright/test'
import { createChannelApi, ensureOwnerAndSignIn, inviteAndSignInPeerViaUi } from './helpers.ts'

test('browser policy headers retain ordinary composer editing and trusted keyboard paste', async ({ page }) => {
  const violations: string[] = []
  page.on('console', message => {
    if (/permissions.policy.*(violation|violat|blocked)|violat.*permissions.policy/i.test(message.text())) violations.push(message.text())
  })
  page.on('pageerror', error => violations.push(error.message))
  for (const [path, status] of [['/', 200], ['/api/v1/missing', 404], ['/api/v1/ready', 404]] as const) {
    const response = (await page.goto(path))!
    expect(response.status()).toBe(status)
    const headers = await response.headersArray()
    for (const [name, expected] of [['cross-origin-opener-policy', 'same-origin'], ['permissions-policy', 'camera=()']]) {
      const fields = headers.filter(header => header.name.toLowerCase() === name)
      expect(fields).toHaveLength(1)
      if (name === 'cross-origin-opener-policy') expect(fields[0].value).toBe(expected)
      else {
        expect(fields[0].value).toContain(expected)
        const features = fields[0].value.split(',').map(feature => feature.trim())
        expect(features).toHaveLength(22)
        expect(new Set(features).size).toBe(features.length)
        expect(features.every(feature => /^[a-z-]+=\(\)$/.test(feature))).toBe(true)
      }
    }
  }
  await ensureOwnerAndSignIn(page)
  const name = `paste-${crypto.randomUUID().slice(0, 8)}`
  await page.getByLabel('チャンネル名', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'チャンネルを作成', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  const composer = page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
  await composer.focus()
  await page.keyboard.type('ordinary editX')
  await page.keyboard.press('Backspace')
  await expect(composer).toHaveValue('ordinary edit')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+C')
  await page.keyboard.type('replace me')
  await page.keyboard.press('ControlOrMeta+A')
  await page.evaluate(() => {
    Object.assign(window, { trustedPaste: false })
    window.addEventListener('paste', event => Object.assign(window, { trustedPaste: event.isTrusted }), { once: true })
  })
  await page.keyboard.press('ControlOrMeta+V')
  await expect(composer).toHaveValue('ordinary edit')
  expect(await page.evaluate(() => (window as typeof window & { trustedPaste: boolean }).trustedPaste)).toBe(true)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('pasted and sent')
  await expect(composer).toHaveValue('ordinary edit\npasted and sent')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
  await expect(page.locator('#main-content .ui-message-row')).toContainText('ordinary edit\npasted and sent')
  expect(violations).toEqual([])
})

test('browser policy retains Reply chains and live Unread presentation', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const page = await context.newPage()
    const org = await ensureOwnerAndSignIn(page)
    const suffix = crypto.randomUUID().slice(0, 8)
    const target = await createChannelApi(page.request, org, `policy-reply-${suffix}`)
    const lobby = await createChannelApi(page.request, org, `policy-lobby-${suffix}`)
    await page.reload()
    const peer = await inviteAndSignInPeerViaUi(page, browser, baseURL!, 'member', suffix)
    peerContext = peer.context
    await page.goto(`/o/${org}/c/${target.id}`)
    await peer.page.goto(`/o/${org}/c/${lobby.id}`)
    for (const current of [page, peer.page]) await expect(current.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const root = `Reply root ${suffix}`
    await page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true }).fill(root)
    await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    const channelRow = peer.page.locator('#channel-content button.ui-list-row').filter({ hasText: target.name })
    await expect(channelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    await channelRow.click()
    await expect(peer.page.locator('#main-content .ui-message-row')).toContainText(root)
    await expect(channelRow.locator('.ui-badge--unread')).toHaveCount(0)
    for (const current of [page, peer.page]) {
      await current.locator('#main-content .ui-message-row').filter({ hasText: root }).getByRole('button', { name: /返信/ }).click()
      await expect(current.locator('#panel-content').getByRole('heading', { name: '返信のつながり', exact: true })).toBeVisible()
    }
    const reply = `Browser Reply ${suffix}`
    await page.locator('#panel-content').getByRole('textbox', { name: 'メッセージ', exact: true }).fill(reply)
    await page.locator('#panel-content').getByRole('button', { name: '送信', exact: true }).click()
    for (const current of [page, peer.page]) await expect(current.locator('#panel-content .ui-message-row').filter({ hasText: reply })).toHaveCount(1)
  } finally {
    await peerContext?.close()
    await context.close()
  }
})
