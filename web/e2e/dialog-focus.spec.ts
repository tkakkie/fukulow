import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type AcceptInviteRequest = components['schemas']['AcceptInviteRequest']
type AddChannelMemberRequest = components['schemas']['AddChannelMemberRequest']
type Channel = components['schemas']['Channel']
type CreateChannelRequest = components['schemas']['CreateChannelRequest']
type CreateInviteRequest = components['schemas']['CreateInviteRequest']
type ErrorBody = components['schemas']['ErrorBody']
type Identity = components['schemas']['Identity']
type InviteResponse = components['schemas']['InviteResponse']
type Message = components['schemas']['Message']
type SendMessageRequest = components['schemas']['SendMessageRequest']

const errorJson = (error: string): { contentType: string; body: string } => ({
  contentType: 'application/json',
  body: JSON.stringify({ error } satisfies ErrorBody),
})

const mainComposer = (page: Page) =>
  page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
const replyComposer = (page: Page) =>
  page.locator('#panel-content').getByRole('textbox', { name: 'メッセージ', exact: true })

async function sendApiMessage(
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

async function inviteAndAccept(
  ownerRequest: APIRequestContext,
  peerRequest: APIRequestContext,
  orgId: string,
  role: 'member' | 'guest',
  name: string,
): Promise<Identity> {
  const email = `dialog-${role}-${crypto.randomUUID()}@example.invalid`
  const password = `correct horse dialog ${role}`
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
  return (await secretSafe(() => acceptRes.json())) as Identity
}

/**
 * Verifies the modal Dialog keyboard and focus contract (docs/ui.md §9):
 * 1. Focus moves into the dialog on open (first enabled button: cancelLabel).
 * 2. Tab wraps forward (cancel -> confirm -> cancel) and Shift+Tab wraps backward (cancel -> confirm -> cancel).
 * 3. Pressing ⌘. / Ctrl+. while the dialog is open is ignored by Workspace.
 * 4. Pressing Escape closes only the dialog (preserving any open right panel / mobile level) and restores focus to `opener`.
 */
async function assertDialogFocusTrapAndEscape(
  page: Page,
  opener: Locator,
  title: string,
  confirmLabel: string,
  options: { expectPanelOpen?: boolean; cancelLabel?: string } = {},
) {
  const cancelLabel = options.cancelLabel ?? 'キャンセル'
  await opener.focus()
  await expect(opener).toBeFocused()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')

  const cancelBtn = dialog.getByRole('button', { name: cancelLabel, exact: true })
  const confirmBtn = dialog.getByRole('button', { name: confirmLabel, exact: true })

  // 1. Focus moves into the dialog on open (first focusable control)
  await expect(cancelBtn).toBeFocused()

  // 2. Tab wraps at the end, Shift+Tab wraps at the start
  await page.keyboard.press('Tab')
  await expect(confirmBtn).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancelBtn).toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(confirmBtn).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(cancelBtn).toBeFocused()

  // 3. Workspace shortcut (⌘. / Ctrl+.) is blocked while modal dialog is open
  const beforeShortcutUrl = page.url()
  await page.keyboard.press('ControlOrMeta+.')
  await expect(dialog).toBeVisible()
  expect(page.url()).toBe(beforeShortcutUrl)
  if (options.expectPanelOpen !== undefined) {
    await expect(page.locator('.workspace')).toHaveAttribute(
      'data-panel-open',
      String(options.expectPanelOpen),
    )
  }

  // 4. Escape closes the dialog, is consumed (panel stays in its prior state), and restores focus to opener
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(page.url()).toBe(beforeShortcutUrl)
  if (options.expectPanelOpen !== undefined) {
    await expect(page.locator('.workspace')).toHaveAttribute(
      'data-panel-open',
      String(options.expectPanelOpen),
    )
    if (options.expectPanelOpen) {
      await expect(page.locator('#panel-content')).toBeVisible()
    }
  }
  await expect(opener).toBeFocused()
}

