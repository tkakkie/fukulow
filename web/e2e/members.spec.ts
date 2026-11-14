import { expect, test } from '@playwright/test'
import { secretSafe } from './helpers.ts'

// auth.spec.ts bootstraps the shared disposable database before this file.
test('Owner creates an Invite link; new Guest accepts, signs in and sees no implicit public Channels', async ({ page, browser }) => {
  await page.goto('/')
  await page.getByLabel('メールアドレス', { exact: true }).fill('owner@example.com')
  await page.getByLabel('パスワード', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
  await page.getByLabel('チャンネル名', { exact: true }).fill('Members public control')
  await page.getByRole('button', { name: 'チャンネルを作成', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Members public control' })).toBeVisible()
  await page.locator('summary').click()
  const email = `guest-${crypto.randomUUID()}@example.invalid`
  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('招待するロール', { exact: true }).selectOption('guest')
  await page.getByRole('button', { name: '招待リンクを作成' }).click()
  const link = await secretSafe(() => page.getByLabel('招待リンク（7日間有効・1回限り）').inputValue())
  const guestContext = await browser.newContext()
  try {
    const guest = await guestContext.newPage()
    const requestPaths: string[] = []
    guest.on('request', request => requestPaths.push(new URL(request.url()).pathname + new URL(request.url()).search))
    await secretSafe(() => guest.goto(link))
    const clearedLink = await secretSafe(() => new URL(link))
    const fragment = clearedLink.hash.slice(1)
    clearedLink.hash = ''
    await expect.poll(() => guest.url() === clearedLink.href, { message: 'Invite fragment is removed from the URL' }).toBe(true)
    const invitation = guest.getByRole('region', { name: '招待を受ける' })
    await invitation.getByLabel('招待先のメールアドレス').fill(email)
    await invitation.getByLabel('組織での名前').fill('招待ゲスト')
    await invitation.getByLabel('新しいアカウントのパスワード（12文字以上）').fill('test password for invited Guest')
    await invitation.getByRole('button', { name: '招待を受ける' }).click()
    await expect(guest.getByRole('status')).toHaveText('招待を受けました。ログインしてください。')
    await guest.getByLabel('メールアドレス', { exact: true }).fill(email)
    await guest.getByLabel('パスワード', { exact: true }).fill('test password for invited Guest')
    await guest.getByRole('button', { name: 'ログイン', exact: true }).click()
    await expect(guest.getByText('Acme / 招待ゲスト さん')).toBeVisible()
    await expect(guest.getByRole('heading', { name: 'Members public control' })).toHaveCount(0)
    await expect(guest.getByRole('button', { name: 'チャンネルを作成' })).toHaveCount(0)
    await expect(guest.getByRole('group', { name: '公開範囲' })).toHaveCount(0)
    await guest.locator('summary').click()
    await expect(guest.getByText('招待ゲスト（ゲスト）')).toBeVisible()
    await expect(guest.getByRole('button', { name: '招待リンクを作成' })).toHaveCount(0)
    expect(requestPaths.every(path => !path.includes('invite=') && !path.includes(fragment)), 'Invite token never enters a request URL').toBe(true)
  } finally { await guestContext.close() }
})
