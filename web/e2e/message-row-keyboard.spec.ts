import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type Message = components['schemas']['Message']
type Send = components['schemas']['SendMessageRequest']

const mainComposer = (page: Page) => page.locator('#main-content').getByRole('textbox', { name: 'メッセージ', exact: true })
const replyComposer = (page: Page) => page.locator('#panel-content').getByRole('textbox', { name: 'メッセージ', exact: true })

async function postMessage(
  request: APIRequestContext,
  org: string,
  channelId: string,
  body: Omit<Send, 'client_message_id'>,
): Promise<Message> {
  const response = await secretSafe(() =>
    request.post(`/api/v1/orgs/${org}/channels/${channelId}/messages`, {
      data: { ...body, client_message_id: crypto.randomUUID() },
    }),
  )
  expect(response.status()).toBe(201)
  return (await secretSafe(() => response.json())) as Message
}

async function expectSingleRovingTabStop(scope: Locator) {
  await expect(scope.locator('.ui-message-row[tabindex="0"]')).toHaveCount(1)
  const invalidTabindex = await scope.locator('.ui-message-row').evaluateAll(rows =>
    rows
      .map(el => el.getAttribute('tabindex'))
      .filter(value => value !== '0' && value !== '-1'),
  )
  expect(invalidTabindex).toEqual([])
}

async function dispatchImeKey(target: Locator, init: { key: string; isComposing?: boolean; keyCode?: number }) {
  await target.evaluate((el, opts) => {
    const event = new KeyboardEvent('keydown', {
      key: opts.key,
      bubbles: true,
      cancelable: true,
      isComposing: Boolean(opts.isComposing),
    })
    if (opts.keyCode !== undefined) {
      Object.defineProperty(event, 'keyCode', { value: opts.keyCode })
      Object.defineProperty(event, 'which', { value: opts.keyCode })
    }
    el.dispatchEvent(event)
  }, init)
}

async function expectImeKeysIgnoredOnRow(page: Page, row: Locator) {
  const urlBefore = page.url()
  await expect(row).toBeFocused()
  for (const init of [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
    { key: 'r', isComposing: true },
    { key: 'r', keyCode: 229 },
    { key: 'ArrowUp', isComposing: true },
    { key: 'ArrowUp', keyCode: 229 },
    { key: 'Escape', isComposing: true },
    { key: 'Escape', keyCode: 229 },
  ]) {
    await dispatchImeKey(row, init)
  }
  await expect(row).toBeFocused()
  expect(page.url()).toBe(urlBefore)
}

