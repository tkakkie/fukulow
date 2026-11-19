import { expect, test, type APIRequestContext } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

async function createSecondMemberRequest(
  ownerRequest: APIRequestContext,
  browser: import('@playwright/test').Browser,
  org: string,
) {
  const email = `unread-member-${crypto.randomUUID()}@example.invalid`
  const password = 'Unread member test password'
  const invitation = await secretSafe(() =>
    ownerRequest.post(`/api/v1/orgs/${org}/invites`, {
      data: { email, role: 'member' },
    }),
  )
  expect(invitation.ok()).toBe(true)
  const invite = (await secretSafe(() => invitation.json())) as { token: string }

  const context = await browser.newContext()
  const accepted = await secretSafe(() =>
    context.request.post(`/api/v1/orgs/${org}/invites/accept`, {
      data: { token: invite.token, email, name: 'Bob', password },
    }),
  )
  expect(accepted.ok()).toBe(true)

  const login = await secretSafe(() =>
    context.request.post('/api/v1/session', {
      data: { email, password },
    }),
  )
  expect(login.ok()).toBe(true)

  return context
}

async function postMessage(
  request: APIRequestContext,
  org: string,
  channelId: string,
  body: string,
  opts?: { topicName?: string },
): Promise<components['schemas']['Message']> {
  const res = await secretSafe(() =>
    request.post(`/api/v1/orgs/${org}/channels/${channelId}/messages`, {
      data: {
        client_message_id: crypto.randomUUID(),
        body,
        ...(opts?.topicName ? { topic_name: opts.topicName } : {}),
      },
    }),
  )
  expect(res.ok()).toBe(true)
  return (await secretSafe(() => res.json())) as components['schemas']['Message']
}

test('first Unread pages beyond the main cap and read reporting survives trimming and newer refetch', async ({ page, browser }) => {
  test.setTimeout(60_000)
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `unread-window-${crypto.randomUUID().slice(0, 8)}`)
  const peer = await createSecondMemberRequest(page.request, browser, org)
  try {
    const first = await postMessage(peer.request, org, channel.id, '窓より前の最初の未読')
    for (let i = 1; i < 450; i += 8) await Promise.all(Array.from({ length: Math.min(8, 450 - i) }, (_, n) =>
      postMessage(peer.request, org, channel.id, `長い未読履歴 ${i + n}`)))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/o/${org}/c/${channel.id}`)
    const main = page.locator('#main-content'), scroll = main.locator('.timeline-scroll')
    await expect(main.locator(`[data-message-id="${first.id}"] [data-read-marker="true"]`)).toBeInViewport()
    expect(await main.locator('[data-message-id]').count()).toBeLessThan(40)
    await scroll.evaluate(async el => {
      while (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
        el.scrollTop += Math.floor(el.clientHeight * .7); el.dispatchEvent(new Event('scroll'))
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        el.dispatchEvent(new Event('scroll'))
      }
    })
    await main.getByRole('button', { name: '最新のメッセージを読み込む', exact: true }).click()
    await expect(main.getByRole('button', { name: '以前のメッセージを読み込む', exact: true })).toBeEnabled()
    await scroll.evaluate(async el => {
      el.scrollTop = 0; el.dispatchEvent(new Event('scroll'))
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      el.dispatchEvent(new Event('scroll'))
      while (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
        el.scrollTop += Math.floor(el.clientHeight * .7); el.dispatchEvent(new Event('scroll'))
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        el.dispatchEvent(new Event('scroll'))
      }
    })
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/orgs/${org}/channels`)
      const data = await response.json() as components['schemas']['ChannelList']
      return data.channels.find(c => c.id === channel.id)?.read_seq
    }).toBe(450)
    for (let i = 0; i < 8; i++) await main.getByRole('button', { name: '以前のメッセージを読み込む', exact: true }).click()
    const older = main.getByRole('button', { name: '以前のメッセージを読み込む', exact: true })
    await expect(older).toHaveCount(0)
    const composer = main.getByRole('textbox', { name: 'メッセージ', exact: true })
    await composer.focus(); await composer.press('ArrowUp')
    await expect(main.locator('.ui-message-row:focus')).toHaveCount(1)
    await page.keyboard.press('Home')
    await expect(main.locator(`[data-message-id="${first.id}"] [data-read-marker="true"]`)).toBeAttached()
  } finally { await peer.close() }
})

