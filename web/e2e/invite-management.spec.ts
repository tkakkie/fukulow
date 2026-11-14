import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { InvitePage, OutstandingInvite } from '../src/api-schema.d.ts'

for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
  test(`${role} Invite controls page, confirm and cancel revocation with keyboard focus`, async ({ page }) => {
    let deleted: string[] = [], pages: string[] = []
    let deny = true
    const allowed = role === 'owner' || role === 'admin'
    const organization = { organization_id: 'o', name: '組織', capabilities: {
      can_invite: { allowed }, can_manage_roles: { allowed: role === 'owner' },
      can_deactivate_members: { allowed }, can_create_channels: { allowed: role !== 'guest' },
    } }
    const member = { id: 'self', name: '自分', role }
    const invites: OutstandingInvite[] = Array.from({ length: 250 }, (_, n) => ({
      id: `${n}`, email: `invite-${n}@example.invalid`, role: 'member', created_by: 'self', expires_at: '2027-01-01T00:00:00Z',
    }))
    const dist = resolve(import.meta.dirname, '../dist')
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost'), path = url.pathname
      const json = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (path === '/api/v1/me') return json({ account: { id: 'account', email: 'test@example.invalid' }, organizations: [organization] })
      if (path === '/api/v1/orgs/o/me') return json({ organization, member })
      if (path === '/api/v1/orgs/o/channels') return json({ channels: [] })
      if (path === '/api/v1/orgs/o/members') return json({ members: [member] })
      if (path === '/api/v1/orgs/o/invites') {
        const cursor = url.searchParams.get('cursor') ?? '0'; pages.push(cursor)
        const start = Number(cursor), end = Math.min(start + 100, invites.length)
        const result: InvitePage = { invites: invites.slice(start, end), ...(end < invites.length ? { next_cursor: `${end}` } : {}) }
        return json(result)
      }
      if (path.startsWith('/api/v1/orgs/o/invites/') && req.method === 'DELETE') {
        deleted.push(path.split('/').at(-1)!)
        if (deny) return json({ error: 'invite_unavailable' }, 404)
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
      const panel = page.getByRole('region', { name: '未承諾の招待', exact: true })
      if (!allowed) { await expect(panel).toHaveCount(0); expect(pages).toEqual([]); return }
      await expect(panel.locator('li')).toHaveCount(100)
      await panel.getByRole('button', { name: 'さらに招待を読み込む' }).click()
      await expect(panel.locator('li')).toHaveCount(200)
      await panel.getByRole('button', { name: 'さらに招待を読み込む' }).click()
      await expect(panel.locator('li')).toHaveCount(250)
      await expect(panel.getByRole('button', { name: 'さらに招待を読み込む' })).toHaveCount(0)
      expect(pages).toEqual(['0', '100', '200'])
      const action = panel.getByRole('button', { name: 'invite-249@example.invalidへの招待を取り消す', exact: true })
      await action.focus(); await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: '招待を取り消しますか？' })
      await expect(dialog).toContainText('元に戻せません')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0); await expect(action).toBeFocused(); expect(deleted).toEqual([])
      await action.click(); await dialog.getByRole('button', { name: '招待を取り消す', exact: true }).click()
      await expect(panel.getByRole('alert')).toContainText('この招待は利用できません')
      await expect(action).toBeVisible(); expect(deleted).toEqual(['249'])
      deny = false
      await action.click(); await dialog.getByRole('button', { name: '招待を取り消す', exact: true }).click()
      await expect(action).toHaveCount(0); await expect(panel.locator('li')).toHaveCount(249)
      await expect(panel.getByRole('heading', { name: '未承諾の招待' })).toBeFocused()
      expect(deleted).toEqual(['249', '249'])
      // Reflow on a phone keeps actions inside the viewport.
      await page.setViewportSize({ width: 320, height: 700 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally {
      await page.goto('about:blank'); server.closeAllConnections()
      await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()))
    }
  })
}
