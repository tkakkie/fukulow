import { expect, test } from '@playwright/test'

let org: string
let first: string
let second: string
let firstName: string
let secondName: string

test.beforeEach(async ({ page }) => {
  const setup = await page.request.get('/api/v1/setup')
  if ((await setup.json()).setup_required) {
    const response = await page.request.post('/api/v1/setup', { data: {
      organization_name: 'Acme', name: 'Alice', email: 'owner@example.com', password: 'correct horse battery',
      setup_token: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
    } })
    expect(response.ok()).toBe(true)
  }
  const login = await page.request.post('/api/v1/session', { data: { email: 'owner@example.com', password: 'correct horse battery' } })
  expect(login.ok()).toBe(true)
  org = (await login.json()).identity.organizations[0].organization_id
  const create = async (name: string) => {
    const response = await page.request.post(`/api/v1/orgs/${org}/channels`, { data: { name: `${name}-${crypto.randomUUID()}`, visibility: 'public' } })
    expect(response.ok()).toBe(true)
    return await response.json() as { id: string; name: string }
  }
  const a = await create('Navigation one')
  const b = await create('Navigation two')
  first = a.id; firstName = a.name
  second = b.id; secondName = b.name
})

const composer = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'メッセージ', exact: true })

test('creating a Channel opens it and pushes its URL while preserving the open tab', async ({ page }) => {
  await page.goto(`/o/${org}/c/${first}?panel=overview`)
  await expect(page.getByRole('heading', { name: firstName, exact: true })).toBeVisible()
  const length = await page.evaluate(() => history.length)
  const historyReads: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/messages')) historyReads.push(path)
  })
  const name = `Created navigation-${crypto.randomUUID()}`
  await page.getByRole('textbox', { name: 'チャンネル名', exact: true }).fill(name)
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/channels'))
  await page.getByRole('button', { name: 'チャンネルを作成', exact: true }).click()
  const created = await response
  expect(created.ok()).toBe(true)
  const channel = await created.json()
  await expect(page).toHaveURL(`/o/${org}/c/${channel.id}?panel=overview`)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(composer(page)).toBeFocused()
  expect(historyReads.filter(path => path.includes(`/channels/${channel.id}/`))).toHaveLength(1)
  expect(await page.evaluate(() => history.length)).toBe(length + 1)
  await page.goBack()
  await expect(page).toHaveURL(`/o/${org}/c/${first}?panel=overview`)
  await expect(page.getByRole('heading', { name: firstName, exact: true })).toBeVisible()
})

test('Channel, panel, Back and Forward restore URL, focus and independent drafts', async ({ page }) => {
  await page.goto(`/o/${org}/c/${first}`)
  await expect(composer(page)).toBeFocused()
  await composer(page).fill('未送信の下書き')
  await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}\\?panel=topics$`))
  await expect(page.locator('#panel-content h2')).toBeFocused()
  await page.getByRole('tab', { name: '概要', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('panel=overview$'))
  await expect(page.getByRole('tab', { name: '概要', exact: true })).toBeFocused()
  await page.locator('.channel-list button').filter({ hasText: secondName }).last().click()
  await expect(page).toHaveURL(new RegExp(`${second}\\?panel=overview$`))
  await expect(composer(page)).toHaveValue('')
  await expect(composer(page)).toBeFocused()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${first}\\?panel=overview$`))
  await expect(composer(page)).toHaveValue('未送信の下書き')
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(page.locator('#panel-content')).toHaveCount(0)
  await page.goForward()
  await expect(page.locator('#panel-content h2')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true })).toBeFocused()
})

test('phone list, view and panel levels preserve drafts across Back, parent replace and resizing', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/o/${org}`)
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
  await page.locator('.channel-list button').filter({ hasText: firstName }).last().click()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(composer(page)).toBeFocused()
  await composer(page).fill('電話の下書き')
  await page.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
  await page.goBack()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
  await expect(composer(page)).toHaveValue('電話の下書き')
  await page.goBack()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
  await expect(page.locator('#channel-list-heading')).toBeFocused()
  await page.goForward()
  await expect(composer(page)).toHaveValue('電話の下書き')
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(composer(page)).toHaveValue('電話の下書き')
  await page.setViewportSize({ width: 375, height: 667 })
  await page.getByRole('button', { name: 'チャンネル一覧へ戻る', exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/o/${org}$`))
  await expect(page.locator('#channel-list-heading')).toBeFocused()
  await page.locator('.channel-list button').filter({ hasText: firstName }).last().click()
  await expect(composer(page)).toHaveValue('電話の下書き')
})

