import { expect, test, type APIRequestContext, type Browser } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

async function createMemberContext(
  ownerRequest: APIRequestContext,
  browser: Browser,
  org: string,
  role: 'member' | 'guest' = 'member',
) {
  const email = `timeline-geom-${role}-${crypto.randomUUID()}@example.invalid`
  const password = 'Timeline geometry test password'
  const invitation = await secretSafe(() =>
    ownerRequest.post(`/api/v1/orgs/${org}/invites`, { data: { email, role } }),
  )
  expect(invitation.ok()).toBe(true)
  const invite = (await secretSafe(() => invitation.json())) as { token: string }

  const context = await browser.newContext()
  const accepted = await secretSafe(() =>
    context.request.post(`/api/v1/orgs/${org}/invites/accept`, {
      data: { token: invite.token, email, name: role === 'guest' ? 'Geom Guest' : 'Bob', password },
    }),
  )
  expect(accepted.ok()).toBe(true)
  const identity = (await secretSafe(() => accepted.json())) as components['schemas']['Identity']

  const login = await secretSafe(() =>
    context.request.post('/api/v1/session', { data: { email, password } }),
  )
  expect(login.ok()).toBe(true)

  return { context, memberId: identity.member.id }
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

test('moves focus to the Channel list on チャンネル一覧へ across desktop, tablet drawer and phone widths', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const base = `/api/v1/orgs/${orgId}`

  const chRes = await secretSafe(() =>
    page.request.post(`${base}/channels`, { data: { name: `c9-focus-${suffix}`, visibility: 'private' } }),
  )
  expect(chRes.status()).toBe(201)
  const singleChannel = (await secretSafe(() => chRes.json())) as components['schemas']['Channel']

  const { context: guestContext, memberId: guestMemberId } = await createMemberContext(
    page.request,
    browser,
    orgId,
    'guest',
  )
  try {
    const grantGuest = async () => {
      const r = await secretSafe(() =>
        page.request.post(`${base}/channels/${singleChannel.id}/members`, { data: { member_id: guestMemberId } }),
      )
      expect(r.ok()).toBe(true)
    }
    const revokeGuest = async () => {
      const r = await secretSafe(() =>
        page.request.delete(`${base}/channels/${singleChannel.id}/members/${guestMemberId}`),
      )
      expect(r.ok()).toBe(true)
    }

    await grantGuest()
    const guestPage = await guestContext.newPage()

    const nav = guestPage.getByRole('navigation', { name: 'チャンネル' })
    const channelNavById = guestPage.locator('#channel-content')
    const channelListHeading = guestPage.locator('#channel-list-heading')
    const timeline = guestPage.getByRole('region', { name: 'タイムライン' })
    const goToListButton = timeline.getByRole('button', { name: 'チャンネル一覧へ', exact: true })
    const c9Alert = timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })

    for (const width of [1280, 768, 375] as const) {
      await guestPage.setViewportSize({ width, height: 800 })
      await guestPage.goto(`/o/${orgId}/c/${singleChannel.id}`)
      await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
      expect(await channelNavById.getAttribute('aria-labelledby')).toBe('channel-list-heading')
      expect(await channelNavById.getAttribute('aria-label')).toBeNull()

      if (width === 1280) {
        await expect(nav).toBeVisible()
        await expect(channelListHeading).toBeVisible()
      } else {
        await expect(nav).toBeHidden()
        await expect(channelListHeading).toBeHidden()
      }

      await revokeGuest()
      await expect(c9Alert).toBeVisible()
      await expect(goToListButton).toBeVisible()

      // Visibility guard: hidden heading must never receive focus
      if (width >= 600) {
        await channelListHeading.evaluate((el) => el.setAttribute('aria-hidden', 'true'))
        await goToListButton.click()
        await expect(channelListHeading).not.toBeFocused()
        await channelListHeading.evaluate((el) => el.removeAttribute('aria-hidden'))
      }
      if (width === 768) {
        await guestPage.keyboard.press('Escape')
        await expect(nav).toBeHidden()
      }

      await goToListButton.click()
      await expect(nav).toBeVisible()
      await expect(channelListHeading).toBeVisible()
      await expect(channelListHeading).toBeFocused()

      if (width < 600) {
        await expect(guestPage).toHaveURL(`/o/${orgId}`)
        await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
        await expect(timeline).toBeHidden()
      } else {
        await expect(guestPage).toHaveURL(`/o/${orgId}/c/${singleChannel.id}`)
        await expect(guestPage.locator('.workspace')).toHaveAttribute(
          'data-drawer-open',
          width < 960 ? 'true' : 'false',
        )
      }

      await grantGuest()
    }
  } finally {
    await guestContext.close()
  }
})

