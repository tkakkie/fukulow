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

    // Guest opens targetPublic.
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
    expect(
      wsObs.receivedEvents.some((e) => e.type === 'channel_access_lost' && e.channel_id === targetPublic.id),
    ).toBe(true)

    // After COMMIT, new history, timeline, send, Topic, Reply and Unread requests are denied.
    await assertRestSurfacesDeniedAfterCommit(
      guestPage.request,
      orgId,
      targetPublic.id,
      topicRoot.topic_id!,
      plainMsg.id,
    )

    // Post a new Message to targetPublic as Owner; confirm Guest receives no new live frame for targetPublic.
    const postAfterRevoke = await sendApiMessage(ownerPage.request, orgId, targetPublic.id, {
      body: `剥奪後の秘匿発言-${suffix}`,
    })
    await expect(guestPage.locator('#main-content').getByText(postAfterRevoke.body)).toHaveCount(0)

    // Control 1: an unaffected Channel (controlPublic) stays live on the same open Organization socket.
    await guestPage.locator('#channel-content .channel-list button').filter({ hasText: controlPublic.name }).click()
    await expect(guestPage.getByRole('heading', { level: 1, name: controlPublic.name, exact: true })).toBeVisible()
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(mainComposer(guestPage)).toBeEnabled()

    const liveControlBody = `コントロールチャンネルライブ発言-${suffix}`
    await sendApiMessage(ownerPage.request, orgId, controlPublic.id, { body: liveControlBody })
    await expect(guestPage.locator('#main-content .ui-message-row').filter({ hasText: liveControlBody })).toHaveCount(1)
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

    // Member opens targetPrivate, types a draft, and also has a failed retryable send to verify C9 disables retry.
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

    // After COMMIT, REST history, timeline, send, Topic, Reply and Unread requests are denied.
    await assertRestSurfacesDeniedAfterCommit(
      memberPage.request,
      orgId,
      targetPrivate.id,
      topicRoot.topic_id!,
      plainMsg.id,
    )

    // Unaffected public Channel remains live on the same socket.
    await memberPage.locator('#channel-content .channel-list button').filter({ hasText: controlPublic.name }).click()
    await expect(memberPage.getByRole('heading', { level: 1, name: controlPublic.name, exact: true })).toBeVisible()
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const controlBody = `プライベート剥奪後パブリック発言-${suffix}`
    await sendApiMessage(ownerPage.request, orgId, controlPublic.id, { body: controlBody })
    await expect(memberPage.locator('#main-content .ui-message-row').filter({ hasText: controlBody })).toHaveCount(1)
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

    // Peer also watches grantedPublic so both Channels are subscribed before demotion, then returns to ungrantedPublic.
    await peerPage.locator('#channel-content .channel-list button').filter({ hasText: grantedPublic.name }).click()
    await expect(peerPage.getByRole('heading', { level: 1, name: grantedPublic.name, exact: true })).toBeVisible()
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    await peerPage.locator('#channel-content .channel-list button').filter({ hasText: ungrantedPublic.name }).click()
    await expect(peerPage.getByRole('heading', { level: 1, name: ungrantedPublic.name, exact: true })).toBeVisible()
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

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

    // After COMMIT, REST history, timeline, send, Topic, Reply and Unread on ungrantedPublic are denied.
    await assertRestSurfacesDeniedAfterCommit(
      peerPage.request,
      orgId,
      ungrantedPublic.id,
      topicRoot.topic_id!,
      plainMsg.id,
    )

    // Control 2 assertion: Role change that keeps access (Guest with an explicit grant on grantedPublic) stays live and usable.
    await peerPage.locator('#channel-content .channel-list button').filter({ hasText: grantedPublic.name }).click()
    await expect(peerPage.getByRole('heading', { level: 1, name: grantedPublic.name, exact: true })).toBeVisible()
    await expect(peerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(mainComposer(peerPage)).toBeEnabled()

    const grantedControlBody = `明示権限あり降格後もライブ-${suffix}`
    await sendApiMessage(ownerPage.request, orgId, grantedPublic.id, { body: grantedControlBody })
    await expect(peerPage.locator('#main-content .ui-message-row').filter({ hasText: grantedControlBody })).toHaveCount(1)
    expect(wsObs.closedCount.value).toBe(0)
  } finally {
    await peerContext?.close()
    await ownerContext.close()
  }
})
