import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type Message = components['schemas']['Message']
type Send = components['schemas']['SendMessageRequest']

test.use({ actionTimeout: 10_000 })

test('bounded timelines keep keyboard navigation and anchors across refetch and live trimming', async ({ page }) => {
  test.setTimeout(120_000)
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `window-${crypto.randomUUID().slice(0, 8)}`)
  const other = await createChannel(page.request, org, `switch-${crypto.randomUUID().slice(0, 8)}`)
  const base = `/api/v1/orgs/${org}/channels/${channel.id}`
  let refetches = 0
  page.on('request', request => { if (request.method() === 'GET' && request.url().includes(`${channel.id}/`)) refetches++ })
  const send = async (request: APIRequestContext, body: Omit<Send, 'client_message_id'>): Promise<Message> => {
    const response = await secretSafe(() => request.post(`${base}/messages`, { data: { ...body, client_message_id: crypto.randomUUID() } }))
    expect(response.status()).toBe(201)
    return await secretSafe(() => response.json()) as Message
  }
  async function batch(count: number, body: (index: number) => Omit<Send, 'client_message_id'>) {
    for (let i = 0; i < count; i += 8) await Promise.all(Array.from({ length: Math.min(8, count - i) }, (_, n) => send(page.request, body(i + n))))
  }
  await batch(450, i => ({ body: `履歴 ${i} ${i % 10 === 0 ? '長い本文\n'.repeat(10) : ''}` }))
  const topicRoot = await send(page.request, { body: 'トピックの起点', topic_name: '窓の検証' })
  await batch(449, i => ({ body: `トピック履歴 ${i}`, topic_name: '窓の検証' }))
  const root = await send(page.request, { body: '返信の起点' })
  await batch(299, i => ({ body: `返信履歴 ${i}`, reply_to: root.id }))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/o/${org}/c/${channel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  const main = page.locator('#main-content')
  const composer = main.getByRole('textbox', { name: 'メッセージ', exact: true })
  const scroll = main.locator('.timeline-scroll')
  for (let i = 0; i < 9; i++) await main.getByRole('button', { name: '以前のメッセージを読み込む', exact: true }).click()
  await expect(main.getByRole('button', { name: '最新のメッセージを読み込む', exact: true })).toBeVisible()
  expect(await main.locator('[data-message-id]').count()).toBeLessThan(40)
  await keyboardWindow(page, '#main-content', composer)
  await main.getByRole('button', { name: '最新のメッセージを読み込む', exact: true }).click()

  await page.evaluate(() => {
    const samples: number[] = []
    new MutationObserver(() => {
      const start = performance.now()
      requestAnimationFrame(() => { if (samples.length < 10000) samples.push(performance.now() - start) })
    }).observe(document.querySelector('.timeline-scroll')!, { childList: true, subtree: true })
    Object.assign(window, { windowRenderSamples: samples })
  })

  await expect(main.getByRole('button', { name: '以前のメッセージを読み込む', exact: true })).toBeEnabled()
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const beforeMetrics = await cdp.send('Performance.getMetrics')
  const started = performance.now()
  await batch(2000, i => ({ body: `到着 ${i} ${i % 10 === 0 ? '長い本文\n'.repeat(10) : ''}` }))
  await expect(main.getByText('到着 1999', { exact: false })).toBeAttached()
  const arrivalMs = performance.now() - started
  const afterMetrics = await cdp.send('Performance.getMetrics')
  const browserCpuMs = Object.fromEntries(['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name,
    Math.round(1000 * ((afterMetrics.metrics.find(m => m.name === name)?.value ?? 0) -
      (beforeMetrics.metrics.find(m => m.name === name)?.value ?? 0)))]))
  const dom = await main.locator('[data-message-id]').count()
  const mainNodes = await main.locator('*').count()
  expect(dom).toBeLessThan(40)
  await keyboardWindow(page, '#main-content', composer)
  await composer.fill('窓を越えた送信')
  await main.getByRole('button', { name: '送信', exact: true }).click()
  await expect(main.getByText('窓を越えた送信', { exact: true })).toBeInViewport()
  await expect(composer).toBeFocused()
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight / 2; el.dispatchEvent(new Event('scroll')) })
  const anchor = await main.locator('[data-message-id]').evaluateAll(nodes => {
    const node = nodes.find(n => n.getBoundingClientRect().top >= 120)!
    return { id: node.getAttribute('data-message-id')!, top: node.getBoundingClientRect().top }
  })
  await batch(450, i => ({ body: `未ピン到着 ${i}` }))
  const anchorAfter = main.locator(`[data-message-id="${anchor.id}"]`)
  await expect(anchorAfter).toBeAttached()
  expect(Math.abs(await anchorAfter.evaluate(el => el.getBoundingClientRect().top) - anchor.top)).toBeLessThan(3)

  for (let i = 0; i < 6; i++) {
    await page.locator(`#channel-content button`).filter({ hasText: other.name }).first().click()
    await page.locator(`#channel-content button`).filter({ hasText: channel.name }).first().click()
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
  }
  await main.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
  await page.locator('#panel-content').getByRole('tab', { name: 'トピック', exact: true }).click()
  await page.locator('#panel-content button.ui-topic-summary').filter({ hasText: '窓の検証' }).click()
  const topicScroll = main.locator('.topic-view__scroll')
  await expect(topicScroll).toBeVisible()
  for (let i = 0; i < 7; i++) await main.getByRole('button', { name: '以前のメッセージを読み込む', exact: true }).click()
  const topicDom = await main.locator('[data-message-id]').count()
  const topicNodes = await main.locator('*').count()
  expect(topicDom).toBeLessThan(40)
  await keyboardWindow(page, '#main-content', composer)

  const navigate = (path: string) => page.evaluate(url => {
    history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await navigate(`/o/${org}/c/${channel.id}/t/${topicRoot.topic_id}?panel=reply:${root.id}`)
  const panel = page.locator('#panel-content')
  await expect(panel.getByRole('heading', { name: '返信のつながり', exact: true })).toBeVisible()
  for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: 'さらに返信を読み込む', exact: true }).click()
  await expect(panel.getByRole('button', { name: '以前の返信を読み込む', exact: true })).toBeVisible()
  const replyDom = await panel.locator('[data-message-id]').count()
  const replyNodes = await panel.locator('*').count()
  const simultaneousNodes = await page.locator('body *').count()
  expect(replyDom).toBeLessThan(40)
  await keyboardWindow(page, '#panel-content', panel.getByRole('textbox', { name: 'メッセージ', exact: true }))
  await main.getByRole('button', { name: '最新のメッセージを読み込む', exact: true }).click()
  await panel.getByRole('button', { name: '以前の返信を読み込む', exact: true }).click()
  await expect(panel.locator(`[data-message-id="${root.id}"]`)).toBeAttached()
  for (let i = 0; i < 3; i++) {
    await navigate(`/o/${org}/c/${channel.id}/t/${topicRoot.topic_id}`)
    await expect(main.locator('.topic-view__item').last()).toContainText('トピック')
    await navigate(`/o/${org}/c/${channel.id}?panel=reply:${root.id}`)
    await expect(panel.getByRole('button', { name: 'さらに返信を読み込む', exact: true })).toBeEnabled()
    await panel.locator('.reply-panel__scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    await expect(panel.locator(`[data-message-id="${root.id}"]`)).toBeAttached()
  }
  const frames = await page.evaluate(() => {
    const samples = (window as unknown as { windowRenderSamples: number[] }).windowRenderSamples.sort((a, b) => a - b)
    return { samples: samples.length, p50: samples[Math.floor(samples.length * .5)], p95: samples[Math.floor(samples.length * .95)] }
  })
  console.log(JSON.stringify({ workload: 'issue308', arrivals: 2450, seeded: 1200, mainDom: dom, topicDom, replyDom,
    elements: { main: mainNodes, topic: topicNodes, reply: replyNodes, simultaneousApp: simultaneousNodes },
    arrivalMs: Math.round(arrivalMs), mutationToFrameMs: frames, browserCpuMs, refetches }))
})

async function keyboardWindow(page: Page, scope: string, composer: ReturnType<Page['locator']>) {
  await expect(page.locator(`${scope} [aria-busy="true"]`)).toHaveCount(0)
  const older = page.locator(scope).getByRole('button', { name: '以前のメッセージを読み込む', exact: true })
  if (await older.count()) await expect(older).toBeEnabled()
  await composer.fill('')
  await composer.focus(); await composer.press('ArrowUp')
  await expect(page.locator(`${scope} .ui-message-row:focus`)).toHaveCount(1)
  await page.keyboard.press('Home')

  const first = await page.locator(`${scope} .ui-message-row:focus`).locator('..').getAttribute('data-message-id')
  await page.keyboard.press('End')
  const last = await page.locator(`${scope} .ui-message-row:focus`).locator('..').getAttribute('data-message-id')
  expect(last).not.toBe(first)
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp')
  await expect(page.locator(`${scope} .ui-message-row:focus`)).toHaveCount(1)
}
