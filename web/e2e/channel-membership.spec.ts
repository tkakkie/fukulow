import { expect, test } from '@playwright/test'
import { secretSafe } from './helpers.ts'

test('shared Member panel adds, confirms removal and leave, explains protection and shows live C9', async ({ page, browser }) => {
  const setupResponse = await secretSafe(() => page.request.get('/api/v1/setup'))
  expect(setupResponse.ok()).toBe(true)
  const setup = await secretSafe(() => setupResponse.json())
  if (setup.setup_required) {
    const response = await secretSafe(() => page.request.post('/api/v1/setup', { data: { setup_token: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only', organization_name: 'Acme', name: 'Alice', email: 'owner@example.com', password: 'correct horse battery' } }))
    expect(response.ok()).toBe(true)
  }
  await page.goto('/')
  await page.getByLabel('メールアドレス', { exact: true }).fill('owner@example.com')
  await page.getByLabel('パスワード', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
  const meResponse = await secretSafe(() => page.request.get('/api/v1/me'))
  expect(meResponse.ok()).toBe(true)
  const me = await secretSafe(() => meResponse.json())
  const org = me.organizations[0].organization_id
  const base = `/api/v1/orgs/${org}`
  const name = `メンバー149-${crypto.randomUUID()}`
  const channelResponse = await secretSafe(() => page.request.post(`${base}/channels`, { data: { name, visibility: 'private' } }))
  expect(channelResponse.ok()).toBe(true)
  const channel = await secretSafe(() => channelResponse.json())
  const guestName = `参加ゲスト-${crypto.randomUUID()}`
  const email = `guest149-${crypto.randomUUID()}@example.invalid`
  const inviteResponse = await secretSafe(() => page.request.post(`${base}/invites`, { data: { email, role: 'guest' } }))
  expect(inviteResponse.ok()).toBe(true)
  const invite = await secretSafe(() => inviteResponse.json())
  const guestContext = await browser.newContext()
  try {
    const accepted = await secretSafe(() => guestContext.request.post(`${base}/invites/accept`, { data: { token: invite.token, email, name: guestName, password: 'Guest test password 149' } }))
    expect(accepted.ok()).toBe(true)
    const guestMember = (await secretSafe(() => accepted.json())).member
    await page.reload()
    await page.getByRole('button', { name: `🔒 ${name}`, exact: true }).click()
    await page.getByRole('button', { name: 'パネルを開く(⌘.)' }).click()
    await page.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const panel = page.getByRole('region', { name: 'チャンネルのメンバー' })
    await panel.getByRole('button', { name: `${guestName}を追加`, exact: true }).click()
    await expect(panel.getByRole('button', { name: `${guestName}をチャンネルから外す` })).toBeVisible()
    // The last manager cannot leave even while a Guest grant remains.
    await panel.getByRole('button', { name: 'Aliceとしてチャンネルを退出' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '退出する', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('このチャンネルを管理できる最後のメンバー')
    const guest = await guestContext.newPage()
    await guest.goto('/')
    await guest.getByLabel('メールアドレス', { exact: true }).fill(email)
    await guest.getByLabel('パスワード', { exact: true }).fill('Guest test password 149')
    await guest.getByRole('button', { name: 'ログイン', exact: true }).click()
    await expect(guest.getByRole('heading', { name, exact: true })).toBeVisible()
    const composer = guest.getByRole('textbox', { name: 'メッセージ' })
    await expect(composer).toBeEnabled()
    await composer.fill('失わない下書き')
    await panel.getByRole('button', { name: `${guestName}をチャンネルから外す` }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: `${guestName}をチャンネルから外す` })).toBeFocused()
    await panel.getByRole('button', { name: `${guestName}をチャンネルから外す` }).click()
    await page.getByRole('dialog').getByRole('button', { name: '外す', exact: true }).click()
    await expect(guest.getByText('このチャンネルは利用できません。', { exact: true })).toBeVisible()
    await expect(composer).toBeDisabled()
    await expect(composer).toHaveValue('失わない下書き')
    // Re-grant does not revive the old subscription. Explicit selection does.
    await panel.getByRole('button', { name: `${guestName}を追加`, exact: true }).click()
    // The post-mutation list reload confirms the grant committed before reselection.
    await expect(panel.getByRole('button', { name: `${guestName}をチャンネルから外す` })).toBeVisible()
    await expect(composer).toBeDisabled()
    await guest.getByRole('button', { name: `🔒 ${name}`, exact: true }).click()
    await expect(composer).toBeEnabled()
    await guest.getByRole('button', { name: 'パネルを開く(⌘.)' }).click()
    await guest.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const gp = guest.getByRole('region', { name: 'チャンネルのメンバー' })
    await expect(gp.getByRole('button', { name: `${guestName}としてチャンネルを退出` })).toBeVisible()
    await expect(gp.getByRole('button', { name: 'Aliceをチャンネルから外す' })).toHaveCount(0)
    await gp.getByRole('button', { name: `${guestName}としてチャンネルを退出` }).click()
    await guest.getByRole('dialog').getByRole('button', { name: '退出する', exact: true }).click()
    await expect(composer).toBeDisabled()
    const check = await secretSafe(() => page.request.get(`${base}/channels/${channel.id}/members`))
    expect(check.ok()).toBe(true)
    expect((await secretSafe(() => check.json())).members.some((m: { id: string }) => m.id === guestMember.id)).toBe(false)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await guestContext.close() }
})