test('hidden tab, ReplyPanel, Topic summary lines and failed pending sends never mark Unread rows until visible scroll', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const lobbyChannel = await createChannel(page.request, orgId, `lobby-vis-${suffix}`)
  const targetChannel = await createChannel(page.request, orgId, `unread-vis-${suffix}`)
  const topicName = `未読トピック-${suffix}`

  const ownMsg = await postMessage(page.request, orgId, targetChannel.id, 'Aliceの既読メッセージ')
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: ownMsg.history_generation, read_seq: ownMsg.created_seq },
    }),
  )
  expect(markOwn.ok()).toBe(true)

  const { context: bobContext } = await createMemberContext(page.request, browser, orgId)
  try {
    const mainMessages: components['schemas']['Message'][] = []
    for (let i = 1; i <= 14; i++) {
      mainMessages.push(
        await postMessage(
          bobContext.request,
          orgId,
          targetChannel.id,
          `Bobの未読 ${i}\n2行目 ${i}\n3行目 ${i}\n4行目 ${i}`,
        ),
      )
    }
    const topicMsg = await postMessage(bobContext.request, orgId, targetChannel.id, 'トピック内の未読', {
      topicName,
    })

    const markReadSeqs: number[] = []
    await page.route(`**/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as { read_seq?: number }
        if (typeof body?.read_seq === 'number') markReadSeqs.push(body.read_seq)
      }
      await route.continue()
    })

    await page.setViewportSize({ width: 1280, height: 600 })
    await page.goto(`/o/${orgId}/c/${lobbyChannel.id}`)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const channelNav = page.locator('#channel-content')
    const targetChannelRow = channelNav
      .locator('.channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: targetChannel.name })
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 15件')

    // 1. Open targetChannel -> opens at first Unread with 未読 marker; later rows stay Unread
    await targetChannelRow.click()
    await expect(page.getByRole('heading', { level: 1, name: targetChannel.name, exact: true })).toBeVisible()
    const firstUnreadItem = page.locator(`#main-content [data-message-id="${mainMessages[0].id}"]`)
    await expect(firstUnreadItem.locator('[data-read-marker="true"]')).toHaveText('未読')
    await expect.poll(() => markReadSeqs.length).toBeGreaterThan(0)
    const initialMarked = Math.max(...markReadSeqs)
    expect(initialMarked).toBeLessThan(mainMessages[mainMessages.length - 1].created_seq)

    // 2. Opening ReplyPanel never marks additional main or Topic messages as read
    await firstUnreadItem.getByRole('button', { name: '返信' }).click()
    await expect(page.locator('#panel-content')).toBeVisible()
    await page.waitForTimeout(150)
    expect(Math.max(...markReadSeqs)).toBe(initialMarked)
    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()

    // 3. While document is hidden, scrolling through remaining Unread rows sends no markRead
    const countBeforeHidden = markReadSeqs.length
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const scrollEl = page.locator('#main-content .timeline-scroll')
    await scrollEl.evaluate(async (el) => {
      const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
      while (el.scrollTop + el.clientHeight < el.scrollHeight) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
        await new Promise((r) => setTimeout(r, 25))
      }
    })
    await page.waitForTimeout(150)
    expect(markReadSeqs.length).toBe(countBeforeHidden)

    // 4. A failed pending send never advances markRead while hidden
    let failNextSend = true
    await page.route(`**/api/v1/orgs/${orgId}/channels/${targetChannel.id}/messages`, async (route) => {
      if (route.request().method() === 'POST' && failNextSend) {
        failNextSend = false
        await route.abort('failed')
        return
      }
      await route.continue()
    })
    const composer = page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
    await composer.fill('未確定の送信失敗メッセージ')
    await composer.press('Enter')
    await expect(page.locator('#main-content').getByText('未確定の送信失敗メッセージ')).toBeVisible()
    await page.waitForTimeout(150)
    expect(markReadSeqs.length).toBe(countBeforeHidden)

    // 5. Returning to visible and scrolling marks visible confirmed rows, ignores Topic summary line and failed send
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await scrollEl.evaluate(async (el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 25))
      const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
      while (el.scrollTop + el.clientHeight < el.scrollHeight) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
        await new Promise((r) => setTimeout(r, 25))
      }
    })
    await expect.poll(() => Math.max(...markReadSeqs)).toBe(mainMessages[mainMessages.length - 1].created_seq)

    // Topic summary line never marked Topic as read -> Topic badge stays 1
    const summaryBtn = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicMsg.topic_id}"]`)
    await expect(summaryBtn.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')

    // Read marker stays at firstUnreadItem for the entire visit
    await scrollEl.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(firstUnreadItem.locator('[data-read-marker="true"]')).toHaveText('未読')
  } finally {
    await bobContext.close()
  }
})