test('direct link has no synthetic parents; in-app close keeps the main target and replaces', async ({ page }) => {
  await page.goto(`/o/${org}/c/${first}`)
  const length = await page.evaluate(() => history.length)
  await page.goto(`/o/${org}/c/${first}/t/00000000-0000-0000-0000-000000000001?panel=reply:00000000-0000-0000-0000-000000000002`)
  const directLength = await page.evaluate(() => history.length)
  expect(directLength).toBe(length + 1)
  await expect(page.locator('#panel-content')).toBeVisible()
  await page.getByRole('button', { name: 'パネルを閉じる(Esc)', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/t/00000000-0000-0000-0000-000000000001$`))
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  expect(await page.evaluate(() => history.length)).toBe(directLength)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
})

test('unknown Channel and Organization links show API-owned unavailable states', async ({ page }) => {
  await page.goto(`/o/${org}/c/00000000-0000-0000-0000-000000000001`)
  await expect(page.getByRole('alert')).toContainText('このチャンネルは利用できません。')
  await expect(composer(page)).toBeDisabled()
  await page.goto(`/o/00000000-0000-0000-0000-000000000001/c/${first}`)
  await expect(page.getByRole('alert')).toContainText('この組織は利用できません。')
})

test('Topic back keeps the panel and announces the API Topic name; reload adds no parent entries', async ({ page }) => {
  const sent = await page.request.post(`/api/v1/orgs/${org}/channels/${first}/messages`, { data: { client_message_id: crypto.randomUUID(), body: 'Topic control', topic_name: '日報' } })
  expect(sent.ok()).toBe(true)
  const message = await sent.json()
  const url = `/o/${org}/c/${first}/t/${message.topic_id}?panel=members`
  await page.goto(url)
  await expect(page.getByRole('heading', { name: '日報', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('日報')
  const length = await page.evaluate(() => history.length)
  await page.reload()
  await expect(page.getByRole('heading', { name: '日報', exact: true })).toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.getByRole('button', { name: 'チャンネルへ戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}\\?panel=members$`))
  await expect(composer(page)).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(length)
})

test('phone direct-link parent buttons replace without leaving; real Back can leave the app', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto('/api/v1/health')
  await page.goto(`/o/${org}/c/${first}?panel=overview`)
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
  const length = await page.evaluate(() => history.length)
  await page.getByRole('button', { name: '前の表示に戻る', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${first}$`))
  await expect(composer(page)).toBeFocused()
  await page.getByRole('button', { name: 'チャンネル一覧へ戻る', exact: true }).first().click()
  await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
  await expect(page.locator('#channel-list-heading')).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.goBack()
  await expect(page).toHaveURL(/\/api\/v1\/health$/)
})

test('reselecting the current Channel leaves history unchanged and Back leaves for the preceding page', async ({ page }) => {
  await page.goto('/api/v1/health')
  await page.goto(`/o/${org}/c/${first}?panel=overview`)
  await expect(composer(page)).toBeEnabled()
  const length = await page.evaluate(() => history.length)
  await page.locator('.channel-list button').filter({ hasText: firstName }).last().click()
  await expect(composer(page)).toBeFocused()
  await expect(page).toHaveURL(`/o/${org}/c/${first}?panel=overview`)
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.goBack()
  await expect(page).toHaveURL(/\/api\/v1\/health$/)
})

test('C9 reselect retries once per click without History writes or automatic retries', async ({ page }) => {
  let subscriptions = 0
  let allow = false
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw)) as import('../src/api-schema.d.ts').ClientMessage
      if (message.type !== 'subscribe' || message.channel_id !== first) return
      subscriptions++
      const response: import('../src/api-schema.d.ts').ServerEvent = allow
        ? { type: 'subscribed', channel_id: first, caught_up_seq: 0 }
        : { type: 'error', channel_id: first, code: 'channel_not_found' }
      ws.send(JSON.stringify(response))
    })
  })
  await page.goto(`/o/${org}/c/${first}`)
  const unavailable = page.getByRole('alert').filter({ hasText: 'このチャンネルは利用できません。' })
  await expect(unavailable).toBeVisible()
  await expect(composer(page)).toBeDisabled()
  const length = await page.evaluate(() => history.length)
  const initial = subscriptions
  const select = page.locator('.channel-list button').filter({ hasText: firstName }).last()
  await select.click()
  await expect.poll(() => subscriptions).toBe(initial + 1)
  await expect(unavailable).toBeVisible()
  await page.clock.install()
  await page.clock.fastForward(60_000)
  expect(subscriptions).toBe(initial + 1)
  allow = true
  await select.click()
  await expect.poll(() => subscriptions).toBe(initial + 2)
  await expect(unavailable).toHaveCount(0)
  await expect(composer(page)).toBeEnabled()
  await select.click()
  await page.clock.fastForward(60_000)
  expect(subscriptions).toBe(initial + 2)
  expect(await page.evaluate(() => history.length)).toBe(length)
})

test('C9 Channel list action preserves desktop and tablet state and replaces the phone URL with list focus', async ({ page }) => {
  await page.routeWebSocket('**/api/v1/orgs/*/ws', ws => {
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw)) as import('../src/api-schema.d.ts').ClientMessage
      if (message.type === 'subscribe') {
        const response: import('../src/api-schema.d.ts').ServerEvent = { type: 'error', channel_id: message.channel_id, code: 'channel_not_found' }
        ws.send(JSON.stringify(response))
      }
    })
  })
  for (const width of [1280, 960, 800, 600, 375]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/o/${org}/c/${first}`)
    const action = page.getByRole('button', { name: 'チャンネル一覧へ', exact: true })
    await expect(action).toBeVisible()
    const length = await page.evaluate(() => history.length)
    await action.click()
    await expect(page.locator('#channel-content')).toBeVisible()
    await expect(page.locator('#channel-list-heading')).toBeVisible()
    await expect(page.locator('#channel-list-heading')).toBeFocused()
    if (width < 600) {
      await expect(page).toHaveURL(`/o/${org}`)
      await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
      await expect(page.locator('#main-content')).toBeHidden()
    } else {
      await expect(page).toHaveURL(`/o/${org}/c/${first}`)
      await expect(page.locator('#main-content')).toBeVisible()
      await expect(page.locator('.workspace')).toHaveAttribute('data-drawer-open', width < 960 ? 'true' : 'false')
    }
    expect(await page.evaluate(() => history.length)).toBe(length)
  }
})

