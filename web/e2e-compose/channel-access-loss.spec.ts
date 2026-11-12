import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { ClientMessage, ServerEvent } from '../src/api-schema.d.ts'
import {
  createChannelApi,
  ensureOwnerAndSignIn,
  inviteAndSignInPeerViaUi,
  secretSafe,
  sendApiMessage,
} from './helpers.ts'

const mainComposer = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })

async function assertRestSurfacesDeniedAfterCommit(
  request: APIRequestContext,
  orgId: string,
  channelId: string,
  topicId: string,
  anchorMessageId: string,
): Promise<void> {
  const base = `/api/v1/orgs/${orgId}/channels/${channelId}`
  for (const resPromise of [
    () => request.get(`${base}/messages`),
    () => request.get(`${base}/timeline`),
    () =>
      request.post(`${base}/messages`, {
        data: { client_message_id: crypto.randomUUID(), body: 'denied after access loss' },
      }),
    () => request.get(`${base}/topics`),
    () => request.get(`${base}/topics/${topicId}`),
    () => request.get(`${base}/topics/${topicId}/messages`),
    () => request.get(`${base}/messages/${anchorMessageId}/chain`),
    () => request.put(`${base}/read`, { data: { read_seq: 1 } }),
    () => request.put(`${base}/topics/${topicId}/read`, { data: { read_seq: 1 } }),
  ]) {
    const res = await secretSafe(resPromise)
    expect([403, 404]).toContain(res.status())
  }
}

function observeOrgSocket(page: Page) {
  const sockets: import('@playwright/test').WebSocket[] = []
  const closedCount = { value: 0 }
  const sentFrames: ClientMessage[] = []
  const receivedEvents: ServerEvent[] = []
  page.on('websocket', (ws) => {
    sockets.push(ws)
    ws.on('close', () => {
      closedCount.value++
    })
    ws.on('framesent', ({ payload }) => {
      try {
        sentFrames.push(JSON.parse(String(payload)) as ClientMessage)
      } catch {
        // ignore non-json frames
      }
    })
    ws.on('framereceived', ({ payload }) => {
      try {
        receivedEvents.push(JSON.parse(String(payload)) as ServerEvent)
      } catch {
        // ignore non-json frames
      }
    })
  })
  return { sockets, closedCount, sentFrames, receivedEvents }
}

