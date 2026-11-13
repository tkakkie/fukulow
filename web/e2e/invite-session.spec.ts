import { expect, test, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { secretSafe } from './helpers.ts'

const organizationId = '00000000-0000-0000-0000-000000000300'
const email = 'invite-recovery@example.invalid'
const identity: components['schemas']['Identity'] = {
  member: { id: 'member', name: '招待メンバー', role: 'member' },
  organization: { organization_id: organizationId, name: '組織', capabilities: {
    can_invite: { allowed: false }, can_manage_roles: { allowed: false },
    can_deactivate_members: { allowed: false }, can_create_channels: { allowed: true },
  } },
}

type Gates = Partial<Record<'signIn' | 'signOut' | 'accept', Promise<void>>>

async function openInvite(page: Page, statuses: number[], logout: number | 'network', gates: Gates = {}) {
  const calls = { accepts: 0, signOuts: 0, signIns: 0, signedIn: false }
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body })
    if (path === '/api/v1/me') return json(401, { error: 'invalid credentials' })
    if (path === '/api/v1/setup') return json(200, { setup_required: false })
    if (path.endsWith('/invites/accept')) {
      const status = statuses[calls.accepts++] ?? 200
      await gates.accept
      const errors: Record<number, string> = { 401: 'invalid credentials', 403: 'invite_account_mismatch', 404: 'invite_unavailable', 409: 'invite_sign_in_required', 500: 'internal error' }
      return json(status, status === 200 ? identity : { error: errors[status] })
    }
    if (path === '/api/v1/session' && route.request().method() === 'DELETE') {
      calls.signOuts++
      await gates.signOut
      if (logout === 'network') return route.abort('failed')
      return route.fulfill({ status: logout, headers: { 'set-cookie': 'fukulow_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict' }, body: logout === 204 ? undefined : JSON.stringify({ error: 'invalid credentials' }) })
    }
    if (path === '/api/v1/session' && route.request().method() === 'POST') {
      calls.signIns++
      await gates.signIn
      calls.signedIn = true
      return route.fulfill({ status: 200, headers: { 'set-cookie': 'fukulow_session=fresh-test-only; Path=/; HttpOnly; SameSite=Strict' }, json: { identity: { account: { id: 'account', email }, organizations: [] }, expires_in: 100 } })
    }
    return json(404, { error: 'organization_unavailable' })
  })
  await secretSafe(() => page.goto(`/#invite=${organizationId}:${'a'.repeat(64)}`))
  const invitation = page.getByRole('region', { name: '招待を受ける' })
  await invitation.getByLabel('招待先のメールアドレス').fill(email)
  await invitation.getByLabel('組織での名前').fill('招待メンバー')
  await invitation.getByLabel('新しいアカウントのパスワード（12文字以上）').fill('invite recovery password')
  return { calls, invitation }
}

