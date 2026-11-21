import { expect, test, type APIRequestContext } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type Message = components['schemas']['Message']

async function postMessage(
  request: APIRequestContext,
  org: string,
  channelId: string,
  body: string,
): Promise<Message> {
  const response = await secretSafe(() =>
    request.post(`/api/v1/orgs/${org}/channels/${channelId}/messages`, {
      data: { body, client_message_id: crypto.randomUUID() },
    }),
  )
  expect(response.status()).toBe(201)
  return (await secretSafe(() => response.json())) as Message
}

test('searches Messages, loads the next page by cursor, and opens a hit at the Message', async ({ page }) => {
  const org = await signInOwner(page.request)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const channel = await createChannel(page.request, org, `search-${suffix}`)
  const keyword = `srch${suffix}`

  // Post 23 matching Messages sequentially so created_at/id order is deterministic across pages.
  const messages: Message[] = []
  for (let i = 1; i <= 23; i++) {
    messages.push(
      await postMessage(
        page.request,
        org,
        channel.id,
        `${keyword} item ${String(i).padStart(2, '0')}`,
      ),
    )
  }

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/o/${org}/c/${channel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  const main = page.locator('#main-content')
  const searchForm = main.getByRole('search', { name: 'メッセージを検索' })
  await searchForm.getByRole('searchbox', { name: 'メッセージを検索' }).fill(keyword)
  await searchForm.getByRole('button', { name: '検索', exact: true }).click()

  await expect(main.getByRole('heading', { name: '検索結果', exact: true })).toBeVisible()
  const list = main.getByRole('list', { name: '検索結果一覧' })
  await expect(list.locator('article')).toHaveCount(20)
  await expect(list.locator('article').first()).toContainText(`${keyword} item 23`)
  await expect(list.locator('article').first()).toContainText(`# ${channel.name}`)
  await expect(list.locator('article').first()).toContainText('Alice')

  const loadMore = main.getByRole('button', { name: 'さらに読み込む', exact: true })
  await expect(loadMore).toBeVisible()
  await loadMore.click()

  await expect(list.locator('article')).toHaveCount(23)
  await expect(loadMore).toHaveCount(0)

  const oldestHit = list.getByRole('button', { name: new RegExp(`${keyword} item 01`) })
  await expect(oldestHit).toBeVisible()
  await oldestHit.click()

  await expect(page).toHaveURL(new RegExp(`/o/${org}/c/${channel.id}$`))
  const matchedRow = main.locator('.ui-message-row--search-match')
  await expect(matchedRow).toBeVisible()
  await expect(matchedRow).toContainText(`${keyword} item 01`)
  await expect(matchedRow.locator('xpath=ancestor::*[@data-message-id]')).toHaveAttribute(
    'data-message-id',
    messages[0].id,
  )
})

test('private-Channel non-member gets no hit while the member sees it', async ({ page, browser }) => {
  const org = await signInOwner(page.request)
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const privateKeyword = `priv${suffix}`

  const channelRes = await secretSafe(() =>
    page.request.post(`/api/v1/orgs/${org}/channels`, {
      data: { name: `priv-${suffix}`, visibility: 'private' },
    }),
  )
  expect(channelRes.status()).toBe(201)
  const privateChannel = (await secretSafe(() => channelRes.json())) as components['schemas']['Channel']
  await postMessage(page.request, org, privateChannel.id, `secret ${privateKeyword} body`)

  const email = `member-${suffix}@example.invalid`
  const memberPassword = 'Member search test password 725'
  const inviteRes = await secretSafe(() =>
    page.request.post(`/api/v1/orgs/${org}/invites`, {
      data: { email, role: 'member' },
    }),
  )
  expect(inviteRes.status()).toBe(201)
  const invite = (await secretSafe(() => inviteRes.json())) as components['schemas']['InviteResponse']

  // Owner (member of the private Channel) gets the hit.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/o/${org}/c/${privateChannel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  const ownerMain = page.locator('#main-content')
  const ownerForm = ownerMain.getByRole('search', { name: 'メッセージを検索' })
  await ownerForm.getByRole('searchbox', { name: 'メッセージを検索' }).fill(privateKeyword)
  await ownerForm.getByRole('button', { name: '検索', exact: true }).click()
  await expect(ownerMain.getByRole('list', { name: '検索結果一覧' }).locator('article')).toHaveCount(1)

  // Second Member (not a member of the private Channel) gets no hit.
  const memberContext = await browser.newContext()
  try {
    const acceptRes = await secretSafe(() =>
      memberContext.request.post(`/api/v1/orgs/${org}/invites/accept`, {
        data: {
          token: invite.token,
          email,
          name: `Bob ${suffix}`,
          password: memberPassword,
        },
      }),
    )
    expect(acceptRes.ok()).toBe(true)

    const memberPage = await memberContext.newPage()
    await memberPage.setViewportSize({ width: 1280, height: 800 })
    await memberPage.goto('/')
    await memberPage.getByLabel('メールアドレス', { exact: true }).fill(email)
    await memberPage.getByLabel('パスワード', { exact: true }).fill(memberPassword)
    await memberPage.getByRole('button', { name: 'ログイン', exact: true }).click()
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const memberMain = memberPage.locator('#main-content')
    const memberForm = memberMain.getByRole('search', { name: 'メッセージを検索' })
    await memberForm.getByRole('searchbox', { name: 'メッセージを検索' }).fill(privateKeyword)
    await memberForm.getByRole('button', { name: '検索', exact: true }).click()

    await expect(memberMain.getByText('一致するメッセージが見つかりませんでした。')).toBeVisible()
    await expect(memberMain.getByRole('list', { name: '検索結果一覧' })).toHaveCount(0)
  } finally {
    await memberContext.close()
  }
})
