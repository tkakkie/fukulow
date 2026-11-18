import { expect, test, type APIRequestContext } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type AcceptInviteRequest = components['schemas']['AcceptInviteRequest']
type CreateInviteRequest = components['schemas']['CreateInviteRequest']
type InviteResponse = components['schemas']['InviteResponse']
type Message = components['schemas']['Message']
type SendMessageRequest = components['schemas']['SendMessageRequest']

async function sendChannelMessage(
  request: APIRequestContext,
  orgId: string,
  channelId: string,
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

async function createPeerSession(
  ownerRequest: APIRequestContext,
  peerRequest: APIRequestContext,
  orgId: string,
  role: 'member' | 'guest',
  name: string,
) {
  const email = `move-${role}-${crypto.randomUUID()}@example.invalid`
  const password = `correct horse move ${role}`
  const inviteReq: CreateInviteRequest = { email, role }
  const inviteRes = await secretSafe(() =>
    ownerRequest.post(`/api/v1/orgs/${orgId}/invites`, { data: inviteReq }),
  )
  expect(inviteRes.ok()).toBe(true)
  const invite = (await secretSafe(() => inviteRes.json())) as InviteResponse
  const acceptReq: AcceptInviteRequest = { token: invite.token, email, name, password }
  const acceptRes = await secretSafe(() =>
    peerRequest.post(`/api/v1/orgs/${orgId}/invites/accept`, { data: acceptReq }),
  )
  expect(acceptRes.ok()).toBe(true)
  const identity = (await secretSafe(() => acceptRes.json())) as components['schemas']['Identity']
  const loginRes = await secretSafe(() =>
    peerRequest.post('/api/v1/session', { data: { email, password } }),
  )
  expect(loginRes.ok()).toBe(true)
  return identity
}

test('authoritative totals survive partial history and cold child navigation and reconcile a live Reply above the delayed snapshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `counts-${crypto.randomUUID().slice(0, 8)}`)
  const base = `/api/v1/orgs/${org}/channels/${channel.id}`
  type Message = components['schemas']['Message']
  const send = async (body: string, reply_to?: string): Promise<Message> => {
    const input: components['schemas']['SendMessageRequest'] = { body, reply_to, client_message_id: crypto.randomUUID() }
    const response = await secretSafe(() => page.request.post(`${base}/messages`, { data: input }))
    expect(response.status()).toBe(201)
    return await secretSafe(() => response.json()) as Message
  }
  const root = await send('返信件数の起点')
  const children: Message[] = []
  for (let i = 0; i < 4; i++) children.push(await send(`既存の返信 ${i + 1}`, root.id))
  const child = children.at(-1)!
  // Only a child is loaded in main; the real count endpoint still returns the whole chain.
  const timeline: components['schemas']['TimelinePage'] = { history_generation: root.history_generation, as_of_seq: children.at(-1)!.created_seq, has_more: false, items: [{ kind: 'message', message: child }] }
  await page.route(`**${base}/timeline*`, route => route.fulfill({ json: timeline }))
  await page.route(`**${base}/messages/*/chain*`, async route => {
    const url = new URL(route.request().url()); url.searchParams.set('limit', '2')
    const response = await route.fetch({ url: url.href })
    await route.fulfill({ response })
  })
  let release = () => {}, captured = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const snapshotReady = new Promise<void>(resolve => { captured = resolve })
  const streamed = new Set<string>()
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const event = JSON.parse(String(frame.payload)) as components['schemas']['ServerEvent']
    if (event.type === 'message' && 'message' in event) streamed.add(event.message.id)
  }))
  const batches: components['schemas']['ReplyCountRequest'][] = []
  await page.route(`**${base}/reply-counts`, async route => {
    batches.push(route.request().postDataJSON() as components['schemas']['ReplyCountRequest'])
    const response = await route.fetch()
    captured(); await held
    await route.fulfill({ response })
  })
  try {
    await page.goto(`/o/${org}/c/${channel.id}?panel=reply:${child.id}`)
    await snapshotReady
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const mainChild = page.locator(`#main-content [data-message-id="${child.id}"]`)
    const panel = page.locator('#panel-content')
    await expect(panel.locator(`[data-message-id="${root.id}"]`)).toBeVisible()
    await expect(mainChild.getByRole('button', { name: '返信', exact: true })).toBeVisible()
    const live = await send('基準取得後の返信', child.id)
    await expect.poll(() => streamed.has(live.id)).toBe(true)
    await expect(page.locator(`#main-content [data-message-id="${live.id}"]`)).toBeVisible()
    release()
    await expect(mainChild.getByRole('button', { name: '返信 5件›', exact: true })).toBeVisible()
    await expect(panel.locator(`[data-message-id="${root.id}"]`).getByRole('button', { name: '返信 5件›', exact: true })).toBeVisible()
    expect(batches).toEqual([{ ids: [root.id], history_generation: root.history_generation }])
    // History adds bodies, never counts; root and every descendant keep the same total.
    const more = panel.getByRole('button', { name: 'さらに返信を読み込む', exact: true })
    await more.click()
    await expect(panel.locator(`[data-message-id="${children[2]!.id}"]`)).toBeVisible()
    await expect(panel.locator(`[data-message-id="${child.id}"]`).getByRole('button', { name: '返信 5件›', exact: true })).toBeVisible()
    await more.click()
    await expect(more).toHaveCount(0)
    await expect(mainChild.getByRole('button', { name: '返信 5件›', exact: true })).toBeVisible()
  } finally { release() }
})

