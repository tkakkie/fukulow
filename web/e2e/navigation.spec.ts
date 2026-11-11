import { expect, test } from '@playwright/test'

let org: string
let first: string
let second: string
let firstName: string
let secondName: string

test.beforeEach(async ({ page }) => {
  const setup = await page.request.get('/api/v1/setup')
  if ((await setup.json()).setup_required) {
    const response = await page.request.post('/api/v1/setup', { data: {
      organization_name: 'Acme', name: 'Alice', email: 'owner@example.com', password: 'correct horse battery',
      setup_token: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
    } })
    expect(response.ok()).toBe(true)
  }
  const login = await page.request.post('/api/v1/session', { data: { email: 'owner@example.com', password: 'correct horse battery' } })
  expect(login.ok()).toBe(true)
  org = (await login.json()).identity.organizations[0].organization_id
  const create = async (name: string) => {
    const response = await page.request.post(`/api/v1/orgs/${org}/channels`, { data: { name: `${name}-${crypto.randomUUID()}`, visibility: 'public' } })
    expect(response.ok()).toBe(true)
    return await response.json() as { id: string; name: string }
  }
  const a = await create('Navigation one')
  const b = await create('Navigation two')
  first = a.id; firstName = a.name
  second = b.id; secondName = b.name
})

const composer = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'メッセージ', exact: true })

test('Channel, panel, Back and Forward restore URL, focus and independent drafts', async ({ page }) => {
  await page.goto(`/o/${org}/c/${first}`)
  await expect(composer(page)).toBeFocused()
  await composer(page).fill('未送信の下書き')
  await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}\\?panel=topics$`))
  await expect(page.locator('#panel-content h2')).toBeFocused()
  await page.getByRole('tab', { name: '概要', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('panel=overview$'))
  await expect(page.getByRole('tab', { name: '概要', exact: true })).toBeFocused()
  await page.locator('.channel-list button').filter({ hasText: secondName }).last().click()
  await expect(page).toHaveURL(new RegExp(`${second}\\?panel=overview$`))
  await expect(composer(page)).toHaveValue('')
  await expect(composer(page)).toBeFocused()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${first}\\?panel=overview$`))
  await expect(composer(page)).toHaveValue('未送信の下書き')
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(page.locator('#panel-content')).toHaveCount(0)
  await page.goForward()
  await expect(page.locator('#panel-content h2')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true })).toBeFocused()
})

test('phone list, view and panel levels preserve drafts across Back, parent replace and resizing', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/o/${org}`)
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
  await page.locator('.channel-list button').filter({ hasText: firstName }).last().click()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(composer(page)).toBeFocused()
  await composer(page).fill('電話の下書き')
  await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
  await page.goBack()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
  await expect(composer(page)).toHaveValue('電話の下書き')
  await page.goBack()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
  await page.goForward()
  await expect(composer(page)).toHaveValue('電話の下書き')
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(composer(page)).toHaveValue('電話の下書き')
  await page.setViewportSize({ width: 375, height: 667 })
  await page.getByRole('button', { name: 'チャンネル一覧へ戻る', exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/o/${org}$`))
  await page.locator('.channel-list button').filter({ hasText: firstName }).last().click()
  await expect(composer(page)).toHaveValue('電話の下書き')
})

test('direct link has no synthetic parents; in-app close keeps the main target and replaces', async ({ page }) => {
  await page.goto(`/o/${org}/c/${first}`)
  const length = await page.evaluate(() => history.length)
  await page.goto(`/o/${org}/c/${first}/t/00000000-0000-0000-0000-000000000001?panel=reply:00000000-0000-0000-0000-000000000002`)
  const directLength = await page.evaluate(() => history.length)
  expect(directLength).toBe(length + 1)
  await expect(page.locator('#panel-content')).toBeVisible()
  await page.getByRole('button', { name: 'パネルを閉じる(Esc)', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/t/00000000-0000-0000-0000-000000000001$`))
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  expect(await page.evaluate(() => history.length)).toBe(directLength)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
})

test('unknown Channel and Organization links show API-owned unavailable states', async ({ page }) => {
  await page.goto(`/o/${org}/c/00000000-0000-0000-0000-000000000001`)
  await expect(page.getByRole('alert')).toContainText('このチャンネルは利用できません。')
  await expect(composer(page)).toBeDisabled()
  await page.goto(`/o/00000000-0000-0000-0000-000000000001/c/${first}`)
  await expect(page.getByRole('alert')).toContainText('この組織は利用できません。')
})

test('Topic back keeps the panel and announces the API Topic name; reload adds no parent entries', async ({ page }) => {
  const sent = await page.request.post(`/api/v1/orgs/${org}/channels/${first}/messages`, { data: { client_message_id: crypto.randomUUID(), body: 'Topic control', topic_name: '日報' } })
  expect(sent.ok()).toBe(true)
  const message = await sent.json()
  const url = `/o/${org}/c/${first}/t/${message.topic_id}?panel=members`
  await page.goto(url)
  await expect(page.getByRole('heading', { name: '日報', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('日報')
  const length = await page.evaluate(() => history.length)
  await page.reload()
  await expect(page.getByRole('heading', { name: '日報', exact: true })).toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}\\?panel=members$`))
  await expect(composer(page)).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(length)
})

test('phone direct-link parent buttons replace without leaving; real Back can leave the app', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto('/api/v1/health')
  await page.goto(`/o/${org}/c/${first}?panel=overview`)
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
  const length = await page.evaluate(() => history.length)
  await page.getByRole('button', { name: '前の表示に戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(composer(page)).toBeFocused()
  await page.getByRole('button', { name: 'チャンネル一覧へ戻る', exact: true }).first().click()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.goBack()
  await expect(page).toHaveURL(/\/api\/v1\/health$/)
})
