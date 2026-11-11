import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type AcceptInviteRequest = components['schemas']['AcceptInviteRequest']
type CreateInviteRequest = components['schemas']['CreateInviteRequest']
type InviteResponse = components['schemas']['InviteResponse']
type Message = components['schemas']['Message']
type SendMessageRequest = components['schemas']['SendMessageRequest']

let orgId: string
let channelId: string
let channelName: string

test.beforeEach(async ({ page }) => {
  orgId = await signInOwner(page.request)
  const created = await createChannel(
    page.request,
    orgId,
    `replies-${crypto.randomUUID().slice(0, 8)}`,
  )
  channelId = created.id
  channelName = created.name
})

async function sendApiMessage(
  request: APIRequestContext,
  body: Omit<SendMessageRequest, 'client_message_id'>,
): Promise<Message> {
  const data: SendMessageRequest = {
    client_message_id: crypto.randomUUID(),
    ...body,
  }
  const res = await secretSafe(() =>
    request.post(`/api/v1/orgs/${orgId}/channels/${channelId}/messages`, { data }),
  )
  expect(res.status()).toBe(201)
  return (await secretSafe(() => res.json())) as Message
}

const mainComposer = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
const replyComposer = (page: Page) =>
  page.locator('#panel-content').getByRole('textbox', { name: 'メッセージ', exact: true })

