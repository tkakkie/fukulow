import { randomUUID } from 'node:crypto'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import type { components, ServerEvent } from '../src/api-schema.d.ts'

type AccountIdentity = components['schemas']['AccountIdentity']
type Channel = components['schemas']['Channel']
type CreateChannelRequest = components['schemas']['CreateChannelRequest']
type ErrorBody = components['schemas']['ErrorBody']
type Message = components['schemas']['Message']
type SendMessageRequest = components['schemas']['SendMessageRequest']
type SetupStatus = components['schemas']['SetupStatus']

const owner = { email: 'owner@example.com', password: 'correct horse battery' }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test.afterEach(async ({ page }) => {
  await page.goto('about:blank')
})

let channelSeq = 0
const nextChannelName = (prefix: string) => `${prefix}-${++channelSeq}-${Date.now()}`

async function signIn(page: Page): Promise<string> {
  const statusRes = await page.request.get('/api/v1/setup')
  expect(statusRes.ok()).toBe(true)
  const { setup_required } = (await statusRes.json()) as SetupStatus

  await page.goto('/')
  if (setup_required) {
    await page.getByLabel('組織名').fill('Acme')
    await page.getByLabel('オーナーの名前').fill('Alice')
    await page.getByLabel('メールアドレス').fill(owner.email)
    await page.getByLabel('パスワード（12文字以上）').fill(owner.password)
    await page.getByLabel('セットアップトークン').fill(process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only')
    await page.getByRole('button', { name: 'セットアップして開始' }).click()
  } else {
    await page.getByLabel('メールアドレス').fill(owner.email)
    await page.getByLabel('パスワード').fill(owner.password)
    await page.getByRole('button', { name: 'ログイン' }).click()
  }
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()

  const meRes = await page.request.get('/api/v1/me')
  expect(meRes.ok()).toBe(true)
  const me = (await meRes.json()) as AccountIdentity
  return me.organizations[0].organization_id
}

async function createChannel(page: Page, name: string): Promise<Channel> {
  const created = page.waitForResponse(
    res => new URL(res.url()).pathname.endsWith('/channels') && res.request().method() === 'POST',
  )
  await page.getByLabel('チャンネル名').fill(name)
  await page.getByRole('button', { name: 'チャンネルを作成' }).click()
  const res = await created
  expect(res.ok()).toBe(true)
  const channel = (await res.json()) as Channel
  await expect(page.getByRole('heading', { name: channel.name })).toBeVisible()
  return channel
}

const errorJson = (error: string): { contentType: string; body: string } => ({
  contentType: 'application/json',
  body: JSON.stringify({ error } satisfies ErrorBody),
})

async function sendConfirmedMessage(page: Page, channelId: string, body: string): Promise<void> {
  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })
  const sent = page.waitForResponse(
    res => new URL(res.url()).pathname.endsWith(`/channels/${channelId}/messages`) && res.request().method() === 'POST',
  )
  await composer.fill(body)
  await sendButton.click()
  const res = await sent
  expect(res.status()).toBe(201)
  await expect(timeline.getByText('送信中…')).toHaveCount(0)
  await expect(timeline.getByText(body)).toBeVisible()
  await expect(composer).toHaveValue('')
}

async function reselectChannel(page: Page, viaName: string, targetName: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'チャンネル' })
  await nav.getByRole('button', { name: viaName }).click()
  await expect(page.getByRole('heading', { name: viaName })).toBeVisible()
  await nav.getByRole('button', { name: targetName }).click()
  await expect(page.getByRole('heading', { name: targetName })).toBeVisible()
}

