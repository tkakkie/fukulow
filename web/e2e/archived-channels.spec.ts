import { expect, test, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { components } from '../src/api-schema.d.ts'

type UnreadChannel = components['schemas']['UnreadChannel']

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible()
  const limit = await page.locator('a[href], button, input, textarea, select, summary, [tabindex]').count() + 2
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate(el => el === document.activeElement)) break
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

const historyGeneration = '00000000-0000-4000-8000-000000000837'

function makeChannel(overrides: Partial<UnreadChannel> & Pick<UnreadChannel, 'id' | 'name'>): UnreadChannel {
  return {
    kind: 'channel',
    visibility: 'public',
    archived: false,
    history_generation: historyGeneration,
    as_of_seq: 0,
    read_seq: 0,
    main_unread_count: 0,
    main_mention_unread_count: 0,
    unread_count: 0,
    mention_unread_count: 0,
    capabilities: {
      can_add_members: { allowed: false },
      can_remove_members: { allowed: false },
      can_manage_managers: { allowed: false },
      can_leave: { allowed: false },
      can_rename: { allowed: false },
      can_archive: { allowed: false },
    },
    ...overrides,
  }
}

async function withMockApp(
  options: { unavailableOnChannels?: boolean },
  run: (ctx: { url: string; archivedRequests: () => number }) => Promise<void>,
) {
  let archivedCount = 0
  const organization = {
    organization_id: 'o',
    name: '組織',
    capabilities: {
      can_invite: { allowed: false },
      can_manage_roles: { allowed: false },
      can_deactivate_members: { allowed: false },
      can_create_channels: { allowed: false },
    },
  }
  const member = { id: '00000000-0000-0000-0000-000000000001', name: '自分', role: 'member' }
  const active = makeChannel({ id: '00000000-0000-4000-8000-000000000010', name: 'general' })
  const archived = makeChannel({ id: '00000000-0000-4000-8000-000000000011', name: 'archived-room', archived: true })
  const history_generation = historyGeneration
  const dist = resolve(import.meta.dirname, '../dist')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const path = url.pathname
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (path === '/api/v1/me') return json({ account: { id: 'account', email: 'test@example.invalid' }, organizations: [organization] })
    if (path === '/api/v1/orgs/o/me') return json({ organization, member })
    if (path === '/api/v1/orgs/o/channels') {
      if (options.unavailableOnChannels) return json({ error: 'organization_unavailable' }, 404)
      if (url.searchParams.get('archived') === 'true') {
        archivedCount++
        return json({ history_generation, channels: [archived] })
      }
      return json({ history_generation, channels: [active] })
    }
    if (path === '/api/v1/orgs/o/dms') return json({ channels: [], has_more: false })
    if (path === '/api/v1/orgs/o/sections') return json({ sections: [] })
    if (path === '/api/v1/orgs/o/members') return json({ members: [member] })
    if (path === `/api/v1/orgs/o/channels/${active.id}/messages`) {
      return json({ history_generation, as_of_seq: 0, messages: [], has_more: false })
    }
    const file = resolve(dist, path === '/' ? 'index.html' : `.${path}`)
    if (!file.startsWith(`${dist}/`)) { res.writeHead(404); res.end(); return }
    try {
      const body = await readFile(file)
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
      }
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    await run({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      archivedRequests: () => archivedCount,
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()))
  }
}

test('archived Channels summary is reachable by Tab and toggles lazily via Enter and Space', async ({ page }) => {
  await withMockApp({}, async ({ url, archivedRequests }) => {
    try {
      await page.goto(url)
      const section = page.getByRole('region', { name: 'アーカイブ済みチャンネル', exact: true })
      const details = section.locator('details.archived-list__details')
      const summary = section.locator('summary.archived-list__toggle')

      await expect(summary).toBeVisible()
      await expect(details).not.toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(0)
      expect(archivedRequests()).toBe(0)

      await tabTo(page, summary)

      await page.keyboard.press('Enter')
      await expect(details).toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(1)
      await expect(section.getByRole('button', { name: /archived-room/ })).toBeVisible()
      expect(archivedRequests()).toBe(1)

      await page.keyboard.press('Space')
      await expect(details).not.toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(0)

      await page.keyboard.press('Space')
      await expect(details).toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(1)
      await expect(section.getByRole('button', { name: /archived-room/ })).toBeVisible()

      await page.keyboard.press('Enter')
      await expect(details).not.toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(0)
    } finally {
      await page.goto('about:blank')
    }
  })
})

test('disabled archived Channels summary stays exposed in the accessibility tree with not-allowed cursor and blocks activation', async ({ page }) => {
  await withMockApp({ unavailableOnChannels: true }, async ({ url, archivedRequests }) => {
    try {
      await page.goto(url)
      await expect(page.getByText('この組織は利用できません')).toBeVisible()

      const section = page.getByRole('region', { name: 'アーカイブ済みチャンネル', exact: true })
      const details = section.locator('details.archived-list__details')
      const summary = section.locator('summary.archived-list__toggle')

      await expect(summary).toBeVisible()
      await expect(summary).toHaveAttribute('aria-disabled', 'true')
      await expect(details).not.toHaveAttribute('inert', '')
      await expect(details).not.toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(0)

      // Verify Chromium's accessibility tree still exposes the disabled, collapsed control.
      const cdp = await page.context().newCDPSession(page)
      const { nodes } = await cdp.send('Accessibility.getFullAXTree')
      const summaryAx = nodes.find(node =>
        !node.ignored
        && node.name?.value === 'アーカイブ済みチャンネル'
        && (node.role?.value === 'DisclosureTriangle' || node.role?.value === 'button'),
      )
      expect(summaryAx).toBeDefined()
      const axProp = (name: string) => summaryAx?.properties?.find(p => p.name === name)?.value?.value
      expect(axProp('disabled')).toBe(true)
      expect(axProp('expanded')).toBe(false)

      // Hover hit-test reaches the summary itself and applies cursor: not-allowed.
      const hit = await summary.evaluate(el => {
        const rect = el.getBoundingClientRect()
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          hitsSummary: target !== null && el.contains(target),
          cursor: target ? getComputedStyle(target).cursor : null,
        }
      })
      expect(hit).toEqual({ hitsSummary: true, cursor: 'not-allowed' })

      // Clicking and keyboard activation cannot open while disabled.
      await summary.click({ force: true })
      await expect(details).not.toHaveAttribute('open', '')
      // Tab skips the disabled summary, like the disabled button it replaced.
      await expect(summary).toHaveAttribute('tabindex', '-1')
      await page.locator('body').focus()
      const stops = await page.locator('a[href], button, input, textarea, select, summary, [tabindex]').count() + 2
      for (let i = 0; i < stops; i++) {
        await page.keyboard.press('Tab')
        expect(await summary.evaluate(el => el === document.activeElement)).toBe(false)
      }
      // Even if focused programmatically, Enter and Space do not open it.
      await summary.focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await expect(details).not.toHaveAttribute('open', '')
      await expect(section.locator('.archived-list__body')).toHaveCount(0)
      expect(archivedRequests()).toBe(0)
    } finally {
      await page.goto('about:blank')
    }
  })
})