test('Move to topic: Member moves own chain to an existing Topic and to a new Topic with live WebSocket delivery and reconnect replay convergence in a second context', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const orgId = await signInOwner(page.request)
  const channel = await createChannel(page.request, orgId, `move-${crypto.randomUUID().slice(0, 8)}`)
  const channelId = channel.id

  const authorContext = await browser.newContext()
  const observerContext = await browser.newContext()
  try {
    await createPeerSession(page.request, authorContext.request, orgId, 'member', '移動作成者')
    await createPeerSession(page.request, observerContext.request, orgId, 'member', 'リアルタイム観察者')

    // Seed an existing Topic and a Reply chain authored entirely by authorContext
    const existingTopicRoot = await sendChannelMessage(page.request, orgId, channelId, {
      body: '既存トピックの初回投稿',
      topic_name: '既存移動先',
    })
    expect(existingTopicRoot.topic_id).toBeTruthy()

    const chainRoot = await sendChannelMessage(authorContext.request, orgId, channelId, {
      body: '移動する親メッセージ',
    })
    const chainReply = await sendChannelMessage(authorContext.request, orgId, channelId, {
      body: '移動する子返信',
      reply_to: chainRoot.id,
    })

    const authorPage = await authorContext.newPage()
    const observerPage = await observerContext.newPage()
    await authorPage.setViewportSize({ width: 1280, height: 800 })
    await observerPage.setViewportSize({ width: 1280, height: 800 })

    // Wire reconnect control on observerPage for part (b)
    let holdObserver = false
    const heldObserver: (() => void)[] = []
    let disconnectObserver!: () => Promise<void>
    await observerPage.routeWebSocket('**/api/v1/orgs/*/ws', (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((raw) => {
        if (holdObserver) heldObserver.push(() => server.send(raw))
        else server.send(raw)
      })
      disconnectObserver = async () => {
        await ws.close({ code: 1011 })
        await server.close({ code: 1011 })
      }
    })

    await Promise.all([
      authorPage.goto(`/o/${orgId}/c/${channelId}`),
      observerPage.goto(`/o/${orgId}/c/${channelId}`),
    ])
    await expect(authorPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(observerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    // Both pages initially see the main-timeline root Message and the 1-Message existing Topic summary
    await expect(authorPage.locator(`#main-content [data-message-id="${chainRoot.id}"]`)).toContainText('移動する親メッセージ')
    await expect(observerPage.locator(`#main-content [data-message-id="${chainRoot.id}"]`)).toContainText('移動する親メッセージ')
    const observerExistingSummary = observerPage.locator(`#main-content button[data-topic-id="${existingTopicRoot.topic_id}"]`)
    await expect(observerExistingSummary).toContainText('トピック: 既存移動先')
    await expect(observerExistingSummary).toContainText('1件›')

    // (a) Author opens the Reply chain and moves it to the existing Topic
    const authorRootRow = authorPage.locator(`#main-content [data-message-id="${chainRoot.id}"]`)
    await Promise.all([
      authorPage.waitForResponse((r) => r.url().includes(`/messages/${chainRoot.id}/chain`) && r.ok()),
      authorRootRow.getByRole('button', { name: /返信/ }).click(),
    ])
    const panel = authorPage.locator('#panel-content')
    await expect(panel).toBeVisible()
    await expect(panel.locator(`[data-message-id="${chainReply.id}"]`)).toContainText('移動する子返信')

    await panel.getByRole('button', { name: 'トピックに移動', exact: true }).click()
    const moveDialog = authorPage.getByRole('dialog', { name: 'トピックに移動', exact: true })
    await expect(moveDialog).toBeVisible()
    await expect(moveDialog.getByRole('radio', { name: '既存のトピック', exact: true })).toBeChecked()
    await moveDialog.getByRole('combobox', { name: '移動先のトピック', exact: true }).selectOption(existingTopicRoot.topic_id!)
    await moveDialog.getByRole('button', { name: 'トピックに移動', exact: true }).click()

    await expect(moveDialog).toHaveCount(0)
    await expect(panel.getByText('トピックに移動しました。', { exact: true })).toBeVisible()
    await expect(panel.getByText('トピック: 既存移動先', { exact: true })).toBeVisible()

    // Second browser context sees the chain under the destination Topic without reload (live WebSocket delivery)
    await expect(observerPage.locator(`#main-content [data-message-id="${chainRoot.id}"]`)).toHaveCount(0)
    await expect(observerExistingSummary).toContainText('3件›')
    await expect(observerExistingSummary).toContainText('移動する子返信')

    // Open the existing Topic in observerPage to confirm both moved Messages are there
    await observerExistingSummary.click()
    await expect(observerPage.getByRole('heading', { level: 1, name: '既存移動先', exact: true })).toBeVisible()
    await expect(observerPage.locator(`#main-content [data-message-id="${chainRoot.id}"]`)).toContainText('移動する親メッセージ')
    await expect(observerPage.locator(`#main-content [data-message-id="${chainReply.id}"]`)).toContainText('移動する子返信')
    await observerPage.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
    await expect(observerExistingSummary).toBeVisible()

    // (b) Second context goes offline during a Move to a new Topic and converges after reconnect (replay)
    holdObserver = true
    await disconnectObserver()
    await expect(observerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'false')

    await panel.getByRole('button', { name: 'トピックに移動', exact: true }).click()
    await expect(moveDialog).toBeVisible()
    await moveDialog.getByRole('radio', { name: '新しいトピック', exact: true }).check()
    await moveDialog.getByLabel('新しいトピック名', { exact: true }).fill('新規移動先トピック')
    await moveDialog.getByRole('button', { name: 'トピックに移動', exact: true }).click()
    await expect(moveDialog).toHaveCount(0)
    await expect(panel.getByText('トピック: 新規移動先トピック', { exact: true })).toBeVisible()

    // Release observer reconnect and verify convergence via replay without page reload
    await expect.poll(() => heldObserver.length).toBeGreaterThan(0)
    holdObserver = false
    for (const release of heldObserver.splice(0)) release()
    await expect(observerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    await expect(observerExistingSummary).toContainText('1件›')
    const newTopicSummary = observerPage.locator('#main-content button[data-topic-id]').filter({ hasText: 'トピック: 新規移動先トピック' })
    await expect(newTopicSummary).toBeVisible()
    await expect(newTopicSummary).toContainText('2件›')
    await expect(newTopicSummary).toContainText('移動する子返信')

    // Reload observerPage on the new Topic view to verify persisted convergence across reload as well
    await newTopicSummary.click()
    await expect(observerPage.getByRole('heading', { level: 1, name: '新規移動先トピック', exact: true })).toBeVisible()
    await observerPage.reload()
    await expect(observerPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(observerPage.locator(`#main-content [data-message-id="${chainRoot.id}"]`)).toContainText('移動する親メッセージ')
    await expect(observerPage.locator(`#main-content [data-message-id="${chainReply.id}"]`)).toContainText('移動する子返信')
  } finally {
    await authorContext.close()
    await observerContext.close()
  }
})

test('Move to topic denials: non-author Member, Guest and DM participant receive the Japanese denial and nothing changes', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const orgId = await signInOwner(page.request)
  const channel = await createChannel(page.request, orgId, `move-deny-${crypto.randomUUID().slice(0, 8)}`)
  const channelId = channel.id

  const memberContext = await browser.newContext()
  const guestContext = await browser.newContext()
  try {
    const memberIdentity = await createPeerSession(page.request, memberContext.request, orgId, 'member', '別メンバー')
    const guestIdentity = await createPeerSession(page.request, guestContext.request, orgId, 'guest', '閲覧ゲスト')

    // Grant Guest access to the public Channel so Guest can view and post their own chain
    const grantRes = await secretSafe(() =>
      page.request.post(`/api/v1/orgs/${orgId}/channels/${channelId}/members`, {
        data: { member_id: guestIdentity.member.id },
      }),
    )
    expect(grantRes.ok()).toBe(true)

    // Mixed-author chain: root by memberContext, reply by owner (so memberContext did not author the whole chain)
    const mixedRoot = await sendChannelMessage(memberContext.request, orgId, channelId, {
      body: '自分の親メッセージ',
    })
    await sendChannelMessage(page.request, orgId, channelId, {
      body: '他者の返信メッセージ',
      reply_to: mixedRoot.id,
    })

    // Guest-authored chain
    const guestRoot = await sendChannelMessage(guestContext.request, orgId, channelId, {
      body: 'ゲスト自身のメッセージ',
    })

    // (c) Member who did not author the whole chain gets the Japanese denial and nothing changes
    const memberPage = await memberContext.newPage()
    await memberPage.setViewportSize({ width: 1280, height: 800 })
    await memberPage.goto(`/o/${orgId}/c/${channelId}?panel=reply:${mixedRoot.id}`)
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const memberPanel = memberPage.locator('#panel-content')
    await expect(memberPanel.locator(`[data-message-id="${mixedRoot.id}"]`)).toContainText('自分の親メッセージ')

    const memberMoveBtn = memberPanel.getByRole('button', { name: 'トピックに移動', exact: true })
    await expect(memberMoveBtn).toBeEnabled()
    await memberMoveBtn.click()
    const memberDialog = memberPage.getByRole('dialog', { name: 'トピックに移動', exact: true })
    await expect(memberDialog).toBeVisible()
    await memberDialog.getByLabel('新しいトピック名', { exact: true }).fill('許可されない移動')
    await memberDialog.getByRole('button', { name: 'トピックに移動', exact: true }).click()

    await expect(memberDialog.getByRole('alert')).toHaveText('この返信のつながりをトピックに移動する権限がありません。')
    await memberDialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(memberDialog).toHaveCount(0)
    await expect(memberPage.locator('#main-content button[data-topic-id]')).toHaveCount(0)
    await expect(memberPage.locator(`#main-content [data-message-id="${mixedRoot.id}"]`)).toContainText('自分の親メッセージ')

    // (d1) Guest cannot Move even a chain they authored themselves
    const guestPage = await guestContext.newPage()
    await guestPage.setViewportSize({ width: 1280, height: 800 })
    await guestPage.goto(`/o/${orgId}/c/${channelId}?panel=reply:${guestRoot.id}`)
    await expect(guestPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const guestPanel = guestPage.locator('#panel-content')
    await expect(guestPanel.locator(`[data-message-id="${guestRoot.id}"]`)).toContainText('ゲスト自身のメッセージ')

    await guestPanel.getByRole('button', { name: 'トピックに移動', exact: true }).click()
    const guestDialog = guestPage.getByRole('dialog', { name: 'トピックに移動', exact: true })
    await expect(guestDialog).toBeVisible()
    await guestDialog.getByLabel('新しいトピック名', { exact: true }).fill('ゲスト移動不可')
    await guestDialog.getByRole('button', { name: 'トピックに移動', exact: true }).click()

    await expect(guestDialog.getByRole('alert')).toHaveText('この返信のつながりをトピックに移動する権限がありません。')
    await guestDialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(guestPage.locator('#main-content button[data-topic-id]')).toHaveCount(0)

    // (d2) DM participant cannot Move a chain in a DM
    const dmRes = await secretSafe(() =>
      memberContext.request.post(`/api/v1/orgs/${orgId}/dms`, {
        data: { member_id: memberIdentity.member.id },
      }),
    )
    // Open DM between owner and memberIdentity
    const ownerDmRes = await secretSafe(() =>
      page.request.post(`/api/v1/orgs/${orgId}/dms`, {
        data: { member_id: memberIdentity.member.id },
      }),
    )
    expect(dmRes.status()).toBe(400) // self-DM is 400; owner <-> member is 200/201
    expect(ownerDmRes.ok()).toBe(true)
    const dm = (await secretSafe(() => ownerDmRes.json())) as components['schemas']['Dm']
    const dmMsg = await sendChannelMessage(memberContext.request, orgId, dm.id, {
      body: 'DMの親メッセージ',
    })

    await memberPage.goto(`/o/${orgId}/c/${dm.id}?panel=reply:${dmMsg.id}`)
    await expect(memberPage.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(memberPanel.locator(`[data-message-id="${dmMsg.id}"]`)).toContainText('DMの親メッセージ')

    await memberPanel.getByRole('button', { name: 'トピックに移動', exact: true }).click()
    await expect(memberDialog).toBeVisible()
    await memberDialog.getByLabel('新しいトピック名', { exact: true }).fill('DMトピック不可')
    await memberDialog.getByRole('button', { name: 'トピックに移動', exact: true }).click()

    await expect(memberDialog.getByRole('alert')).toHaveText('この返信のつながりをトピックに移動する権限がありません。')
  } finally {
    await memberContext.close()
    await guestContext.close()
  }
})