test('phone 375px: defers first-Unread positioning and markRead while ?panel=topics hides main, then scrolls to first Unread on panel close', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const targetChannel = await createChannel(page.request, orgId, `unread-defer-${suffix}`)

  let lastReadMsg!: components['schemas']['Message']
  for (let i = 1; i <= 4; i++) {
    lastReadMsg = await postMessage(page.request, orgId, targetChannel.id, `既読 ${i}`)
  }
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: lastReadMsg.history_generation, read_seq: lastReadMsg.created_seq },
    }),
  )
  expect(markOwn.ok()).toBe(true)

  const { context: bobContext } = await createMemberContext(page.request, browser, orgId)
  try {
    const unreadMsgs: components['schemas']['Message'][] = []
    for (let i = 1; i <= 10; i++) {
      unreadMsgs.push(
        await postMessage(bobContext.request, orgId, targetChannel.id, `未読 ${i}\n2行目 ${i}\n3行目 ${i}`),
      )
    }

    const markReadSeqs: number[] = []
    await page.route(`**/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as { read_seq?: number }
        if (typeof body?.read_seq === 'number') markReadSeqs.push(body.read_seq)
      }
      await route.continue()
    })

    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/o/${orgId}/c/${targetChannel.id}?panel=topics`)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(page.locator('#panel-content')).toBeVisible()
    await expect(page.locator('#main-content')).toBeHidden()
    await page.waitForTimeout(250)
    expect(markReadSeqs).toEqual([])

    // Closing the panel displays main, scrolls to first Unread, and submits markRead
    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    const firstUnread = page.locator(`#main-content [data-message-id="${unreadMsgs[0].id}"]`)
    await expect(firstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')
    await expect.poll(() => page.locator('#main-content .timeline-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect(firstUnread).toBeInViewport()
    await expect.poll(() => markReadSeqs.length).toBeGreaterThan(0)
  } finally {
    await bobContext.close()
  }
})

test('same-Channel C9 recovery with zero Unread resets scroll state and pins to bottom on reselection', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const base = `/api/v1/orgs/${orgId}`

  const chRes = await secretSafe(() =>
    page.request.post(`${base}/channels`, { data: { name: `c9-scroll-${suffix}`, visibility: 'private' } }),
  )
  expect(chRes.status()).toBe(201)
  const privateChannel = (await secretSafe(() => chRes.json())) as components['schemas']['Channel']

  const { context: guestContext, memberId: guestMemberId } = await createMemberContext(
    page.request,
    browser,
    orgId,
    'guest',
  )
  try {
    const grantGuest = async () => {
      const r = await secretSafe(() =>
        page.request.post(`${base}/channels/${privateChannel.id}/members`, { data: { member_id: guestMemberId } }),
      )
      expect(r.ok()).toBe(true)
    }
    const revokeGuest = async () => {
      const r = await secretSafe(() =>
        page.request.delete(`${base}/channels/${privateChannel.id}/members/${guestMemberId}`),
      )
      expect(r.ok()).toBe(true)
    }

    await grantGuest()
    let lastMsg!: components['schemas']['Message']
    for (let i = 1; i <= 14; i++) {
      lastMsg = await postMessage(page.request, orgId, privateChannel.id, `C9履歴 ${i}\n2行目 ${i}\n3行目 ${i}`)
    }

    const markRes = await secretSafe(() =>
      guestContext.request.put(`${base}/channels/${privateChannel.id}/read`, {
        data: { history_generation: lastMsg.history_generation, read_seq: lastMsg.created_seq },
      }),
    )
    expect(markRes.ok()).toBe(true)

    const guestPage = await guestContext.newPage()
    await guestPage.setViewportSize({ width: 1280, height: 600 })
    await guestPage.goto(`/o/${orgId}/c/${privateChannel.id}`)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const scrollEl = guestPage.locator('#main-content .timeline-scroll')
    const lastRow = guestPage.locator(`#main-content [data-message-id="${lastMsg.id}"]`)
    await expect(lastRow).toBeInViewport()

    // 1. Initial visit with 0 Unread is pinned to bottom
    const initialMetrics = await scrollEl.evaluate((el) => ({
      scrollTop: el.scrollTop,
      maxScroll: el.scrollHeight - el.clientHeight,
    }))
    expect(initialMetrics.maxScroll).toBeGreaterThan(50)
    expect(initialMetrics.scrollTop).toBeGreaterThan(initialMetrics.maxScroll - 40)

    // 2. Scroll upward to top (unpinned)
    await scrollEl.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => scrollEl.evaluate((el) => el.scrollTop)).toBeLessThan(20)

    // 3. Lose access via C9, then re-grant and reselect -> new visit with 0 Unread resets scroll state and pins to bottom
    await revokeGuest()
    const c9Alert = guestPage.locator('#main-content').getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })
    await expect(c9Alert).toBeVisible()

    await grantGuest()
    const channelRow = guestPage.locator('#channel-content .channel-list button').filter({ hasText: privateChannel.name })
    await expect(channelRow).toHaveCount(1)
    await channelRow.click()
    await expect(c9Alert).toHaveCount(0)
    await expect(lastRow).toBeInViewport()
    await expect
      .poll(() => scrollEl.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)
  } finally {
    await guestContext.close()
  }
})

