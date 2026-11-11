import { expect, test, type Page } from '@playwright/test'
import { secretSafe } from './helpers.ts'

let orgId: string
let channelId: string
let channelName: string

test.beforeEach(async ({ page }) => {
  const setup = await secretSafe(() => page.request.get('/api/v1/setup'))
  expect(setup.ok()).toBe(true)
  if ((await secretSafe(() => setup.json())).setup_required) {
    const response = await secretSafe(() =>
      page.request.post('/api/v1/setup', {
        data: {
          organization_name: 'Acme',
          name: 'Alice',
          email: 'owner@example.com',
          password: 'correct horse battery',
          setup_token: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
        },
      }),
    )
    expect(response.ok()).toBe(true)
  }
  const login = await secretSafe(() =>
    page.request.post('/api/v1/session', {
      data: { email: 'owner@example.com', password: 'correct horse battery' },
    }),
  )
  expect(login.ok()).toBe(true)
  orgId = (await secretSafe(() => login.json())).identity.organizations[0].organization_id

  channelName = `topics-${crypto.randomUUID().slice(0, 8)}`
  const created = await secretSafe(() =>
    page.request.post(`/api/v1/orgs/${orgId}/channels`, {
      data: { name: channelName, visibility: 'public' },
    }),
  )
  expect(created.ok()).toBe(true)
  channelId = (await secretSafe(() => created.json())).id
})

const messageComposer = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
const topicNameInput = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'トピック名', exact: true })

test('desktop 1280px: create Topic by first Message, see summary move to latest activity, open Topic view, post, and go back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/o/${orgId}/c/${channelId}`)
  await expect(page.getByRole('heading', { level: 1, name: channelName, exact: true })).toBeVisible()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  // 1. Post an ordinary Channel message
  await messageComposer(page).fill('チャンネルの最初の発言')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
  await expect(page.locator('#main-content .timeline-list__item')).toHaveCount(1)

  // 2. Create a Topic by posting its first Message with a Topic name
  await topicNameInput(page).fill('リリース相談')
  await messageComposer(page).fill('トピック最初の投稿')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()

  const summaryButton = page.locator('#main-content button[data-topic-id]')
  await expect(summaryButton).toBeVisible()
  await expect(summaryButton).toContainText('トピック: リリース相談')
  await expect(summaryButton).toContainText('1件›')
  await expect(summaryButton).toContainText('トピック最初の投稿')
  await expect(topicNameInput(page)).toHaveValue('')
  await expect(messageComposer(page)).toHaveValue('')

  // Topic Messages are not rendered as inline MessageRows in the Channel timeline
  await expect(page.locator('#main-content .ui-message-row')).toHaveCount(1)

  const topicId = await summaryButton.getAttribute('data-topic-id')
  expect(topicId).toBeTruthy()

  // 3. Post a second Channel message after the Topic so the Topic is currently in the middle
  await messageComposer(page).fill('チャンネルの2番目の発言')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
  const beforeMoveItems = page.locator('#main-content .timeline-list__item')
  await expect(beforeMoveItems).toHaveCount(3)
  await expect(beforeMoveItems.nth(0)).toContainText('チャンネルの最初の発言')
  await expect(beforeMoveItems.nth(1)).toContainText('トピック: リリース相談')
  await expect(beforeMoveItems.nth(2)).toContainText('チャンネルの2番目の発言')

  // 4. Channel sidebar accordion shows the recent Topic + すべてのトピック(1)› -> opens right panel Topic list
  const channelNav = page.locator('#channel-content')
  await expect(channelNav.getByRole('button', { name: /リリース相談/ })).toBeVisible()
  await channelNav.getByRole('button', { name: 'すべてのトピック(1)›', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}\\?panel=topics$`))
  await expect(page.locator('#panel-content').getByRole('list', { name: 'トピック一覧' })).toContainText(
    'トピック: リリース相談',
  )

  // 5. Keep an unsent Channel draft, open Topic view, verify isolated draft & Topic messages, and post in it
  await messageComposer(page).fill('チャンネルに残す下書き')
  await summaryButton.click()

  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}/t/${topicId}\\?panel=topics$`))
  await expect(page.getByRole('heading', { level: 1, name: 'リリース相談', exact: true })).toBeVisible()
  await expect(messageComposer(page)).toHaveValue('')
  await expect(page.locator('#main-content .topic-view__item')).toHaveCount(1)
  await expect(page.locator('#main-content .topic-view__item').first()).toContainText('トピック最初の投稿')

  await messageComposer(page).fill('トピック内の2件目')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
  await expect(page.locator('#main-content .topic-view__item')).toHaveCount(2)
  await expect(page.locator('#main-content .topic-view__item').nth(1)).toContainText('トピック内の2件目')

  // 6. Go back to Channel: focus returns to the Topic summary line, Channel draft is preserved, and summary moved to latest activity
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}\\?panel=topics$`))
  const returnedSummary = page.locator(`#main-content [data-topic-id="${topicId}"]`)
  await expect(returnedSummary).toBeFocused()
  await expect(messageComposer(page)).toHaveValue('チャンネルに残す下書き')

  const afterMoveItems = page.locator('#main-content .timeline-list__item')
  await expect(afterMoveItems).toHaveCount(3)
  await expect(afterMoveItems.nth(0)).toContainText('チャンネルの最初の発言')
  await expect(afterMoveItems.nth(1)).toContainText('チャンネルの2番目の発言')
  await expect(afterMoveItems.nth(2)).toContainText('トピック: リリース相談')
  await expect(afterMoveItems.nth(2)).toContainText('2件›')
  await expect(afterMoveItems.nth(2)).toContainText('トピック内の2件目')
})