test('single-Channel phone list intent and Back/Forward preserve URL and History length and focus the heading only when visible', async ({
  page,
  browser,
}) => {
  type AcceptInviteRequest = import('../src/api-schema.d.ts').components['schemas']['AcceptInviteRequest']
  type AddChannelMemberRequest = import('../src/api-schema.d.ts').components['schemas']['AddChannelMemberRequest']
  type Channel = import('../src/api-schema.d.ts').components['schemas']['Channel']
  type CreateChannelRequest = import('../src/api-schema.d.ts').components['schemas']['CreateChannelRequest']
  type CreateInviteRequest = import('../src/api-schema.d.ts').components['schemas']['CreateInviteRequest']
  type Identity = import('../src/api-schema.d.ts').components['schemas']['Identity']
  type InviteResponse = import('../src/api-schema.d.ts').components['schemas']['InviteResponse']

  const base = `/api/v1/orgs/${org}`
  const channelReq: CreateChannelRequest = { name: `Phone single-${crypto.randomUUID()}`, visibility: 'private' }
  const channelRes = await page.request.post(`${base}/channels`, { data: channelReq })
  expect(channelRes.ok()).toBe(true)
  const singleChannel = (await channelRes.json()) as Channel

  const email = `phone-single-${crypto.randomUUID()}@example.invalid`
  const password = 'correct horse phone nav'
  const inviteReq: CreateInviteRequest = { email, role: 'guest' }
  const inviteRes = await page.request.post(`${base}/invites`, { data: inviteReq })
  expect(inviteRes.ok()).toBe(true)
  const invite = (await inviteRes.json()) as InviteResponse

  const guestContext = await browser.newContext()
  try {
    const acceptReq: AcceptInviteRequest = { token: invite.token, email, name: 'Phone Guest', password }
    const acceptRes = await guestContext.request.post(`${base}/invites/accept`, { data: acceptReq })
    expect(acceptRes.ok()).toBe(true)
    const guestIdentity = (await acceptRes.json()) as Identity

    const addReq: AddChannelMemberRequest = { member_id: guestIdentity.member.id }
    const addRes = await page.request.post(`${base}/channels/${singleChannel.id}/members`, { data: addReq })
    expect(addRes.ok()).toBe(true)

    const loginRes = await guestContext.request.post('/api/v1/session', { data: { email, password } })
    expect(loginRes.ok()).toBe(true)

    const guestPage = await guestContext.newPage()
    await guestPage.setViewportSize({ width: 375, height: 667 })

    const heading = guestPage.locator('#channel-list-heading')
    const singleChannelBtn = guestPage.locator('#channel-content .channel-list button')
    const backToListBtn = guestPage.getByRole('button', { name: 'チャンネル一覧へ戻る', exact: true }).first()

    // 1. Direct link to Channel view -> phone `list` intent replaces URL to /o/{org}, adds no extra entry, and focuses #channel-list-heading
    await guestPage.goto('/api/v1/health')
    await guestPage.goto(`/o/${org}/c/${singleChannel.id}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(composer(guestPage)).toBeEnabled()
    const directLen = await guestPage.evaluate(() => history.length)

    await backToListBtn.click()
    await expect(guestPage).toHaveURL(`/o/${org}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(singleChannelBtn).toHaveCount(1)
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(directLen)

    // Real Back leaves directly to /api/v1/health (proving no synthetic parent entry); Forward returns to /o/{org}
    await guestPage.goBack()
    await expect(guestPage).toHaveURL(/\/api\/v1\/health$/)
    expect(await guestPage.evaluate(() => history.length)).toBe(directLen)
    await guestPage.goForward()
    await expect(guestPage).toHaveURL(`/o/${org}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(singleChannelBtn).toHaveCount(1)
    expect(await guestPage.evaluate(() => history.length)).toBe(directLen)

    // 2. Selecting the single Channel pushes 1 entry, opening panel pushes 1 entry; Back/Forward keep URL and History consistent
    await singleChannelBtn.click()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(composer(guestPage)).toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(directLen + 1)

    await guestPage.getByRole('button', { name: 'パネルを開く(⌘.)', exact: true }).click()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}?panel=topics`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    await expect(guestPage.locator('#panel-content h2')).toBeFocused()
    const totalLen = directLen + 2
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)

    await guestPage.goBack()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)

    await guestPage.goBack()
    await expect(guestPage).toHaveURL(`/o/${org}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(heading).toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)

    await guestPage.goForward()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'view')
    await expect(composer(guestPage)).toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)

    await guestPage.goForward()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}?panel=topics`)
    await expect(guestPage.locator('.workspace')).toHaveAttribute('data-mobile-level', 'panel')
    await expect(guestPage.locator('#panel-content h2')).toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)

    // 3. Visibility guard on `list`: neither aria-hidden heading on phone nor closed drawer at 768px receives focus
    await guestPage.goBack()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}`)
    await heading.evaluate(el => {
      el.setAttribute('aria-hidden', 'true')
    })
    await backToListBtn.click()
    await expect(guestPage).toHaveURL(`/o/${org}`)
    await expect(heading).toHaveAttribute('aria-hidden', 'true')
    await expect(heading).not.toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)
    await heading.evaluate(el => {
      el.removeAttribute('aria-hidden')
    })

    await guestPage.goForward()
    await expect(guestPage).toHaveURL(`/o/${org}/c/${singleChannel.id}?panel=topics`)
    await guestPage.setViewportSize({ width: 768, height: 800 })
    await expect(heading).toBeHidden()
    await guestPage.goBack()
    await expect(guestPage).toHaveURL(`/o/${org}`)
    await expect(heading).toBeHidden()
    await expect(heading).not.toBeFocused()
    expect(await guestPage.evaluate(() => history.length)).toBe(totalLen)

    await guestPage.goto('about:blank')
  } finally {
    await guestContext.close()
  }
})

test('beforeunload warns for a draft in an Organization that is not selected, including while selection is unavailable', async ({ page }) => {
  const identityResponse = await page.request.get('/api/v1/me')
  const identity = await identityResponse.json() as import('../src/api-schema.d.ts').components['schemas']['AccountIdentity']
  const memberResponse = await page.request.get(`/api/v1/orgs/${org}/me`)
  const member = await memberResponse.json() as import('../src/api-schema.d.ts').components['schemas']['Identity']
  const other = '00000000-0000-0000-0000-000000000003'
  const otherOrganization = { ...identity.organizations[0]!, organization_id: other, name: 'Other Organization' }
  await page.route('**/api/v1/me', route => route.fulfill({ json: { ...identity, organizations: [...identity.organizations, otherOrganization] } }))
  let unavailable = false
  await page.route(`**/api/v1/orgs/${other}/**`, route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/me')) return route.fulfill(unavailable
      ? { status: 404, json: { error: 'organization_unavailable' } }
      : { json: { ...member, organization: otherOrganization } })
    if (path.endsWith('/channels')) return route.fulfill({ json: { channels: [] } })
    if (path.endsWith('/members')) return route.fulfill({ json: { members: [] } })
    return route.continue()
  })
  await page.routeWebSocket(`**/api/v1/orgs/${other}/ws`, () => {})
  const warns = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  await page.goto(`/o/${org}/c/${first}`)
  await expect(composer(page)).toBeEnabled()
  expect(await warns()).toBe(false)
  await composer(page).fill('別の組織にも残る下書き')
  await page.locator('.org-switcher__select').selectOption(other)
  await expect(page).toHaveURL(`/o/${other}`)
  await expect(page.getByText('チャンネルがありません。', { exact: true })).toBeVisible()
  expect(await warns()).toBe(true)
  await page.locator('.org-switcher__select').selectOption(org)
  await page.locator('.channel-list button').filter({ hasText: firstName }).last().click()
  await expect(composer(page)).toHaveValue('別の組織にも残る下書き')
  unavailable = true
  await page.locator('.org-switcher__select').selectOption(other)
  await expect(page.getByRole('alert')).toContainText('この組織は利用できません。')
  expect(await warns()).toBe(true)
})
