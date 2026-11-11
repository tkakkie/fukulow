import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AddressInfo } from 'node:net'

// Real browser WebSocket handshakes against a real HTTP upgrade rejection. No WebSocket mock:
// JavaScript sees only 1006 and must use the independent REST probe to classify the failure.
async function fixture(
  mode: 'membership' | 'network' | 'server',
  options: { withChannel?: boolean; upgradeDelayMs?: number } = {},
) {
  let upgrades = 0, memberChecks = 0
  const capabilities = { can_invite: { allowed: true }, can_manage_roles: { allowed: true }, can_create_channels: { allowed: true } }
  const dist = resolve(import.meta.dirname, '../dist')
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (path === '/api/v1/me') return json({ account: { id: 'account', email: 'a@example.com' },
      organizations: [{ organization_id: 'o', name: 'Org', capabilities }] })
    if (path === '/api/v1/orgs/o/me') {
      memberChecks++
      if (memberChecks > 1) {
        if (mode === 'membership') return json({ error: 'organization_unavailable' }, 404)
        if (mode === 'network') { req.socket.destroy(); return }
        return json({ error: 'internal_error' }, 503)
      }
      return json({ organization: { organization_id: 'o', name: 'Org', capabilities }, member: { id: 'm', name: 'Alice', role: 'owner' } })
    }
    if (path === '/api/v1/orgs/o/members') return json({ members: [] })
    if (path === '/api/v1/orgs/o/channels') {
      return json({
        channels: options.withChannel
          ? [{ id: 'c1', name: 'general', visibility: 'public', created_at: '2026-01-01T00:00:00Z' }]
          : [],
      })
    }
    if (path === '/api/v1/orgs/o/channels/c1/messages') {
      return json({
        messages: [
          {
            id: 'm1',
            channel_id: 'c1',
            seq: 1,
            sender: 'm',
            client_message_id: 'cm1',
            body: '保持されるメッセージ',
            created_at: '2026-01-01T00:00:00Z',
            topic_id: null,
            reply_to: null,
            reply_root_id: null,
          },
        ],
        has_more: false,
      })
    }
    const file = resolve(dist, path === '/' ? 'index.html' : `.${path}`)
    if (!file.startsWith(`${dist}/`)) { res.writeHead(404); res.end(); return }
    try {
      const body = await readFile(file)
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
  })
  server.on('upgrade', (_req, socket) => {
    upgrades++
    const finish = () => {
      if (mode === 'membership') socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      else if (mode === 'server') socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    }
    if (options.upgradeDelayMs) setTimeout(finish, options.upgradeDelayMs)
    else finish()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, get upgrades() { return upgrades },
    get memberChecks() { return memberChecks },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}

test('403-rejected handshake uses REST 404 organization_unavailable and becomes terminal', async ({ page }) => {
  const host = await fixture('membership')
  try {
    await page.goto(host.url)
    await expect(page.getByRole('alert')).toHaveText('この組織は利用できません。')
    expect(host.memberChecks).toBe(2)
    expect(host.upgrades).toBe(1)
    await page.waitForTimeout(1_600) // Beyond both first backoff slots; a terminal state must never retry.
    expect(host.upgrades).toBe(1)
    expect(host.memberChecks).toBe(2)
    await expect(page.getByRole('heading', { name: 'ログイン' })).toHaveCount(0)
    await page.goto('about:blank')
  } finally { await host.close() }
})

test('C10 organization_unavailable keeps Workspace and Timeline mounted with loaded Messages, drafts and distinct C10 banner', async ({ page }) => {
  const host = await fixture('membership', { withChannel: true, upgradeDelayMs: 400 })
  try {
    await page.goto(host.url)
    await expect(page.getByRole('list', { name: 'メッセージ一覧' }).getByText('保持されるメッセージ')).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'メッセージ' })
    await composer.fill('保持される下書き')

    await expect(page.getByRole('alert')).toHaveText('この組織は利用できません。')
    await expect(
      page.getByText('この組織へのアクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'メンバー資格を再確認' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'メッセージ一覧' }).getByText('保持されるメッセージ')).toBeVisible()
    await expect(composer).toHaveValue('保持される下書き')
    await expect(composer).toBeDisabled()
    await expect(page.getByText('このチャンネルは利用できません。')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'チャンネル一覧へ' })).toHaveCount(0)
    await page.goto('about:blank')
  } finally {
    await host.close()
  }
})

for (const mode of ['network', 'server'] as const) {
  test(`${mode} failure during handshake/probe reconnects without Membership loss`, async ({ page }) => {
    const host = await fixture(mode)
    try {
      await page.goto(host.url)
      await expect.poll(() => host.upgrades).toBeGreaterThanOrEqual(2)
      await expect.poll(() => host.memberChecks).toBeGreaterThanOrEqual(3)
      await expect(page.getByText('この組織は利用できません。')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'ログイン' })).toHaveCount(0)
      await page.goto('about:blank')
    } finally { await host.close() }
  })
}