test('phone 375px: create Topic, open Topic from panel list, post in Topic view, and go back without overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/o/${orgId}`)
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')

  await page.locator('#channel-content .channel-list button').filter({ hasText: channelName }).click()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  // Create Topic on phone
  await topicNameInput(page).fill('スマホ議題')
  await messageComposer(page).fill('スマホ初回の投稿')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()

  const summaryButton = page.locator('#main-content button[data-topic-id]')
  await expect(summaryButton).toContainText('トピック: スマホ議題')
  await expect(summaryButton).toContainText('1件›')
  const topicId = await summaryButton.getAttribute('data-topic-id')

  // Open panel on phone -> select Topic from panel Topic list -> drops panel and opens Topic view
  await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
  const panelTopicBtn = page
    .locator('#panel-content')
    .getByRole('button', { name: /トピック: スマホ議題/ })
  await expect(panelTopicBtn).toBeVisible()
  await panelTopicBtn.click()

  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}/t/${topicId}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'スマホ議題', exact: true })).toBeVisible()

  // Post inside Topic view on phone
  await messageComposer(page).fill('スマホからの返信')
  await page.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
  await expect(page.locator('#main-content .topic-view__item')).toHaveCount(2)

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)

  // Return to Channel timeline
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}$`))
  await expect(page.locator(`#main-content [data-topic-id="${topicId}"]`)).toContainText('2件›')
  await expect(page.locator(`#main-content [data-topic-id="${topicId}"]`)).toContainText('スマホからの返信')
})

test('keyboard path: create Topic, open Topic view, send a Message, and return to summary line via real key presses', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/o/${orgId}/c/${channelId}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  await expect(messageComposer(page)).toBeFocused()

  // Shift+Tab from Composer textarea into Topic name input, type Topic name, press Enter to return to textarea
  await page.keyboard.press('Shift+Tab')
  await expect(topicNameInput(page)).toBeFocused()
  await page.keyboard.type('キーボード議題')
  await page.keyboard.press('Enter')
  await expect(messageComposer(page)).toBeFocused()

  // Type first Message and press Enter to create the Topic
  await page.keyboard.type('キーボード初回投稿')
  await page.keyboard.press('Enter')

  const summaryButton = page.locator('#main-content button[data-topic-id]')
  await expect(summaryButton).toContainText('トピック: キーボード議題')
  await expect(summaryButton).toContainText('1件›')
  const topicId = await summaryButton.getAttribute('data-topic-id')

  // Shift+Tab twice from textarea -> Topic name input -> Topic summary line, then Enter to open Topic view
  await page.keyboard.press('Shift+Tab')
  await expect(topicNameInput(page)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(summaryButton).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}/t/${topicId}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'キーボード議題', exact: true })).toBeVisible()
  await expect(messageComposer(page)).toBeFocused()

  // Type and press Enter to send inside Topic view
  await page.keyboard.type('キーボードからの追記')
  await page.keyboard.press('Enter')
  // Pending rows are not focusable; wait for confirmation and the roving tab stop before navigating.
  const topicRows = page.locator('#main-content .ui-message-row[data-focusable="true"]')
  await expect(topicRows).toHaveCount(2)
  await expect(topicRows.last()).toContainText('キーボードからの追記')
  await expect(topicRows.last()).toHaveAttribute('tabindex', '0')

  // Shift+Tab from Topic textarea -> roving Message row -> panel toggle -> チャンネルへ戻る, then Enter to return to summary line
  await page.keyboard.press('Shift+Tab')
  await expect(topicRows.last()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  const backButton = page.getByRole('button', { name: 'チャンネルへ戻る', exact: true })
  await expect(backButton).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/c/${channelId}$`))
  const returnedSummary = page.locator(`#main-content [data-topic-id="${topicId}"]`)
  await expect(returnedSummary).toBeFocused()
  await expect(returnedSummary).toContainText('2件›')
})

