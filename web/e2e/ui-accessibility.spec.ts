import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { secretSafe, createChannel, owner, signInOwner } from './helpers.ts'

// No locator.click/fill/focus in these flows: even at narrow widths, controls must
// be reachable by the browser's real sequential keyboard navigation.
async function tabTo(page: Page, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab') {
  await expect(target).toBeVisible()
  const limit = await page.locator('a[href], button, input, textarea, select, summary, [tabindex]').count() + 2
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate(el => el === document.activeElement)) break
    await page.keyboard.press(key)
  }
  await expect(target).toBeFocused()
  await expectControlFits(target)
}

async function expectNoHorizontalScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

// toBeVisible alone also passes for off-screen or overflow:hidden-clipped buttons.
async function expectControlFits(control: Locator) {
  await expect(control).toBeVisible()
  await expect(control).toBeInViewport({ ratio: 1 })
  await expect.poll(() => control.evaluate(el => {
    const rect = el.getBoundingClientRect()
    if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) return false
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const box = parent.getBoundingClientRect()
      const left = box.left + parent.clientLeft
      const top = box.top + parent.clientTop
      if (style.overflowX !== 'visible' && (rect.left < left - 1 || rect.right > left + parent.clientWidth + 1)) return false
      if (style.overflowY !== 'visible' && (rect.top < top - 1 || rect.bottom > top + parent.clientHeight + 1)) return false
    }
    return el.tagName !== 'BUTTON' || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)
  })).toBe(true)
}

async function keyboardSignIn(page: Page, org: string, doubleText = false) {
  await page.context().clearCookies()
  await page.goto(`/o/${org}`)
  await expect(page.getByRole('heading', { name: 'ログイン', exact: true })).toBeVisible()
  const normal = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
  if (doubleText) {
    // The default root is 15px (93.75%); double its computed size, not the
    // browser default. Apply after mount so settings cannot overwrite it.
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size * 2}px` }, normal)
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(normal * 2)
  }
  await expectNoHorizontalScroll(page)
  const email = page.getByLabel('メールアドレス', { exact: true })
  const password = page.getByLabel('パスワード', { exact: true })
  const submit = page.getByRole('button', { name: 'ログイン', exact: true })
  for (const control of [email, password, submit]) await expectControlFits(control)
  await tabTo(page, email)
  await page.keyboard.type(owner.email)
  await page.keyboard.press('Tab')
  await expect(password).toBeFocused()
  await page.keyboard.type(owner.password)
  await page.keyboard.press('Tab')
  await expect(submit).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation', { name: 'チャンネル', exact: true })).toBeVisible()
  return normal * (doubleText ? 2 : 1)
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'メッセージ', exact: true })
const panelOpener = (page: Page) => page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true })

async function sendWithKeyboard(page: Page, channelId: string, body: string) {
  await expect(composer(page)).toBeFocused()
  await expectControlFits(composer(page))
  await page.keyboard.type(body)
  const send = page.getByRole('button', { name: '送信', exact: true })
  await expectControlFits(send)
  // Exercise the visible send control's tab stop too, then return to Enter-send.
  await page.keyboard.press('Tab')
  await expect(send).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(composer(page)).toBeFocused()
  const sent = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith(`/channels/${channelId}/messages`))
  await page.keyboard.press('Enter')
  await expect(composer(page)).toHaveValue('')
  expect((await sent).status()).toBe(201)
  await expect(page.getByRole('list', { name: 'メッセージ一覧' }).getByText(body, { exact: true })).toBeVisible()
  await expect(composer(page)).toBeFocused()
}

async function openAndClosePanel(page: Page) {
  await tabTo(page, panelOpener(page), 'Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(page.locator('#panel-content h2')).toBeFocused()
  await expectNoHorizontalScroll(page)
  const close = page.getByRole('button', { name: 'パネルを閉じる(Esc)', exact: true })
  const topics = page.getByRole('tab', { name: 'トピック', exact: true })
  for (const control of [close, topics, page.getByRole('tab', { name: '概要', exact: true }), page.getByRole('tab', { name: 'メンバー', exact: true })]) {
    await expectControlFits(control)
  }
  await tabTo(page, close)
  await page.keyboard.press('Tab')
  await expect(topics).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#panel-content')).toHaveCount(0)
  await expect(panelOpener(page)).toBeFocused()
  await expectControlFits(panelOpener(page))
  await expectNoHorizontalScroll(page)
}

for (const { name, width, doubleText } of [
  { name: '320 CSS px reflow: sign-in, Channel list, long Message and panel remain keyboard operable', width: 320, doubleText: false },
  { name: '200% text at 1280px: sign-in, Channel selection, send and panel fit and work by keyboard', width: 1280, doubleText: true },
  { name: '200% text at 375px: sign-in, Channel selection, send and panel fit and work by keyboard', width: 375, doubleText: true },
]) {
  test(name, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const org = await signInOwner(page.request)
    const channel = await createChannel(page.request, org, `a11y-${crypto.randomUUID().slice(0, 8)}`)
    const longBody = `long-${'abcdefghij'.repeat(24)} https://example.invalid/${'0123456789'.repeat(24)}`
    const seed: components['schemas']['SendMessageRequest'] = { client_message_id: crypto.randomUUID(), body: longBody }
    expect((await secretSafe(() => page.request.post(`/api/v1/orgs/${org}/channels/${channel.id}/messages`, { data: seed }))).status()).toBe(201)

    const rootSize = await keyboardSignIn(page, org, doubleText)

    const select = page.getByRole('navigation', { name: 'チャンネル', exact: true }).getByRole('button', { name: `# ${channel.name}`, exact: true })
    await tabTo(page, select)
    await expectNoHorizontalScroll(page)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(`/o/${org}/c/${channel.id}`)
    await expect(composer(page)).toBeFocused()
    const message = page.getByRole('article').filter({ hasText: longBody })
    await expect(message).toBeVisible()
    // The long body may need vertical timeline scrolling, but must wrap horizontally.
    await expect.poll(() => message.evaluate(el => {
      const rect = el.getBoundingClientRect()
      if (el.scrollWidth > el.clientWidth || rect.left < 0 || rect.right > innerWidth) return false
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === 'visible') continue
        const left = parent.getBoundingClientRect().left + parent.clientLeft
        if (rect.left < left - 1 || rect.right > left + parent.clientWidth + 1) return false
      }
      return true
    })).toBe(true)
    await expectNoHorizontalScroll(page)
    await sendWithKeyboard(page, channel.id, `keyboard send ${width}`)
    await expectNoHorizontalScroll(page)
    await openAndClosePanel(page)
    await expect(page.locator('html')).toHaveCSS('font-size', `${rootSize}px`)
  })
}

