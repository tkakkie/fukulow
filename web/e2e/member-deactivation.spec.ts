import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AddressInfo } from 'node:net'

for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
  test(`${role} Member deactivation controls confirm, cancel and retain denied targets`, async ({ page }) => {
    let requests = 0
    let denied = true
    const capabilities = {
      can_invite: { allowed: role === 'owner' || role === 'admin' },
      can_manage_roles: { allowed: role === 'owner' },
      can_deactivate_members: { allowed: role === 'owner' || role === 'admin' },
      can_create_channels: { allowed: role !== 'guest' },
    }
    const organization = { organization_id: 'o', name: '組織', capabilities }
    const members = [
      { id: 'self', name: '自分', role },
      { id: 'owner', name: '別のオーナー', role: 'owner' },
      { id: 'target', name: '対象メンバー', role: 'member' },
    ]
    const dist = resolve(import.meta.dirname, '../dist')
    const server = createServer(async (req, res) => {
      const path = new URL(req.url!, 'http://localhost').pathname
      const json = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (path === '/api/v1/me') return json({ account: { id: 'account', email: 'test@example.invalid' }, organizations: [organization] })
      if (path === '/api/v1/orgs/o/me') return json({ organization, member: members[0] })
      if (path === '/api/v1/orgs/o/channels') return json({ channels: [] })
      if (path === '/api/v1/orgs/o/invites') return json({ invites: [] })
      if (path === '/api/v1/orgs/o/members') return json({ members })
      if (path === '/api/v1/orgs/o/members/target/deactivate' && req.method === 'POST') {
        requests++
        if (denied) return json({ error: 'last_channel_manager' }, 409)
        res.writeHead(204); res.end(); return
      }
      const file = resolve(dist, path === '/' ? 'index.html' : `.${path}`)
      if (!file.startsWith(`${dist}/`)) { res.writeHead(404); res.end(); return }
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch { res.writeHead(404); res.end() }
    })
    server.on('upgrade', (_req, socket) => socket.destroy())
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      await page.locator('summary').click()
      await expect(page.getByRole('button', { name: '自分を無効化', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '別のオーナーを無効化', exact: true })).toHaveCount(role === 'owner' ? 1 : 0)
      const action = page.getByRole('button', { name: '対象メンバーを無効化', exact: true })
      if (role === 'member' || role === 'guest') { await expect(action).toHaveCount(0); return }
      await action.focus(); await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'メンバーを無効化しますか？' })
      await expect(dialog).toContainText('過去のメッセージは残ります。')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0); await expect(action).toBeFocused()
      expect(requests).toBe(0)
      await action.click()
      await dialog.getByRole('button', { name: '無効化する', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('先に別のチャンネル管理者を追加してください。')
      await expect(action).toBeVisible(); expect(requests).toBe(1)
      denied = false
      await action.click()
      await dialog.getByRole('button', { name: '無効化する', exact: true }).click()
      await expect(action).toHaveCount(0)
      await expect(page.locator('summary')).toBeFocused()
      expect(requests).toBe(2)
    } finally {
      await page.goto('about:blank')
      server.closeAllConnections()
      await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()))
    }
  })
}
