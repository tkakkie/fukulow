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
