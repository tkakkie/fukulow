import { expect, test } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

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
    if (event.type === 'message') streamed.add(event.message.id)
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