for (const status of [204, 401]) {
  test(`Invite 401 offers explicit sign-out ${status}, keeps the form and waits for resubmission`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 760 })
    const { calls, invitation } = await openInvite(page, [401, 200], status)
    const logout = invitation.getByRole('button', { name: 'ログアウトして続ける' })
    await expect(logout).toHaveCount(0)
    await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
    await expect(logout).toBeVisible()
    await expect(invitation.getByRole('button', { name: '招待を受ける', exact: true })).toBeDisabled()
    expect(calls.signOuts).toBe(0)
    await logout.click()
    await expect(logout).toHaveCount(0)
    expect(calls).toMatchObject({ accepts: 1, signOuts: 1 })
    await expect(invitation.getByLabel('招待先のメールアドレス')).toHaveValue(email)
    await expect(invitation.getByLabel('組織での名前')).toHaveValue('招待メンバー')
    await expect(invitation.getByRole('button', { name: '招待を受ける', exact: true })).toBeEnabled()
    await invitation.getByLabel('新しいアカウントのパスワード（12文字以上）').fill('invite recovery password')
    await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('招待を受けました。ログインしてください。')
    expect(calls).toMatchObject({ accepts: 2, signOuts: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const failure of ['network', 500, 503] as const) {
  test(`Invite sign-out ${failure} keeps the Invite and error without resubmitting`, async ({ page }) => {
    const { calls, invitation } = await openInvite(page, [401], failure)
    await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
    await invitation.getByRole('button', { name: 'ログアウトして続ける' }).click()
    await expect(invitation.getByRole('alert')).toContainText('ログアウトできませんでした')
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(invitation.getByRole('button', { name: 'ログアウトして続ける' })).toBeEnabled()
    await expect(invitation.getByRole('button', { name: '招待を受ける', exact: true })).toBeDisabled()
    expect(calls).toMatchObject({ accepts: 1, signOuts: 1 })
  })
}

test('existing Account keeps the sign-in route after recovery and unrelated errors never offer sign-out', async ({ page }) => {
  const { calls, invitation } = await openInvite(page, [401, 409, 200], 401)
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await invitation.getByRole('button', { name: 'ログアウトして続ける' }).click()
  await expect(invitation.getByRole('button', { name: 'ログアウトして続ける' })).toHaveCount(0)
  await invitation.getByLabel('新しいアカウントのパスワード（12文字以上）').fill('invite recovery password')
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await expect(invitation.getByRole('alert')).toContainText('このアドレスのアカウントでログイン')
  await expect(invitation.getByRole('button', { name: 'ログアウトして続ける' })).toHaveCount(0)
  expect(calls.signOuts).toBe(1)
  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill('invite recovery password')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  const signedInInvite = page.getByRole('region', { name: '招待を受ける' })
  await expect(signedInInvite.getByLabel('新しいアカウントのパスワード（12文字以上）')).toHaveCount(0)
  expect(calls).toMatchObject({ accepts: 2, signedIn: true })
  await signedInInvite.getByLabel('招待先のメールアドレス').fill(email)
  await signedInInvite.getByLabel('組織での名前').fill('招待メンバー')
  await signedInInvite.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await expect(signedInInvite).toHaveCount(0)
  expect(calls).toMatchObject({ accepts: 3, signOuts: 1 })
})

test('matching Account sign-in replaces the rejected Session without invoking Invite sign-out', async ({ page }) => {
  const { calls, invitation } = await openInvite(page, [401, 200], 204)
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await expect(invitation.getByRole('button', { name: 'ログアウトして続ける' })).toBeVisible()
  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill('invite recovery password')
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  const signedInInvite = page.getByRole('region', { name: '招待を受ける' })
  await expect(signedInInvite.getByRole('button', { name: 'ログアウトして続ける' })).toHaveCount(0)
  await expect(signedInInvite.getByRole('button', { name: '招待を受ける', exact: true })).toBeEnabled()
  await signedInInvite.getByLabel('招待先のメールアドレス').fill(email)
  await signedInInvite.getByLabel('組織での名前').fill('招待メンバー')
  await signedInInvite.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await expect(signedInInvite).toHaveCount(0)
  expect(calls).toMatchObject({ accepts: 2, signOuts: 0, signedIn: true })
})

for (const status of [403, 404, 409, 500]) {
  test(`unrelated Invite ${status} never offers or triggers sign-out`, async ({ page }) => {
    const { calls, invitation } = await openInvite(page, [status], 204)
    await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
    await expect(invitation.getByRole('alert')).toBeVisible()
    await expect(invitation.getByRole('button', { name: 'ログアウトして続ける' })).toHaveCount(0)
    await expect(invitation.getByRole('button', { name: '招待を受ける', exact: true })).toBeEnabled()
    expect(calls).toMatchObject({ accepts: 1, signOuts: 0 })
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('loading-timeout 再試行 retries a pending restore and ignores its late response', async ({ page }) => {
  const initial = deferred()
  let reads = 0
  await page.clock.install()
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/me') {
      const first = ++reads === 1
      if (first) await initial.promise
      return route.fulfill({ status: first ? 500 : 401, json: { error: first ? 'internal error' : 'invalid credentials' } })
    }
    if (path === '/api/v1/setup') return route.fulfill({ json: { setup_required: false } })
    return route.fulfill({ status: 404, json: { error: 'not found' } })
  })
  await page.goto('/')
  await expect.poll(() => reads).toBe(1)
  await page.clock.fastForward(10_000)
  await page.getByRole('button', { name: '再試行', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeEnabled()
  expect(reads).toBe(2)
  const completed = page.waitForResponse(response => response.url().endsWith('/api/v1/me') && response.status() === 500)
  initial.resolve()
  await completed
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '再試行', exact: true })).toHaveCount(0)
})

async function fillSignIn(page: Page) {
  await page.getByLabel('メールアドレス', { exact: true }).fill(email)
  await page.getByLabel('パスワード', { exact: true }).fill('invite recovery password')
}

async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find(cookie => cookie.name === 'fukulow_session')?.value
}