test('keeps loaded Messages and the unsent draft visible in error and unavailable states', async ({ page }) => {
  let clientSocket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    ws.connectToServer()
    clientSocket = ws
  })

  await signIn(page)
  const target = await createChannel(page, nextChannelName('keep-visible'))
  const other = await createChannel(page, nextChannelName('other'))

  const nav = page.getByRole('navigation', { name: 'チャンネル' })
  await nav.getByRole('button', { name: target.name }).click()
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })

  const loadedMessage = `loaded-message-${Date.now()}`
  await sendConfirmedMessage(page, target.id, loadedMessage)

  const unsentDraft = `unsent-draft-${Date.now()}`
  await composer.fill(unsentDraft)

  // Remount Timeline through a Channel switch so the visible Message and draft come from adapter state.
  await reselectChannel(page, other.name, target.name)
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()
  await expect(timeline.getByText(loadedMessage)).toBeVisible()
  await expect(composer).toHaveValue(unsentDraft)

  // 1. Enter `unavailable` (C9 subscription error) while settled Messages and draft are present; recover by reselection.
  const refusal: ServerEvent = { type: 'error', channel_id: target.id, code: 'channel_not_found' }
  clientSocket!.send(JSON.stringify(refusal))

  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: 'チャンネル一覧へ', exact: true })).toBeVisible()
  await expect(timeline.getByRole('button', { name: '再試行' })).toHaveCount(0)
  await expect(timeline.getByText(loadedMessage)).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue(unsentDraft)

  await reselectChannel(page, other.name, target.name)
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()
  await expect(timeline.getByRole('alert')).toHaveCount(0)
  await expect(timeline.getByText(loadedMessage)).toBeVisible()
  await expect(composer).toHaveValue(unsentDraft)

  // 2. Drive retryable 503 (`error`) and 404 (`unavailable`) history states without retrying from `unavailable`.
  const existingIds = new Set([target.id, other.id])
  let latestOutcome: 'server_error' | 'not_found' | 'pass' = 'server_error'
  await page.route('**/api/v1/orgs/*/channels/*/messages*', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const channelId = /\/channels\/([^/]+)\/messages/.exec(new URL(route.request().url()).pathname)?.[1]
    if (!channelId || existingIds.has(channelId)) return route.continue()
    if (latestOutcome === 'server_error') {
      return route.fulfill({ status: 503, ...errorJson('internal_error') })
    }
    if (latestOutcome === 'not_found') {
      return route.fulfill({ status: 404, ...errorJson('not_found') })
    }
    return route.continue()
  })

  const historyTarget = await createChannel(page, nextChannelName('history-errors'))
  await expect(timeline.getByRole('alert').filter({ hasText: 'メッセージを読み込めませんでした。' })).toBeVisible()

  const confirmedInError = `confirmed-in-error-${Date.now()}`
  await sendConfirmedMessage(page, historyTarget.id, confirmedInError)

  const historyDraft = `history-draft-${Date.now()}`
  await composer.fill(historyDraft)

  // Re-selecting with no established cursor re-fetches `latest` (503 -> `error`); settled Message and draft stay visible.
  await reselectChannel(page, other.name, historyTarget.name)
  await expect(timeline.getByRole('alert').filter({ hasText: 'メッセージを読み込めませんでした。' })).toBeVisible()
  await expect(timeline.getByText(confirmedInError)).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue(historyDraft)

  // 3. `再試行` from retryable `error` fails with HTTP 404 -> `unavailable`; settled Message and draft stay visible.
  latestOutcome = 'not_found'
  await timeline.getByRole('button', { name: '再試行' }).click()
  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: 'チャンネル一覧へ', exact: true })).toBeVisible()
  await expect(timeline.getByRole('button', { name: '再試行' })).toHaveCount(0)
  await expect(timeline.getByRole('alert').filter({ hasText: 'メッセージを読み込めませんでした。' })).toHaveCount(0)
  await expect(timeline.getByText(confirmedInError)).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue(historyDraft)

  // 4. Recovery from `unavailable` via Channel reselection succeeds against the real server and clears the alert.
  latestOutcome = 'pass'
  await reselectChannel(page, other.name, historyTarget.name)
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()
  await expect(timeline.getByRole('alert')).toHaveCount(0)
  await expect(timeline.getByText(confirmedInError)).toBeVisible()
  await expect(composer).toHaveValue(historyDraft)
})