test('desktop 1280px: second user posts in main and Topics; first user sees badges, opens at first Unread with 未読 marker, scrolls to mark main read, Topic view marks only its Topic, and badge stays 0 after reload', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const lobbyChannel = await createChannel(page.request, orgId, `lobby-desktop-${suffix}`)
  const targetChannel = await createChannel(page.request, orgId, `unread-desktop-${suffix}`)
  const topicAName = `トピックA-${suffix}`
  const topicBName = `トピックB-${suffix}`

  // User 1 posts an initial read message in targetChannel and marks it read
  const ownMsg = await postMessage(page.request, orgId, targetChannel.id, 'Aliceの既読メッセージ')
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: ownMsg.history_generation, read_seq: ownMsg.created_seq },
    }),
  )
  expect(markOwn.ok()).toBe(true)

  const bobContext = await createSecondMemberRequest(page.request, browser, orgId)
  try {
    // Bob posts 14 main-timeline messages (tall enough to require scrolling) plus messages in 2 Topics
    const mainMessages: components['schemas']['Message'][] = []
    for (let i = 1; i <= 14; i++) {
      const msg = await postMessage(
        bobContext.request,
        orgId,
        targetChannel.id,
        `Bobのメイン未読メッセージ ${i}\n2行目のテキスト ${i}\n3行目のテキスト ${i}`,
      )
      mainMessages.push(msg)
    }

    const topicAFirst = await postMessage(bobContext.request, orgId, targetChannel.id, 'トピックAの未読1', {
      topicName: topicAName,
    })
    expect(topicAFirst.topic_id).toBeTruthy()
    await postMessage(bobContext.request, orgId, targetChannel.id, 'トピックAの未読2', {
      topicName: topicAName,
    })

    const topicBFirst = await postMessage(bobContext.request, orgId, targetChannel.id, 'トピックBの未読1', {
      topicName: topicBName,
    })
    expect(topicBFirst.topic_id).toBeTruthy()

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/o/${orgId}/c/${lobbyChannel.id}`)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // 1. In lobby, Alice sees the aggregate Unread badge (14 main + 2 Topic A + 1 Topic B = 17) on targetChannel
    const channelNav = page.locator('#channel-content')
    const targetChannelRow = channelNav
      .locator('.channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: targetChannel.name })
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 17件')

    // 2. Alice selects targetChannel -> opens at the first Unread message (mainMessages[0]) with the 未読 read marker
    await targetChannelRow.click()
    await expect(page.getByRole('heading', { level: 1, name: targetChannel.name, exact: true })).toBeVisible()

    const firstUnreadId = mainMessages[0].id
    const firstUnreadItem = page.locator(`#main-content [data-message-id="${firstUnreadId}"]`)
    await expect(firstUnreadItem).toBeVisible()
    const readMarker = firstUnreadItem.locator('[data-read-marker="true"]')
    await expect(readMarker).toBeVisible()
    await expect(readMarker).toHaveText('未読')

    // Accordion Topic rows and right panel Topic list show Topic badges (topicA: 2, topicB: 1)
    const accordionTopicA = channelNav
      .locator('.ui-list-row-group--topic button.ui-list-row')
      .filter({ hasText: topicAName })
    const accordionTopicB = channelNav
      .locator('.ui-list-row-group--topic button.ui-list-row')
      .filter({ hasText: topicBName })
    await expect(accordionTopicA.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')
    await expect(accordionTopicB.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    await channelNav.getByRole('button', { name: 'すべてのトピック(2)›', exact: true }).click()
    const panelTopicA = page.locator(`#panel-content button.ui-topic-summary[data-topic-id="${topicAFirst.topic_id}"]`)
    const panelTopicB = page.locator(`#panel-content button.ui-topic-summary[data-topic-id="${topicBFirst.topic_id}"]`)
    await expect(panelTopicA.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')
    await expect(panelTopicB.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    // 3. Scroll the main timeline to the bottom so all 14 main Unread messages are presented
    const scrollContainer = page.locator('#main-content .timeline-scroll')
    await scrollContainer.evaluate(async (el) => {
      const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
      while (el.scrollTop + el.clientHeight < el.scrollHeight) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
        await new Promise((r) => setTimeout(r, 30))
      }
    })

    // Main Unread messages are now read, leaving only Topic A (2) + Topic B (1) = 3 Unread on the Channel badge
    // Topic summary lines in the main timeline never marked Topics as read
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 3件')
    const timelineTopicA = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicAFirst.topic_id}"]`)
    const timelineTopicB = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicBFirst.topic_id}"]`)
    await expect(timelineTopicA.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')
    await expect(timelineTopicB.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    // A virtualized row restores the visit's marker when it re-enters the viewport.
    await scrollContainer.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await expect(readMarker).toHaveText('未読')
    await scrollContainer.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })

    // 4. Open Topic A -> shows 未読 marker on Topic A's first Unread message and marks ONLY Topic A as read
    await timelineTopicA.click()
    await expect(page.getByRole('heading', { level: 1, name: topicAName, exact: true })).toBeVisible()
    const topicAFirstItem = page.locator(`#main-content [data-message-id="${topicAFirst.id}"]`)
    await expect(topicAFirstItem.locator('[data-read-marker="true"]')).toHaveText('未読')

    // Topic A badge clears to 0, while Topic B (1) and Channel badge (1) remain
    await expect(accordionTopicA.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(panelTopicA.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(accordionTopicB.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    await expect(panelTopicB.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    // Marker in Topic A stays visible for the rest of the visit
    await expect(topicAFirstItem.locator('[data-read-marker="true"]')).toBeVisible()

    // 5. Open Topic B from the right panel -> marks Topic B as read -> Channel badge goes to 0
    await panelTopicB.click()
    await expect(page.getByRole('heading', { level: 1, name: topicBName, exact: true })).toBeVisible()
    await expect(accordionTopicB.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(panelTopicB.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)

    // 6. Reload and confirm owned Channel and Topic badges stay 0 and no read marker is shown
    await page.reload()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(accordionTopicA.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(accordionTopicB.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(panelTopicA.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(panelTopicB.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(page.locator('#main-content [data-read-marker="true"]')).toHaveCount(0)
  } finally {
    await bobContext.close()
  }
})

test('phone 375px: Channel and Topic badges, open Channel at first Unread with 未読 marker, open Topic view from panel, and mark all read without overflow', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  await createChannel(page.request, orgId, `lobby-phone-${suffix}`)
  const targetChannel = await createChannel(page.request, orgId, `unread-phone-${suffix}`)
  const topicName = `スマホ未読トピック-${suffix}`

  const bobContext = await createSecondMemberRequest(page.request, browser, orgId)
  try {
    const mainMsg = await postMessage(bobContext.request, orgId, targetChannel.id, 'スマホのメイン未読')
    const topicMsg = await postMessage(bobContext.request, orgId, targetChannel.id, 'スマホのトピック未読', {
      topicName,
    })

    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/o/${orgId}`)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')

    // Channel list shows aggregate badge (2) on targetChannel
    const channelNav = page.locator('#channel-content')
    const targetChannelRow = channelNav
      .locator('.channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: targetChannel.name })
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')

    // Tap targetChannel -> opens main timeline at first Unread with 未読 marker
    await targetChannelRow.click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const mainItem = page.locator(`#main-content [data-message-id="${mainMsg.id}"]`)
    await expect(mainItem.locator('[data-read-marker="true"]')).toHaveText('未読')

    // Topic summary line in main timeline shows 未読 1件
    const summaryBtn = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicMsg.topic_id}"]`)
    await expect(summaryBtn.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    // Open panel -> Topic list shows 未読 1件 -> tap Topic to open Topic view
    await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    const panelTopicBtn = page.locator(`#panel-content button.ui-topic-summary[data-topic-id="${topicMsg.topic_id}"]`)
    await expect(panelTopicBtn.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    await panelTopicBtn.click()

    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(page.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()
    const topicItem = page.locator(`#main-content [data-message-id="${topicMsg.id}"]`)
    await expect(topicItem.locator('[data-read-marker="true"]')).toHaveText('未読')

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHorizontalOverflow).toBe(false)

    // Return to Channel timeline -> Topic summary badge is now gone
    await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
    await expect(summaryBtn.locator('.ui-badge--unread')).toHaveCount(0)

    // Return to mobile Channel list -> Channel badge is 0 and stays 0 after reload
    await page.getByRole('button', { name: 'チャンネル一覧へ戻る', exact: true }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)

    await page.reload()
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)
  } finally {
    await bobContext.close()
  }
})

test('keyboard path: open Unread Channel, enter Unread Topic via real key presses, and return with badges cleared', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const lobbyChannel = await createChannel(page.request, orgId, `lobby-kbd-${suffix}`)
  const targetChannel = await createChannel(page.request, orgId, `unread-kbd-${suffix}`)
  const topicName = `キーボード未読トピック-${suffix}`

  const bobContext = await createSecondMemberRequest(page.request, browser, orgId)
  try {
    const mainMsg = await postMessage(bobContext.request, orgId, targetChannel.id, 'キーボードのメイン未読')
    const topicMsg = await postMessage(bobContext.request, orgId, targetChannel.id, 'キーボードのトピック未読', {
      topicName,
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/o/${orgId}/c/${lobbyChannel.id}`)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const channelNav = page.locator('#channel-content')
    const targetChannelRow = channelNav
      .locator('.channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: targetChannel.name })
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')

    // Open Unread Channel via real Enter key press on its Channel row
    await targetChannelRow.focus()
    await expect(targetChannelRow).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { level: 1, name: targetChannel.name, exact: true })).toBeVisible()
    await expect(page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })).toBeFocused()

    // Main Unread message has the 未読 marker and is marked read on entry; Topic summary still has 未読 1件
    const mainItem = page.locator(`#main-content [data-message-id="${mainMsg.id}"]`)
    await expect(mainItem.locator('[data-read-marker="true"]')).toHaveText('未読')

    const summaryButton = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicMsg.topic_id}"]`)
    await expect(summaryButton.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    const accordionTopic = channelNav
      .locator('.ui-list-row-group--topic button.ui-list-row')
      .filter({ hasText: topicName })
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    await expect(accordionTopic.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    // Shift+Tab twice from Composer textarea -> Topic name input -> Topic summary line, then Enter to open Topic view
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('#main-content').getByRole('textbox', { name: 'トピック名', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(summaryButton).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(page.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()
    const topicItem = page.locator(`#main-content [data-message-id="${topicMsg.id}"]`)
    await expect(topicItem.locator('[data-read-marker="true"]')).toHaveText('未読')

    // Topic is marked read -> owned Channel and Topic badges clear to 0
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(accordionTopic.locator('.ui-badge--unread')).toHaveCount(0)

    // Shift+Tab from Topic textarea -> roving Message row -> panel toggle -> チャンネルへ戻る, then Enter
    const topicRow = page.locator('#main-content .ui-message-row[data-focusable="true"]').last()
    await expect(topicRow).toHaveAttribute('tabindex', '0')
    await page.keyboard.press('Shift+Tab')
    await expect(topicRow).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    const backButton = page.getByRole('button', { name: 'チャンネルへ戻る', exact: true })
    await expect(backButton).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(summaryButton).toBeFocused()
    await expect(summaryButton.locator('.ui-badge--unread')).toHaveCount(0)
  } finally {
    await bobContext.close()
  }
})

test('read reporting advances over rows mounted after scroll stops via IntersectionObserver alone', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const channel = await createChannel(page.request, orgId, `unread-observer-${suffix}`)
  const bobContext = await createSecondMemberRequest(page.request, browser, orgId)
  try {
    // Seed 30 own messages so opening at the bottom measures the lower half and scrolling to the top
    // measures the upper half: all 30 rows above the future Unread insertion point have cached heights.
    const ownMessages: components['schemas']['Message'][] = []
    for (let i = 1; i <= 30; i++) {
      ownMessages.push(await postMessage(page.request, orgId, channel.id, `自分の履歴 ${i}`))
    }

    await page.setViewportSize({ width: 1280, height: 800 })
    // Pin periodic activity reconcile jitter near the end of its 30 s window so a random periodic
    // notify() cannot re-run Timeline's visibility/entry effects during the post-scroll assertion.
    await page.addInitScript(() => {
      Math.random = () => 0.99
    })
    // Track startup and post-jump refresh requests for this Organization/Channel so no late
    // activitySnapshot() or Topics notify() can re-run Timeline's scroll-sync/visibility effects
    // after the jump and advance read_seq without IntersectionObserver.
    let activityReadySeen = false
    let timelineFinished = false
    let postReadyMeCompleted = 0
    let postBootstrapChannelsCompleted = 0
    let recordingPostJumpRequests = false
    const postJumpRefreshRequests: string[] = []
    const inFlightChannels = new Set<import('@playwright/test').Request>()
    const inFlightTopics = new Set<import('@playwright/test').Request>()
    const postBootstrapChannelRequests = new WeakSet<import('@playwright/test').Request>()
    const postReadyMeRequests = new WeakSet<import('@playwright/test').Request>()
    const okResponses = new WeakSet<import('@playwright/test').Request>()
    const isGetPath = (req: import('@playwright/test').Request, pathname: string) =>
      req.method() === 'GET' && new URL(req.url()).pathname === pathname
    const isChannelsListRequest = (req: import('@playwright/test').Request) =>
      isGetPath(req, `/api/v1/orgs/${orgId}/channels`)
    const isTopicsListRequest = (req: import('@playwright/test').Request) =>
      isGetPath(req, `/api/v1/orgs/${orgId}/channels/${channel.id}/topics`)
    const isTimelineRequest = (req: import('@playwright/test').Request) =>
      isGetPath(req, `/api/v1/orgs/${orgId}/channels/${channel.id}/timeline`)
    const isOrgMeRequest = (req: import('@playwright/test').Request) =>
      isGetPath(req, `/api/v1/orgs/${orgId}/me`)
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        if (typeof frame.payload === 'string' && frame.payload.includes('"activity_ready"')) {
          activityReadySeen = true
        }
      })
    })
    page.on('request', (req) => {
      if (isChannelsListRequest(req)) {
        inFlightChannels.add(req)
        if (activityReadySeen && timelineFinished) {
          postBootstrapChannelRequests.add(req)
        }
        if (recordingPostJumpRequests) {
          postJumpRefreshRequests.push(`GET ${new URL(req.url()).pathname}`)
        }
      } else if (isTopicsListRequest(req)) {
        inFlightTopics.add(req)
        if (recordingPostJumpRequests) {
          postJumpRefreshRequests.push(`GET ${new URL(req.url()).pathname}`)
        }
      } else if (activityReadySeen && isOrgMeRequest(req)) {
        postReadyMeRequests.add(req)
      }
    })
    page.on('response', (res) => {
      if (res.ok()) {
        okResponses.add(res.request())
      }
    })
    page.on('requestfinished', (req) => {
      inFlightChannels.delete(req)
      inFlightTopics.delete(req)
      if (!okResponses.has(req)) return
      if (isTimelineRequest(req)) timelineFinished = true
      if (postBootstrapChannelRequests.has(req)) postBootstrapChannelsCompleted++
      if (postReadyMeRequests.has(req)) postReadyMeCompleted++
    })
    page.on('requestfailed', (req) => {
      inFlightChannels.delete(req)
      inFlightTopics.delete(req)
    })
    await page.goto(`/o/${orgId}/c/${channel.id}`)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const main = page.locator('#main-content')
    const scroll = main.locator('.timeline-scroll')
    const channelRow = page
      .locator('#channel-content .channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: channel.name })

    // Wait for bottom rows to mount and be measured at the bottom, then scroll to top so the view is
    // unpinned and the upper rows are also measured (bottom rows unmount, keeping their cached heights).
    await expect(main.locator(`[data-message-id="${ownMessages.at(-1)!.id}"]`)).toBeInViewport()
    await scroll.evaluate((el) => {
      el.scrollTo({ top: 0, behavior: 'instant' })
    })
    await expect(main.locator(`[data-message-id="${ownMessages[0].id}"]`)).toBeInViewport()
    await expect(main.locator(`[data-message-id="${ownMessages.at(-1)!.id}"]`)).toHaveCount(0)

    // Record the exact top offset where the next message (seq 31) will land now that all 30 rows are measured.
    const targetTop = await scroll.evaluate((el: HTMLElement) => {
      const list = el.querySelector('.timeline-list') as HTMLElement
      return (list.offsetTop - el.offsetTop) + list.offsetHeight
    })

    // While Alice stays unpinned at the top, Bob posts 15 Unread messages (using Bob for all 15 avoids
    // ownSendAtTail auto-scrolling to bottom, and the extra rows keep the jump destination unpinned so
    // followBottom never writes scrollTop).
    const targetUnread: components['schemas']['Message'][] = []
    for (let i = 1; i <= 15; i++) {
      targetUnread.push(await postMessage(bobContext.request, orgId, channel.id, `停止後にマウントされる未読 ${i}`))
    }

    // Wait for all 45 messages (30 initial + 15 Unread) to arrive over WS and for
    // reactive effects (scroll-sync, visibility, entry) to settle while target rows remain unmounted.
    await expect(channelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 15件')
    await expect(main.locator(`[data-message-id="${ownMessages[0].id}"]`)).toHaveAttribute('aria-setsize', '45')
    const firstTarget = targetUnread[0]
    await expect(main.locator(`[data-message-id="${firstTarget.id}"]`)).toHaveCount(0)

    // Wait until startup activity_ready and Channel bootstrap refreshes have completely settled:
    // - activity_ready invalidates capabilities (/me), channels, and main:<channel> (/topics, if
    //   holdMain() ran before activity_ready) in the same 200 ms batch. Once the post-activity_ready
    //   /me GET finishes, any main:<channel> /topics GET has already started, so inFlightTopics === 0
    //   guarantees it has finished (without hanging when holdMain() ran after activity_ready).
    // - Channel bootstrap (cursor null -> non-null after /timeline finishes, unread.ts) and
    //   activity_ready are the only startup triggers for /channels. Waiting for a /channels GET that
    //   started after both activity_ready and /timeline finished to complete (with inFlightChannels === 0)
    //   guarantees no queued follow-up refresh (activity.ts schedule(200)) remains pending.
    await expect
      .poll(() => ({
        activityReadySeen,
        timelineFinished,
        postReadyMeCompleted: postReadyMeCompleted >= 1,
        postBootstrapChannelsCompleted: postBootstrapChannelsCompleted >= 1,
        inFlightChannels: inFlightChannels.size,
        inFlightTopics: inFlightTopics.size,
      }))
      .toEqual({
        activityReadySeen: true,
        timelineFinished: true,
        postReadyMeCompleted: true,
        postBootstrapChannelsCompleted: true,
        inFlightChannels: 0,
        inFlightTopics: 0,
      })
    // Flush any renderer microtasks/effects queued by the just-finished startup responses before jumping.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )

    // Record whether firstTarget is in the DOM during every native scroll event from the jump
    // through read advancement. Listen in capture phase on document (filtering to el) so the
    // probe runs before target-phase listeners (handleScroll and row-window's refresh, whose
    // post-listener microtask checkpoint mounts firstTarget).
    await scroll.evaluate((el, targetId) => {
      const key = Symbol.for('fukulow.e2e.scrollProbe')
      const targetPresentPerScroll: boolean[] = []
      const onScroll = (event: Event) => {
        if (event.target !== el) return
        targetPresentPerScroll.push(el.querySelector(`[data-message-id="${CSS.escape(targetId)}"]`) !== null)
      }
      document.addEventListener('scroll', onScroll, { passive: true, capture: true })
      ;(el as unknown as Record<symbol, { targetPresentPerScroll: boolean[]; stop: () => void }>)[key] = {
        targetPresentPerScroll,
        stop: () => document.removeEventListener('scroll', onScroll, { capture: true }),
      }
    }, firstTarget.id)

    // Native single jump with no synthetic scroll event. Rows above firstTarget already have cached heights,
    // so ResizeObserver's layout(saved) keeps offsets[index] and scrollTop unchanged and emits no extra scroll event.
    recordingPostJumpRequests = true
    await scroll.evaluate((el, top) => {
      el.scrollTo({ top, behavior: 'instant' })
    }, targetTop)

    await expect(main.locator(`[data-message-id="${firstTarget.id}"]`)).toBeInViewport()
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/orgs/${orgId}/channels`)
      const data = (await response.json()) as components['schemas']['ChannelList']
      return data.channels.find((c) => c.id === channel.id)?.read_seq
    }).toBeGreaterThanOrEqual(firstTarget.created_seq)
    recordingPostJumpRequests = false

    const targetPresentPerScroll = await scroll.evaluate((el) => {
      const key = Symbol.for('fukulow.e2e.scrollProbe')
      const store = el as unknown as Record<symbol, { targetPresentPerScroll: boolean[]; stop: () => void } | undefined>
      const probe = store[key]
      probe?.stop()
      delete store[key]
      return probe?.targetPresentPerScroll ?? []
    })
    expect(targetPresentPerScroll.length).toBeGreaterThanOrEqual(1)
    expect(targetPresentPerScroll.every((present) => !present)).toBe(true)
    expect(postJumpRefreshRequests).toEqual([])
  } finally {
    await bobContext.close()
  }
})
