import { expect, test, type Page } from '@playwright/test'
import {
  closePageSockets,
  createChannelApi,
  ensureOwnerAndSignIn,
  installSocketCloseHook,
  inviteAndSignInPeerViaUi,
  secretSafe,
  sendApiMessage,
} from './helpers.ts'

const mainComposer = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
const topicNameInput = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'トピック名', exact: true })
const replyComposer = (page: Page) =>
  page.locator('#panel-content').getByRole('textbox', { name: 'メッセージ', exact: true })

test('Invite and Guest visibility', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let guestContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)

    const initialGranted = await createChannelApi(ownerPage.request, orgId, `guest-initial-${suffix}`, 'public')
    const ungrantedPublic = await createChannelApi(ownerPage.request, orgId, `guest-ungranted-pub-${suffix}`, 'public')
    const grantedPublic = await createChannelApi(ownerPage.request, orgId, `guest-granted-pub-${suffix}`, 'public')
    const grantedPrivate = await createChannelApi(ownerPage.request, orgId, `guest-granted-priv-${suffix}`, 'private')
    const ungrantedPrivate = await createChannelApi(ownerPage.request, orgId, `guest-ungranted-priv-${suffix}`, 'private')

    await ownerPage.reload()
    await expect(ownerPage.getByText('Acme / Alice さん')).toBeVisible()

    // Owner creates a real Invite in the UI; second Account accepts it and signs in as a Guest.
    const guest = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'guest', suffix)
    guestContext = guest.context
    const guestPage = guest.page

    // Before any grant, the Guest sees none of the Channels (no implicit public Channel access).
    const guestChannelList = guestPage.locator('#channel-content .channel-list')
    await expect(guestChannelList.getByRole('button', { name: `# ${initialGranted.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `# ${ungrantedPublic.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `# ${grantedPublic.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `🔒 ${grantedPrivate.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `🔒 ${ungrantedPrivate.name}`, exact: true })).toHaveCount(0)

    // Owner grants one initial Channel via the UI Member panel; Guest reloads and sees only that granted Channel.
    await ownerPage.reload()
    await ownerPage.getByRole('button', { name: `# ${initialGranted.name}`, exact: true }).click()
    await ownerPage.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await ownerPage.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const memberPanel = ownerPage.getByRole('region', { name: 'チャンネルのメンバー', exact: true })
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    await guestPage.reload()
    await expect(guestPage.getByText(`Acme / ${guest.name} さん`)).toBeVisible()
    await expect(guestChannelList.getByRole('button', { name: `# ${initialGranted.name}`, exact: true })).toBeVisible()
    await expect(guestChannelList.getByRole('button', { name: `# ${ungrantedPublic.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `# ${grantedPublic.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `🔒 ${grantedPrivate.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `🔒 ${ungrantedPrivate.name}`, exact: true })).toHaveCount(0)

    // Owner grants a public Channel and a private Channel through the UI; Guest sees both after reloading the Channel list.
    await ownerPage.getByRole('button', { name: `# ${grantedPublic.name}`, exact: true }).click()
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    await ownerPage.getByRole('button', { name: `🔒 ${grantedPrivate.name}`, exact: true }).click()
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    await guestPage.reload()
    await expect(guestPage.getByText(`Acme / ${guest.name} さん`)).toBeVisible()
    await expect(guestChannelList.getByRole('button', { name: `# ${initialGranted.name}`, exact: true })).toBeVisible()
    await expect(guestChannelList.getByRole('button', { name: `# ${grantedPublic.name}`, exact: true })).toBeVisible()
    await expect(guestChannelList.getByRole('button', { name: `🔒 ${grantedPrivate.name}`, exact: true })).toBeVisible()
    await expect(guestChannelList.getByRole('button', { name: `# ${ungrantedPublic.name}`, exact: true })).toHaveCount(0)
    await expect(guestChannelList.getByRole('button', { name: `🔒 ${ungrantedPrivate.name}`, exact: true })).toHaveCount(0)
  } finally {
    await guestContext?.close()
    await ownerContext.close()
  }
})

test('Topics (P1-P5)', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)
    const channel = await createChannelApi(ownerPage.request, orgId, `topics-${suffix}`, 'public')

    const peer = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'member', suffix)
    peerContext = peer.context
    const peerPage = peer.page

    await ownerPage.goto(`/o/${orgId}/c/${channel.id}`)
    await peerPage.goto(`/o/${orgId}/c/${channel.id}`)
    await expect(ownerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const topicName = `設計トピック-${suffix}`
    const firstTopicBody = `トピック初回投稿-${suffix}`
    const mainBody = `メインタイムライン発言-${suffix}`
    const secondTopicBody = `トピック一覧からの追記-${suffix}`
    const thirdTopicBody = `サマリー行からの追記-${suffix}`

    // Owner creates a Topic with its first Message through the UI.
    await topicNameInput(ownerPage).fill(topicName)
    await mainComposer(ownerPage).fill(firstTopicBody)
    await ownerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()

    const ownerSummary = ownerPage.locator('#main-content button[data-topic-id]')
    const peerSummary = peerPage.locator('#main-content button[data-topic-id]')
    await expect(ownerSummary).toHaveCount(1)
    await expect(peerSummary).toHaveCount(1)
    const topicId = await ownerSummary.getAttribute('data-topic-id')
    expect(topicId).toBeTruthy()

    for (const summary of [ownerSummary, peerSummary]) {
      await expect(summary).toContainText(`トピック: ${topicName}`)
      await expect(summary).toContainText('1件›')
      await expect(summary).toContainText(firstTopicBody)
    }

    // Topic Messages are not rendered as MessageRows in the main timeline.
    await expect(ownerPage.locator('#main-content .ui-message-row')).toHaveCount(0)
    await expect(peerPage.locator('#main-content .ui-message-row')).toHaveCount(0)

    // Post an ordinary main-timeline Message so the summary line is above it before Topic activity moves it.
    await mainComposer(ownerPage).fill(mainBody)
    await ownerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(peerPage.locator('#main-content .timeline-list__item')).toHaveCount(2)
    await expect(peerPage.locator('#main-content .timeline-list__item').nth(0)).toContainText(`トピック: ${topicName}`)
    await expect(peerPage.locator('#main-content .timeline-list__item').nth(1)).toContainText(mainBody)

    // Peer opens the Topic from the Topic list (right panel) and posts through its Composer.
    await peerPage.locator('#channel-content').getByRole('button', { name: 'すべてのトピック(1)›', exact: true }).click()
    const panelTopicBtn = peerPage.locator(`#panel-content button[data-topic-id="${topicId}"]`)
    await expect(panelTopicBtn).toBeVisible()
    await panelTopicBtn.click()
    await expect(peerPage.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()

    // Topic view contains only Topic Messages (not the main-timeline Message).
    await expect(peerPage.locator('#main-content .topic-view__item')).toHaveCount(1)
    await expect(peerPage.locator('#main-content .topic-view__item').first()).toContainText(firstTopicBody)
    await expect(peerPage.locator('#main-content')).not.toContainText(mainBody)

    await mainComposer(peerPage).fill(secondTopicBody)
    await peerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(peerPage.locator('#main-content .topic-view__item')).toHaveCount(2)
    await expect(peerPage.locator('#main-content .topic-view__item').nth(1)).toContainText(secondTopicBody)

    // Owner's main timeline still shows exactly one summary line for the Topic, moved to latest activity with count 2.
    const ownerItemsAfterSecond = ownerPage.locator('#main-content .timeline-list__item')
    await expect(ownerItemsAfterSecond).toHaveCount(2)
    await expect(ownerItemsAfterSecond.nth(0)).toContainText(mainBody)
    await expect(ownerItemsAfterSecond.nth(1)).toContainText(`トピック: ${topicName}`)
    await expect(ownerItemsAfterSecond.nth(1)).toContainText('2件›')
    await expect(ownerItemsAfterSecond.nth(1)).toContainText(secondTopicBody)
    await expect(ownerPage.locator('#main-content button[data-topic-id]')).toHaveCount(1)
    await expect(ownerPage.locator('#main-content .ui-message-row')).toHaveCount(1)

    // Owner opens the Topic from its summary line and posts through its Composer.
    await ownerSummary.click()
    await expect(ownerPage.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()
    await expect(ownerPage.locator('#main-content .topic-view__item')).toHaveCount(2)
    await expect(ownerPage.locator('#main-content')).not.toContainText(mainBody)

    await mainComposer(ownerPage).fill(thirdTopicBody)
    await ownerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(ownerPage.locator('#main-content .topic-view__item')).toHaveCount(3)
    await expect(peerPage.locator('#main-content .topic-view__item')).toHaveCount(3)
    await expect(peerPage.locator('#main-content .topic-view__item').nth(2)).toContainText(thirdTopicBody)

    // Both return to the main timeline and see 1 summary line with count 3 and latest activity.
    await ownerPage.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
    await peerPage.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()

    for (const p of [ownerPage, peerPage]) {
      const summaries = p.locator('#main-content button[data-topic-id]')
      await expect(summaries).toHaveCount(1)
      await expect(summaries).toContainText(`トピック: ${topicName}`)
      await expect(summaries).toContainText('3件›')
      await expect(summaries).toContainText(thirdTopicBody)
      await expect(p.locator('#main-content .ui-message-row')).toHaveCount(1)
    }
  } finally {
    await peerContext?.close()
    await ownerContext.close()
  }
})

test('Main-timeline paging (P2, P5)', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)
    const channel = await createChannelApi(ownerPage.request, orgId, `paging-${suffix}`, 'public')

    const peer = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'member', suffix)
    peerContext = peer.context
    const peerPage = peer.page

    // Seed 55 items on the main timeline:
    // - 1 older Topic (at position 1) that will be bumped by live activity while paging
    // - 1 older Topic (at position 2) that stays on the older page
    // - 3 older plain Messages (at positions 3..5)
    // - 50 newer plain Messages (at positions 6..55), filling the initial page (limit 50)
    const movedTopicName = `移動トピック-${suffix}`
    const staticTopicName = `固定トピック-${suffix}`
    const movedTopicFirst = await sendApiMessage(ownerPage.request, orgId, channel.id, {
      body: `移動トピック初回-${suffix}`,
      topic_name: movedTopicName,
    })
    const staticTopicFirst = await sendApiMessage(ownerPage.request, orgId, channel.id, {
      body: `固定トピック初回-${suffix}`,
      topic_name: staticTopicName,
    })
    for (let i = 1; i <= 53; i++) {
      await sendApiMessage(ownerPage.request, orgId, channel.id, {
        body: `ページング発言-${String(i).padStart(2, '0')}-${suffix}`,
      })
    }

    await ownerPage.goto(`/o/${orgId}/c/${channel.id}`)
    await peerPage.goto(`/o/${orgId}/c/${channel.id}`)
    await expect(ownerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // Initial page (limit 50) shows messages 04..53 (50 items) and has "以前のメッセージを読み込む".
    const loadOlderBtn = ownerPage.locator('#main-content').getByRole('button', { name: '以前のメッセージを読み込む', exact: true })
    await expect(loadOlderBtn).toBeVisible()
    await expect(ownerPage.locator('#main-content .timeline-list__item')).toHaveCount(50)

    // Before paging with the initial as_of_seq, the second context posts to movedTopic (moving it above W)
    // and also posts a new plain Message through the UI.
    await peerPage.goto(`/o/${orgId}/c/${channel.id}/t/${movedTopicFirst.topic_id}`)
    await expect(peerPage.getByRole('heading', { level: 1, name: movedTopicName, exact: true })).toBeVisible()
    const liveMovedTopicBody = `移動トピックライブ追記-${suffix}`
    await mainComposer(peerPage).fill(liveMovedTopicBody)
    await peerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()

    await peerPage.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
    const liveMainBody = `ページング中ライブ発言-${suffix}`
    await mainComposer(peerPage).fill(liveMainBody)
    await peerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()

    // Wait for Owner's stream to receive both live posts before clicking "以前のメッセージを読み込む".
    await expect(ownerPage.locator('#main-content').getByText(liveMainBody)).toBeVisible()
    await expect(ownerPage.locator(`#main-content button[data-topic-id="${movedTopicFirst.topic_id}"]`)).toContainText(liveMovedTopicBody)

    // Now Owner pages older items using the initial as_of_seq.
    const timelineRespPromise = ownerPage.waitForResponse(
      (res) =>
        new URL(res.url()).pathname.endsWith(`/channels/${channel.id}/timeline`) &&
        new URL(res.url()).searchParams.has('as_of_seq') &&
        new URL(res.url()).searchParams.has('before_position'),
    )
    await loadOlderBtn.click()
    const timelineResp = await timelineRespPromise
    expect(timelineResp.ok()).toBe(true)
    await expect(loadOlderBtn).toHaveCount(0)

    // Verify P2 & P5:
    // - Total lines: 53 seeded plain messages + 1 live plain message + 2 Topics = 56 lines
    // - No line is omitted and none is shown twice.
    const allItems = ownerPage.locator('#main-content .timeline-list__item')
    await expect(allItems).toHaveCount(56)
    await expect(ownerPage.locator(`#main-content button[data-topic-id="${movedTopicFirst.topic_id}"]`)).toHaveCount(1)
    await expect(ownerPage.locator(`#main-content button[data-topic-id="${movedTopicFirst.topic_id}"]`)).toContainText('2件›')
    await expect(ownerPage.locator(`#main-content button[data-topic-id="${movedTopicFirst.topic_id}"]`)).toContainText(liveMovedTopicBody)
    await expect(ownerPage.locator(`#main-content button[data-topic-id="${staticTopicFirst.topic_id}"]`)).toHaveCount(1)
    await expect(ownerPage.locator(`#main-content button[data-topic-id="${staticTopicFirst.topic_id}"]`)).toContainText('1件›')

    for (const i of [1, 2, 3, 4, 53]) {
      const text = `ページング発言-${String(i).padStart(2, '0')}-${suffix}`
      await expect(ownerPage.locator('#main-content .ui-message-row').filter({ hasText: text })).toHaveCount(1)
    }
    await expect(ownerPage.locator('#main-content .ui-message-row').filter({ hasText: liveMainBody })).toHaveCount(1)

    // Also verify no duplicate data-message-id attributes in the rendered list.
    const itemIds = await allItems.evaluateAll((els) => els.map((el) => el.getAttribute('data-message-id')))
    expect(new Set(itemIds).size).toBe(56)
  } finally {
    await peerContext?.close()
    await ownerContext.close()
  }
})