test('disables the Composer when the Channel is unavailable', async ({ page }) => {
  let clientSocket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    ws.connectToServer()
    clientSocket = ws
  })

  await signIn(page)
  const target = await createChannel(page, nextChannelName('composer-disabled'))
  const other = await createChannel(page, nextChannelName('composer-other'))
  await page.getByRole('navigation', { name: 'チャンネル' }).getByRole('button', { name: target.name }).click()
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })

  await composer.fill('non-empty draft')
  await expect(composer).toBeEnabled()
  await expect(sendButton).toBeEnabled()

  const refusal: ServerEvent = { type: 'error', channel_id: target.id, code: 'channel_not_found' }
  clientSocket!.send(JSON.stringify(refusal))

  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await expect(composer).toBeDisabled()
  await expect(sendButton).toBeDisabled()

  // Reselecting recovers the unavailable Channel and re-enables the Composer.
  await reselectChannel(page, other.name, target.name)
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()
  await expect(timeline.getByRole('alert')).toHaveCount(0)
  await expect(composer).toBeEnabled()
  await expect(sendButton).toBeEnabled()

  // Retryable `error` keeps the Composer enabled, and `再試行` from `error` clears it.
  const existingIds = new Set([target.id, other.id])
  let failOnce = true
  await page.route('**/api/v1/orgs/*/channels/*/messages*', async route => {
    const channelId = /\/channels\/([^/]+)\/messages/.exec(new URL(route.request().url()).pathname)?.[1]
    if (route.request().method() === 'GET' && channelId && !existingIds.has(channelId) && failOnce) {
      failOnce = false
      return route.fulfill({ status: 503, ...errorJson('internal_error') })
    }
    return route.continue()
  })

  await createChannel(page, nextChannelName('composer-retryable'))
  await expect(timeline.getByRole('alert').filter({ hasText: 'メッセージを読み込めませんでした。' })).toBeVisible()
  await composer.fill('draft during retryable error')
  await expect(composer).toBeEnabled()
  await expect(sendButton).toBeEnabled()

  await timeline.getByRole('button', { name: '再試行' }).click()
  await expect(timeline.getByRole('alert')).toHaveCount(0)
  await expect(composer).toBeEnabled()
  await expect(sendButton).toBeEnabled()
})

test('shows 編集して送り直す on a definite failed send and restores the text into the Composer', async ({ page }) => {
  await signIn(page)
  const target = await createChannel(page, nextChannelName('definite-send-fail'))

  let refuseNext = true
  await page.route(`**/api/v1/orgs/*/channels/${target.id}/messages`, async route => {
    if (route.request().method() === 'POST' && refuseNext) {
      refuseNext = false
      return route.fulfill({ status: 400, ...errorJson('invalid_input') })
    }
    return route.continue()
  })

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })

  const body = `refused-send-${Date.now()}`
  await composer.fill(body)
  await sendButton.click()

  await expect(composer).toHaveValue('')
  await expect(timeline.getByRole('alert').filter({ hasText: '送信できませんでした。' })).toBeVisible()
  const editButton = timeline.getByRole('button', { name: '編集して送り直す', exact: true })
  await expect(editButton).toBeVisible()
  await expect(timeline.getByRole('button', { name: '再送する', exact: true })).toHaveCount(0)

  await editButton.click()
  await expect(composer).toHaveValue(body)
  await expect(editButton).toHaveCount(0)
  await expect(timeline.getByRole('alert')).toHaveCount(0)

  const confirmed = page.waitForResponse(
    res => new URL(res.url()).pathname.endsWith(`/channels/${target.id}/messages`) && res.request().method() === 'POST',
  )
  await sendButton.click()
  expect((await confirmed).status()).toBe(201)
  await expect(timeline.getByText('送信中…')).toHaveCount(0)
  await expect(composer).toHaveValue('')
  await expect(timeline.getByText(body)).toBeVisible()
  await expect(timeline.getByRole('alert')).toHaveCount(0)
})

