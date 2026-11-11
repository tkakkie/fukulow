import { expect, test } from '@playwright/test'

// The server and its database are shared and start empty (CI service / fresh local DB),
// so these tests run serially in state order: not set up -> setup -> set up.
test.describe.configure({ mode: 'serial' })

const owner = { email: 'owner@example.com', password: 'correct horse battery' }

test('not-set-up instance shows the setup screen', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '初期セットアップ' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ログイン' })).toHaveCount(0)
})

test('setup signs the Owner in automatically', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('組織名').fill('Acme')
  await page.getByLabel('オーナーの名前').fill('Alice')
  await page.getByLabel('メールアドレス').fill(owner.email)
  await page.getByLabel('パスワード（12文字以上）').fill(owner.password)
  await page.getByRole('button', { name: 'セットアップして開始' }).click()

  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ログイン' })).toHaveCount(0)

  // The session cookie survives a reload.
  await page.reload()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
})

test('set-up instance shows the sign-in screen and signs in', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '初期セットアップ' })).toHaveCount(0)

  await page.getByLabel('メールアドレス').fill(owner.email)
  await page.getByLabel('パスワード').fill('wrong password here')
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page.getByRole('alert')).toBeVisible()

  await page.getByLabel('パスワード').fill(owner.password)
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
})

test('sign out returns to the sign-in screen and stays signed out after reload', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('メールアドレス').fill(owner.email)
  await page.getByLabel('パスワード').fill(owner.password)
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()

  await page.getByRole('button', { name: 'ログアウト' }).click()
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible()
  await expect(page.getByText('Acme / Alice さん')).toHaveCount(0)
})

test('phone zero-Channels reaches creation and sign-out; creating a Channel and sending a Message has no console or page errors', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  // 1. Phone width with zero Channels: Channel creation form and sign-out are immediately reachable
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto('/')
  await page.getByLabel('メールアドレス').fill(owner.email)
  await page.getByLabel('パスワード').fill(owner.password)
  errors.length = 0
  await page.getByRole('button', { name: 'ログイン' }).click()

  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
  await expect(page.getByLabel('チャンネル名')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible()
  await expect(page.getByText('左のフォーム')).toHaveCount(0)

  // 2. Create Channel `general` on phone -> enters view, subscribes live, and shows Composer
  await page.getByLabel('チャンネル名').fill('general')
  await page.getByRole('button', { name: 'チャンネルを作成' }).click()
  await expect(page.getByRole('heading', { name: 'general' })).toBeVisible()
  await expect(page.getByTestId('live-status')).toHaveText('リアルタイム接続済み')

  // 3. Send a Message -> visible in timeline, no effect_update_depth_exceeded or console errors
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('こんにちは、世界')
  await page.getByRole('button', { name: '送信' }).click()
  await expect(page.getByRole('list', { name: 'メッセージ一覧' }).getByText('こんにちは、世界')).toBeVisible()

  // 4. Desktop width: open right panel, navigate ARIA tabs with ArrowRight, close with Escape
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.getByRole('button', { name: 'パネルを開く(⌘.)' }).click()
  const topicsTab = page.getByRole('tab', { name: 'トピック' })
  await expect(topicsTab).toHaveAttribute('aria-selected', 'true')
  await topicsTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: '概要' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'パネルを開く(⌘.)' })).toBeFocused()

  expect(errors).toEqual([])
})