test('Reply chain (P6, P7)', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)
    const channel = await createChannelApi(ownerPage.request, orgId, `replies-${suffix}`, 'public')

    const peer = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'member', suffix)
    peerContext = peer.context
    const peerPage = peer.page

    // Seed a Topic root Message with 51 replies (including descendants and siblings) so the chain
    // requires paging ("さらに返信を読み込む", limit 50: root + 49 replies, leaving 2 for the second page),
    // plus 50 plain Messages after them so the initial unfiltered /messages page does not pre-populate all replies.
    const topicName = `返信トピック-${suffix}`
    const rootMsg = await sendApiMessage(ownerPage.request, orgId, channel.id, {
      body: `トピック親メッセージ-${suffix}`,
      topic_name: topicName,
    })
    expect(rootMsg.topic_id).toBeTruthy()
    const childA = await sendApiMessage(ownerPage.request, orgId, channel.id, {
      body: `子返信A-01-${suffix}`,
      reply_to: rootMsg.id,
    })
    const siblingB = await sendApiMessage(ownerPage.request, orgId, channel.id, {
      body: `兄弟返信B-02-${suffix}`,
      reply_to: rootMsg.id,
    })
    const grandchildA1 = await sendApiMessage(ownerPage.request, orgId, channel.id, {
      body: `孫返信A1-03-${suffix}`,
      reply_to: childA.id,
    })
    expect(grandchildA1.reply_root_id).toBe(rootMsg.id)
    expect(grandchildA1.topic_id).toBe(rootMsg.topic_id)

    for (let i = 4; i <= 51; i++) {
      await sendApiMessage(ownerPage.request, orgId, channel.id, {
        body: `連鎖返信-${String(i).padStart(2, '0')}-${suffix}`,
        reply_to: i % 2 === 0 ? childA.id : siblingB.id,
      })
    }
    for (let i = 1; i <= 50; i++) {
      await sendApiMessage(ownerPage.request, orgId, channel.id, {
        body: `後続メイン発言-${String(i).padStart(2, '0')}-${suffix}`,
      })
    }

    // Both contexts open the Topic view and open the Reply chain from a Message in the Topic.
    await ownerPage.goto(`/o/${orgId}/c/${channel.id}/t/${rootMsg.topic_id}`)
    await peerPage.goto(`/o/${orgId}/c/${channel.id}/t/${rootMsg.topic_id}`)
    await expect(ownerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // Open the Reply chain from the visible latest Message in the Topic view (without loading older Topic messages first,
    // so only the Reply chain endpoint pages the 52 chain messages: 50 on page 1, then 2 more via "さらに返信を読み込む").
    for (const p of [ownerPage, peerPage]) {
      const visibleTopicRow = p.locator('#main-content .topic-view__item').last()
      await expect(visibleTopicRow).toBeVisible()
      await visibleTopicRow.getByRole('button', { name: /返信/ }).click()
    }

    const ownerPanel = ownerPage.locator('#panel-content')
    const peerPanel = peerPage.locator('#panel-content')
    for (const panel of [ownerPanel, peerPanel]) {
      await expect(panel.getByRole('heading', { level: 2, name: '返信のつながり', exact: true })).toBeVisible()
      await expect(panel.locator(`[data-message-id="${rootMsg.id}"]`)).toContainText(`トピック親メッセージ-${suffix}`)
      await expect(panel.locator(`[data-message-id="${childA.id}"]`)).toContainText(`子返信A-01-${suffix}`)
      await expect(panel.locator(`[data-message-id="${siblingB.id}"]`)).toContainText(`兄弟返信B-02-${suffix}`)
      await expect(panel.locator(`[data-message-id="${grandchildA1.id}"]`)).toContainText(`孫返信A1-03-${suffix}`)
      // Page 1 of the chain (50 items: root + replies 1..49) + the anchor message (reply 51) = 51 items before paging;
      // reply 50 (`連鎖返信-50-${suffix}`) is only loaded after clicking "さらに返信を読み込む".
      await expect(panel.locator('[data-message-id]')).toHaveCount(51)
      await expect(panel).not.toContainText(`連鎖返信-50-${suffix}`)
      const loadMoreBtn = panel.getByRole('button', { name: 'さらに返信を読み込む', exact: true })
      await expect(loadMoreBtn).toBeVisible()
      await loadMoreBtn.click()
      await expect(panel.locator('[data-message-id]')).toHaveCount(52)
      await expect(panel).toContainText(`連鎖返信-50-${suffix}`)
      await expect(panel).toContainText(`連鎖返信-51-${suffix}`)
      await expect(loadMoreBtn).toHaveCount(0)
    }

    // Owner replies through the panel Composer; verify the Reply inherits the Topic and root, and appears live in Peer's panel and Topic view.
    const ownerReplyBody = `オーナーパネル返信-${suffix}`
    const ownerPostPromise = ownerPage.waitForResponse(
      (res) => new URL(res.url()).pathname.endsWith(`/channels/${channel.id}/messages`) && res.request().method() === 'POST',
    )
    await replyComposer(ownerPage).fill(ownerReplyBody)
    await ownerPanel.getByRole('button', { name: '送信', exact: true }).click()
    const ownerPostRes = await ownerPostPromise
    expect(ownerPostRes.status()).toBe(201)
    const ownerReplyMsg = (await secretSafe(() => ownerPostRes.json())) as import('./helpers.ts').Message
    expect(ownerReplyMsg.topic_id).toBe(rootMsg.topic_id)
    expect(ownerReplyMsg.reply_root_id).toBe(rootMsg.id)
    expect(ownerReplyMsg.reply_to).toBeTruthy()

    await expect(ownerPanel.locator(`[data-message-id="${ownerReplyMsg.id}"]`)).toContainText(ownerReplyBody)
    await expect(peerPanel.locator(`[data-message-id="${ownerReplyMsg.id}"]`)).toContainText(ownerReplyBody)
    await expect(peerPage.locator(`#main-content [data-message-id="${ownerReplyMsg.id}"]`)).toContainText(ownerReplyBody)

    // Peer replies to a descendant (grandchildA1) through the panel Composer; verify it inherits the same Topic and root, and appears live in Owner's panel.
    await peerPanel.locator(`[data-message-id="${grandchildA1.id}"]`).getByRole('button', { name: '返信', exact: true }).click()
    const peerReplyBody = `ピア子孫返信-${suffix}`
    const peerPostPromise = peerPage.waitForResponse(
      (res) => new URL(res.url()).pathname.endsWith(`/channels/${channel.id}/messages`) && res.request().method() === 'POST',
    )
    await replyComposer(peerPage).fill(peerReplyBody)
    await peerPanel.getByRole('button', { name: '送信', exact: true }).click()
    const peerPostRes = await peerPostPromise
    expect(peerPostRes.status()).toBe(201)
    const peerReplyMsg = (await secretSafe(() => peerPostRes.json())) as import('./helpers.ts').Message
    expect(peerReplyMsg.topic_id).toBe(rootMsg.topic_id)
    expect(peerReplyMsg.reply_root_id).toBe(rootMsg.id)
    expect(peerReplyMsg.reply_to).toBe(grandchildA1.id)

    await expect(peerPanel.locator(`[data-message-id="${peerReplyMsg.id}"]`)).toContainText(peerReplyBody)
    await expect(ownerPanel.locator(`[data-message-id="${peerReplyMsg.id}"]`)).toContainText(peerReplyBody)
    await expect(ownerPage.locator(`#main-content [data-message-id="${peerReplyMsg.id}"]`)).toContainText(peerReplyBody)
  } finally {
    await peerContext?.close()
    await ownerContext.close()
  }
})

