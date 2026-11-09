import { expect, test, type Page } from '@playwright/test'

// Empty DB -> setup -> sign in -> create channel -> post -> appears live in a second browser context.
const owner = { email: 'owner@example.com', password: 'correct horse battery' }

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('メールアドレス').fill(owner.email)
  await page.getByLabel('パスワード').fill(owner.password)
  await page.getByRole('button', { name: 'ログイン' }).click()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
}

test('a message posted in one browser appears live in another, without reload', async ({ browser }) => {
  // Browser A and B are independent contexts (own cookies, own sessions).
  const a = await (await browser.newContext()).newPage()
  const b = await (await browser.newContext()).newPage()

  // A: fresh instance -> setup (signs in automatically) -> channel through the product UI.
  await a.goto('/')
  await a.getByLabel('組織名').fill('Acme')
  await a.getByLabel('オーナーの名前').fill('Alice')
  await a.getByLabel('メールアドレス').fill(owner.email)
  await a.getByLabel('パスワード（12文字以上）').fill(owner.password)
  await a.getByRole('button', { name: 'セットアップして開始' }).click()
  await expect(a.getByText('Acme / Alice さん')).toBeVisible()
  await a.getByLabel('チャンネル名').fill('general')
  await a.getByRole('button', { name: 'チャンネルを作成' }).click()
  await expect(a.getByRole('heading', { name: 'general' })).toBeVisible()

  // B: own session, same channel; wait until its WebSocket is subscribed before A posts.
  await signIn(b)
  await b.getByRole('button', { name: '# general' }).click()
  await expect(b.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  await expect(a.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  const historyAfterPost: string[] = []
  b.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('/messages') && r.method() === 'GET') historyAfterPost.push(r.url())
  })

  const text = `live ${Date.now()}`
  await a.getByLabel('メッセージ').fill(text)
  await a.getByRole('button', { name: '送信' }).click()

  // No reload, no refetch trigger: only the WebSocket can deliver this.
  await expect(b.locator('.body', { hasText: text })).toHaveCount(1)
  await expect(a.locator('.body', { hasText: text })).toHaveCount(1) // echo dedupes with the optimistic entry
  expect(historyAfterPost).toEqual([])
})