for (const { label, width, height } of [
  { label: 'desktop 1280px', width: 1280, height: 800 },
  { label: 'phone 375px', width: 375, height: 667 },
] as const) {
  test(`${label}: draft-replace Dialog focus trap, Esc consumption and Composer focus restore in Timeline, TopicView and ReplyPanel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    const orgId = await signInOwner(page.request)
    const channel = await createChannel(
      page.request,
      orgId,
      `dialog-draft-${width}-${crypto.randomUUID().slice(0, 8)}`,
    )

    const rootMsg = await sendApiMessage(page.request, orgId, channel.id, {
      body: '返信元のメッセージ',
    })
    const topicMsg = await sendApiMessage(page.request, orgId, channel.id, {
      body: 'トピック初回メッセージ',
      topic_name: '下書き確認トピック',
    })
    expect(topicMsg.topic_id).toBeTruthy()

    let refuseNextSend = false
    await page.route(`**/api/v1/orgs/${orgId}/channels/${channel.id}/messages`, async (route) => {
      if (route.request().method() === 'POST' && refuseNextSend) {
        refuseNextSend = false
        return route.fulfill({ status: 400, ...errorJson('invalid_input') })
      }
      return route.continue()
    })

    // 1. Timeline draft-replace confirmation Dialog (with right panel open on desktop to prove Esc does not close the panel)
    const timelineUrl =
      width >= 600
        ? `/o/${orgId}/c/${channel.id}?panel=overview`
        : `/o/${orgId}/c/${channel.id}`
    await page.goto(timelineUrl)
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    if (width >= 600) {
      await expect(page.locator('#panel-content')).toBeVisible()
    }

    const timeline = page.getByRole('region', { name: 'タイムライン', exact: true })
    const timelineSend = timeline.getByRole('button', { name: '送信', exact: true })
    const timelineEdit = timeline.getByRole('button', { name: '編集して送り直す', exact: true })

    refuseNextSend = true
    await mainComposer(page).fill('タイムラインの拒否メッセージ')
    await timelineSend.click()
    await expect(timelineEdit).toBeVisible()
    await mainComposer(page).fill('タイムラインの既存下書き')

    await assertDialogFocusTrapAndEscape(
      page,
      timelineEdit,
      '入力中の下書きを置き換えますか？',
      '置き換える',
      { expectPanelOpen: width >= 600 },
    )
    await expect(mainComposer(page)).toHaveValue('タイムラインの既存下書き')

    // Reopen and click キャンセル: closes dialog and returns focus to the invoking 編集して送り直す button
    await page.keyboard.press('Enter')
    const timelineDialog = page.getByRole('dialog', {
      name: '入力中の下書きを置き換えますか？',
      exact: true,
    })
    await expect(timelineDialog).toBeVisible()
    await expect(timelineDialog.getByRole('button', { name: 'キャンセル', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(timelineDialog).toHaveCount(0)
    await expect(timelineEdit).toBeFocused()
    await expect(mainComposer(page)).toHaveValue('タイムラインの既存下書き')

    // Reopen and confirm 置き換える: invoking 編集して送り直す control is removed, focus moves to Composer
    await page.keyboard.press('Enter')
    await expect(timelineDialog).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(timelineDialog.getByRole('button', { name: '置き換える', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(timelineDialog).toHaveCount(0)
    await expect(timelineEdit).toHaveCount(0)
    await expect(mainComposer(page)).toHaveValue('タイムラインの拒否メッセージ')
    await expect(mainComposer(page)).toBeFocused()

    // Also verify Dialog fallback to Composer when the invoking 編集して送り直す row disappears before cancel
    refuseNextSend = true
    await mainComposer(page).fill('途中で消える拒否メッセージ')
    await timelineSend.click()
    await expect(timelineEdit).toBeVisible()
    await mainComposer(page).fill('残す下書き')
    await timelineEdit.focus()
    await page.keyboard.press('Enter')
    await expect(timelineDialog).toBeVisible()
    // Discard the failed row while the Dialog is open so the opener button unmounts, then press Escape
    await timeline.getByRole('button', { name: '破棄', exact: true }).evaluate((btn: HTMLElement) => btn.click())
    await expect(timelineEdit).toHaveCount(0)
    await timelineDialog.getByRole('button', { name: 'キャンセル', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(timelineDialog).toHaveCount(0)
    await expect(mainComposer(page)).toBeFocused()

    // 2. TopicView draft-replace confirmation Dialog
    const topicUrl =
      width >= 600
        ? `/o/${orgId}/c/${channel.id}/t/${topicMsg.topic_id}?panel=overview`
        : `/o/${orgId}/c/${channel.id}/t/${topicMsg.topic_id}`
    await page.goto(topicUrl)
    await expect(page.getByRole('heading', { level: 1, name: '下書き確認トピック', exact: true })).toBeVisible()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

    const topicRegion = page.getByRole('region', { name: 'トピックタイムライン', exact: true })
    const topicSend = topicRegion.getByRole('button', { name: '送信', exact: true })
    const topicEdit = topicRegion.getByRole('button', { name: '編集して送り直す', exact: true })

    refuseNextSend = true
    await mainComposer(page).fill('トピックの拒否メッセージ')
    await topicSend.click()
    await expect(topicEdit).toBeVisible()
    await mainComposer(page).fill('トピックの既存下書き')

    await assertDialogFocusTrapAndEscape(
      page,
      topicEdit,
      '入力中の下書きを置き換えますか？',
      '置き換える',
      { expectPanelOpen: width >= 600 },
    )
    await expect(mainComposer(page)).toHaveValue('トピックの既存下書き')

    // Confirm 置き換える in TopicView: opener is removed and focus moves to Topic Composer
    await page.keyboard.press('Enter')
    const topicDialog = page.getByRole('dialog', {
      name: '入力中の下書きを置き換えますか？',
      exact: true,
    })
    await expect(topicDialog).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(topicDialog.getByRole('button', { name: '置き換える', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(topicDialog).toHaveCount(0)
    await expect(topicEdit).toHaveCount(0)
    await expect(mainComposer(page)).toHaveValue('トピックの拒否メッセージ')
    await expect(mainComposer(page)).toBeFocused()

    // 3. ReplyPanel draft-replace confirmation Dialog (inside the right panel; Esc must NOT close the reply panel)
    await page.goto(`/o/${orgId}/c/${channel.id}?panel=reply:${rootMsg.id}`)
    const panel = page.locator('#panel-content')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { level: 2, name: '返信のつながり', exact: true })).toBeVisible()
    await expect(panel.locator(`[data-message-id="${rootMsg.id}"]`)).toContainText('返信元のメッセージ')

    const replySend = panel.getByRole('button', { name: '送信', exact: true })
    const replyEdit = panel.getByRole('button', { name: '編集して送り直す', exact: true })

    refuseNextSend = true
    await replyComposer(page).fill('返信パネルの拒否メッセージ')
    await replySend.click()
    await expect(replyEdit).toBeVisible()
    await replyComposer(page).fill('返信パネルの既存下書き')

    await assertDialogFocusTrapAndEscape(
      page,
      replyEdit,
      '入力中の下書きを置き換えますか？',
      '置き換える',
      { expectPanelOpen: true },
    )
    await expect(panel).toBeVisible()
    await expect(replyComposer(page)).toHaveValue('返信パネルの既存下書き')

    // Confirm 置き換える in ReplyPanel: opener is removed and focus moves to Reply Composer while panel stays open
    await page.keyboard.press('Enter')
    const replyDialog = page.getByRole('dialog', {
      name: '入力中の下書きを置き換えますか？',
      exact: true,
    })
    await expect(replyDialog).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(replyDialog.getByRole('button', { name: '置き換える', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(replyDialog).toHaveCount(0)
    await expect(replyEdit).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(replyComposer(page)).toHaveValue('返信パネルの拒否メッセージ')
    await expect(replyComposer(page)).toBeFocused()
  })

  test(`${label}: ChannelMembers Dialogs (grant/revoke manager, remove member, leave channel) trap focus, consume Esc and restore focus`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width, height })
    const orgId = await signInOwner(page.request)
    const base = `/api/v1/orgs/${orgId}`

    const channelReq: CreateChannelRequest = {
      name: `dialog-members-${width}-${crypto.randomUUID().slice(0, 8)}`,
      visibility: 'private',
    }
    const channelRes = await secretSafe(() =>
      page.request.post(`${base}/channels`, { data: channelReq }),
    )
    expect(channelRes.status()).toBe(201)
    const privateChannel = (await secretSafe(() => channelRes.json())) as Channel

    const peerContext = await browser.newContext()
    try {
      const memberIdentity = await inviteAndAccept(
        page.request,
        peerContext.request,
        orgId,
        'member',
        '佐藤 花子',
      )
      const addMember: AddChannelMemberRequest = { member_id: memberIdentity.member.id }
      expect(
        (
          await secretSafe(() =>
            page.request.post(`${base}/channels/${privateChannel.id}/members`, { data: addMember }),
          )
        ).ok(),
      ).toBe(true)

      await page.goto(`/o/${orgId}/c/${privateChannel.id}?panel=members`)
      const panel = page.locator('#panel-content')
      const memberRegion = panel.getByRole('region', { name: 'チャンネルのメンバー', exact: true })
      await expect(memberRegion).toBeVisible()

      // 1. Grant チャンネル管理者 Dialog: trap, Esc keeps panel open and restores focus, then confirm grants
      const grantBtn = memberRegion.getByRole('button', {
        name: '佐藤 花子のチャンネル管理者を付与する',
        exact: true,
      })
      await expect(grantBtn).toBeVisible()
      await assertDialogFocusTrapAndEscape(
        page,
        grantBtn,
        'チャンネル管理者を付与しますか？',
        '付与する',
        { expectPanelOpen: true },
      )

      // Confirm grant so 佐藤 花子 becomes a Channel manager (unlocking revoke and Alice's leave)
      await page.keyboard.press('Enter')
      const grantDialog = page.getByRole('dialog', {
        name: 'チャンネル管理者を付与しますか？',
        exact: true,
      })
      await expect(grantDialog).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(grantDialog.getByRole('button', { name: '付与する', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(grantDialog).toHaveCount(0)

      // 2. Revoke チャンネル管理者 Dialog: trap, Esc keeps panel open and restores focus to revoke button
      const revokeBtn = memberRegion.getByRole('button', {
        name: '佐藤 花子のチャンネル管理者を解除する',
        exact: true,
      })
      await expect(revokeBtn).toBeVisible()
      await assertDialogFocusTrapAndEscape(
        page,
        revokeBtn,
        'チャンネル管理者を解除しますか？',
        '解除する',
        { expectPanelOpen: true },
      )

      // 3. Leave Channel Dialog (`チャンネルを退出しますか？`): trap, Esc keeps panel open and restores focus to leave button
      const leaveBtn = memberRegion.getByRole('button', {
        name: 'Aliceとしてチャンネルを退出',
        exact: true,
      })
      await expect(leaveBtn).toBeVisible()
      await assertDialogFocusTrapAndEscape(
        page,
        leaveBtn,
        'チャンネルを退出しますか？',
        '退出する',
        { expectPanelOpen: true },
      )

      // 4. Remove Member Dialog (`メンバーをチャンネルから外しますか？`): trap, Esc keeps panel open and restores focus to remove button, then confirm removes
      const removeBtn = memberRegion.getByRole('button', {
        name: '佐藤 花子をチャンネルから外す',
        exact: true,
      })
      await expect(removeBtn).toBeVisible()
      await assertDialogFocusTrapAndEscape(
        page,
        removeBtn,
        'メンバーをチャンネルから外しますか？',
        '外す',
        { expectPanelOpen: true },
      )
      await page.keyboard.press('Enter')
      const removeDialog = page.getByRole('dialog', {
        name: 'メンバーをチャンネルから外しますか？',
        exact: true,
      })
      await expect(removeDialog).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(removeDialog.getByRole('button', { name: '外す', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(removeDialog).toHaveCount(0)
      await expect(removeBtn).toHaveCount(0)
    } finally {
      await peerContext.close()
    }
  })
}