test('Reconnect and reload (C1-C4, P1)', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const ownerSockets = await installSocketCloseHook(ownerPage)
    const orgId = await ensureOwnerAndSignIn(ownerPage)
    const channel = await createChannelApi(ownerPage.request, orgId, `reconnect-${suffix}`, 'public')

    const peer = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'member', suffix)
    peerContext = peer.context
    const peerPage = peer.page

    await ownerPage.goto(`/o/${orgId}/c/${channel.id}`)
    await peerPage.goto(`/o/${orgId}/c/${channel.id}`)
    await expect(ownerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // Track gap-fill requests (GET /messages?after_seq=...) on Owner's page.
    const afterSeqRequests: string[] = []
    ownerPage.on('request', (req) => {
      const url = new URL(req.url())
      if (
        req.method() === 'GET' &&
        url.pathname.endsWith(`/channels/${channel.id}/messages`) &&
        url.searchParams.has('after_seq')
      ) {
        afterSeqRequests.push(req.url())
      }
    })

    // 1. Both contexts see initial main-timeline Message and Topic Message (hidden from main timeline rows).
    const beforeDropMain = `切断前メイン-${suffix}`
    await mainComposer(ownerPage).fill(beforeDropMain)
    await ownerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(peerPage.locator('#main-content .ui-message-row').filter({ hasText: beforeDropMain })).toHaveCount(1)

    const topicName = `裏トピック-${suffix}`
    const hiddenTopicMsg1 = `裏トピック発言1-${suffix}`
    await topicNameInput(peerPage).fill(topicName)
    await mainComposer(peerPage).fill(hiddenTopicMsg1)
    await peerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()

    const summaryBtn = ownerPage.locator('#main-content button[data-topic-id]')
    await expect(summaryBtn).toContainText(`トピック: ${topicName}`)
    await expect(summaryBtn).toContainText('1件›')
    const topicId = await summaryBtn.getAttribute('data-topic-id')
    expect(topicId).toBeTruthy()

    // Post another main-timeline Message after the hidden Topic Message; verify no false gap-fill occurred (P1).
    const afterHiddenTopicMain = `トピック直後メイン-${suffix}`
    await mainComposer(peerPage).fill(afterHiddenTopicMain)
    await peerPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(ownerPage.locator('#main-content .ui-message-row').filter({ hasText: afterHiddenTopicMain })).toHaveCount(1)
    expect(afterSeqRequests).toEqual([])

    // 2. Drop Owner's WebSocket and have Peer post both a hidden Topic Message and a main-timeline Message before replay completes.
    const oldSocket = ownerSockets.at(-1)!
    const countBefore = ownerSockets.length
    const closed = new Promise<void>((resolve) => oldSocket.once('close', () => resolve()))
    await ownerPage.evaluate(() => (window as typeof window & { closeTestSockets: () => void }).closeTestSockets())
    await closed

    const duringDropTopicBody = `切断中トピック発言2-${suffix}`
    const duringDropMainBody = `切断中メイン発言-${suffix}`
    await sendApiMessage(peerPage.request, orgId, channel.id, {
      body: duringDropTopicBody,
      topic_name: topicName,
    })
    await sendApiMessage(peerPage.request, orgId, channel.id, {
      body: duringDropMainBody,
    })

    await expect.poll(() => ownerSockets.length).toBeGreaterThan(countBefore)
    await expect(ownerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // After reconnect, canonical Messages appear with no duplicate rendering and no false gap fill.
    const ownerMainRows = ownerPage.locator('#main-content .ui-message-row')
    await expect(ownerMainRows).toHaveCount(3)
    await expect(ownerMainRows.filter({ hasText: beforeDropMain })).toHaveCount(1)
    await expect(ownerMainRows.filter({ hasText: afterHiddenTopicMain })).toHaveCount(1)
    await expect(ownerMainRows.filter({ hasText: duringDropMainBody })).toHaveCount(1)
    await expect(summaryBtn).toHaveCount(1)
    await expect(summaryBtn).toContainText('2件›')
    await expect(summaryBtn).toContainText(duringDropTopicBody)
    expect(afterSeqRequests).toEqual([])

    // 3. Reload Owner's history and confirm identical canonical Messages and Topic summary with no duplicates.
    await ownerPage.reload()
    await expect(ownerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(ownerMainRows).toHaveCount(3)
    await expect(ownerMainRows.filter({ hasText: beforeDropMain })).toHaveCount(1)
    await expect(ownerMainRows.filter({ hasText: afterHiddenTopicMain })).toHaveCount(1)
    await expect(ownerMainRows.filter({ hasText: duringDropMainBody })).toHaveCount(1)
    await expect(summaryBtn).toHaveCount(1)
    await expect(summaryBtn).toContainText('2件›')
    await expect(summaryBtn).toContainText(duringDropTopicBody)

    // Open the Topic view and verify the 2 canonical Topic Messages are present once each.
    await summaryBtn.click()
    const topicRows = ownerPage.locator('#main-content .topic-view__item')
    await expect(topicRows).toHaveCount(2)
    await expect(topicRows.filter({ hasText: hiddenTopicMsg1 })).toHaveCount(1)
    await expect(topicRows.filter({ hasText: duringDropTopicBody })).toHaveCount(1)
    expect(afterSeqRequests).toEqual([])
  } finally {
    await peerContext?.close()
    await ownerContext.close()
  }
})

