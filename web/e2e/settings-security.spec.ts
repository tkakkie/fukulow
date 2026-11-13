import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { secretSafe, signInOwner } from './helpers.ts'
import type { components } from '../src/api-schema.d.ts'

for (const changePassword of [true, false]) {
  test(`${changePassword ? 'password change' : 'revoke other sessions'} confirms, handles 403, and preserves this session at phone width`, async ({ page, request, browser }) => {
    const organization = await signInOwner(request)
    const email = `security-${randomUUID()}@example.com`
    const password = 'correct horse battery'
    const newPassword = 'changed horse battery'
    const invitation = await secretSafe(() => request.post(`/api/v1/orgs/${organization}/invites`, { data: { email, role: 'member' } }))
    expect(invitation.status()).toBe(201)
    const invite = await secretSafe(() => invitation.json()) as components['schemas']['InviteResponse']
    const otherContext = await browser.newContext()
    try {
      const accepted = await secretSafe(() => otherContext.request.post(`/api/v1/orgs/${organization}/invites/accept`, { data: { token: invite.token, email, name: '設定テスト', password } }))
      expect(accepted.ok()).toBe(true)
      const otherLogin = await secretSafe(() => otherContext.request.post('/api/v1/session', { data: { email, password } }))
      expect(otherLogin.status()).toBe(200)
      const nativeLogin = await secretSafe(() => otherContext.request.post('/api/v1/native/session', { data: { email, password } }))
      const native = await secretSafe(() => nativeLogin.json()) as components['schemas']['NativeSessionResponse']
      await page.setViewportSize({ width: 320, height: 760 })
      await page.goto('/')
      await page.getByLabel('メールアドレス').fill(email)
      await page.getByLabel('パスワード', { exact: true }).fill(password)
      await page.getByRole('button', { name: 'ログイン', exact: true }).click()
      await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible()
      const mutations: string[] = []
      page.on('request', req => { if (req.url().endsWith('/me/password') || req.url().endsWith('/me/sessions/revoke-others')) mutations.push(req.method()) })
      const action = changePassword ? 'パスワードを変更' : '他のセッションをログアウト'
      await page.getByRole('button', { name: '設定', exact: true }).click()
      await page.getByRole('button', { name: action, exact: true }).click()
      await page.getByLabel('現在のパスワード').fill('incorrect password')
      if (changePassword) await page.getByLabel('新しいパスワード').fill(newPassword)
      await page.getByRole('button', { name: '変更内容を確認' }).click()
      await expect(page.getByRole('dialog', { name: `${action}しますか？` })).toBeVisible()
      expect(mutations).toHaveLength(0)
      await page.keyboard.press('Escape')
      await expect(page.getByLabel('現在のパスワード')).toBeFocused()
      expect(mutations).toHaveLength(0)
      await page.getByRole('button', { name: '変更内容を確認' }).click()
      await page.getByRole('button', { name: action, exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('現在のパスワードが正しくありません')
      await expect(page.getByRole('heading', { name: 'ログイン', exact: true })).toHaveCount(0)
      await expect(page.getByLabel('現在のパスワード')).toHaveValue('')
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const arrived = new Promise<void>(resolve => { entered = resolve })
      await page.route(changePassword ? '**/api/v1/me/password' : '**/api/v1/me/sessions/revoke-others', async route => {
        entered()
        await held
        await route.continue()
      })
      await page.getByLabel('現在のパスワード').fill(password)
      if (changePassword) await page.getByLabel('新しいパスワード').fill(newPassword)
      await page.getByRole('button', { name: '変更内容を確認' }).click()
      await page.getByRole('button', { name: action, exact: true }).click()
      await arrived
      const pending = page.getByRole('dialog', { name: `${action}しますか？` })
      await expect(pending.getByRole('button', { name: action, exact: true })).toBeDisabled()
      await expect(pending.getByRole('button', { name: '戻る' })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(pending).toBeVisible()
      release()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '設定', exact: true })).toBeFocused()
      expect(mutations).toEqual([changePassword ? 'PUT' : 'POST', changePassword ? 'PUT' : 'POST'])
      const current = await secretSafe(() => page.request.get('/api/v1/me'))
      expect(current.status()).toBe(200)
      const revokedCookie = await secretSafe(() => otherContext.request.get('/api/v1/me'))
      expect(revokedCookie.status()).toBe(401)
      const revokedBearer = await secretSafe(() => otherContext.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${native.token}` } }))
      expect(revokedBearer.status()).toBe(401)
      expect((await secretSafe(() => request.get('/api/v1/me'))).status()).toBe(200)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.getByRole('button', { name: '設定', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '設定', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '設定', exact: true })).toBeFocused()
    } finally {
      await otherContext.close()
    }
  })
}