test('keyboard only: sign in, select Channel, Enter-send, panel Esc restores focus and desktop skip link reaches Composer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `keys-${crypto.randomUUID().slice(0, 8)}`)
  await keyboardSignIn(page, org)
  const select = page.getByRole('navigation', { name: 'チャンネル', exact: true }).getByRole('button', { name: `# ${channel.name}`, exact: true })
  await tabTo(page, select)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}`)
  await sendWithKeyboard(page, channel.id, 'Only physical keyboard navigation')
  await openAndClosePanel(page)

  // Desktop path only; phone skip targets and Back already have coverage.
  const skip = page.getByRole('link', { name: 'メッセージへ移動', exact: true })
  await tabTo(page, skip, 'Shift+Tab')
  await expect(skip).toHaveAttribute('href', '#main-content')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await tabTo(page, composer(page))
  await page.keyboard.type('Reached through skip link')
  await expect(composer(page)).toHaveValue('Reached through skip link')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
})

declare global {
  interface Window { __a11yStatusUpdates: string[] }
}

async function observeStatus(page: Page) {
  const status = page.getByRole('status')
  await expect(status).toHaveCount(1)
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await status.evaluate(region => {
    window.__a11yStatusUpdates = []
    new MutationObserver(records => {
      // Count non-empty DOM writes, including consecutive identical texts. Do not
      // dedupe by text or sample once per callback (both can hide duplicates).
      for (const record of records) {
        const nodes = record.type === 'characterData' ? [record.target] : [...record.addedNodes]
        for (const node of nodes) {
          const text = node.textContent?.trim()
          if (text) window.__a11yStatusUpdates.push(text)
        }
      }
    }).observe(region, { childList: true, characterData: true, subtree: true })
  })
  return status
}

const updates = (page: Page) => page.evaluate(() => window.__a11yStatusUpdates)

async function freezeTime(page: Page) {
  const time = Date.now()
  await page.clock.install({ time })
  await page.clock.pauseAt(time + 1_000)
}

async function postMessage(request: APIRequestContext, org: string, channel: string, body: string) {
  const data: components['schemas']['SendMessageRequest'] = { client_message_id: crypto.randomUUID(), body }
  const response = await secretSafe(() => request.post(`/api/v1/orgs/${org}/channels/${channel}/messages`, { data }))
  expect(response.status()).toBe(201)
}

// Same Invite -> accept -> separate Session sequence as navigation/timeline-errors.
async function announcementFixture(page: Page, other: APIRequestContext) {
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `status-${crypto.randomUUID().slice(0, 8)}`)
  const email = `a11y-${crypto.randomUUID()}@example.invalid`
  const password = 'correct horse announcements'
  const inviteRequest: components['schemas']['CreateInviteRequest'] = { email, role: 'member' }
  const invited = await secretSafe(() => page.request.post(`/api/v1/orgs/${org}/invites`, { data: inviteRequest }))
  expect(invited.ok()).toBe(true)
  const invite = await secretSafe(() => invited.json()) as components['schemas']['InviteResponse']
  const acceptRequest: components['schemas']['AcceptInviteRequest'] = { token: invite.token, email, password, name: '通知メンバー' }
  expect((await secretSafe(() => other.post(`/api/v1/orgs/${org}/invites/accept`, { data: acceptRequest }))).ok()).toBe(true)
  expect((await secretSafe(() => other.post('/api/v1/session', { data: { email, password } }))).ok()).toBe(true)
  // A history entry proves that mounting the page is not a live announcement.
  await postMessage(other, org, channel.id, 'Initial history must stay silent')
  const membersLoaded = page.waitForResponse(res => res.request().method() === 'GET' && res.url().endsWith(`/orgs/${org}/members`))
  await page.goto(`/o/${org}/c/${channel.id}`)
  expect((await membersLoaded).ok()).toBe(true)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  await expect(page.getByRole('list', { name: 'メッセージ一覧' }).getByText('Initial history must stay silent')).toBeVisible()
  await expect(page.getByRole('status')).toHaveText(`# ${channel.name}`)
  const status = await observeStatus(page)
  await freezeTime(page)
  return { org, channel, status, post: (body: string) => postMessage(other, org, channel.id, body) }
}

