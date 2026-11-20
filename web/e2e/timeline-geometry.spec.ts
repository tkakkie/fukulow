import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type ReadMark = {
  scope: 'channel' | 'topic'
  topicId: string | null
  history_generation: string | undefined
  read_seq: number | undefined
}

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
  try {
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
  } catch (err) {
    await context.close()
    throw err
  }
}

async function postMessage(
  request: APIRequestContext,
  org: string,
  channelId: string,
  body: string,
  opts?: { topicName?: string; replyTo?: string },
): Promise<components['schemas']['Message']> {
  const res = await secretSafe(() =>
    request.post(`/api/v1/orgs/${org}/channels/${channelId}/messages`, {
      data: {
        client_message_id: crypto.randomUUID(),
        body,
        ...(opts?.topicName ? { topic_name: opts.topicName } : {}),
        ...(opts?.replyTo ? { reply_to: opts.replyTo } : {}),
      },
    }),
  )
  expect(res.ok()).toBe(true)
  return (await secretSafe(() => res.json())) as components['schemas']['Message']
}

async function flushAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

async function scrollToBottom(scrollEl: Locator): Promise<void> {
  await scrollEl.evaluate(async (el) => {
    const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
    while (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
      el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
      el.dispatchEvent(new Event('scroll'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      el.dispatchEvent(new Event('scroll'))
    }
  })
}

async function trackReadMarks(page: Page, orgId: string, channelId: string): Promise<ReadMark[]> {
  const marks: ReadMark[] = []
  await page.route(`**/api/v1/orgs/${orgId}/channels/${channelId}/read`, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { history_generation?: string; read_seq?: number }
      marks.push({
        scope: 'channel',
        topicId: null,
        history_generation: body?.history_generation,
        read_seq: body?.read_seq,
      })
    }
    await route.continue()
  })
  await page.route(`**/api/v1/orgs/${orgId}/channels/${channelId}/topics/*/read`, async (route) => {
    if (route.request().method() === 'PUT') {
      const url = new URL(route.request().url())
      const match = url.pathname.match(/\/topics\/([^/]+)\/read$/)
      const body = route.request().postDataJSON() as { history_generation?: string; read_seq?: number }
      marks.push({
        scope: 'topic',
        topicId: match?.[1] ?? null,
        history_generation: body?.history_generation,
        read_seq: body?.read_seq,
      })
    }
    await route.continue()
  })
  return marks
}

async function maxVisibleConfirmedSeq(scrollEl: Locator, seqById: Record<string, number>): Promise<number> {
  return scrollEl.evaluate((el, map) => {
    const cRect = el.getBoundingClientRect()
    let maxSeq = 0
    for (const row of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = row.getAttribute('data-message-id')
      if (!id || !(id in map)) continue
      const r = row.getBoundingClientRect()
      if (r.height === 0 && r.width === 0) continue
      if (r.bottom > cRect.top && r.top < cRect.bottom) {
        maxSeq = Math.max(maxSeq, map[id])
      }
    }
    return maxSeq
  }, seqById)
}