test('shows 再送する on an unknown send outcome and resends with the same client_message_id', async ({ page }) => {
  await signIn(page)
  const target = await createChannel(page, nextChannelName('unknown-send-retry'))

  const sentRequests: SendMessageRequest[] = []
  await page.route(`**/api/v1/orgs/*/channels/${target.id}/messages`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const payload = route.request().postDataJSON() as SendMessageRequest
    sentRequests.push(payload)
    if (sentRequests.length === 1) {
      return route.abort('failed')
    }
    if (sentRequests.length === 2) {
      return route.fulfill({ status: 503, ...errorJson('service_unavailable') })
    }
    return route.continue()
  })

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })
  const resendButton = timeline.getByRole('button', { name: '再送する', exact: true })

  const body = `idempotent-retry-${Date.now()}`
  await composer.fill(body)
  await sendButton.click()

  // Attempt 1 aborted (network error): unknown outcome offers 再送する, never 編集して送り直す.
  await expect(timeline.getByRole('alert').filter({ hasText: '送信を確認できませんでした。' })).toBeVisible()
  await expect(resendButton).toBeVisible()
  await expect(timeline.getByRole('button', { name: '編集して送り直す', exact: true })).toHaveCount(0)
  expect(sentRequests).toHaveLength(1)
  expect(sentRequests[0].body).toBe(body)
  expect(sentRequests[0].client_message_id).toMatch(uuidPattern)

  // Attempt 2 returns 503: still unknown, reuses the exact same client_message_id.
  await resendButton.click()
  await expect.poll(() => sentRequests.length).toBe(2)
  expect(sentRequests[1].client_message_id).toBe(sentRequests[0].client_message_id)
  expect(sentRequests[1].body).toBe(body)
  await expect(resendButton).toBeVisible()
  await expect(timeline.getByRole('button', { name: '編集して送り直す', exact: true })).toHaveCount(0)

  // Attempt 3 reaches the real server with the same client_message_id and settles the Message.
  const confirmedRes = page.waitForResponse(
    res => res.url().endsWith(`/channels/${target.id}/messages`) && res.request().method() === 'POST',
  )
  await resendButton.click()
  const response = await confirmedRes
  expect(response.status()).toBe(201)
  const confirmed = (await response.json()) as Message

  expect(sentRequests).toHaveLength(3)
  expect(sentRequests[2].client_message_id).toBe(sentRequests[0].client_message_id)
  expect(confirmed.client_message_id).toBe(sentRequests[0].client_message_id)

  await expect(resendButton).toHaveCount(0)
  await expect(timeline.getByRole('alert')).toHaveCount(0)
  await expect(timeline.getByText(body)).toBeVisible()
})

test('shows the loadOlder error on failure and clears it on a successful retry', async ({ page }) => {
  const orgId = await signIn(page)

  // Seed 101 Messages so `latest` returns 52..101 (has_more: true) and the first older page
  // returns 2..51 with `has_more: true`, keeping the loadOlder section mounted after retry.
  const channelReq: CreateChannelRequest = { name: nextChannelName('load-older'), visibility: 'public' }
  const channelRes = await page.request.post(`/api/v1/orgs/${orgId}/channels`, { data: channelReq })
  expect(channelRes.status()).toBe(201)
  const target = (await channelRes.json()) as Channel

  for (let i = 1; i <= 101; i++) {
    const msgReq: SendMessageRequest = {
      client_message_id: randomUUID(),
      body: `paged-msg-${String(i).padStart(3, '0')}`,
    }
    const msgRes = await page.request.post(`/api/v1/orgs/${orgId}/channels/${target.id}/messages`, { data: msgReq })
    expect(msgRes.status()).toBe(201)
  }

  await page.reload()
  await expect(page.getByText('Acme / Alice さん')).toBeVisible()
  await page.getByRole('navigation', { name: 'チャンネル' }).getByRole('button', { name: target.name }).click()

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const loadOlderButton = timeline.getByRole('button', { name: '以前のメッセージを読み込む' })
  const olderErrorAlert = timeline.getByRole('alert').filter({ hasText: '以前のメッセージを読み込めませんでした。' })

  await expect(timeline.getByText('paged-msg-101')).toBeVisible()
  await expect(timeline.getByText('paged-msg-051')).toHaveCount(0)
  await expect(loadOlderButton).toBeVisible()
  await expect(olderErrorAlert).toHaveCount(0)

  let failBeforeOnce = true
  await page.route(`**/api/v1/orgs/*/channels/${target.id}/messages*`, async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'GET' && url.searchParams.has('before_seq') && failBeforeOnce) {
      failBeforeOnce = false
      return route.fulfill({ status: 503, ...errorJson('internal_error') })
    }
    return route.continue()
  })

  await loadOlderButton.click()
  await expect(olderErrorAlert).toBeVisible()
  await expect(timeline.getByText('paged-msg-051')).toHaveCount(0)
  await expect(loadOlderButton).toBeEnabled()

  await loadOlderButton.click()
  await expect(timeline.getByText('paged-msg-051')).toBeVisible()
  await expect(loadOlderButton).toBeVisible()
  await expect(olderErrorAlert).toHaveCount(0)
})

test('shows Composer validation error and keeps the draft when body exceeds 4000 characters', async ({ page }) => {
  await signIn(page)
  await createChannel(page, nextChannelName('composer-validation'))

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })

  const oversized = 'あ'.repeat(4001)
  await composer.fill(oversized)
  await sendButton.click()

  await expect(timeline.getByRole('alert').filter({ hasText: 'メッセージは4000文字以内にしてください。' })).toBeVisible()
  await expect(composer).toHaveValue(oversized)
})

