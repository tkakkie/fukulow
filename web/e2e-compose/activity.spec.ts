import { expect, test } from '@playwright/test'
import type { ServerEvent } from '../src/api-schema.d.ts'
import { createChannelApi, ensureOwnerAndSignIn, inviteAndSignInPeerViaUi, sendApiMessage } from './helpers.ts'

for (const visible of [2, 258]) test(`two Members update unwatched badges live with ${visible} visible Channels and one watch`, async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  const owner = await context.newPage()
  const org = await ensureOwnerAndSignIn(owner)
  const suffix = crypto.randomUUID().slice(0, 8)
  const channels = []
  for (let index = 0; index < visible; index++) channels.push(await createChannelApi(owner.request, org, `activity-${suffix}-${String(index).padStart(3, '0')}`))
  const peer = await inviteAndSignInPeerViaUi(owner, browser, baseURL!, 'member', suffix)
  const received: ServerEvent[] = [], subscribed = new Set<string>()
  // Reopen once to observe registration, the ready handoff and every subsequent wire frame.
  peer.page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => received.push(JSON.parse(String(payload)) as ServerEvent))
    socket.on('framesent', ({ payload }) => {
      const control = JSON.parse(String(payload)) as { type: string; channel_id: string }
      if (control.type === 'subscribe') subscribed.add(control.channel_id)
      if (control.type === 'unsubscribe') subscribed.delete(control.channel_id)
    })
  })
  const watched = channels[0], unwatched = channels.at(-1)!
  await peer.page.goto(`/o/${org}/c/${watched.id}`)
  await expect(peer.page.getByRole('heading', { name: watched.name, exact: true })).toBeVisible()
  await expect.poll(() => received.some(e => e.type === 'activity_ready')).toBe(true)
  await expect.poll(() => subscribed.size).toBe(1)
  expect(subscribed.has(unwatched.id)).toBe(false)
  const row = peer.page.locator('button.ui-list-row').filter({ hasText: unwatched.name })
  await expect(row).toHaveCount(1)
  await expect(row.locator('.ui-badge--unread')).toHaveCount(0)
  received.length = 0
  const message = await sendApiMessage(owner.request, org, unwatched.id, { body: `Body stays off the unwatched socket ${suffix}` })
  await expect.poll(() => received.some(e => e.type === 'channel_activity' && e.channel_id === unwatched.id && e.seq >= message.seq)).toBe(true)
  await expect(row.locator('.ui-badge--unread')).toHaveAttribute('aria-label', '未読 1件')
  expect(received.some(e => e.type === 'message' && e.message.channel_id === unwatched.id)).toBe(false)
  const notices = received.filter(e => e.type === 'channel_activity' && e.channel_id === unwatched.id)
  expect(notices.length).toBeGreaterThan(0)
  for (const notice of notices) expect(Object.keys(notice).sort()).toEqual(['channel_id', 'seq', 'type'])
  expect(subscribed.size).toBe(1)
  expect(subscribed.has(unwatched.id)).toBe(false)
  await peer.context.close(); await context.close()
})