test('MessageRow declarative roving tabindex, Enter/R reply open, IME guards, child-control guards and focus restoration across Timeline, TopicView and ReplyPanel (#412)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `row-keys-${crypto.randomUUID().slice(0, 8)}`)

  const m1 = await postMessage(page.request, org, channel.id, { body: 'タイムライン1件目' })
  const m2 = await postMessage(page.request, org, channel.id, { body: 'タイムライン2件目 https://example.com/link' })
  await postMessage(page.request, org, channel.id, { body: 'タイムライン返信A', reply_to: m2.id })
  const r2 = await postMessage(page.request, org, channel.id, { body: 'タイムライン返信B', reply_to: m2.id })
  const m3 = await postMessage(page.request, org, channel.id, { body: 'タイムライン3件目' })

  const topicRoot = await postMessage(page.request, org, channel.id, {
    body: 'トピック1件目',
    topic_name: 'キーボード検証',
  })
  const t2 = await postMessage(page.request, org, channel.id, {
    body: 'トピック2件目 https://example.com/topic',
    topic_name: 'キーボード検証',
  })
  const t3 = await postMessage(page.request, org, channel.id, {
    body: 'トピック3件目',
    topic_name: 'キーボード検証',
  })

  await page.goto(`/o/${org}/c/${channel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  const main = page.locator('#main-content')
  const panel = page.locator('#panel-content')
  const mainRow = (id: string) => main.locator(`[data-message-id="${id}"] .ui-message-row`)
  const panelRow = (id: string) => panel.locator(`[data-message-id="${id}"] .ui-message-row`)

  await expect(mainRow(m3.id)).toBeVisible()
  await expectSingleRovingTabStop(main)
  await expect(mainRow(m3.id)).toHaveAttribute('tabindex', '0')

  // 1. Timeline: ArrowUp from empty Composer, mounted-row movement, roving tab stop, IME guard, child-control guard
  await mainComposer(page).focus()
  await page.keyboard.press('ArrowUp')
  await expect(mainRow(m3.id)).toBeFocused()
  await expectSingleRovingTabStop(main)

  await page.keyboard.press('ArrowUp')
  await expect(mainRow(r2.id)).toBeFocused()
  await expect(mainRow(r2.id)).toHaveAttribute('tabindex', '0')
  await expectSingleRovingTabStop(main)

  await page.keyboard.press('Home')
  await expect(mainRow(m1.id)).toBeFocused()
  await expectSingleRovingTabStop(main)
  await page.keyboard.press('ArrowDown')
  await expect(mainRow(m2.id)).toBeFocused()
  await expect(mainRow(m2.id)).toHaveAttribute('tabindex', '0')
  await expectSingleRovingTabStop(main)

  await expectImeKeysIgnoredOnRow(page, mainRow(m2.id))
  await expect(panel).toHaveCount(0)

  // Child control guard: keydown on an inline link inside the roving row must not trigger row shortcuts or navigation
  const inlineLink = mainRow(m2.id).locator('a.ui-message-body__link')
  await expect(inlineLink).toHaveAttribute('tabindex', '0')
  await inlineLink.focus()
  await expect(inlineLink).toBeFocused()
  await page.keyboard.press('r')
  await page.keyboard.press('ArrowUp')
  await expect(panel).toHaveCount(0)
  await expect(inlineLink).toBeFocused()

  // Return to row m2, verify End -> m3, Home -> m1, ArrowDown -> m2
  await mainRow(m2.id).focus()
  await page.keyboard.press('End')
  await expect(mainRow(m3.id)).toBeFocused()
  await expectSingleRovingTabStop(main)
  await page.keyboard.press('Home')
  await expect(mainRow(m1.id)).toBeFocused()
  await expectSingleRovingTabStop(main)
  await page.keyboard.press('ArrowDown')
  await expect(mainRow(m2.id)).toBeFocused()

  // Enter opens ReplyPanel and Esc restores focus to m2
  await page.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}?panel=reply:${m2.id}`)
  await expect(replyComposer(page)).toBeFocused()

  // 2. ReplyPanel: single roving tab stop, ArrowUp/ArrowDown, IME guard, Enter & R anchor switch, Esc restoration
  await expect(panelRow(r2.id)).toBeVisible()
  await expectSingleRovingTabStop(panel)
  await expect(panelRow(r2.id)).toHaveAttribute('tabindex', '0')

  await page.keyboard.press('ArrowUp')
  await expect(panelRow(r2.id)).toBeFocused()
  await expectSingleRovingTabStop(panel)

  await page.keyboard.press('ArrowUp')
  const panelPrevRow = panel.locator('.ui-message-row:focus')
  await expect(panelPrevRow).toHaveCount(1)
  await expectSingleRovingTabStop(panel)
  await expectImeKeysIgnoredOnRow(page, panelPrevRow)

  // Press Enter on the root message inside ReplyPanel to focus that anchor
  await page.keyboard.press('Home')
  await expect(panelRow(m2.id)).toBeFocused()
  await expectSingleRovingTabStop(panel)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}?panel=reply:${m2.id}`)
  await expect(replyComposer(page)).toBeFocused()

  // Press R on r2 inside ReplyPanel
  await page.keyboard.press('ArrowUp')
  await expect(panelRow(r2.id)).toBeFocused()
  await page.keyboard.press('R')
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}?panel=reply:${r2.id}`)
  await expect(replyComposer(page)).toBeFocused()

  // Escape closes the topmost layer (the ReplyPanel) and restores focus to m2; Escape from m2 returns to main Composer
  await page.keyboard.press('ArrowUp')
  await expect(panelRow(r2.id)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(mainRow(m2.id)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(mainComposer(page)).toBeFocused()

  // R from Timeline row m1 opens ReplyPanel and Esc restores focus to m1
  await mainRow(m1.id).focus()
  await expect(mainRow(m1.id)).toBeFocused()
  await page.keyboard.press('r')
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}?panel=reply:${m1.id}`)
  await expect(replyComposer(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(mainRow(m1.id)).toBeFocused()

  // 3. Pending/failed non-focusable row preservation in Timeline
  await page.route(`**/api/v1/orgs/${org}/channels/${channel.id}/messages`, route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_request', message: 'bad' }) })
    return route.continue()
  })
  await mainComposer(page).fill('失敗するペンディング送信')
  await mainComposer(page).press('Enter')
  const failedRow = main.locator('.ui-message-row--failed')
  await expect(failedRow).toBeVisible()
  await expect(failedRow).toHaveAttribute('tabindex', '-1')
  await expect(failedRow).not.toHaveAttribute('data-focusable', 'true')
  await expectSingleRovingTabStop(main)
  await failedRow.evaluate(el => {
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  await expect(panel).toHaveCount(0)
  await main.getByRole('button', { name: '破棄', exact: true }).click()
  await expect(failedRow).toHaveCount(0)
  await expect(mainComposer(page)).toBeFocused()
  await page.unroute(`**/api/v1/orgs/${org}/channels/${channel.id}/messages`)

  // 4. TopicView: single roving tab stop, ArrowUp/ArrowDown, IME guard, child-control guard, Enter & R + Esc restoration
  await page.goto(`/o/${org}/c/${channel.id}/t/${topicRoot.topic_id}`)
  await expect(mainRow(t3.id)).toBeVisible()
  await expectSingleRovingTabStop(main)
  await expect(mainRow(t3.id)).toHaveAttribute('tabindex', '0')

  await mainComposer(page).focus()
  await page.keyboard.press('ArrowUp')
  await expect(mainRow(t3.id)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(mainRow(t2.id)).toBeFocused()
  await expectSingleRovingTabStop(main)

  await expectImeKeysIgnoredOnRow(page, mainRow(t2.id))
  await expect(panel).toHaveCount(0)

  const topicLink = mainRow(t2.id).locator('a.ui-message-body__link')
  await expect(topicLink).toHaveAttribute('tabindex', '0')
  await topicLink.focus()
  await page.keyboard.press('r')
  await expect(panel).toHaveCount(0)
  await expect(topicLink).toBeFocused()

  await mainRow(t2.id).focus()
  await page.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}/t/${topicRoot.topic_id}?panel=reply:${t2.id}`)
  await expect(replyComposer(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(mainRow(t2.id)).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(mainRow(t3.id)).toBeFocused()
  await page.keyboard.press('r')
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}/t/${topicRoot.topic_id}?panel=reply:${t3.id}`)
  await expect(replyComposer(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(mainRow(t3.id)).toBeFocused()
})

test('MessageRow roving tabindex, keyboard navigation and focus eviction remain intact under virtualization across Timeline, TopicView and ReplyPanel (#412)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 600 })
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `row-virt-${crypto.randomUUID().slice(0, 8)}`)

  const multiline = (label: string, i: number) => `${label} #${i}\n2行目の本文\n3行目の本文\n4行目の本文`
  async function batch(count: number, make: (i: number) => Omit<Send, 'client_message_id'>) {
    const out: Message[] = []
    for (let i = 0; i < count; i += 8) {
      const chunk = await Promise.all(
        Array.from({ length: Math.min(8, count - i) }, (_, n) => postMessage(page.request, org, channel.id, make(i + n))),
      )
      out.push(...chunk)
    }
    return out
  }

  // Seed enough tall rows in Timeline, TopicView and ReplyPanel so VirtualRows mounts only a viewport+overscan subset
  const mainMessages = await batch(45, i => ({ body: multiline('メイン仮想化', i) }))
  const topicRoot = await postMessage(page.request, org, channel.id, {
    body: multiline('トピック仮想化起点', 0),
    topic_name: '仮想化トピック',
  })
  await batch(44, i => ({ body: multiline('トピック仮想化', i + 1), topic_name: '仮想化トピック' }))
  const replyRoot = await postMessage(page.request, org, channel.id, { body: multiline('返信仮想化起点', 0) })
  await batch(44, i => ({ body: multiline('返信仮想化', i + 1), reply_to: replyRoot.id }))

  async function verifyVirtualizedScope(scope: Locator, scrollContainer: Locator, composer: Locator) {
    await expect.poll(() => scope.locator('[data-message-id]').count()).toBeGreaterThan(0)
    await expect.poll(() => scope.locator('[data-message-id]').count()).toBeLessThan(40)
    await expectSingleRovingTabStop(scope)

    // Enter latest row from empty Composer, jump to Home (unmounts bottom rows, mounts top rows), then End (remounts bottom)
    await composer.fill('')
    await composer.focus()
    await composer.press('ArrowUp')
    const focused = scope.locator('.ui-message-row:focus')
    await expect(focused).toHaveCount(1)
    const bottomId = await focused.locator('..').getAttribute('data-message-id')
    await expectSingleRovingTabStop(scope)

    await page.keyboard.press('Home')
    await expect(focused).toHaveCount(1)
    const topId = await focused.locator('..').getAttribute('data-message-id')
    expect(topId).toBeTruthy()
    expect(topId).not.toBe(bottomId)
    await expect(scope.locator(`[data-message-id="${bottomId}"]`)).toHaveCount(0)
    await expectSingleRovingTabStop(scope)

    // Step across newly mounted rows at the top
    await page.keyboard.press('ArrowDown')
    await expect(focused).toHaveCount(1)
    const secondTopId = await focused.locator('..').getAttribute('data-message-id')
    expect(secondTopId).not.toBe(topId)
    await expectSingleRovingTabStop(scope)

    // Scroll far away so the focused row unmounts -> focus must fall back to Composer and roving tab stop remains unique
    await scrollContainer.evaluate(el => {
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(scope.locator(`[data-message-id="${secondTopId}"]`)).toHaveCount(0)
    await expect(composer).toBeFocused()
    await expectSingleRovingTabStop(scope)

    // Remounted bottom row still handles declarative focus + Enter reply open
    await composer.press('ArrowUp')
    await expect(focused).toHaveCount(1)
    const remountedId = await focused.locator('..').getAttribute('data-message-id')
    expect(remountedId).toBeTruthy()
    await expectSingleRovingTabStop(scope)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`[?&]panel=reply:${remountedId}$`))
    await expect(replyComposer(page)).toBeFocused()
  }

  // Timeline virtualization
  await page.goto(`/o/${org}/c/${channel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  const main = page.locator('#main-content')
  const panel = page.locator('#panel-content')
  expect(mainMessages.length).toBe(45)
  await verifyVirtualizedScope(main, main.locator('.timeline-scroll'), mainComposer(page))
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // TopicView virtualization
  await page.goto(`/o/${org}/c/${channel.id}/t/${topicRoot.topic_id}`)
  await verifyVirtualizedScope(main, main.locator('.topic-view__scroll'), mainComposer(page))
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // ReplyPanel virtualization
  await page.goto(`/o/${org}/c/${channel.id}?panel=reply:${replyRoot.id}`)
  await expect(panel.getByRole('heading', { name: '返信のつながり', exact: true })).toBeVisible()
  await verifyVirtualizedScope(panel, panel.locator('.reply-panel__scroll'), replyComposer(page))
})