test('phone 375px: keeps following the bottom when a live Message arrives while hidden behind a phone panel in main and Topic views', async ({
  page,
  browser,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const orgId = await signInOwner(page.request)
  const targetChannel = await createChannel(page.request, orgId, `unread-follow-${suffix}`)
  const topicName = `スマホ追従トピック-${suffix}`

  const ownMsg = await postMessage(page.request, orgId, targetChannel.id, '既読メイン1')
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: ownMsg.history_generation, read_seq: ownMsg.created_seq },
    }),
  )
  expect(markOwn.ok()).toBe(true)

  const { context: bobContext } = await createMemberContext(page.request, browser, orgId)
  try {
    const mainMsgs: components['schemas']['Message'][] = []
    for (let i = 1; i <= 10; i++) {
      mainMsgs.push(
        await postMessage(bobContext.request, orgId, targetChannel.id, `メイン未読 ${i}\n2行目 ${i}\n3行目 ${i}`),
      )
    }
    const topicMsgs: components['schemas']['Message'][] = []
    for (let i = 1; i <= 10; i++) {
      topicMsgs.push(
        await postMessage(bobContext.request, orgId, targetChannel.id, `トピック未読 ${i}\n2行目 ${i}\n3行目 ${i}`, {
          topicName,
        }),
      )
    }

    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/o/${orgId}/c/${targetChannel.id}`)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // 1. Main timeline opens at first Unread with 未読 marker
    const mainFirstUnread = page.locator(`#main-content [data-message-id="${mainMsgs[0].id}"]`)
    await expect(mainFirstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')

    // 2. Scroll main to bottom (pinned), open phone panel, receive live main Message, close panel
    const mainScroll = page.locator('#main-content .timeline-scroll')
    await mainScroll.evaluate(async (el) => {
      const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
      while (el.scrollTop + el.clientHeight < el.scrollHeight) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
        await new Promise((r) => setTimeout(r, 25))
      }
    })
    await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')

    const liveMain = await postMessage(bobContext.request, orgId, targetChannel.id, 'メイン新着ライブ')
    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')

    const liveMainRow = page.locator(`#main-content [data-message-id="${liveMain.id}"]`)
    await expect(liveMainRow).toBeInViewport()
    await expect
      .poll(() => mainScroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)

    // 3. Same scenario in TopicView: open Topic -> positions at first Unread -> scroll to bottom -> open panel -> live Topic Message -> close panel
    const summaryBtn = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicMsgs[0].topic_id}"]`)
    await summaryBtn.click()
    await expect(page.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()
    const topicFirstUnread = page.locator(`#main-content [data-message-id="${topicMsgs[0].id}"]`)
    await expect(topicFirstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')

    const topicScroll = page.locator('#main-content .topic-view__scroll')
    await topicScroll.evaluate(async (el) => {
      const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
      while (el.scrollTop + el.clientHeight < el.scrollHeight) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
        await new Promise((r) => setTimeout(r, 25))
      }
    })
    await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')

    const liveTopic = await postMessage(bobContext.request, orgId, targetChannel.id, 'トピック新着ライブ', {
      topicName,
    })
    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')

    const liveTopicRow = page.locator(`#main-content [data-message-id="${liveTopic.id}"]`)
    await expect(liveTopicRow).toBeInViewport()
    await expect
      .poll(() => topicScroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)
  } finally {
    await bobContext.close()
  }
})