test('Channel access loss: removing a Guest explicit grant on a public Channel (plus unaffected Channel control)', async ({
  browser,
  baseURL,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let guestContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)

    const targetPublic = await createChannelApi(ownerPage.request, orgId, `c9-guest-pub-${suffix}`, 'public')
    const controlPublic = await createChannelApi(ownerPage.request, orgId, `c9-control-pub-${suffix}`, 'public')

    const topicRoot = await sendApiMessage(ownerPage.request, orgId, targetPublic.id, {
      body: `初期トピック親-${suffix}`,
      topic_name: `議題-${suffix}`,
    })
    expect(topicRoot.topic_id).toBeTruthy()
    const plainMsg = await sendApiMessage(ownerPage.request, orgId, targetPublic.id, {
      body: `初期メイン発言-${suffix}`,
    })

    await ownerPage.reload()
    await expect(ownerPage.getByText('Acme / Alice さん')).toBeVisible()

    const guest = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'guest', suffix)
    guestContext = guest.context
    const guestPage = guest.page
    const wsObs = observeOrgSocket(guestPage)

    // Owner grants Guest access to both targetPublic and controlPublic through the UI.
    await ownerPage.reload()
    await ownerPage.getByRole('button', { name: `# ${targetPublic.name}`, exact: true }).click()
    await ownerPage.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await ownerPage.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const memberPanel = ownerPage.getByRole('region', { name: 'チャンネルのメンバー', exact: true })
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    await ownerPage.getByRole('button', { name: `# ${controlPublic.name}`, exact: true }).click()
    await memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Switch Owner back to targetPublic so Owner can remove Guest's grant on targetPublic.
    await ownerPage.getByRole('button', { name: `# ${targetPublic.name}`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Guest opens targetPublic on guestPage, and also keeps an active subscription on controlPublic in a second page
    // of the same browser context across the grant removal (since each page watches only its selected Channel).
    const guestControlPage = await guestContext.newPage()
    await guestControlPage.setViewportSize({ width: 1280, height: 800 })
    const controlWsObs = observeOrgSocket(guestControlPage)
    await guestControlPage.goto(`/o/${orgId}/c/${controlPublic.id}`)
    await expect(guestControlPage.getByRole('heading', { level: 1, name: controlPublic.name, exact: true })).toBeVisible()
    await expect(guestControlPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const controlSubscribesBefore = controlWsObs.sentFrames.filter(
      (f) => f.type === 'subscribe' && f.channel_id === controlPublic.id,
    ).length
    expect(controlSubscribesBefore).toBe(1)

    await guestPage.goto(`/o/${orgId}/c/${targetPublic.id}`)
    await expect(guestPage.getByRole('heading', { level: 1, name: targetPublic.name, exact: true })).toBeVisible()
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(guestPage.locator('#main-content')).toContainText(`初期メイン発言-${suffix}`)

    const socketsBeforeLoss = wsObs.sockets.length
    expect(socketsBeforeLoss).toBeGreaterThan(0)

    // Owner removes Guest's explicit grant on targetPublic through the UI.
    await memberPanel.getByRole('button', { name: `${guest.name}をチャンネルから外す`, exact: true }).click()
    await ownerPage.getByRole('dialog').getByRole('button', { name: '外す', exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${guest.name}を追加`, exact: true })).toBeVisible()

    // Guest's open Channel transitions to C9-unavailable via channel_access_lost, disables sending and retry, and keeps the Organization socket open.
    const timeline = guestPage.getByRole('region', { name: 'タイムライン', exact: true })
    await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
    await expect(mainComposer(guestPage)).toBeDisabled()
    await expect(timeline.getByRole('button', { name: '送信', exact: true })).toBeDisabled()
    await expect(timeline.getByRole('button', { name: '再試行', exact: true })).toHaveCount(0)
    await expect(timeline.getByRole('button', { name: 'チャンネル一覧へ', exact: true })).toBeVisible()
    expect(wsObs.closedCount.value).toBe(0)
    expect(wsObs.sockets.length).toBe(socketsBeforeLoss)
    const lossEventIdx = wsObs.receivedEvents.findIndex(
      (e) => e.type === 'channel_access_lost' && e.channel_id === targetPublic.id,
    )
    expect(lossEventIdx).toBeGreaterThanOrEqual(0)

    // After COMMIT, new history, timeline, send, Topic, Reply and Unread requests are denied.
    await assertRestSurfacesDeniedAfterCommit(
      guestPage.request,
      orgId,
      targetPublic.id,
      topicRoot.topic_id!,
      plainMsg.id,
    )

    // Post a new Message to targetPublic while guestPage is still on targetPublic, then post a control Message to controlPublic.
    // Verify the active subscription on guestControlPage receives the control Message without reselecting or resubscribing,
    // and that neither socket received a frame for the revoked Channel's Message.
    const postAfterRevokeWhileOpen = await sendApiMessage(ownerPage.request, orgId, targetPublic.id, {
      body: `剥奪後の秘匿発言1-${suffix}`,
    })
    const activeControlBody = `既存購読コントロール発言-${suffix}`
    const activeControlMsg = await sendApiMessage(ownerPage.request, orgId, controlPublic.id, {
      body: activeControlBody,
    })
    await expect(
      guestControlPage.locator('#main-content .ui-message-row').filter({ hasText: activeControlBody }),
    ).toHaveCount(1)
    expect(controlWsObs.closedCount.value).toBe(0)
    expect(
      controlWsObs.sentFrames.filter((f) => f.type === 'subscribe' && f.channel_id === controlPublic.id).length,
    ).toBe(controlSubscribesBefore)
    expect(
      controlWsObs.receivedEvents.some((e) => e.type === 'message' && e.message.id === activeControlMsg.id),
    ).toBe(true)
    expect(
      controlWsObs.receivedEvents.some((e) => e.type === 'message' && e.message.channel_id === targetPublic.id),
    ).toBe(false)
    await expect(guestPage.locator('#main-content').getByText(postAfterRevokeWhileOpen.body)).toHaveCount(0)

    // Also switch guestPage to controlPublic on the same open Organization socket, post again to targetPublic and then
    // to controlPublic, wait for the control frame on guestPage's socket, and assert no post-loss frame for targetPublic arrived.
    await guestPage.locator('#channel-content .channel-list button').filter({ hasText: controlPublic.name }).click()
    await expect(guestPage.getByRole('heading', { level: 1, name: controlPublic.name, exact: true })).toBeVisible()
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(mainComposer(guestPage)).toBeEnabled()

    const postAfterRevokeAfterSwitch = await sendApiMessage(ownerPage.request, orgId, targetPublic.id, {
      body: `剥奪後の秘匿発言2-${suffix}`,
    })
    const liveControlBody = `コントロールチャンネルライブ発言-${suffix}`
    const liveControlMsg = await sendApiMessage(ownerPage.request, orgId, controlPublic.id, { body: liveControlBody })
    await expect(guestPage.locator('#main-content .ui-message-row').filter({ hasText: liveControlBody })).toHaveCount(1)
    await expect
      .poll(() => wsObs.receivedEvents.some((e) => e.type === 'message' && e.message.id === liveControlMsg.id))
      .toBe(true)
    expect(
      wsObs.receivedEvents.some(
        (e) =>
          e.type === 'message' &&
          (e.message.id === postAfterRevokeWhileOpen.id || e.message.id === postAfterRevokeAfterSwitch.id),
      ),
    ).toBe(false)
    expect(
      wsObs.receivedEvents
        .slice(lossEventIdx + 1)
        .some((e) => e.type === 'message' && e.message.channel_id === targetPublic.id),
    ).toBe(false)
    expect(wsObs.closedCount.value).toBe(0)
    expect(wsObs.sockets.length).toBe(socketsBeforeLoss)
  } finally {
    await guestContext?.close()
    await ownerContext.close()
  }
})

test('Channel access loss: removing a private-Channel grant', async ({ browser, baseURL }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let memberContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)

    const targetPrivate = await createChannelApi(ownerPage.request, orgId, `c9-priv-${suffix}`, 'private')
    const controlPublic = await createChannelApi(ownerPage.request, orgId, `c9-priv-ctrl-${suffix}`, 'public')

    const topicRoot = await sendApiMessage(ownerPage.request, orgId, targetPrivate.id, {
      body: `秘密トピック親-${suffix}`,
      topic_name: `秘密議題-${suffix}`,
    })
    const plainMsg = await sendApiMessage(ownerPage.request, orgId, targetPrivate.id, {
      body: `秘密メイン発言-${suffix}`,
    })

    await ownerPage.reload()
    await expect(ownerPage.getByText('Acme / Alice さん')).toBeVisible()

    // Invite second Account as a regular Member and grant access to targetPrivate via UI.
    const member = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'member', suffix)
    memberContext = member.context
    const memberPage = member.page
    const wsObs = observeOrgSocket(memberPage)

    await ownerPage.reload()
    await ownerPage.getByRole('button', { name: `🔒 ${targetPrivate.name}`, exact: true }).click()
    await ownerPage.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await ownerPage.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const memberPanel = ownerPage.getByRole('region', { name: 'チャンネルのメンバー', exact: true })
    await memberPanel.getByRole('button', { name: `${member.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${member.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Member keeps an active subscription on controlPublic in a second page of the same browser context across the removal,
    // while memberPage opens targetPrivate, types a draft, and has a failed retryable send to verify C9 disables retry.
    const memberControlPage = await memberContext.newPage()
    await memberControlPage.setViewportSize({ width: 1280, height: 800 })
    const controlWsObs = observeOrgSocket(memberControlPage)
    await memberControlPage.goto(`/o/${orgId}/c/${controlPublic.id}`)
    await expect(memberControlPage.getByRole('heading', { level: 1, name: controlPublic.name, exact: true })).toBeVisible()
    await expect(memberControlPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const controlSubscribesBefore = controlWsObs.sentFrames.filter(
      (f) => f.type === 'subscribe' && f.channel_id === controlPublic.id,
    ).length
    expect(controlSubscribesBefore).toBe(1)

    await memberPage.goto(`/o/${orgId}/c/${targetPrivate.id}`)
    await expect(memberPage.getByRole('heading', { level: 1, name: targetPrivate.name, exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(memberPage.locator('#main-content')).toContainText(`秘密メイン発言-${suffix}`)

    const socketsBeforeLoss = wsObs.sockets.length
    expect(socketsBeforeLoss).toBeGreaterThan(0)

    // Create a retryable unknown-outcome send on targetPrivate before access loss so we can verify C9 hides "再送する".
    let abortOnce = true
    await memberPage.route(`**/api/v1/orgs/${orgId}/channels/${targetPrivate.id}/messages`, async (route) => {
      if (route.request().method() === 'POST' && abortOnce) {
        abortOnce = false
        return route.abort('failed')
      }
      return route.continue()
    })
    await mainComposer(memberPage).fill(`未確認送信-${suffix}`)
    await memberPage.locator('#main-content').getByRole('button', { name: '送信', exact: true }).click()
    const timeline = memberPage.getByRole('region', { name: 'タイムライン', exact: true })
    await expect(timeline.getByRole('button', { name: '再送する', exact: true })).toBeVisible()

    await mainComposer(memberPage).fill(`残る下書き-${suffix}`)

    // Owner removes Member's private-Channel grant via UI.
    await memberPanel.getByRole('button', { name: `${member.name}をチャンネルから外す`, exact: true }).click()
    await ownerPage.getByRole('dialog').getByRole('button', { name: '外す', exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${member.name}を追加`, exact: true })).toBeVisible()

    // Member's open private Channel becomes C9-unavailable; sending and retry ("再送する") are disabled/hidden; Organization socket stays open.
    await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
    await expect(mainComposer(memberPage)).toBeDisabled()
    await expect(mainComposer(memberPage)).toHaveValue(`残る下書き-${suffix}`)
    await expect(timeline.getByRole('button', { name: '再送する', exact: true })).toHaveCount(0)
    await expect(timeline.getByRole('button', { name: '破棄', exact: true })).toBeVisible()
    expect(wsObs.closedCount.value).toBe(0)
    expect(wsObs.sockets.length).toBe(socketsBeforeLoss)
    const lossEventIdx = wsObs.receivedEvents.findIndex(
      (e) => e.type === 'channel_access_lost' && e.channel_id === targetPrivate.id,
    )
    expect(lossEventIdx).toBeGreaterThanOrEqual(0)

    // After COMMIT, REST history, timeline, send, Topic, Reply and Unread requests are denied.
    await assertRestSurfacesDeniedAfterCommit(
      memberPage.request,
      orgId,
      targetPrivate.id,
      topicRoot.topic_id!,
      plainMsg.id,
    )

    // Verify the active subscription on memberControlPage receives a live Message without reselecting or resubscribing,
    // and no frame for the revoked private Channel arrives.
    const postAfterPrivateRevoke1 = await sendApiMessage(ownerPage.request, orgId, targetPrivate.id, {
      body: `プライベート剥奪後秘匿発言1-${suffix}`,
    })
    const activeControlBody = `プライベート剥奪中も継続購読-${suffix}`
    const activeControlMsg = await sendApiMessage(ownerPage.request, orgId, controlPublic.id, {
      body: activeControlBody,
    })
    await expect(
      memberControlPage.locator('#main-content .ui-message-row').filter({ hasText: activeControlBody }),
    ).toHaveCount(1)
    expect(controlWsObs.closedCount.value).toBe(0)
    expect(
      controlWsObs.sentFrames.filter((f) => f.type === 'subscribe' && f.channel_id === controlPublic.id).length,
    ).toBe(controlSubscribesBefore)
    expect(
      controlWsObs.receivedEvents.some((e) => e.type === 'message' && e.message.id === activeControlMsg.id),
    ).toBe(true)
    expect(
      controlWsObs.receivedEvents.some((e) => e.type === 'message' && e.message.channel_id === targetPrivate.id),
    ).toBe(false)

    // Also switch memberPage to controlPublic on the same socket and verify denied live delivery on memberPage's socket.
    await memberPage.locator('#channel-content .channel-list button').filter({ hasText: controlPublic.name }).click()
    await expect(memberPage.getByRole('heading', { level: 1, name: controlPublic.name, exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const postAfterPrivateRevoke2 = await sendApiMessage(ownerPage.request, orgId, targetPrivate.id, {
      body: `プライベート剥奪後秘匿発言2-${suffix}`,
    })
    const controlBody = `プライベート剥奪後パブリック発言-${suffix}`
    const controlMsg = await sendApiMessage(ownerPage.request, orgId, controlPublic.id, { body: controlBody })
    await expect(memberPage.locator('#main-content .ui-message-row').filter({ hasText: controlBody })).toHaveCount(1)
    await expect
      .poll(() => wsObs.receivedEvents.some((e) => e.type === 'message' && e.message.id === controlMsg.id))
      .toBe(true)
    expect(
      wsObs.receivedEvents.some(
        (e) =>
          e.type === 'message' &&
          (e.message.id === postAfterPrivateRevoke1.id || e.message.id === postAfterPrivateRevoke2.id),
      ),
    ).toBe(false)
    expect(
      wsObs.receivedEvents
        .slice(lossEventIdx + 1)
        .some((e) => e.type === 'message' && e.message.channel_id === targetPrivate.id),
    ).toBe(false)
    expect(wsObs.closedCount.value).toBe(0)
  } finally {
    await memberContext?.close()
    await ownerContext.close()
  }
})

test('Channel access loss: demoting a Member to Guest on a public Channel without grant (plus Role-change and redundant-grant controls)', async ({
  browser,
  baseURL,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const ownerContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  let peerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const ownerPage = await ownerContext.newPage()
    const orgId = await ensureOwnerAndSignIn(ownerPage)

    // Create two public Channels:
    // - ungrantedPublic: Peer has no explicit grant (only implicit Member access)
    // - grantedPublic: Peer is given an explicit grant while a Member
    const ungrantedPublic = await createChannelApi(ownerPage.request, orgId, `c9-demote-ungranted-${suffix}`, 'public')
    const grantedPublic = await createChannelApi(ownerPage.request, orgId, `c9-demote-granted-${suffix}`, 'public')

    const topicRoot = await sendApiMessage(ownerPage.request, orgId, ungrantedPublic.id, {
      body: `降格テストトピック親-${suffix}`,
      topic_name: `降格議題-${suffix}`,
    })
    const plainMsg = await sendApiMessage(ownerPage.request, orgId, ungrantedPublic.id, {
      body: `降格テストメイン発言-${suffix}`,
    })

    await ownerPage.reload()
    await expect(ownerPage.getByText('Acme / Alice さん')).toBeVisible()

    // Invite second Account as a Member.
    const peer = await inviteAndSignInPeerViaUi(ownerPage, browser, baseURL!, 'member', suffix)
    peerContext = peer.context
    const peerPage = peer.page
    const wsObs = observeOrgSocket(peerPage)

    // Control 3: Add and then remove a redundant explicit grant from a non-Guest (Member) on ungrantedPublic;
    // verify the Member keeps access and remains live.
    await ownerPage.reload()
    await ownerPage.getByRole('button', { name: `# ${ungrantedPublic.name}`, exact: true }).click()
    await ownerPage.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await ownerPage.getByRole('tab', { name: 'メンバー', exact: true }).click()
    const memberPanel = ownerPage.getByRole('region', { name: 'チャンネルのメンバー', exact: true })
    await memberPanel.getByRole('button', { name: `${peer.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${peer.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Peer opens ungrantedPublic while holding both Member role and explicit grant.
    await peerPage.goto(`/o/${orgId}/c/${ungrantedPublic.id}`)
    await expect(peerPage.getByRole('heading', { level: 1, name: ungrantedPublic.name, exact: true })).toBeVisible()
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const socketsBefore = wsObs.sockets.length
    expect(socketsBefore).toBeGreaterThan(0)

    // Owner removes the redundant grant on ungrantedPublic while Peer is still a Member.
    await memberPanel.getByRole('button', { name: `${peer.name}をチャンネルから外す`, exact: true }).click()
    await ownerPage.getByRole('dialog').getByRole('button', { name: '外す', exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${peer.name}を追加`, exact: true })).toBeVisible()

    // Control 3 assertion: removing a redundant grant from a non-Guest on a public Channel does NOT cause C9; Channel stays live.
    const afterRedundantRemoveBody = `冗長権限削除後も有効-${suffix}`
    await sendApiMessage(ownerPage.request, orgId, ungrantedPublic.id, { body: afterRedundantRemoveBody })
    await expect(peerPage.locator('#main-content .ui-message-row').filter({ hasText: afterRedundantRemoveBody })).toHaveCount(1)
    await expect(mainComposer(peerPage)).toBeEnabled()

    // Also give Peer an explicit grant on grantedPublic (for Control 2: Role change that keeps access because of explicit grant).
    await ownerPage.getByRole('button', { name: `# ${grantedPublic.name}`, exact: true }).click()
    await memberPanel.getByRole('button', { name: `${peer.name}を追加`, exact: true }).click()
    await expect(memberPanel.getByRole('button', { name: `${peer.name}をチャンネルから外す`, exact: true })).toBeVisible()

    // Each page watches only its selected Channel (session.ts stopFollowing), so open a second page in peerContext
    // that stays subscribed to grantedPublic throughout the demotion while peerPage stays subscribed to ungrantedPublic.
    const peerGrantedPage = await peerContext.newPage()
    await peerGrantedPage.setViewportSize({ width: 1280, height: 800 })
    const grantedWsObs = observeOrgSocket(peerGrantedPage)
    await peerGrantedPage.goto(`/o/${orgId}/c/${grantedPublic.id}`)
    await expect(peerGrantedPage.getByRole('heading', { level: 1, name: grantedPublic.name, exact: true })).toBeVisible()
    await expect(peerGrantedPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const grantedSubscribesBeforeDemotion = grantedWsObs.sentFrames.filter(
      (f) => f.type === 'subscribe' && f.channel_id === grantedPublic.id,
    ).length
    expect(grantedSubscribesBeforeDemotion).toBe(1)

    // Now Owner demotes Peer from Member to Guest in the Organization Member list UI.
    const orgMemberDetails = ownerPage.locator('details.member-list')
    if (!(await orgMemberDetails.evaluate((el: HTMLDetailsElement) => el.open))) {
      await orgMemberDetails.locator('summary').click()
    }
    await orgMemberDetails.getByLabel(`${peer.name}のロール`, { exact: true }).selectOption('guest')
    await expect(orgMemberDetails.getByText(`${peer.name}（ゲスト）`)).toBeVisible()

    // Transition 3 assertion: Peer loses access on ungrantedPublic (C9-unavailable), while Organization socket stays open.
    const timeline = peerPage.getByRole('region', { name: 'タイムライン', exact: true })
    await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
    await expect(mainComposer(peerPage)).toBeDisabled()
    await expect(timeline.getByRole('button', { name: '再試行', exact: true })).toHaveCount(0)
    expect(wsObs.closedCount.value).toBe(0)
    expect(wsObs.sockets.length).toBe(socketsBefore)
    const lossEventIdx = wsObs.receivedEvents.findIndex(
      (e) => e.type === 'channel_access_lost' && e.channel_id === ungrantedPublic.id,
    )
    expect(lossEventIdx).toBeGreaterThanOrEqual(0)

    // After COMMIT, REST history, timeline, send, Topic, Reply and Unread on ungrantedPublic are denied.
    await assertRestSurfacesDeniedAfterCommit(
      peerPage.request,
      orgId,
      ungrantedPublic.id,
      topicRoot.topic_id!,
      plainMsg.id,
    )

    // Control 2 assertion (existing subscription): peerGrantedPage stayed on grantedPublic across demotion without
    // reselecting or resubscribing, receives no channel_access_lost, and receives a post-COMMIT live Message.
    const postAfterDemote1 = await sendApiMessage(ownerPage.request, orgId, ungrantedPublic.id, {
      body: `降格後の秘匿発言1-${suffix}`,
    })
    const activeGrantedBody = `既存購読で明示権限あり降格後もライブ-${suffix}`
    const activeGrantedMsg = await sendApiMessage(ownerPage.request, orgId, grantedPublic.id, {
      body: activeGrantedBody,
    })
    await expect(
      peerGrantedPage.locator('#main-content .ui-message-row').filter({ hasText: activeGrantedBody }),
    ).toHaveCount(1)
    await expect(mainComposer(peerGrantedPage)).toBeEnabled()
    expect(grantedWsObs.closedCount.value).toBe(0)
    expect(
      grantedWsObs.sentFrames.filter((f) => f.type === 'subscribe' && f.channel_id === grantedPublic.id).length,
    ).toBe(grantedSubscribesBeforeDemotion)
    expect(grantedWsObs.receivedEvents.some((e) => e.type === 'channel_access_lost')).toBe(false)
    expect(
      grantedWsObs.receivedEvents.some((e) => e.type === 'message' && e.message.id === activeGrantedMsg.id),
    ).toBe(true)
    expect(
      grantedWsObs.receivedEvents.some((e) => e.type === 'message' && e.message.channel_id === ungrantedPublic.id),
    ).toBe(false)

    // Also verify switching peerPage to grantedPublic on the same open Organization socket works and no frame for ungrantedPublic arrived.
    await peerPage.locator('#channel-content .channel-list button').filter({ hasText: grantedPublic.name }).click()
    await expect(peerPage.getByRole('heading', { level: 1, name: grantedPublic.name, exact: true })).toBeVisible()
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(mainComposer(peerPage)).toBeEnabled()

    const postAfterDemote2 = await sendApiMessage(ownerPage.request, orgId, ungrantedPublic.id, {
      body: `降格後の秘匿発言2-${suffix}`,
    })
    const grantedControlBody = `明示権限あり降格後もライブ-${suffix}`
    const grantedControlMsg = await sendApiMessage(ownerPage.request, orgId, grantedPublic.id, {
      body: grantedControlBody,
    })
    await expect(peerPage.locator('#main-content .ui-message-row').filter({ hasText: grantedControlBody })).toHaveCount(1)
    await expect
      .poll(() => wsObs.receivedEvents.some((e) => e.type === 'message' && e.message.id === grantedControlMsg.id))
      .toBe(true)
    expect(
      wsObs.receivedEvents.some(
        (e) =>
          e.type === 'message' &&
          (e.message.id === postAfterDemote1.id || e.message.id === postAfterDemote2.id),
      ),
    ).toBe(false)
    expect(
      wsObs.receivedEvents
        .slice(lossEventIdx + 1)
        .some((e) => e.type === 'message' && e.message.channel_id === ungrantedPublic.id),
    ).toBe(false)
    expect(wsObs.closedCount.value).toBe(0)
  } finally {
    await peerContext?.close()
    await ownerContext.close()
  }
})
