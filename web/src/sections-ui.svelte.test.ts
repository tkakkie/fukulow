import { mount, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Result, SectionLayout } from './api'
import { settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import ChannelList from './ChannelList.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { sectionsAdapter } from './sections.svelte'
import { client, database, deferred, http, layout, ok, row } from './sections-test-helpers'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import Workspace from './Workspace.svelte'
import { buttonsByText, installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

function memoryBrowser(url = 'http://localhost/'): NavigationBrowser {
  const location = { href: url }
  return {
    location: location as Location,
    history: {
      pushState: (_data: unknown, _unused: string, next?: string | URL | null) => { if (next) location.href = new URL(String(next), location.href).toString() },
      replaceState: (_data: unknown, _unused: string, next?: string | URL | null) => { if (next) location.href = new URL(String(next), location.href).toString() },
    } as unknown as History,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

function makeWorkspaceSession(c: ReturnType<typeof client>) {
  return {
    channels: channelsAdapter(c.session.channels),
    sections: sectionsAdapter(c.session.sections),
    sync: syncAdapter(c.session.sync),
    topics: (id: string) => topicsAdapter(c.session.topics, id),
    unread: (id: string) => unreadAdapter(c.session.unread, id),
    close: () => c.session.close(),
  }
}

describe('personal sections adapter & UI', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!
      await fn()
    }
    vi.useRealTimers()
    dom.doc.body.innerHTML = ''
  })

  it('holds sections at Session creation and refetches on sections_changed while left column is not mounted', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = { generation: '1', sections: [{ id: 's1', name: '開発', channel_ids: ['A'] }], other_channel_ids: [] }
    db.rows = [row('A', { name: 'general' })]
    const c = client(db)
    cleanups.push(() => c.session.close())

    // No ChannelList or Workspace is mounted yet; Session creation already called sections.hold().
    await vi.advanceTimersByTimeAsync(0)
    expect(c.getLayout).toHaveBeenCalledTimes(1)
    await c.ready()
    expect(c.groups()).toEqual([['s1', ['A']], [null, []]])

    db.layout = { generation: '2', sections: [{ id: 's1', name: '開発チーム', channel_ids: ['A'] }], other_channel_ids: [] }
    c.event({ type: 'sections_changed', generation: '2' })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.sections.get().generation).toBe('2')
    expect(c.sections.get().groups[0]).toMatchObject({ id: 's1', name: '開発チーム' })
  })

  it('keeps Channel-list failure visible while hiding retry during reconnect, then restores retry on activity_ready if error persists', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = { generation: '1', sections: [{ id: 's1', name: '開発', channel_ids: ['A'] }], other_channel_ids: [] }
    db.rows = [row('A', { name: 'general' })]
    const c = client(db, { initialList: Promise.resolve(http(503, 'service unavailable')) })
    cleanups.push(() => c.session.close())
    // Keep Channel-list failing with 503 so the retry guard is actively exercised across reconnect.
    c.list.mockResolvedValue(http(503, 'service unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const nav = createNavigation(memoryBrowser())
    cleanups.push(() => nav.destroy())
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(Workspace, {
      target: host as unknown as Element,
      props: { session: makeWorkspaceSession(c), navigation: nav, selectedOrganizationId: 'org' },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    const leftCol = host.querySelector('#channel-content')!
    expect(leftCol.textContent).toContain('チャンネルを読み込めませんでした。')
    expect(buttonsByText(leftCol, '再試行')).toHaveLength(1)
    expect(leftCol.textContent).not.toContain('再接続中')

    // Simulate disconnect while waiting for activity_ready: keep error text visible, suppress non-functional retry.
    c.socket().onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)
    await settle()

    expect(c.sections.get().reconnecting).toBe(true)
    expect(leftCol.textContent).toContain('再接続中')
    expect(leftCol.textContent).toContain('チャンネルを読み込めませんでした。')
    expect(buttonsByText(leftCol, '再試行')).toHaveLength(0)

    // Reconnect and receive activity_ready while 503 still persists -> retry button returns.
    await vi.advanceTimersByTimeAsync(2_000)
    await c.ready()
    await settle()
    expect(c.sections.get().reconnecting).toBe(false)
    expect(leftCol.textContent).not.toContain('再接続中')
    expect(leftCol.textContent).toContain('チャンネルを読み込めませんでした。')
    expect(buttonsByText(leftCol, '再試行')).toHaveLength(1)

    // Recover Channel list via retry button.
    c.list.mockResolvedValue(ok({ channels: db.rows }))
    buttonsByText(leftCol, '再試行')[0]!.click()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(leftCol.textContent).toContain('開発')
    expect(leftCol.textContent).not.toContain('チャンネルを読み込めませんでした。')
  })

  it('renders custom sections in order then Other Channels (hidden when empty), preserves Topic accordions and Unread badges, and collapses in memory only', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's2', name: '運用', channel_ids: ['B'] },
        { id: 's1', name: '開発', channel_ids: ['A'] },
      ],
      other_channel_ids: ['C'],
    }
    db.rows = [
      row('A', { name: 'dev', unread_count: 4, mention_unread_count: 1 }),
      row('B', { name: 'ops', unread_count: 0, mention_unread_count: 0 }),
      row('C', { name: 'random', unread_count: 2, mention_unread_count: 0 }),
    ]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const onselect = vi.fn()
    const onselecttopic = vi.fn()
    const topicLatest = { id: 'm1', channel_id: 'A', sender: 'u1', body: 'hi', topic_id: 't1', reply_to: null, reply_root_id: null, client_message_id: 'cm1', created_seq: 5, created_at: '2026-01-01T00:00:00Z', deleted: false, history_generation: '00000000-0000-4000-8000-000000000515', version: 1 }
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: {
        channels: db.rows,
        selectedId: 'A',
        topics: [{
          kind: 'topic',
          topicId: 't1',
          position: 5,
          latestMessage: topicLatest,
          messageCount: 2,
          summaryError: null,
          baseline: {
            asOfSeq: 5,
            summary: {
              id: 't1', name: '障害対応', first_seq: 1, last_seq: 5, message_count: 2, read_seq: 2, unread_count: 1, mention_unread_count: 0,
              latest_message: topicLatest,
            },
          },
        }],
        allTopicsKnown: true,
        channelUnreadCount: (id: string) => db.rows.find(r => r.id === id)?.unread_count ?? null,
        channelMentionUnreadCount: (id: string) => db.rows.find(r => r.id === id)?.mention_unread_count ?? null,
        sections: sectionsAdapter(c.sections),
        onselect,
        onselecttopic,
      },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // Order: 運用, 開発, その他のチャンネル
    const headings = queryAll(host, '[data-section-heading]')
    expect(headings.map(h => h.textContent?.trim())).toEqual(['▾ 運用', '▾ 開発', '▾ その他のチャンネル'])
    expect(headings.every(h => h.getAttribute('aria-expanded') === 'true')).toBe(true)

    // Topic accordion and Unread badge preserved inside visible Channel A.
    expect(host.textContent).toContain('障害対応')
    expect(host.textContent).toContain('4')

    // Collapse '開発' — hides its body without calling any write API or changing Unread.
    headings[1]!.click()
    await settle()
    expect(headings[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-channel-id="A"]')).toBeNull()
    expect(c.sectionsApi.reorder).not.toHaveBeenCalled()
    expect(c.sectionsApi.moveChannel).not.toHaveBeenCalled()

    // Expand again.
    headings[1]!.click()
    await settle()
    expect(headings[1]!.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-channel-id="A"]')).not.toBeNull()

    // Hide Other Channels when it becomes empty.
    db.layout = {
      generation: '2',
      sections: [
        { id: 's2', name: '運用', channel_ids: ['B'] },
        { id: 's1', name: '開発', channel_ids: ['A', 'C'] },
      ],
      other_channel_ids: [],
    }
    c.event({ type: 'sections_changed', generation: '2' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    const nextHeadings = queryAll(host, '[data-section-heading]')
    expect(nextHeadings.map(h => h.textContent?.trim())).toEqual(['▾ 運用', '▾ 開発'])
  })

  it('closes an open move dialog without retaining revoked Channel details, restores fallback focus, and keeps empty custom sections editable', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = { generation: '1', sections: [{ id: 's1', name: '限定', channel_ids: ['A'] }], other_channel_ids: [] }
    db.rows = [row('A', { name: 'secret', visibility: 'private' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const heading = dom.doc.createElement('h2')
    heading.tabIndex = -1
    dom.doc.body.appendChild(heading)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: {
        channels: db.rows,
        selectedId: null,
        sections: sectionsAdapter(c.sections),
        channelListHeading: heading as unknown as HTMLElement,
        onselect: vi.fn(),
      },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // Open move dialog for Channel A before revoking access.
    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    expect(host.textContent).toContain('secret')
    expect(buttonsByText(host, '移動する')).toHaveLength(1)

    // Revoke access to Channel A while the move dialog is open.
    db.rows = []
    c.event({ type: 'channel_access_revoked', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[data-channel-id="A"]')).toBeNull()
    expect(host.textContent).not.toContain('secret')
    expect(buttonsByText(host, '移動する')).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(heading)

    const sec = host.querySelector('[data-section-id="s1"]')!
    expect(sec).not.toBeNull()
    expect(sec.querySelector('button[aria-label="名前を変更"]')?.disabled).toBe(false)
    expect(sec.querySelector('button[aria-label="セクションを削除"]')?.disabled).toBe(false)
    expect(host.querySelector('[data-section-id="__other__"]')).toBeNull()
  })

  it('supports create, rename, move, reorder, delete, focus preservation and delete fallback focus', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '第一', channel_ids: ['A', 'B'] },
        { id: 's2', name: '第二', channel_ids: [] },
      ],
      other_channel_ids: ['C'],
    }
    db.rows = [row('A', { name: 'alpha' }), row('B', { name: 'beta' }), row('C', { name: 'gamma' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const heading = dom.doc.createElement('h2')
    heading.tabIndex = -1
    dom.doc.body.appendChild(heading)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: {
        channels: db.rows,
        selectedId: null,
        sections: sectionsAdapter(c.sections),
        channelListHeading: heading as unknown as HTMLElement,
        onselect: vi.fn(),
      },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // 1. Reorder section s2 up -> focus stays on s2 (now at index 0, so heading is focused since up is disabled).
    c.sectionsApi.reorder.mockImplementationOnce(async ({ section_ids }) => {
      db.layout = {
        generation: '2',
        sections: section_ids.map(id => db.layout.sections.find(s => s.id === id)!),
        other_channel_ids: db.layout.other_channel_ids,
      }
      return ok(undefined)
    })
    host.querySelector('[data-testid="section-move-up-s2"]')!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-heading="s2"]'))

    // 2. Reorder Channel B up within s1 -> focus stays on Channel B (now at index 0 -> row focused).
    c.sectionsApi.reorderChannels.mockImplementationOnce(async ({ section_id, channel_ids }) => {
      db.layout = {
        generation: '3',
        sections: db.layout.sections.map(s => (s.id === section_id ? { ...s, channel_ids } : s)),
        other_channel_ids: db.layout.other_channel_ids,
      }
      return ok(undefined)
    })
    host.querySelector('[data-testid="channel-move-up-B"]')!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-channel-id="B"] .ui-list-row'))

    // 3. Move Channel C into s2 via dialog -> focus stays on moved Channel C.
    c.sectionsApi.moveChannel.mockImplementationOnce(async (ch, { section_id }) => {
      db.layout = {
        generation: '4',
        sections: db.layout.sections.map(s => (s.id === section_id ? { ...s, channel_ids: [...s.channel_ids, ch] } : s)),
        other_channel_ids: db.layout.other_channel_ids.filter(id => id !== ch),
      }
      return ok(undefined)
    })
    host.querySelector('[data-channel-id="C"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    const radioS2 = queryAll(host, 'input').find(el => el.value === 's2')!
    radioS2.checked = true
    radioS2.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-channel-id="C"] .ui-list-row'))

    // 4. Delete s2 (index 0, followed by s1) -> focus goes to next section heading (s1).
    c.sectionsApi.delete.mockImplementationOnce(async (id) => {
      const removed = db.layout.sections.find(s => s.id === id)
      db.layout = {
        generation: '5',
        sections: db.layout.sections.filter(s => s.id !== id),
        other_channel_ids: [...db.layout.other_channel_ids, ...(removed?.channel_ids ?? [])],
      }
      return ok(undefined)
    })
    host.querySelector('[data-section-id="s2"] button[aria-label="セクションを削除"]')!.click()
    await settle()
    buttonsByText(host, '削除する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-heading="s1"]'))

    // 5. Delete s1 (now last custom section, Other Channels has C) -> focus goes to Other Channels heading.
    c.sectionsApi.delete.mockImplementationOnce(async (id) => {
      const removed = db.layout.sections.find(s => s.id === id)
      db.layout = {
        generation: '6',
        sections: db.layout.sections.filter(s => s.id !== id),
        other_channel_ids: [...db.layout.other_channel_ids, ...(removed?.channel_ids ?? [])],
      }
      return ok(undefined)
    })
    host.querySelector('[data-section-id="s1"] button[aria-label="セクションを削除"]')!.click()
    await settle()
    buttonsByText(host, '削除する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-heading="__other__"]'))
  })

  it('focuses Channel-list heading when deleting the only section and Other Channels is empty', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = { generation: '1', sections: [{ id: 's1', name: '空', channel_ids: [] }], other_channel_ids: [] }
    db.rows = []
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const heading = dom.doc.createElement('h2')
    heading.tabIndex = -1
    dom.doc.body.appendChild(heading)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: {
        channels: [],
        selectedId: null,
        sections: sectionsAdapter(c.sections),
        channelListHeading: heading as unknown as HTMLElement,
        onselect: vi.fn(),
      },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    c.sectionsApi.delete.mockImplementationOnce(async () => {
      db.layout = { generation: '2', sections: [], other_channel_ids: [] }
      return ok(undefined)
    })
    host.querySelector('[data-section-id="s1"] button[aria-label="セクションを削除"]')!.click()
    await settle()
    buttonsByText(host, '削除する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(heading)
  })

  it('shows busy state while a write is in flight, renders polite Japanese errors and does not auto-retry', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = layout('1', ['A'], '開発')
    db.rows = [row('A', { name: 'general' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: db.rows, selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    const pending = deferred<Result<{ id: string; generation: string }>>()
    c.sectionsApi.create.mockReturnValueOnce(pending.promise)

    buttonsByText(host, 'セクションを作成')[0]!.click()
    await settle()
    const input = host.querySelector('input[name="section_name"]')!
    input.value = '新規'
    input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    await settle()
    buttonsByText(host, '作成する')[0]!.click()
    await settle()

    // Busy state while write is in flight.
    expect(host.querySelector('.section-channel-list')?.getAttribute('aria-busy')).toBe('true')
    expect(buttonsByText(host, '作成する')[0]!.disabled).toBe(true)

    pending.resolve(http(409, 'section_limit'))
    await settle()

    expect(host.querySelector('.section-channel-list')?.getAttribute('aria-busy')).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('セクション数の上限（50件）')
    // No automatic retry.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(c.sectionsApi.create).toHaveBeenCalledTimes(1)
  })

  it('supports keyboard Enter/Escape in dialogs and focuses previous section heading when deleting last custom section with empty Other Channels', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '先頭', channel_ids: ['A'] },
        { id: 's2', name: '末尾', channel_ids: [] },
      ],
      other_channel_ids: [],
    }
    db.rows = [row('A', { name: 'alpha' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: db.rows, selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // Open Create dialog and press Escape to close without writing.
    const createBtn = buttonsByText(host, 'セクションを作成')[0]!
    createBtn.focus()
    createBtn.click()
    await settle()
    const dialog = host.querySelector('[role="dialog"]')!
    dialog.dispatchEvent(Object.assign(new MiniDomEvent('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }))
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(c.sectionsApi.create).not.toHaveBeenCalled()

    // Open Rename dialog on s2 and submit with Enter.
    c.sectionsApi.rename.mockImplementationOnce(async (id, { name }) => {
      db.layout = {
        generation: '2',
        sections: db.layout.sections.map(s => (s.id === id ? { ...s, name } : s)),
        other_channel_ids: [],
      }
      return ok(undefined)
    })
    host.querySelector('[data-section-id="s2"] button[aria-label="名前を変更"]')!.click()
    await settle()
    const input = host.querySelector('input[name="section_name"]')!
    input.value = '末尾改'
    input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    input.dispatchEvent(Object.assign(new MiniDomEvent('keydown', { bubbles: true, cancelable: true }), { key: 'Enter' }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[data-section-heading="s2"]')?.textContent).toContain('末尾改')

    // Delete last custom section s2 while Other Channels is empty -> focuses previous section heading s1.
    c.sectionsApi.delete.mockImplementationOnce(async (id) => {
      db.layout = {
        generation: '3',
        sections: db.layout.sections.filter(s => s.id !== id),
        other_channel_ids: [],
      }
      return ok(undefined)
    })
    host.querySelector('[data-section-id="s2"] button[aria-label="セクションを削除"]')!.click()
    await settle()
    buttonsByText(host, '削除する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-heading="s1"]'))
  })

  it('restores post-move focus by item ID across concurrent order changes and cancels when the user moves focus elsewhere', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '一', channel_ids: [] },
        { id: 's2', name: '二', channel_ids: [] },
        { id: 's3', name: '三', channel_ids: ['A'] },
      ],
      other_channel_ids: [],
    }
    db.rows = [row('A', { name: 'alpha' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: db.rows, selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // 1. Move s3 up (predicted index 1), but another tab deletes s1 before the delayed snapshot lands -> s3 settles at index 0.
    const delayed1 = deferred<Result<SectionLayout>>()
    c.getLayout.mockReturnValueOnce(delayed1.promise)
    c.sectionsApi.reorder.mockResolvedValueOnce(ok(undefined))
    host.querySelector('[data-testid="section-move-up-s3"]')!.click()
    await settle()

    // Authoritative snapshot arrives with s1 deleted concurrently; s3 is at index 0 instead of 1.
    delayed1.resolve(ok({
      generation: '2',
      sections: [
        { id: 's3', name: '三', channel_ids: ['A'] },
        { id: 's2', name: '二', channel_ids: [] },
      ],
      other_channel_ids: [],
    }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-heading="s3"]'))

    // 2. Move s3 down with a delayed snapshot, and move focus to セクションを作成 before snapshot lands -> focus is not stolen.
    const delayed2 = deferred<Result<SectionLayout>>()
    c.getLayout.mockReturnValueOnce(delayed2.promise)
    c.sectionsApi.reorder.mockResolvedValueOnce(ok(undefined))
    host.querySelector('[data-testid="section-move-down-s3"]')!.click()
    await settle()

    const createBtn = buttonsByText(host, 'セクションを作成')[0]!
    createBtn.focus()
    expect(dom.doc.activeElement).toBe(createBtn)

    delayed2.resolve(ok({
      generation: '3',
      sections: [
        { id: 's2', name: '二', channel_ids: [] },
        { id: 's3', name: '三', channel_ids: ['A'] },
      ],
      other_channel_ids: [],
    }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(createBtn)
  })

  it('disambiguates duplicate section names including その他のチャンネル and selects destinations by section ID', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '開発', channel_ids: [] },
        { id: 's2', name: 'その他のチャンネル', channel_ids: [] },
        { id: 's3', name: '開発', channel_ids: [] },
      ],
      other_channel_ids: ['A'],
    }
    db.rows = [row('A', { name: 'alpha' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: db.rows, selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()

    const labels = queryAll(host, '.section-dialog__option-label').map(el => el.textContent?.trim())
    expect(labels).toEqual([
      '開発（1番目）',
      'その他のチャンネル（1番目）',
      '開発（2番目）',
      'その他のチャンネル（既定）',
    ])

    // Select the custom section named その他のチャンネル (id: 's2') and confirm.
    c.sectionsApi.moveChannel.mockImplementationOnce(async (ch, { section_id }) => {
      db.layout = {
        generation: '2',
        sections: db.layout.sections.map(s => (s.id === section_id ? { ...s, channel_ids: [ch] } : s)),
        other_channel_ids: [],
      }
      return ok(undefined)
    })
    const customOtherRadio = queryAll(host, 'input[name="section_move_destination"]').find(el => el.value === 's2')!
    customOtherRadio.checked = true
    customOtherRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(c.sectionsApi.moveChannel).toHaveBeenLastCalledWith('A', { section_id: 's2' }, expect.anything())

    // Move back to the implicit その他のチャンネル（既定） (id: null).
    c.sectionsApi.moveChannel.mockImplementationOnce(async (ch) => {
      db.layout = {
        generation: '3',
        sections: db.layout.sections.map(s => ({ ...s, channel_ids: s.channel_ids.filter(id => id !== ch) })),
        other_channel_ids: [ch],
      }
      return ok(undefined)
    })
    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    const implicitRadio = queryAll(host, 'input[name="section_move_destination"]').find(el => el.value === '')!
    implicitRadio.checked = true
    implicitRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(c.sectionsApi.moveChannel).toHaveBeenLastCalledWith('A', { section_id: null }, expect.anything())
  })

  it('ties post-write focus to the accepted layout (ignoring intermediate Channel-list renders), records focus changes during the write, cancels on unmount, and falls back to a visible control when targets disappear', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '一', channel_ids: ['A'] },
        { id: 's2', name: '二', channel_ids: [] },
      ],
      other_channel_ids: ['B'],
    }
    db.rows = [row('A', { name: 'alpha' }), row('B', { name: 'beta' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: db.rows, selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // 1. Move Channel A from s1 to s2, but while the post-write layout is still pending, an unrelated
    // Channel-list update rebuilds `groups`. Pending focus must wait for the accepted post-write layout
    // and then focus Channel A in its new group s2.
    const delayedLayout = deferred<Result<SectionLayout>>()
    c.getLayout.mockReturnValueOnce(delayedLayout.promise)
    c.sectionsApi.moveChannel.mockResolvedValueOnce(ok(undefined))
    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    const radioS2 = queryAll(host, 'input[name="section_move_destination"]').find(el => el.value === 's2')!
    radioS2.checked = true
    radioS2.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await settle()

    // Intermediate Channel-list update rebuilds groups without accepting a new section layout.
    db.rows = [row('A', { name: 'alpha-renamed' }), row('B', { name: 'beta' })]
    c.event({ type: 'channel_list_changed' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(host.querySelector('[data-section-id="s1"] [data-channel-id="A"]')).not.toBeNull()
    expect(dom.doc.activeElement).not.toBe(host.querySelector('[data-section-id="s1"] [data-channel-id="A"] .ui-list-row'))

    // Now the accepted post-write layout arrives with A in s2 -> focus lands on A in s2.
    delayedLayout.resolve(ok({
      generation: '2',
      sections: [
        { id: 's1', name: '一', channel_ids: [] },
        { id: 's2', name: '二', channel_ids: ['A'] },
      ],
      other_channel_ids: ['B'],
    }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-id="s2"] [data-channel-id="A"] .ui-list-row'))

    // 2. Focus change DURING the write cancels pending focus even if that newly focused control later
    // disappears (leaving activeElement on body) before reconciliation.
    const pendingWrite = deferred<Result<undefined>>()
    c.sectionsApi.moveChannel.mockReturnValueOnce(pendingWrite.promise)
    const externalBtn = dom.doc.createElement('button')
    externalBtn.textContent = '外部'
    dom.doc.body.appendChild(externalBtn)

    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    const radioS1 = queryAll(host, 'input[name="section_move_destination"]').find(el => el.value === 's1')!
    radioS1.checked = true
    radioS1.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await settle()

    // User moves focus to externalBtn while write is in flight, then externalBtn is removed -> body.
    externalBtn.focus()
    expect(dom.doc.activeElement).toBe(externalBtn)
    externalBtn.remove()
    dom.doc.activeElement = dom.doc.body

    db.layout = {
      generation: '3',
      sections: [
        { id: 's1', name: '一', channel_ids: ['A'] },
        { id: 's2', name: '二', channel_ids: [] },
      ],
      other_channel_ids: ['B'],
    }
    pendingWrite.resolve(ok(undefined))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).not.toBe(host.querySelector('[data-channel-id="A"] .ui-list-row'))

    // 3. Target disappears before reconciliation (moved channel revoked and destination deleted, and no
    // channelListHeading prop) -> falls back to a visible control, never body.
    c.sectionsApi.moveChannel.mockImplementationOnce(async () => {
      db.rows = []
      db.layout = { generation: '4', sections: [], other_channel_ids: [] }
      return ok(undefined)
    })
    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    const radioS2Again = queryAll(host, 'input[name="section_move_destination"]').find(el => el.value === 's2')!
    radioS2Again.checked = true
    radioS2Again.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).not.toBe(dom.doc.body)
    expect(dom.doc.activeElement).toBe(buttonsByText(host, 'セクションを作成')[0])
  })

  it('cancels pending focus restoration on pointerdown outside the Channel list even when focus falls to body', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '一', channel_ids: ['A'] },
        { id: 's2', name: '二', channel_ids: [] },
      ],
      other_channel_ids: [],
    }
    db.rows = [row('A', { name: 'alpha' })]
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const outsideNonFocusable = dom.doc.createElement('div')
    outsideNonFocusable.textContent = 'メイン領域'
    dom.doc.body.appendChild(outsideNonFocusable)

    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: db.rows, selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // Move Channel A from s1 to s2 with a delayed layout GET.
    const delayedLayout = deferred<Result<SectionLayout>>()
    c.getLayout.mockReturnValueOnce(delayedLayout.promise)
    c.sectionsApi.moveChannel.mockResolvedValueOnce(ok(undefined))
    host.querySelector('[data-channel-id="A"] button[aria-label="チャンネルを移動"]')!.click()
    await settle()
    const radioS2 = queryAll(host, 'input[name="section_move_destination"]').find(el => el.value === 's2')!
    radioS2.checked = true
    radioS2.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, '移動する')[0]!.click()
    await settle()

    // User clicks a non-focusable area outside the Channel list: pointerdown fires and focus clears to body (no focusin).
    outsideNonFocusable.dispatchEvent(new MiniDomEvent('pointerdown', { bubbles: true }))
    dom.doc.activeElement = dom.doc.body

    // Delayed layout GET completes -> focus must NOT move into the Channel list.
    delayedLayout.resolve(ok({
      generation: '2',
      sections: [
        { id: 's1', name: '一', channel_ids: [] },
        { id: 's2', name: '二', channel_ids: ['A'] },
      ],
      other_channel_ids: [],
    }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(host.querySelector('[data-section-id="s2"] [data-channel-id="A"]')).not.toBeNull()
    expect(dom.doc.activeElement).toBe(dom.doc.body)
  })

  it('removes document listeners and prevents focus movement when unmounted while a restoration token is still armed', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '一', channel_ids: [] },
        { id: 's2', name: '二', channel_ids: [] },
      ],
      other_channel_ids: [],
    }
    db.rows = []
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const outsideHeading = dom.doc.createElement('h2')
    outsideHeading.setAttribute('tabindex', '-1')
    outsideHeading.textContent = 'チャンネル一覧'
    dom.doc.body.appendChild(outsideHeading)

    const addSpy = vi.spyOn(dom.doc, 'addEventListener')
    const removeSpy = vi.spyOn(dom.doc, 'removeEventListener')
    cleanups.push(() => {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    })

    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: {
        channels: [],
        selectedId: null,
        sections: sectionsAdapter(c.sections),
        channelListHeading: outsideHeading as unknown as HTMLElement,
        onselect: vi.fn(),
      },
    })
    await settle()

    const delayed = deferred<Result<SectionLayout>>()
    c.getLayout.mockReturnValueOnce(delayed.promise)
    c.sectionsApi.reorder.mockResolvedValueOnce(ok(undefined))
    host.querySelector('[data-testid="section-move-up-s2"]')!.click()
    await settle()

    // Token is still armed (no focusin/pointerdown cancellation before unmount).
    const focusInAdd = addSpy.mock.calls.find(([type, , capture]) => type === 'focusin' && capture === true)
    const pointerDownAdd = addSpy.mock.calls.find(([type, , capture]) => type === 'pointerdown' && capture === true)
    expect(focusInAdd).toBeDefined()
    expect(pointerDownAdd).toBeDefined()

    // Unmount while the restoration token is live.
    await unmount(inst)
    expect(removeSpy).toHaveBeenCalledWith('focusin', focusInAdd![1], true)
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', pointerDownAdd![1], true)

    dom.doc.activeElement = dom.doc.body
    delayed.resolve(ok({
      generation: '2',
      sections: [
        { id: 's2', name: '二', channel_ids: [] },
        { id: 's1', name: '一', channel_ids: [] },
      ],
      other_channel_ids: [],
    }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(dom.doc.body)
  })

  it('cancels pending focus restoration on unmount', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 's1', name: '一', channel_ids: [] },
        { id: 's2', name: '二', channel_ids: [] },
      ],
      other_channel_ids: [],
    }
    db.rows = []
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const outsideBtn = dom.doc.createElement('button')
    outsideBtn.textContent = '外'
    dom.doc.body.appendChild(outsideBtn)

    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: [], selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    await settle()

    const delayed = deferred<Result<SectionLayout>>()
    c.getLayout.mockReturnValueOnce(delayed.promise)
    c.sectionsApi.reorder.mockResolvedValueOnce(ok(undefined))
    host.querySelector('[data-testid="section-move-up-s2"]')!.click()
    await settle()

    outsideBtn.focus()
    await unmount(inst)
    delayed.resolve(ok({
      generation: '2',
      sections: [
        { id: 's2', name: '二', channel_ids: [] },
        { id: 's1', name: '一', channel_ids: [] },
      ],
      other_channel_ids: [],
    }))
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(dom.doc.activeElement).toBe(outsideBtn)
  })

  it('focuses C (not D) when deleting B in [A, B, C, D] while another tab concurrently deletes A', async () => {
    vi.useFakeTimers()
    const db = database()
    db.layout = {
      generation: '1',
      sections: [
        { id: 'A', name: 'A', channel_ids: [] },
        { id: 'B', name: 'B', channel_ids: [] },
        { id: 'C', name: 'C', channel_ids: [] },
        { id: 'D', name: 'D', channel_ids: [] },
      ],
      other_channel_ids: [],
    }
    db.rows = []
    const c = client(db)
    cleanups.push(() => c.session.close())
    await vi.advanceTimersByTimeAsync(0)
    await c.ready()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const inst = mount(ChannelList, {
      target: host as unknown as Element,
      props: { channels: [], selectedId: null, sections: sectionsAdapter(c.sections), onselect: vi.fn() },
    })
    cleanups.push(() => unmount(inst))
    await settle()

    // Delete B locally while another tab concurrently deletes A -> reconciled layout is [C, D].
    c.sectionsApi.delete.mockImplementationOnce(async () => {
      db.layout = {
        generation: '2',
        sections: [
          { id: 'C', name: 'C', channel_ids: [] },
          { id: 'D', name: 'D', channel_ids: [] },
        ],
        other_channel_ids: [],
      }
      return ok(undefined)
    })
    host.querySelector('[data-section-id="B"] button[aria-label="セクションを削除"]')!.click()
    await settle()
    buttonsByText(host, '削除する')[0]!.click()
    await vi.advanceTimersByTimeAsync(200)
    await settle()

    expect(dom.doc.activeElement).toBe(host.querySelector('[data-section-heading="C"]'))
  })
})