test('open a reply chain from a Message, send a reply, receive a live update from a second user, page with さらに返信を読み込む, open from the Topic view, and close with ×', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })

  // Seed a root Message with 51 replies so the first reply-chain page (default limit 50: root + 49 replies)
  // leaves 2 replies for paging with "さらに返信を読み込む", plus a 50-Message Topic so the initial
  // unfiltered /messages page (limit 50) does not pre-populate replies 50-51 before paging.
  const rootMsg = await sendApiMessage(page.request, { body: '親メッセージ本文' })
  for (let i = 1; i <= 51; i++) {
    await sendApiMessage(page.request, {
      body: `既存の返信-${String(i).padStart(2, '0')}`,
      reply_to: rootMsg.id,
    })
  }
  const topicRoot = await sendApiMessage(page.request, {
    body: 'トピック内の親メッセージ',
    topic_name: '仕様確認',
  })
  expect(topicRoot.topic_id).toBeTruthy()
  const topicReply = await sendApiMessage(page.request, {
    body: 'トピック内の最初の返信',
    reply_to: topicRoot.id,
  })
  for (let i = 2; i <= 49; i++) {
    await sendApiMessage(page.request, {
      body: `トピック内の返信-${String(i).padStart(2, '0')}`,
      reply_to: topicRoot.id,
    })
  }

  // Create and sign in a second member to send a live reply while the panel is open
  const secondEmail = `reply-peer-${crypto.randomUUID()}@example.invalid`
  const secondPassword = 'correct horse reply peer'
  const inviteReq: CreateInviteRequest = { email: secondEmail, role: 'member' }
  const inviteRes = await secretSafe(() =>
    page.request.post(`/api/v1/orgs/${orgId}/invites`, { data: inviteReq }),
  )
  expect(inviteRes.ok()).toBe(true)
  const invite = (await secretSafe(() => inviteRes.json())) as InviteResponse

  const peerContext = await browser.newContext()
  try {
    const acceptReq: AcceptInviteRequest = {
      token: invite.token,
      email: secondEmail,
      name: 'Bob',
      password: secondPassword,
    }
    const acceptRes = await secretSafe(() =>
      peerContext.request.post(`/api/v1/orgs/${orgId}/invites/accept`, { data: acceptReq }),
    )
    expect(acceptRes.ok()).toBe(true)
    const peerLogin = await secretSafe(() =>
      peerContext.request.post('/api/v1/session', {
        data: { email: secondEmail, password: secondPassword },
      }),
    )
    expect(peerLogin.ok()).toBe(true)

    await page.goto(`/o/${orgId}/c/${channelId}`)
    await expect(page.getByRole('heading', { level: 1, name: channelName, exact: true })).toBeVisible()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // 1. Load the older main-timeline page so the root Message (seq 1, behind 51 replies + 1 Topic summary)
    // is rendered in the Channel timeline, then open its reply chain.
    await page
      .locator('#main-content')
      .getByRole('button', { name: '以前のメッセージを読み込む', exact: true })
      .click()
    const rootRow = page.locator(`#main-content [data-message-id="${rootMsg.id}"]`)
    await expect(rootRow).toContainText('親メッセージ本文')
    const openReplyButton = rootRow.getByRole('button', { name: /返信/ })
    await openReplyButton.click()

    const panel = page.locator('#panel-content')
    await expect(panel).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}\\?panel=reply:${rootMsg.id}$`))
    await expect(panel.getByRole('heading', { level: 2, name: '返信のつながり', exact: true })).toBeVisible()
    await expect(replyComposer(page)).toBeFocused()
    await expect(panel.locator(`[data-message-id="${rootMsg.id}"]`)).toContainText('親メッセージ本文')
    await expect(panel.locator('[data-message-id]')).toHaveCount(50)

    // 2. Paging with "さらに返信を読み込む" loads the remaining replies
    const loadMoreButton = panel.getByRole('button', { name: 'さらに返信を読み込む', exact: true })
    await expect(loadMoreButton).toBeVisible()
    await loadMoreButton.click()
    await expect(panel.locator('[data-message-id]')).toHaveCount(52)
    await expect(panel).toContainText('既存の返信-51')
    await expect(loadMoreButton).toHaveCount(0)

    // 3. Send a reply from the panel Composer and wait for the confirmed row [data-message-id]
    await replyComposer(page).fill('パネルから送信した返信')
    await panel.getByRole('button', { name: '送信', exact: true }).click()
    await expect(replyComposer(page)).toHaveValue('')
    await expect(replyComposer(page)).toBeFocused()
    const confirmedOwnRow = panel
      .locator('[data-message-id]')
      .filter({ hasText: 'パネルから送信した返信' })
    await expect(confirmedOwnRow).toBeVisible()
    await expect(panel.locator('[data-message-id]')).toHaveCount(53)

    // 4. Live update from a second user appears in the open reply chain panel
    const peerMsg = await sendApiMessage(peerContext.request, {
      body: 'Bobからのライブ返信',
      reply_to: rootMsg.id,
    })
    const livePeerRow = panel.locator(`[data-message-id="${peerMsg.id}"]`)
    await expect(livePeerRow).toBeVisible()
    await expect(livePeerRow).toContainText('Bobからのライブ返信')
    await expect(rootRow.getByRole('button', { name: '返信 53件›', exact: true })).toBeVisible()

    // 5. Close with × returns focus to the opener button and removes the panel from the URL
    await panel.getByRole('button', { name: 'パネルを閉じる(Esc)', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}$`))
    await expect(openReplyButton).toBeFocused()

    // 6. Open a Reply chain from the Topic view and close with ×
    const topicSummary = page.locator(`#main-content button[data-topic-id="${topicRoot.topic_id}"]`)
    await expect(topicSummary).toBeVisible()
    await topicSummary.click()

    await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}/t/${topicRoot.topic_id}$`))
    await expect(page.getByRole('heading', { level: 1, name: '仕様確認', exact: true })).toBeVisible()
    await expect(mainComposer(page)).toBeFocused()

    const topicMessageRow = page.locator(`#main-content [data-message-id="${topicRoot.id}"]`)
    await expect(topicMessageRow).toContainText('トピック内の親メッセージ')
    const topicReplyOpener = topicMessageRow.getByRole('button', { name: /返信/ })
    await topicReplyOpener.click()

    await expect(panel).toBeVisible()
    await expect(page).toHaveURL(
      new RegExp(`/o/${orgId}/c/${channelId}/t/${topicRoot.topic_id}\\?panel=reply:${topicRoot.id}$`),
    )
    await expect(replyComposer(page)).toBeFocused()
    await expect(panel.locator(`[data-message-id="${topicRoot.id}"]`)).toContainText(
      'トピック内の親メッセージ',
    )
    await expect(panel.locator(`[data-message-id="${topicReply.id}"]`)).toContainText(
      'トピック内の最初の返信',
    )

    // Send a reply inside the Topic's reply chain and wait for its confirmed [data-message-id] row
    await replyComposer(page).fill('トピック返信パネルからの追記')
    await panel.getByRole('button', { name: '送信', exact: true }).click()
    const confirmedTopicReply = panel
      .locator('[data-message-id]')
      .filter({ hasText: 'トピック返信パネルからの追記' })
    await expect(confirmedTopicReply).toBeVisible()
    await expect(topicMessageRow.getByRole('button', { name: '返信 50件›', exact: true })).toBeVisible()

    // Close with × from Topic view
    await panel.getByRole('button', { name: 'パネルを閉じる(Esc)', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}/t/${topicRoot.topic_id}$`))
    await expect(topicReplyOpener).toBeFocused()

    // 7. Keyboard path: ArrowUp in empty Topic Composer focuses the latest Message row, R opens its Reply chain, Esc restores focus to the row
    await mainComposer(page).focus()
    await expect(mainComposer(page)).toHaveValue('')
    await page.keyboard.press('ArrowUp')
    const latestTopicRow = page.locator('#main-content .ui-message-row[data-focusable="true"]').last()
    await expect(latestTopicRow).toBeFocused()
    await page.keyboard.press('r')
    await expect(panel).toBeVisible()
    await expect(replyComposer(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(latestTopicRow).toBeFocused()
  } finally {
    await peerContext.close()
  }
})