test('Unread (P8)', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let guestContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)
    const lobbyChannel = await createChannelApi(ownerPage.request, orgId, `unread-lobby-${suffix}`, 'public')
    const targetChannel = await createChannelApi(ownerPage.request, orgId, `unread-target-${suffix}`, 'private')

    await ownerPage.reload()
    await expect(ownerPage.getByText('Acme / Alice さん')).toBeVisible()

    // Invite second Account as Guest and grant lobby + targetChannel via UI.
    const guest = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'guest', suffix)
    guestContext = guest.context
    const guestPage = guest.page
    const guestSockets = await installSocketCloseHook(guestPage)

    await ownerPage.reload()
    await ownerPage.getByRole('button', { name: `# ${lobbyChannel.name}`, exact: true }).click()
    await ownerPage.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await ownerPage.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const memberPanel = ownerPage.getByRole('region', { name: 'チャンネルのメンバー', exact: true })
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    await ownerPage.getByRole('button', { name: `🔒 ${targetChannel.name}`, exact: true }).click()
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Guest parks on lobbyChannel.
    await guestPage.goto(`/o/${orgId}/c/${lobbyChannel.id}`)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const channelNav = guestPage.locator('#channel-content')
    const targetChannelRow = channelNav
      .locator('.channel-list > li > .ui-list-row-group > button.ui-list-row')
      .filter({ hasText: targetChannel.name })
    await expect(targetChannelRow).toBeVisible()
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)

    // After access is granted, Owner posts:
    // - 14 main-timeline Messages (so later rows are off-screen below the viewport)
    // - 1 Topic Message
    // - 1 Reply to that Topic Message (inherits the Topic)
    const mainMessages: import('./helpers.ts').Message[] = []
    for (let i = 1; i <= 14; i++) {
      const m = await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
        body: `未読メイン発言-${i}-${suffix}\n2行目-${i}\n3行目-${i}\n4行目-${i}`,
      })
      mainMessages.push(m)
    }
    const topicName = `未読トピック-${suffix}`
    const topicMsg = await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
      body: `未読トピック親発言-${suffix}`,
      topic_name: topicName,
    })
    expect(topicMsg.topic_id).toBeTruthy()
    await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
      body: `未読トピック返信発言-${suffix}`,
      reply_to: topicMsg.id,
    })

    // Refresh Guest's Channel list baseline via reconnect and verify exact aggregate badge (14 main + 2 Topic = 16).
    await closePageSockets(guestPage, guestSockets)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 16件')

    // Simulate background tab (visibilityState = 'hidden'): opening the view while hidden marks nothing at all.
    await guestPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    const markReadRequestsWhileHidden: string[] = []
    const onReq = (req: import('@playwright/test').Request) => {
      if (req.method() === 'PUT' && new URL(req.url()).pathname.includes('/read')) {
        markReadRequestsWhileHidden.push(req.url())
      }
    }
    guestPage.on('request', onReq)

    await targetChannelRow.click()
    await expect(guestPage.getByRole('heading', { level: 1, name: targetChannel.name, exact: true })).toBeVisible()
    await expect(guestPage.locator(`#main-content [data-message-id="${mainMessages[0].id}"]`)).toBeVisible()

    // While hidden, Owner posts one more live main-timeline Message (15th main message, total 17 Unread).
    const hiddenLiveMsg = await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
      body: `バックグラウンド着信メイン-15-${suffix}\n2行目\n3行目\n4行目`,
    })
    mainMessages.push(hiddenLiveMsg)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 17件')
    expect(markReadRequestsWhileHidden).toEqual([])
    guestPage.off('request', onReq)

    // Restore tab visibility to 'visible': only the presented on-screen main-timeline Messages advance the position;
    // off-screen rows below the viewport and the 2 hidden Topic Messages stay Unread.
    const firstMarkReadPromise = guestPage.waitForResponse(
      (res) => res.request().method() === 'PUT' && new URL(res.url()).pathname.endsWith(`/channels/${targetChannel.id}/read`),
    )
    await guestPage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const firstMarkRes = await firstMarkReadPromise
    expect(firstMarkRes.ok()).toBe(true)
    const firstMarkBody = (await secretSafe(() => firstMarkRes.json())) as { read_seq: number }
    // Off-screen bottom main message (hiddenLiveMsg) is not yet presented, so read_seq < hiddenLiveMsg.seq.
    expect(firstMarkBody.read_seq).toBeGreaterThanOrEqual(mainMessages[0].seq)
    expect(firstMarkBody.read_seq).toBeLessThan(hiddenLiveMsg.seq)

    const accordionTopic = channelNav
      .locator('.ui-list-row-group--topic button.ui-list-row')
      .filter({ hasText: topicName })
    await expect(accordionTopic.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')

    // Scroll to the bottom of the main timeline so all 15 main-timeline Messages are presented.
    const scrollContainer = guestPage.locator('#main-content .timeline-scroll')
    await scrollContainer.evaluate(async (el) => {
      const step = Math.max(100, Math.floor(el.clientHeight * 0.7))
      while (el.scrollTop + el.clientHeight < el.scrollHeight) {
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step)
        el.dispatchEvent(new Event('scroll'))
        await new Promise((r) => setTimeout(r, 30))
      }
    })

    // Main timeline Unread is now 0; only the 2 hidden Topic Messages (Topic root + Reply) stay Unread.
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')
    const timelineTopicSummary = guestPage.locator(`#main-content button.ui-topic-summary[data-topic-id="${topicMsg.topic_id}"]`)
    await expect(timelineTopicSummary.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')

    // Own sends never count as Unread and never move a read position.
    await mainComposer(guestPage).fill(`ゲスト自身の発言-${suffix}`)
    await guestPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    await expect(guestPage.locator('#main-content .ui-message-row').filter({ hasText: `ゲスト自身の発言-${suffix}` })).toHaveCount(1)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 2件')

    // Open the Topic view -> presents the Topic Message and Reply -> moves only that Topic's position -> badges become 0.
    await timelineTopicSummary.click()
    await expect(guestPage.getByRole('heading', { level: 1, name: topicName, exact: true })).toBeVisible()
    await expect(accordionTopic.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)

    // Reconnect refetches persisted positions and counts; badges stay 0.
    await closePageSockets(guestPage, guestSockets)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(accordionTopic.locator('.ui-badge--unread')).toHaveCount(0)
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)

    // Move Guest back to lobbyChannel, then Owner removes Guest's grant on targetChannel, posts while revoked, and re-grants.
    await guestPage.locator('#channel-content .channel-list button').filter({ hasText: lobbyChannel.name }).click()
    await expect(guestPage.getByRole('heading', { level: 1, name: lobbyChannel.name, exact: true })).toBeVisible()

    await memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true }).click()
    await ownerPage.getByRole('dialog').getByRole('button', { name: '外す', exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true })).toBeVisible()

    // Messages posted while the grant is removed precede the new grant's committed-seq baseline.
    await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
      body: `権限剥奪中のメイン発言-${suffix}`,
    })
    await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
      body: `権限剥奪中のトピック発言-${suffix}`,
      topic_name: topicName,
    })

    // Re-grant access to Guest.
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Guest reloads Channel list: Unread restarted at the new committed-seq baseline (0 Unread for messages posted during revocation).
    await guestPage.reload()
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(targetChannelRow).toBeVisible()
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveCount(0)

    // Messages posted after the re-grant become Unread normally.
    await sendApiMessage(ownerPage.request, orgId, targetChannel.id, {
      body: `再付与後の新着発言-${suffix}`,
    })
    await closePageSockets(guestPage, guestSockets)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(targetChannelRow.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
  } finally {
    await guestContext?.close()
    await ownerContext.close()
  }
})