test('pending sign-in disables recovery and duplicate submits; later recovery and sign-in work without clearing the replacement cookie', async ({ page }) => {
  const login = deferred()
  const gates: Gates = { signIn: login.promise }
  const { calls, invitation } = await openInvite(page, [401, 401], 401, gates)
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  const recovery = invitation.getByRole('button', { name: 'ログアウトして続ける' })
  await expect(recovery).toBeEnabled()
  await fillSignIn(page)
  const signIn = page.getByRole('button', { name: 'ログイン', exact: true })
  await signIn.click()
  await expect.poll(() => calls.signIns).toBe(1)
  await expect(signIn).toBeDisabled()
  await expect(recovery).toBeDisabled()
  await recovery.dispatchEvent('click')
  await recovery.dispatchEvent('click')
  await signIn.evaluate(button => { button.closest('form')!.requestSubmit(); button.closest('form')!.requestSubmit() })
  expect(calls).toMatchObject({ signIns: 1, signOuts: 0, accepts: 1 })
  login.resolve()
  await expect(signIn).toHaveCount(0)
  expect(await sessionCookie(page)).toBe('fresh-test-only')
  expect(calls.signOuts).toBe(0)
  // A new rejection after sign-in allows an explicit recovery, then another sign-in.
  await invitation.getByLabel('招待先のメールアドレス').fill(email)
  await invitation.getByLabel('組織での名前').fill('招待メンバー')
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await expect(recovery).toBeEnabled()
  await recovery.click()
  await expect(recovery).toHaveCount(0)
  expect(await sessionCookie(page)).toBeUndefined()
  await fillSignIn(page)
  await signIn.click()
  await expect(signIn).toHaveCount(0)
  expect(await sessionCookie(page)).toBe('fresh-test-only')
  expect(calls).toMatchObject({ signIns: 2, signOuts: 1, accepts: 2 })
})

test('pending recovery disables sign-in and double clicks; sign-in starts only after cookie removal completes', async ({ page }) => {
  const logout = deferred()
  const { calls, invitation } = await openInvite(page, [401], 401, { signOut: logout.promise })
  await invitation.getByRole('button', { name: '招待を受ける', exact: true }).click()
  await fillSignIn(page)
  const recovery = invitation.getByRole('button', { name: 'ログアウトして続ける' })
  const signIn = page.getByRole('button', { name: 'ログイン', exact: true })
  await recovery.click()
  await expect.poll(() => calls.signOuts).toBe(1)
  await expect(recovery).toBeDisabled()
  await expect(signIn).toBeDisabled()
  await expect(invitation.getByRole('button', { name: '招待を受ける', exact: true })).toBeDisabled()
  await recovery.dispatchEvent('click')
  await recovery.dispatchEvent('click')
  await signIn.evaluate(button => { button.closest('form')!.requestSubmit(); button.closest('form')!.requestSubmit() })
  expect(calls).toMatchObject({ signIns: 0, signOuts: 1, accepts: 1 })
  logout.resolve()
  await expect(recovery).toHaveCount(0)
  await expect(signIn).toBeEnabled()
  expect(calls.signIns).toBe(0)
  await signIn.click()
  await expect(signIn).toHaveCount(0)
  expect(await sessionCookie(page)).toBe('fresh-test-only')
  expect(calls).toMatchObject({ signIns: 1, signOuts: 1, accepts: 1 })
})

test('pending Invite acceptance disables sign-in and duplicate accepts, then releases both forms', async ({ page }) => {
  const acceptance = deferred()
  const gates: Gates = { accept: acceptance.promise }
  const { calls, invitation } = await openInvite(page, [409, 200], 401, gates)
  await fillSignIn(page)
  const accept = invitation.getByRole('button', { name: '招待を受ける', exact: true })
  const signIn = page.getByRole('button', { name: 'ログイン', exact: true })
  await accept.click()
  await expect.poll(() => calls.accepts).toBe(1)
  await expect(accept).toBeDisabled()
  await expect(signIn).toBeDisabled()
  await signIn.evaluate(button => button.closest('form')!.requestSubmit())
  await accept.evaluate(button => button.closest('form')!.requestSubmit())
  expect(calls).toMatchObject({ signIns: 0, signOuts: 0, accepts: 1 })
  acceptance.resolve()
  await expect(accept).toBeEnabled()
  await expect(signIn).toBeEnabled()
  await signIn.click()
  await expect(signIn).toHaveCount(0)
  await invitation.getByLabel('招待先のメールアドレス').fill(email)
  await invitation.getByLabel('組織での名前').fill('招待メンバー')
  await accept.click()
  await expect(invitation).toHaveCount(0)
  expect(calls).toMatchObject({ signIns: 1, signOuts: 0, accepts: 2 })
})