test('C9 renders no 再試行 and チャンネル一覧へ moves focus to the Channel list across desktop, tablet and phone widths', async ({
  page,
}) => {
  let clientSocket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    ws.connectToServer()
    clientSocket = ws
  })

  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page)
  const target = await createChannel(page, nextChannelName('c9-focus-target'))
  const other = await createChannel(page, nextChannelName('c9-focus-other'))

  const nav = page.getByRole('navigation', { name: 'チャンネル' })
  await nav.getByRole('button', { name: target.name }).click()
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const goToListButton = timeline.getByRole('button', { name: 'チャンネル一覧へ', exact: true })
  const targetChannelButton = nav.getByRole('button', { name: target.name })
  const channelListHeading = nav.getByRole('heading', { name: 'チャンネル', exact: true })

  const refusal: ServerEvent = { type: 'error', channel_id: target.id, code: 'channel_not_found' }
  clientSocket!.send(JSON.stringify(refusal))

  // 1. Desktop (1280px): C9 has no 再試行, and チャンネル一覧へ shows the Channel list and focuses the チャンネル heading
  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: '再試行' })).toHaveCount(0)
  await expect(goToListButton).toBeVisible()

  await goToListButton.click()
  await expect(nav).toBeVisible()
  await expect(channelListHeading).toBeVisible()
  await expect(channelListHeading).toBeFocused()
  await expect(goToListButton).not.toBeFocused()

  // Clicking the current Channel row directly triggers one retry and recovers from C9
  await targetChannelButton.click()
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()
  await expect(timeline.getByRole('alert')).toHaveCount(0)

  // 2. Tablet drawer (768px): Channel column starts hidden; チャンネル一覧へ opens the drawer and focuses the チャンネル heading
  clientSocket!.send(JSON.stringify(refusal))
  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await page.setViewportSize({ width: 768, height: 800 })
  await expect(nav).toBeHidden()
  await expect(channelListHeading).toBeHidden()
  await goToListButton.click()
  await expect(nav).toBeVisible()
  await expect(channelListHeading).toBeVisible()
  await expect(channelListHeading).toBeFocused()

  // 3. Phone (375px): enter the Channel view level, trigger C9, and verify チャンネル一覧へ shows the Channel list and focuses the チャンネル heading
  await page.setViewportSize({ width: 375, height: 800 })
  await nav.getByRole('button', { name: other.name }).click()
  await expect(page.getByRole('heading', { name: other.name })).toBeVisible()
  await page.getByRole('button', { name: 'チャンネル一覧へ戻る' }).click()
  await targetChannelButton.click()
  await expect(page.getByRole('heading', { name: target.name })).toBeVisible()
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()
  await expect(nav).toBeHidden()
  await expect(channelListHeading).toBeHidden()

  clientSocket!.send(JSON.stringify(refusal))
  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: '再試行' })).toHaveCount(0)

  await goToListButton.click()
  await expect(nav).toBeVisible()
  await expect(timeline).toBeHidden()
  await expect(channelListHeading).toBeVisible()
  await expect(channelListHeading).toBeFocused()
})

test('confirms before replacing a non-empty Composer draft on 編集して送り直す (置き換える / キャンセル)', async ({
  page,
}) => {
  await signIn(page)
  const target = await createChannel(page, nextChannelName('draft-replace-confirm'))

  let refuseNext = true
  await page.route(`**/api/v1/orgs/*/channels/${target.id}/messages`, async route => {
    if (route.request().method() === 'POST' && refuseNext) {
      refuseNext = false
      return route.fulfill({ status: 400, ...errorJson('invalid_input') })
    }
    return route.continue()
  })

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })
  const editButton = timeline.getByRole('button', { name: '編集して送り直す', exact: true })

  const refusedBody = `refused-body-${Date.now()}`
  await composer.fill(refusedBody)
  await sendButton.click()

  await expect(editButton).toBeVisible()
  await expect(composer).toHaveValue('')

  const currentDraft = `existing-draft-${Date.now()}`
  await composer.fill(currentDraft)

  // 1. Clicking 編集して送り直す with a non-empty draft opens the confirmation dialog; キャンセル keeps both
  await editButton.click()
  const dialog = page.getByRole('dialog', { name: '入力中の下書きを置き換えますか？' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '置き換える', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'キャンセル', exact: true })).toBeVisible()

  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(composer).toHaveValue(currentDraft)
  await expect(editButton).toBeVisible()
  await expect(timeline.getByText(refusedBody)).toBeVisible()

  // 2. Clicking 置き換える replaces the draft with the refused Message, removes the failed row and focuses the Composer
  await editButton.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '置き換える', exact: true }).click()

  await expect(dialog).toHaveCount(0)
  await expect(composer).toHaveValue(refusedBody)
  await expect(composer).toBeFocused()
  await expect(editButton).toHaveCount(0)

  const confirmed = page.waitForResponse(
    res => new URL(res.url()).pathname.endsWith(`/channels/${target.id}/messages`) && res.request().method() === 'POST',
  )
  await sendButton.click()
  expect((await confirmed).status()).toBe(201)
  await expect(timeline.getByText(refusedBody)).toBeVisible()
  await expect(composer).toHaveValue('')
})