test('announcements: one live Message from another Member updates the polite status once; own sends stay silent', async ({ page, request }) => {
  const { org, channel, status, post } = await announcementFixture(page, request)
  const body = 'A single live Message'
  await post(body)
  await expect(page.getByRole('article').filter({ hasText: body })).toBeVisible()
  await page.clock.runFor(2_000)
  await expect(status).toHaveText(`通知メンバー: ${body}`)
  await expect.poll(() => updates(page)).toEqual([`通知メンバー: ${body}`])
  await postMessage(page.request, org, channel.id, 'Own send must stay silent')
  await expect(page.getByRole('article').filter({ hasText: 'Own send must stay silent' })).toBeVisible()
  await page.clock.runFor(4_000)
  await expect(status).toHaveText(`通知メンバー: ${body}`)
  expect(await updates(page)).toEqual([`通知メンバー: ${body}`])
})

test('announcements: Messages within 2 seconds produce one coalesced polite status update', async ({ page, request }) => {
  const { status, post } = await announcementFixture(page, request)
  for (let i = 1; i <= 3; i++) {
    const body = `Burst Message ${i}`
    await post(body)
    await expect(page.getByRole('article').filter({ hasText: body })).toBeVisible()
    if (i < 3) await page.clock.runFor(500)
  }
  await page.clock.runFor(999)
  expect(await updates(page)).toEqual([])
  await page.clock.runFor(1)
  await expect(status).toHaveText('新着メッセージ 3件')
  await expect.poll(() => updates(page)).toEqual(['新着メッセージ 3件'])
  await page.clock.runFor(4_000)
  expect(await updates(page)).toEqual(['新着メッセージ 3件'])
})

test('announcements: reconnect announces each connection state once and never announces replay', async ({ page, request }) => {
  let holdSubscriptions = false
  let disconnect: (() => Promise<void>) | undefined
  const held: (() => void)[] = []
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    const server = ws.connectToServer()
    // Real server frames throughout. Hold only outbound subscriptions to keep the
    // outage longer than 2 s without relying on OS offline/WebSocket semantics.
    ws.onMessage(raw => {
      if (holdSubscriptions) held.push(() => server.send(raw))
      else server.send(raw)
    })
    disconnect = async () => {
      await ws.close({ code: 1011, reason: 'E2E reconnect' })
      await server.close({ code: 1011 })
    }
  })
  const { status, post } = await announcementFixture(page, request)
  await post('Live before reconnect')
  await expect(page.getByRole('article').filter({ hasText: 'Live before reconnect' })).toBeVisible()
  await page.clock.runFor(2_000)
  await expect(status).toHaveText('通知メンバー: Live before reconnect')
  await expect.poll(() => updates(page)).toEqual(['通知メンバー: Live before reconnect'])

  holdSubscriptions = true
  expect(disconnect).toBeDefined()
  await disconnect!()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'false')
  await post('Replay during outage must stay silent')
  await page.clock.runFor(1_999)
  expect(await updates(page)).toEqual(['通知メンバー: Live before reconnect'])
  await page.clock.runFor(1)
  await expect(status).toHaveText('再接続しています…')
  await expect.poll(() => updates(page)).toEqual(['通知メンバー: Live before reconnect', '再接続しています…'])
  await page.clock.runFor(2_000)
  await expect.poll(() => held.length).toBeGreaterThan(0)
  expect(await updates(page)).toEqual(['通知メンバー: Live before reconnect', '再接続しています…'])
  holdSubscriptions = false
  for (const release of held.splice(0)) release()
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  await expect(page.getByRole('article').filter({ hasText: 'Replay during outage must stay silent' })).toBeVisible()
  await expect(status).toHaveText('接続しました。')
  const expected = ['通知メンバー: Live before reconnect', '再接続しています…', '接続しました。']
  await expect.poll(() => updates(page)).toEqual(expected)
  await page.clock.runFor(4_000)
  await expect(status).toHaveText('接続しました。')
  expect(await updates(page)).toEqual(expected)
})