function installWsMessageTracker(page: Page) {
  const receivedIds = new Set<string>()
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return
      try {
        const parsed = JSON.parse(frame.payload) as { type?: string; message?: { id?: string } }
        if (parsed?.type === 'message' && typeof parsed.message?.id === 'string') {
          receivedIds.add(parsed.message.id)
        }
      } catch {
        // Ignore non-JSON frames
      }
    })
  })
  return {
    async waitForMessage(id: string) {
      await expect.poll(() => receivedIds.has(id)).toBe(true)
    },
  }
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
    await guestPage.addInitScript(() => {
      const calls: string[] = []
      ;(window as unknown as { __historyCalls: string[] }).__historyCalls = calls
      const origPush = history.pushState.bind(history)
      const origReplace = history.replaceState.bind(history)
      history.pushState = (state, title, url) => {
        calls.push(`push:${String(url ?? '')}`)
        return origPush(state, title, url)
      }
      history.replaceState = (state, title, url) => {
        calls.push(`replace:${String(url ?? '')}`)
        return origReplace(state, title, url)
      }
    })
    const clearHistoryCalls = () =>
      guestPage.evaluate(() => {
        ;(window as unknown as { __historyCalls: string[] }).__historyCalls.length = 0
      })
    const getHistoryCalls = () =>
      guestPage.evaluate(() => [...(window as unknown as { __historyCalls: string[] }).__historyCalls])

    const nav = guestPage.getByRole('navigation', { name: 'チャンネル' })
    const channelNavById = guestPage.locator('#channel-content')
    const channelListHeading = guestPage.locator('#channel-list-heading')
    const timeline = guestPage.getByRole('region', { name: 'タイムライン' })
    const goToListButton = timeline.getByRole('button', { name: 'チャンネル一覧へ', exact: true })
    const c9Alert = timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })

    // 1. Desktop (1280px): heading semantics, hidden-heading preserves action-button focus, normal click focuses heading with zero History writes
    await guestPage.setViewportSize({ width: 1280, height: 800 })
    await guestPage.goto(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    expect(await channelNavById.getAttribute('aria-labelledby')).toBe('channel-list-heading')
    expect(await channelNavById.getAttribute('aria-label')).toBeNull()
    expect(await channelListHeading.evaluate((el) => el.tagName)).toBe('H2')
    await expect(channelListHeading).toHaveText('チャンネル')
    await expect(channelListHeading).toHaveAttribute('tabindex', '-1')
    await expect(nav).toBeVisible()
    await expect(channelListHeading).toBeVisible()

    await revokeGuest()
    await expect(c9Alert).toBeVisible()
    await expect(goToListButton).toBeVisible()

    await channelListHeading.evaluate((el) => {
      ;(el as HTMLElement).hidden = true
    })
    await clearHistoryCalls()
    await goToListButton.focus()
    await expect(goToListButton).toBeFocused()
    await goToListButton.click()
    await flushAnimationFrames(guestPage)
    await expect(channelListHeading).toBeHidden()
    await expect(goToListButton).toBeFocused()
    expect(await getHistoryCalls()).toEqual([])
    await channelListHeading.evaluate((el) => {
      ;(el as HTMLElement).hidden = false
    })

    await clearHistoryCalls()
    await goToListButton.click()
    await expect(nav).toBeVisible()
    await expect(channelListHeading).toBeVisible()
    await expect(channelListHeading).toBeFocused()
    await expect(guestPage).toHaveURL(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-drawer-open', 'false')
    expect(await getHistoryCalls()).toEqual([])

    // 2. Tablet (768px): popstate to /o/{org} keeps rail-button focus while heading is hidden; チャンネル一覧へ opens drawer and focuses heading with zero History writes
    await grantGuest()
    await guestPage.setViewportSize({ width: 768, height: 800 })
    await guestPage.goto(`/o/${orgId}`)
    const railChannelBtn = guestPage.getByRole('button', { name: 'チャンネル一覧', exact: true })
    await expect(railChannelBtn).toBeVisible()
    await railChannelBtn.click()
    await expect(nav).toBeVisible()
    await nav.getByRole('button', { name: singleChannel.name }).click()
    await expect(guestPage).toHaveURL(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(nav).toBeHidden()
    await expect(channelListHeading).toBeHidden()

    await revokeGuest()
    await expect(c9Alert).toBeVisible()
    await expect(goToListButton).toBeVisible()

    await railChannelBtn.focus()
    await expect(railChannelBtn).toBeFocused()
    await guestPage.goBack()
    await expect(guestPage).toHaveURL(`/o/${orgId}`)
    await flushAnimationFrames(guestPage)
    await expect(channelListHeading).toBeHidden()
    await expect(railChannelBtn).toBeFocused()

    await guestPage.goForward()
    await expect(guestPage).toHaveURL(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(c9Alert).toBeVisible()
    await expect(goToListButton).toBeVisible()

    await channelListHeading.evaluate((el) => {
      ;(el as HTMLElement).hidden = true
    })
    await goToListButton.click()
    await flushAnimationFrames(guestPage)
    await expect(channelListHeading).not.toBeFocused()
    await channelListHeading.evaluate((el) => {
      ;(el as HTMLElement).hidden = false
    })
    await guestPage.keyboard.press('Escape')
    await expect(nav).toBeHidden()

    await clearHistoryCalls()
    await goToListButton.focus()
    await expect(goToListButton).toBeFocused()
    await goToListButton.click()
    await expect(nav).toBeVisible()
    await expect(channelListHeading).toBeVisible()
    await expect(channelListHeading).toBeFocused()
    await expect(guestPage).toHaveURL(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-drawer-open', 'true')
    expect(await getHistoryCalls()).toEqual([])

    // 3. Phone (375px): hidden heading never receives focus on C9 action; normal click closes drawer, replaces URL, switches to channels level, and focuses heading
    await grantGuest()
    await guestPage.setViewportSize({ width: 375, height: 800 })
    await guestPage.goto(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(nav).toBeHidden()

    await revokeGuest()
    await expect(c9Alert).toBeVisible()
    await expect(goToListButton).toBeVisible()

    await channelListHeading.evaluate((el) => {
      ;(el as HTMLElement).hidden = true
    })
    await goToListButton.focus()
    await expect(goToListButton).toBeFocused()
    await goToListButton.click()
    await expect(guestPage).toHaveURL(`/o/${orgId}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-drawer-open', 'false')
    await flushAnimationFrames(guestPage)
    await expect(channelListHeading).toBeHidden()
    await expect(channelListHeading).not.toBeFocused()

    // Re-enter the unavailable Channel URL to verify normal phone C9 action with visible heading
    await guestPage.goto(`/o/${orgId}/c/${singleChannel.id}`)
    await expect(c9Alert).toBeVisible()
    await expect(goToListButton).toBeVisible()

    await clearHistoryCalls()
    await goToListButton.focus()
    await expect(goToListButton).toBeFocused()
    await goToListButton.click()
    await expect(nav).toBeVisible()
    await expect(channelListHeading).toBeVisible()
    await expect(channelListHeading).toBeFocused()
    await expect(guestPage).toHaveURL(`/o/${orgId}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-drawer-open', 'false')
    await expect(timeline).toBeHidden()
    expect(await getHistoryCalls()).toEqual([`replace:/o/${orgId}`])
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
  const historyGeneration = ownMsg.history_generation
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: historyGeneration, read_seq: ownMsg.created_seq },
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
    // Seed an unread reply to mainMessages[0] whose seq is past the initial viewport so ReplyPanel renders an unread row
    const unreadReply = await postMessage(
      bobContext.request,
      orgId,
      targetChannel.id,
      'ReplyPanel内の未読返信',
      { replyTo: mainMessages[0].id },
    )
    const topicMsg = await postMessage(bobContext.request, orgId, targetChannel.id, 'トピック内の未読', {
      topicName,
    })

    const seqById: Record<string, number> = { [ownMsg.id]: ownMsg.created_seq }
    for (const m of mainMessages) seqById[m.id] = m.created_seq
    seqById[unreadReply.id] = unreadReply.created_seq

    const readMarks = await trackReadMarks(page, orgId, targetChannel.id)

    await page.setViewportSize({ width: 1280, height: 600 })
    await page.goto(`/o/${orgId}/c/${lobbyChannel.id}`)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const channelNav = page.locator('#channel-content')
    const targetChannelRow = channelNav
      .locator('.channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: targetChannel.name })
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 16件')

    // 1. Open targetChannel -> opens at first Unread with 未読 marker; only visible confirmed rows are marked
    await targetChannelRow.click()
    await expect(page.getByRole('heading', { level: 1, name: targetChannel.name, exact: true })).toBeVisible()
    const scrollEl = page.locator('#main-content .timeline-scroll')
    const firstUnreadItem = page.locator(`#main-content [data-message-id="${mainMessages[0].id}"]`)
    await expect(firstUnreadItem.locator('[data-read-marker="true"]')).toHaveText('未読')
    await expect.poll(() => readMarks.length).toBeGreaterThan(0)
    await flushAnimationFrames(page)

    const initialVisibleSeq = await maxVisibleConfirmedSeq(scrollEl, seqById)
    expect(initialVisibleSeq).toBeGreaterThanOrEqual(mainMessages[0].created_seq)
    expect(initialVisibleSeq).toBeLessThan(mainMessages[mainMessages.length - 1].created_seq)
    const afterOpenMarks = [...readMarks]
    expect(afterOpenMarks).toEqual([
      {
        scope: 'channel',
        topicId: null,
        history_generation: historyGeneration,
        read_seq: initialVisibleSeq,
      },
    ])

    const expectedRemainingAfterOpen = 16 - (initialVisibleSeq - ownMsg.created_seq)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute(
      'aria-label',
      `未読 ${expectedRemainingAfterOpen}件`,
    )

    // 2. Opening ReplyPanel with an unread reply never marks Channel or Topic messages as read
    await firstUnreadItem.getByRole('button', { name: /返信/ }).click()
    await expect(page.locator('#panel-content')).toBeVisible()
    await expect(page.locator(`#panel-content [data-message-id="${unreadReply.id}"]`)).toBeVisible()
    await flushAnimationFrames(page)
    expect(readMarks).toEqual(afterOpenMarks)
    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('#panel-content')).toHaveCount(0)

    // 3. While document is hidden, scrolling through remaining Unread rows sends no markRead and keeps Unread count unchanged
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await scrollToBottom(scrollEl)
    await flushAnimationFrames(page)
    expect(readMarks).toEqual(afterOpenMarks)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute(
      'aria-label',
      `未読 ${expectedRemainingAfterOpen}件`,
    )

    // 4. A failed pending send reaches failed state while hidden and never advances markRead
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
    await expect(page.locator('#main-content').getByText('送信を確認できませんでした。')).toBeVisible()
    await expect(page.locator('#main-content').getByRole('button', { name: '再送する', exact: true })).toBeVisible()
    await expect(page.locator('#main-content').getByText('未確定の送信失敗メッセージ')).toBeVisible()
    await flushAnimationFrames(page)
    expect(readMarks).toEqual(afterOpenMarks)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute(
      'aria-label',
      `未読 ${expectedRemainingAfterOpen}件`,
    )

    // 5. Return to visible, scroll one controlled viewport step down from first Unread, then scroll to bottom: assert full ordered request sequence
    await scrollEl.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await flushAnimationFrames(page)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flushAnimationFrames(page)

    await scrollEl.evaluate((el) => {
      el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.floor(el.clientHeight * 0.7))
      el.dispatchEvent(new Event('scroll'))
    })
    await flushAnimationFrames(page)
    const midVisibleSeq = await maxVisibleConfirmedSeq(scrollEl, seqById)
    expect(midVisibleSeq).toBeGreaterThan(initialVisibleSeq)
    expect(midVisibleSeq).toBeLessThan(unreadReply.created_seq)

    await expect.poll(() => readMarks.at(-1)?.read_seq).toBe(midVisibleSeq)
    await flushAnimationFrames(page)
    const afterMidMarks = [...readMarks]
    expect(afterMidMarks).toEqual([
      ...afterOpenMarks,
      {
        scope: 'channel',
        topicId: null,
        history_generation: historyGeneration,
        read_seq: midVisibleSeq,
      },
    ])

    // sequenceToSubmit advances only across a contiguous prefix of presented rows, so step
    // through the remaining viewport windows deterministically and await each PUT /read before the next step.
    const expectedMarks: ReadMark[] = [...afterMidMarks]
    let lastExpectedSeq = midVisibleSeq
    while (await scrollEl.evaluate((el) => el.scrollTop + el.clientHeight < el.scrollHeight - 1)) {
      await scrollEl.evaluate((el) => {
        const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
      })
      await flushAnimationFrames(page)
      const stepVisibleSeq = await maxVisibleConfirmedSeq(scrollEl, seqById)
      if (stepVisibleSeq > lastExpectedSeq) {
        lastExpectedSeq = stepVisibleSeq
        expectedMarks.push({
          scope: 'channel',
          topicId: null,
          history_generation: historyGeneration,
          read_seq: stepVisibleSeq,
        })
        await expect.poll(() => readMarks.at(-1)?.read_seq).toBe(stepVisibleSeq)
        await flushAnimationFrames(page)
      }
    }
    expect(lastExpectedSeq).toBe(unreadReply.created_seq)
    expect(expectedMarks.length).toBeGreaterThan(afterMidMarks.length)
    expect(readMarks).toEqual(expectedMarks)

    // Topic summary line never marked Topic as read -> Topic badge and Channel badge stay 1
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
  const historyGeneration = lastReadMsg.history_generation
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: historyGeneration, read_seq: lastReadMsg.created_seq },
    }),
  )
  expect(markOwn.ok()).toBe(true)

  const { context: bobContext } = await createMemberContext(page.request, browser, orgId)
  try {
    const unreadMsgs: components['schemas']['Message'][] = []
    for (let i = 1; i <= 10; i++) {
      unreadMsgs.push(
        await postMessage(bobContext.request, orgId, targetChannel.id, `未読 ${i}`),
      )
    }
    const seqById: Record<string, number> = {}
    for (const m of unreadMsgs) seqById[m.id] = m.created_seq

    const readMarks = await trackReadMarks(page, orgId, targetChannel.id)

    await page.setViewportSize({ width: 375, height: 667 })
    const initialTimelineLoaded = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/timeline`) &&
        res.request().method() === 'GET' &&
        res.status() === 200,
    )
    await page.goto(`/o/${orgId}/c/${targetChannel.id}?panel=topics`)
    await initialTimelineLoaded
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(page.locator('#panel-content')).toBeVisible()
    await expect(page.locator('#main-content')).toBeHidden()
    const firstUnread = page.locator(`#main-content [data-message-id="${unreadMsgs[0].id}"]`)
    await expect(firstUnread).toBeAttached()
    await flushAnimationFrames(page)

    const scrollEl = page.locator('#main-content .timeline-scroll')
    expect(await scrollEl.evaluate((el) => el.scrollTop)).toBe(0)
    expect(readMarks).toEqual([])

    // Closing the panel displays main, aligns to first Unread, and submits one complete markRead for the last visible confirmed row
    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    const marker = firstUnread.locator('[data-read-marker="true"]')
    await expect(marker).toHaveText('未読')
    await expect.poll(() => readMarks.length).toBeGreaterThan(0)
    await flushAnimationFrames(page)

    const alignment = await scrollEl.evaluate((el) => {
      const markerEl = el.querySelector<HTMLElement>('[data-read-marker="true"]')
      if (!markerEl) return null
      const cRect = el.getBoundingClientRect()
      const mRect = markerEl.getBoundingClientRect()
      return {
        scrollTop: el.scrollTop,
        offsetFromTop: mRect.top - cRect.top,
      }
    })
    expect(alignment).not.toBeNull()
    expect(alignment!.scrollTop).toBeGreaterThan(0)
    expect(Math.abs(alignment!.offsetFromTop)).toBeLessThanOrEqual(8)

    const lastVisibleSeq = await maxVisibleConfirmedSeq(scrollEl, seqById)
    expect(lastVisibleSeq).toBeGreaterThanOrEqual(unreadMsgs[0].created_seq)
    expect(readMarks).toEqual([
      {
        scope: 'channel',
        topicId: null,
        history_generation: historyGeneration,
        read_seq: lastVisibleSeq,
      },
    ])
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
  const historyGeneration = ownMsg.history_generation
  const markOwn = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/read`, {
      data: { history_generation: historyGeneration, read_seq: ownMsg.created_seq },
    }),
  )
  expect(markOwn.ok()).toBe(true)

  const ownTopicMsg = await postMessage(page.request, orgId, targetChannel.id, '既読トピック1', { topicName })
  const markOwnTopic = await secretSafe(() =>
    page.request.put(`/api/v1/orgs/${orgId}/channels/${targetChannel.id}/topics/${ownTopicMsg.topic_id}/read`, {
      data: { history_generation: historyGeneration, read_seq: ownTopicMsg.created_seq },
    }),
  )
  expect(markOwnTopic.ok()).toBe(true)

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

    const readMarks = await trackReadMarks(page, orgId, targetChannel.id)
    const wsTracker = installWsMessageTracker(page)

    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`/o/${orgId}/c/${targetChannel.id}`)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // 1. Main timeline opens at first Unread with 未読 marker
    const mainFirstUnread = page.locator(`#main-content [data-message-id="${mainMsgs[0].id}"]`)
    await expect(mainFirstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')

    // 2. Scroll main to bottom (pinned), open phone panel, receive live main Message while hidden, then close panel
    const mainScroll = page.locator('#main-content .timeline-scroll')
    await scrollToBottom(mainScroll)
    await expect.poll(() => readMarks.at(-1)?.read_seq).toBe(mainMsgs[mainMsgs.length - 1].created_seq)

    await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    await expect(page.locator('#main-content')).toBeHidden()
    const mainMarksBeforeLive = readMarks.length

    const liveMain = await postMessage(bobContext.request, orgId, targetChannel.id, 'メイン新着ライブ')
    await wsTracker.waitForMessage(liveMain.id)
    await flushAnimationFrames(page)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    expect(readMarks.length).toBe(mainMarksBeforeLive)

    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')

    const liveMainRow = page.locator(`#main-content [data-message-id="${liveMain.id}"]`)
    await expect(liveMainRow).toBeInViewport()
    await expect
      .poll(() => mainScroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)
    await expect.poll(() => readMarks.at(-1)).toEqual({
      scope: 'channel',
      topicId: null,
      history_generation: historyGeneration,
      read_seq: liveMain.created_seq,
    })

    // Read marker stays at mainMsgs[0] after reopening
    await mainScroll.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(mainFirstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')

    // 3. Same scenario in TopicView: open Topic -> positions at first Unread -> scroll to bottom -> open panel -> live Topic Message while hidden -> close panel
    await scrollToBottom(mainScroll)
    const summaryBtn = page.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicMsgs[0].topic_id}"]`)
    await summaryBtn.click()
    await expect(page.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()
    const topicFirstUnread = page.locator(`#main-content [data-message-id="${topicMsgs[0].id}"]`)
    await expect(topicFirstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')

    const topicScroll = page.locator('#main-content .topic-view__scroll')
    await scrollToBottom(topicScroll)
    await expect.poll(() => readMarks.at(-1)).toEqual({
      scope: 'topic',
      topicId: topicMsgs[0].topic_id,
      history_generation: historyGeneration,
      read_seq: topicMsgs[topicMsgs.length - 1].created_seq,
    })

    await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    await expect(page.locator('#main-content')).toBeHidden()
    const topicMarksBeforeLive = readMarks.length

    const liveTopic = await postMessage(bobContext.request, orgId, targetChannel.id, 'トピック新着ライブ', {
      topicName,
    })
    await wsTracker.waitForMessage(liveTopic.id)
    await flushAnimationFrames(page)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    expect(readMarks.length).toBe(topicMarksBeforeLive)

    await page.locator('#panel-content').getByRole('button', { name: 'パネルを閉じる(Esc)' }).click()
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')

    const liveTopicRow = page.locator(`#main-content [data-message-id="${liveTopic.id}"]`)
    await expect(liveTopicRow).toBeInViewport()
    await expect
      .poll(() => topicScroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40)
    await expect.poll(() => readMarks.at(-1)).toEqual({
      scope: 'topic',
      topicId: topicMsgs[0].topic_id,
      history_generation: historyGeneration,
      read_seq: liveTopic.created_seq,
    })

    // Read marker stays at topicMsgs[0] after reopening
    await topicScroll.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(topicFirstUnread.locator('[data-read-marker="true"]')).toHaveText('未読')
  } finally {
    await bobContext.close()
  }
})