test('discards failed sends via 破棄, focuses Composer when active, and hides resend/edit when target is unavailable', async ({
  page,
}) => {
  let clientSocket: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    ws.connectToServer()
    clientSocket = ws
  })

  await signIn(page)
  const target = await createChannel(page, nextChannelName('discard-failed'))
  await expect(page.getByText('リアルタイム接続済み')).toBeVisible()

  let postMode: 'abort' | 'refuse' | 'pass' = 'abort'
  await page.route(`**/api/v1/orgs/*/channels/${target.id}/messages`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    if (postMode === 'abort') return route.abort('failed')
    if (postMode === 'refuse') return route.fulfill({ status: 400, ...errorJson('invalid_input') })
    return route.continue()
  })

  const timeline = page.getByRole('region', { name: 'タイムライン' })
  const composer = timeline.getByRole('textbox', { name: 'メッセージ' })
  const sendButton = timeline.getByRole('button', { name: '送信' })
  const discardButtons = timeline.getByRole('button', { name: '破棄', exact: true })

  // 1. Active Channel: 破棄 removes the failed Message and moves focus to the Composer
  const firstFailed = `discard-active-${Date.now()}`
  await composer.fill(firstFailed)
  await sendButton.click()
  await expect(timeline.getByRole('alert').filter({ hasText: '送信を確認できませんでした。' })).toBeVisible()
  await expect(discardButtons).toHaveCount(1)

  await discardButtons.click()
  await expect(discardButtons).toHaveCount(0)
  await expect(timeline.getByText(firstFailed)).toHaveCount(0)
  await expect(timeline.getByRole('alert')).toHaveCount(0)
  await expect(composer).toBeFocused()

  // 2. Target unavailable (C9): hides 再送する and 編集して送り直す while keeping failed text and 破棄
  const unknownFailed = `discard-c9-unknown-${Date.now()}`
  await composer.fill(unknownFailed)
  await sendButton.click()
  await expect(timeline.getByRole('button', { name: '再送する', exact: true })).toBeVisible()

  postMode = 'refuse'
  const refusedFailed = `discard-c9-refused-${Date.now()}`
  await composer.fill(refusedFailed)
  await sendButton.click()
  await expect(timeline.getByRole('button', { name: '編集して送り直す', exact: true })).toBeVisible()
  await expect(discardButtons).toHaveCount(2)

  const refusal: ServerEvent = { type: 'error', channel_id: target.id, code: 'channel_not_found' }
  clientSocket!.send(JSON.stringify(refusal))

  await expect(timeline.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません' })).toBeVisible()
  await expect(timeline.getByRole('button', { name: '再送する', exact: true })).toHaveCount(0)
  await expect(timeline.getByRole('button', { name: '編集して送り直す', exact: true })).toHaveCount(0)
  await expect(timeline.getByText(unknownFailed)).toBeVisible()
  await expect(timeline.getByText(refusedFailed)).toBeVisible()
  await expect(discardButtons).toHaveCount(2)

  await discardButtons.first().click()
  await expect(discardButtons).toHaveCount(1)
  await expect(timeline.getByText(unknownFailed)).toHaveCount(0)
  await expect(timeline.getByText(refusedFailed)).toBeVisible()

  await discardButtons.first().click()
  await expect(discardButtons).toHaveCount(0)
  await expect(timeline.getByText(refusedFailed)).toHaveCount(0)
})