// These tests use real HTTP persistence and server WebSocket delivery. The route only controls transport timing.
test('Topic view reconnect replays a Message sent during the WebSocket drop exactly once', async ({ page }) => {
  let hold = false
  const held: (() => void)[] = []
  let disconnect!: () => Promise<void>
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    const server = ws.connectToServer()
    ws.onMessage(raw => { if (hold) held.push(() => server.send(raw)); else server.send(raw) })
    disconnect = async () => { await ws.close({ code: 1011 }); await server.close({ code: 1011 }) }
  })
  const base = `/api/v1/orgs/${orgId}/channels/${channelId}`
  const firstResponse = await secretSafe(() => page.request.post(`${base}/messages`, {
    data: { client_message_id: crypto.randomUUID(), body: 'before drop', topic_name: 'Reconnect Topic' },
  }))
  expect(firstResponse.ok()).toBe(true)
  const first = await secretSafe(() => firstResponse.json())
  await page.goto(`/o/${orgId}/c/${channelId}/t/${first.topic_id}`)
  await expect(page.getByRole('heading', { name: 'Reconnect Topic', exact: true })).toBeVisible()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  await expect(page.locator('.topic-view__item')).toHaveCount(1)
  await messageComposer(page).fill('draft across reconnect')
  hold = true
  await disconnect()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'false')
  const response = await secretSafe(() => page.request.post(`${base}/messages`, {
    data: { client_message_id: crypto.randomUUID(), body: 'sent during drop', topic_name: 'Reconnect Topic' },
  }))
  expect(response.ok()).toBe(true)
  await expect.poll(() => held.length).toBeGreaterThan(0)
  hold = false
  for (const release of held.splice(0)) release()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  const rows = page.locator('.topic-view__item')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('before drop')
  await expect(rows.nth(1)).toContainText('sent during drop')
  await expect(rows.filter({ hasText: 'sent during drop' })).toHaveCount(1)
  await expect(messageComposer(page)).toHaveValue('draft across reconnect')
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page.locator('#main-content button[data-topic-id]')).toHaveCount(1)
  await expect(page.locator('#main-content button[data-topic-id]')).toContainText('2件›')
})

test('removing a private Channel Member shows C9 in the open Topic while another Channel stays usable', async ({ page, browser }) => {
  const base = `/api/v1/orgs/${orgId}`
  const created = await secretSafe(() => page.request.post(`${base}/channels`, {
    data: { name: `private-topic-${crypto.randomUUID()}`, visibility: 'private' },
  }))
  expect(created.ok()).toBe(true)
  const privateChannel = await secretSafe(() => created.json())
  const email = `topic-member-${crypto.randomUUID()}@example.invalid`
  const password = 'Topic membership test password'
  const invitation = await secretSafe(() => page.request.post(`${base}/invites`, { data: { email, role: 'member' } }))
  expect(invitation.ok()).toBe(true)
  const invite = await secretSafe(() => invitation.json())
  const context = await browser.newContext()
  try {
    const accepted = await secretSafe(() => context.request.post(`${base}/invites/accept`, {
      data: { token: invite.token, email, name: 'Topic Member', password },
    }))
    expect(accepted.ok()).toBe(true)
    const identity = await secretSafe(() => accepted.json())
    const grant = await secretSafe(() => page.request.post(`${base}/channels/${privateChannel.id}/members`, { data: { member_id: identity.member.id } }))
    expect(grant.ok()).toBe(true)
    const sent = await secretSafe(() => page.request.post(`${base}/channels/${privateChannel.id}/messages`, {
      data: { client_message_id: crypto.randomUUID(), body: 'private Topic history', topic_name: 'Private Topic' },
    }))
    expect(sent.ok()).toBe(true)
    const message = await secretSafe(() => sent.json())
    const login = await secretSafe(() => context.request.post('/api/v1/session', { data: { email, password } }))
    expect(login.ok()).toBe(true)
    const memberPage = await context.newPage()
    await memberPage.setViewportSize({ width: 1280, height: 800 })
    await memberPage.goto(`/o/${orgId}/c/${privateChannel.id}/t/${message.topic_id}`)
    await expect(memberPage.getByRole('heading', { name: 'Private Topic', exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(memberPage.locator('.topic-view__item')).toContainText('private Topic history')
    await messageComposer(memberPage).fill('private Topic draft')
    const removed = await secretSafe(() => page.request.delete(`${base}/channels/${privateChannel.id}/members/${identity.member.id}`))
    expect(removed.ok()).toBe(true)
    await expect(memberPage.getByRole('alert')).toContainText('このチャンネルは利用できません。')
    await expect(messageComposer(memberPage)).toBeDisabled()
    await expect(messageComposer(memberPage)).toHaveValue('private Topic draft')
    await expect(memberPage.locator('.topic-view__item')).toContainText('private Topic history')
    await expect(memberPage.getByRole('button', { name: '再試行', exact: true })).toHaveCount(0)
    await memberPage.locator('#channel-content .channel-list button').filter({ hasText: channelName }).click()
    await expect(memberPage.getByRole('heading', { level: 1, name: channelName, exact: true })).toBeVisible()
    await expect(messageComposer(memberPage)).toBeEnabled()
    await messageComposer(memberPage).fill('other Channel still works')
    await memberPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(memberPage.locator('#main-content .timeline-list__item[data-message-id]').filter({ hasText: 'other Channel still works' })).toHaveCount(1)
    await expect(memberPage.locator('#main-content .timeline-list__item[data-status]')).toHaveCount(0)
  } finally { await context.close() }
})
