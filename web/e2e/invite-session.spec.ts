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

async function openInvite(page: Page, statuses: number[], logout: number | 'network') {
  const calls = { accepts: 0, signOuts: 0, signedIn: false }
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body })
    if (path === '/api/v1/me') return json(401, { error: 'invalid credentials' })
    if (path === '/api/v1/setup') return json(200, { setup_required: false })
    if (path.endsWith('/invites/accept')) {
      const status = statuses[calls.accepts++] ?? 200
      const errors: Record<number, string> = { 401: 'invalid credentials', 403: 'invite_account_mismatch', 404: 'invite_unavailable', 409: 'invite_sign_in_required', 500: 'internal error' }
      return json(status, status === 200 ? identity : { error: errors[status] })
    }
    if (path === '/api/v1/session' && route.request().method() === 'DELETE') {
      calls.signOuts++
      if (logout === 'network') return route.abort('failed')
      return route.fulfill({ status: logout, body: logout === 204 ? undefined : JSON.stringify({ error: 'invalid credentials' }) })
    }
    if (path === '/api/v1/session' && route.request().method() === 'POST') {
      calls.signedIn = true
      return json(200, { identity: { account: { id: 'account', email }, organizations: [] }, expires_in: 100 })
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
