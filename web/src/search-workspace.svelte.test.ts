import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { repliesAdapter } from './replies.svelte'
import { createDefaultSearchSource, createMockSearchSource, type SearchSource } from './search-source'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'
import { msg } from './topic-test-helpers'
import { installMiniDom, MiniDomEvent, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Workspace search integration (#153)', () => {
  const ORG_ID = '00000000-0000-4000-8000-000000000001'
  const CH_ID = '00000000-0000-4000-8000-000000000010'
  const TOPIC_ID = '00000000-0000-4000-8000-000000000020'

  async function mountSearchWorkspace(opts: {
    width?: number
    href?: string
    searchSource?: SearchSource
    onannounce?: (message: string) => void
    setupNet?: (net: ReturnType<typeof fakeNetwork>) => void
  } = {}) {
    dom.win.innerWidth = opts.width ?? 1280
    const net = fakeNetwork()
    opts.setupNet?.(net)
    const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.lists[0]!.resolve(ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      channels: [channel(CH_ID, 'general')],
    }))
    const navigation = createNavigation({
      location: { href: opts.href ?? `http://localhost/o/${ORG_ID}/c/${CH_ID}` },
      history: { state: null, pushState() {}, replaceState() {} },
      get innerWidth() { return dom.win.innerWidth },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        selectedOrganizationId: ORG_ID,
        searchSource: opts.searchSource ?? createMockSearchSource(),
        onannounce: opts.onannounce,
        session: {
          channels: channelsAdapter(raw.channels),
          sync: syncAdapter(raw.sync),
          topics: (id: string) => topicsAdapter(raw.topics, id),
          replies: (id: string) => repliesAdapter(raw.replies, id),
          close: raw.close,
        },
      },
    })
    await settle()
    return {
      host,
      navigation,
      async close() {
        await unmount(instance)
        navigation.destroy()
        raw.close()
        host.remove()
      },
    }
  }

  it('keeps the same search form and input focus on submit, without extra live regions', async () => {
    const ctx = await mountSearchWorkspace()
    try {
      const formBefore = ctx.host.querySelector('#main-content [role="search"]')!
      const inputBefore = formBefore.querySelector('input')!
      inputBefore.focus()
      expect(dom.doc.activeElement).toBe(inputBefore)

      inputBefore.value = 'リリース'
      inputBefore.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      formBefore.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const formAfter = ctx.host.querySelector('#main-content [role="search"]')!
      const inputAfter = formAfter.querySelector('input')!
      expect(formAfter).toBe(formBefore)
      expect(inputAfter).toBe(inputBefore)
      expect(dom.doc.activeElement).toBe(inputBefore)
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(queryAll(ctx.host, '#main-content [role="status"]')).toHaveLength(0)
    } finally {
      await ctx.close()
    }
  })

  it('keeps the current view and shows an inline notice when selecting a hit whose Channel cannot be opened', async () => {
    const ctx = await mountSearchWorkspace()
    try {
      const routeBefore = ctx.navigation.get().target
      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      // Default mock hit has channelId 'general' which is not in the user's loaded UUID channels.
      const hitButton = ctx.host.querySelector('#main-content ol button')!
      hitButton.click()
      await settle()

      expect(ctx.navigation.get().target).toEqual(routeBefore)
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(ctx.host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('開けません')
    } finally {
      await ctx.close()
    }
  })

  it('exposes search at the phone Channel-list level (375 px) and transitions to results and back', async () => {
    const ctx = await mountSearchWorkspace({ width: 375, href: `http://localhost/o/${ORG_ID}` })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      expect(workspace.getAttribute('data-mobile-level')).toBe('channels')

      const listForm = ctx.host.querySelector('.channel-column [role="search"]')
      expect(listForm).not.toBeNull()
      const listInput = listForm!.querySelector('input')!
      listInput.focus()
      listInput.value = 'リリース'
      listInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      listForm!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      expect(workspace.getAttribute('data-mobile-level')).toBe('view')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      const mainSearchInput = ctx.host.querySelector('#main-content [role="search"] input')!
      expect(dom.doc.activeElement).toBe(mainSearchInput)

      const backBtn = queryAll(ctx.host, '#main-content header button').find((b) => b.textContent.includes('戻る'))!
      backBtn.click()
      await settle()

      expect(workspace.getAttribute('data-mobile-level')).toBe('channels')
      const restoredListInput = ctx.host.querySelector('.channel-column [role="search"] input')!
      expect(dom.doc.activeElement).toBe(restoredListInput)
    } finally {
      await ctx.close()
    }
  })

  it('closes the same topmost layer on Escape regardless of focus inside search', async () => {
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}?panel=topics`,
    })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')

      // First Escape from the focused search input closes the topmost layer (the right panel), keeping search open.
      const esc1 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc1.key = 'Escape'
      input.dispatchEvent(esc1)
      await settle()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')

      // Second Escape closes search.
      const esc2 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc2.key = 'Escape'
      input.dispatchEvent(esc2)
      await settle()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).not.toBe('検索結果')
    } finally {
      await ctx.close()
    }
  })

  it('keeps Topic view Shift+Tab order from Composer -> roving row -> panel toggle -> チャンネルへ戻る ahead of SearchBar', async () => {
    const topicMsg = {
      ...record(1, CH_ID),
      body: 'トピック本文',
      topic_id: TOPIC_ID,
      topic_name: 'キーボード議題',
    }
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}/t/${TOPIC_ID}`,
      setupNet(net) {
        net.topicMessages[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 1,
          messages: [topicMsg],
          has_more: false,
        })
        net.topicSummaries[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 1,
          topic: {
            mention_unread_count: 0,
            id: TOPIC_ID,
            name: 'キーボード議題',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: topicMsg,
            read_seq: 0,
            unread_count: 0,
          },
        })
      },
    })
    try {
      const main = ctx.host.querySelector('#main-content')!
      // Collect desktop-visible tabbable elements in DOM order inside #main-content
      // (.mobile-only wrappers are display: none at 1280px).
      const tabbables: MiniElement[] = []
      const walk = (node: MiniElement) => {
        if ((node.getAttribute('class') ?? '').split(/\s+/).includes('mobile-only')) return
        const tag = node.tagName.toLowerCase()
        const tabindex = node.getAttribute('tabindex')
        const disabled = node.hasAttribute('disabled') || (node as unknown as { disabled?: boolean }).disabled === true
        const naturallyTabbable = tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || (tag === 'a' && node.hasAttribute('href'))
        const isTabbable = !disabled && (
          (naturallyTabbable && tabindex !== '-1') ||
          (tabindex !== null && tabindex !== '' && Number(tabindex) >= 0)
        )
        if (isTabbable) tabbables.push(node)
        for (const child of node.childNodes) {
          if (child instanceof MiniElement) walk(child)
        }
      }
      walk(main)

      const composer = main.querySelector('textarea')!
      const rovingRow = main.querySelector('.ui-message-row[data-focusable="true"][tabindex="0"]')!
      const panelToggle = main.querySelector('button[aria-label="パネルを開く(⌘.)"]')!
      const backButton = queryAll(main, 'button').find((b) => b.textContent.includes('チャンネルへ戻る'))!
      const searchSubmit = queryAll(main, '[role="search"] button').find((b) => b.textContent.trim() === '検索')!
      const searchInput = main.querySelector('[role="search"] input')!

      const composerIdx = tabbables.indexOf(composer)
      expect(composerIdx).toBeGreaterThanOrEqual(5)
      // Shift+Tab x1 -> roving Message row, x2 -> panel toggle, x3 -> チャンネルへ戻る (matching e2e/topics.spec.ts & e2e/unread.spec.ts)
      expect(tabbables[composerIdx - 1]).toBe(rovingRow)
      expect(tabbables[composerIdx - 2]).toBe(panelToggle)
      expect(tabbables[composerIdx - 3]).toBe(backButton)
      // SearchBar controls precede the view header row in DOM and visual order.
      expect(tabbables[composerIdx - 4]).toBe(searchSubmit)
      expect(tabbables[composerIdx - 5]).toBe(searchInput)
    } finally {
      await ctx.close()
    }
  })

  it('keeps reverse Tab order from Topic Composer to the roving MessageRow after closing a Reply panel with search closed', async () => {
    const topicMsg1 = {
      ...record(1, CH_ID),
      body: 'トピック内の親メッセージ',
      topic_id: TOPIC_ID,
      topic_name: '仕様確認',
    }
    const topicMsg2 = {
      ...record(2, CH_ID),
      body: 'トピック内の返信-01',
      topic_id: TOPIC_ID,
      topic_name: '仕様確認',
      reply_to: topicMsg1.id,
      reply_root_id: topicMsg1.id,
    }
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}/t/${TOPIC_ID}?panel=reply:${topicMsg1.id}`,
      setupNet(net) {
        net.topicMessages[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          messages: [topicMsg1, topicMsg2],
          has_more: false,
        })
        net.topicSummaries[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          topic: {
            mention_unread_count: 0,
            id: TOPIC_ID,
            name: '仕様確認',
            first_seq: 1,
            last_seq: 2,
            message_count: 2,
            latest_message: topicMsg2,
            read_seq: 2,
            unread_count: 0,
          },
        })
        net.replyChains[`${CH_ID}:${topicMsg1.id}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          root_id: topicMsg1.id,
          chain_version: 2,
          messages: [topicMsg1, topicMsg2],
          has_more: false,
        })
        net.replyChains[`${CH_ID}:${topicMsg2.id}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          root_id: topicMsg1.id,
          chain_version: 2,
          messages: [topicMsg1, topicMsg2],
          has_more: false,
        })
      },
    })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      // Close Reply panel via × with search closed: focus returns to main Topic Composer.
      const closeBtn = ctx.host.querySelector('#panel-content button[aria-label="パネルを閉じる(Esc)"]')!
      closeBtn.click()
      await settle()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')

      const main = ctx.host.querySelector('#main-content')!
      const composer = main.querySelector('textarea')!
      expect(dom.doc.activeElement).toBe(composer)

      // Fill a non-empty draft and verify reverse Tab from Composer reaches the roving tabindex="0" row directly.
      composer.value = '消さずに残すトピック下書き'
      composer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      composer.focus()

      const tabbables: MiniElement[] = []
      const walk = (node: MiniElement) => {
        if ((node.getAttribute('class') ?? '').split(/\s+/).includes('mobile-only')) return
        const tag = node.tagName.toLowerCase()
        const tabindex = node.getAttribute('tabindex')
        const disabled = node.hasAttribute('disabled') || (node as unknown as { disabled?: boolean }).disabled === true
        const naturallyTabbable = tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || (tag === 'a' && node.hasAttribute('href'))
        const isTabbable = !disabled && (
          (naturallyTabbable && tabindex !== '-1') ||
          (tabindex !== null && tabindex !== '' && Number(tabindex) >= 0)
        )
        if (isTabbable) tabbables.push(node)
        for (const child of node.childNodes) {
          if (child instanceof MiniElement) walk(child)
        }
      }
      walk(main)

      const rovingRow = main.querySelector(`[data-message-id="${topicMsg2.id}"] .ui-message-row`)!
      expect(rovingRow.getAttribute('tabindex')).toBe('0')
      const composerIdx = tabbables.indexOf(composer)
      expect(tabbables[composerIdx - 1]).toBe(rovingRow)

      // Simulate Shift+Tab landing on rovingRow, press 'r' to open Reply panel without clearing draft, then Escape.
      rovingRow.focus()
      expect(dom.doc.activeElement).toBe(rovingRow)
      const openKey = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      openKey.key = 'r'
      rovingRow.dispatchEvent(openKey)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('true')
      expect(dom.doc.activeElement).toBe(ctx.host.querySelector('#panel-content textarea'))
      expect(composer.value).toBe('消さずに残すトピック下書き')

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      ctx.host.querySelector('#panel-content textarea')!.dispatchEvent(esc)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(dom.doc.activeElement).toBe(rovingRow)
    } finally {
      await ctx.close()
    }
  })

  it('restores keyboard focus inside search when closing a panel via Escape while search stays open', async () => {
    const ctx = await mountSearchWorkspace()
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')

      // Focus a search hit, open the Topics panel with Cmd+., then press Escape from its heading.
      const hitButton = ctx.host.querySelector('#main-content ol button')!
      hitButton.focus()
      expect(dom.doc.activeElement).toBe(hitButton)

      const togglePanel = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      togglePanel.key = '.'
      togglePanel.metaKey = true
      dom.win.dispatchEvent(togglePanel)
      await settle()
      expect(workspace.getAttribute('data-panel-open')).toBe('true')
      const panelHeading = ctx.host.querySelector('#panel-content h2')!
      expect(dom.doc.activeElement).toBe(panelHeading)

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      panelHeading.dispatchEvent(esc)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(dom.doc.activeElement).toBe(hitButton)
      expect(dom.doc.activeElement?.isConnected).toBe(true)
    } finally {
      await ctx.close()
    }
  })

  it('falls back to the search input when closing a pre-opened panel while search stays open', async () => {
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}?panel=topics`,
    })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const panelHeading = ctx.host.querySelector('#panel-content h2')!
      panelHeading.focus()
      expect(dom.doc.activeElement).toBe(panelHeading)

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      panelHeading.dispatchEvent(esc)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(dom.doc.activeElement).toBe(input)
      expect(dom.doc.activeElement?.isConnected).toBe(true)
    } finally {
      await ctx.close()
    }
  })

  it('announces production unavailable search and unopenable hits through the existing page live region without adding new live regions', async () => {
    const prodAnnouncements: string[] = []
    const prodCtx = await mountSearchWorkspace({
      searchSource: createDefaultSearchSource(ORG_ID, { isDev: false }),
      onannounce: (msg) => prodAnnouncements.push(msg),
    })
    try {
      const form = prodCtx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      expect(dom.doc.activeElement).toBe(input)
      expect(prodCtx.host.textContent).toContain('メッセージ検索は現在準備中です。')
      expect(prodAnnouncements).toContain('メッセージ検索は現在準備中です。')
      expect(queryAll(prodCtx.host, '#main-content [role="status"]')).toHaveLength(0)
    } finally {
      await prodCtx.close()
    }

    const mockAnnouncements: string[] = []
    const mockCtx = await mountSearchWorkspace({
      onannounce: (msg) => mockAnnouncements.push(msg),
    })
    try {
      const form = mockCtx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const hitButton = mockCtx.host.querySelector('#main-content ol button')!
      hitButton.click()
      await settle()

      expect(dom.doc.activeElement).toBe(hitButton)
      expect(mockCtx.host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('開けません')
      expect(mockAnnouncements.some((msg) => msg.includes('開けません'))).toBe(true)
      expect(queryAll(mockCtx.host, '#main-content [role="status"]')).toHaveLength(0)
    } finally {
      await mockCtx.close()
    }
  })

  it('rejects a hit with a listed Channel and a missing Topic, keeping search open with an announced notice', async () => {
    const announcements: string[] = []
    const missingTopicId = '00000000-0000-4000-8000-000000000999'
    const ctx = await mountSearchWorkspace({
      onannounce: (msg) => announcements.push(msg),
      searchSource: createMockSearchSource({
        items: [
          {
            messageId: 'msg-missing-topic',
            channelId: CH_ID,
            topicId: missingTopicId,
            replyRootId: null,
            context: {
              kind: 'channel',
              channelId: CH_ID,
              channelName: 'general',
              topicId: missingTopicId,
              topicName: '存在しないトピック',
            },
            authorName: '田中 美咲',
            authorActive: true,
            createdAt: new Date().toISOString(),
            excerpt: '存在しないトピックの検索ヒット',
          },
        ],
      }),
    })
    try {
      const routeBefore = ctx.navigation.get().target
      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.value = '存在しないトピック'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const hitButton = ctx.host.querySelector('#main-content ol button')!
      hitButton.click()
      await settle()

      expect(ctx.navigation.get().target).toEqual(routeBefore)
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(ctx.host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('開けません')
      expect(announcements.some((msg) => msg.includes('開けません'))).toBe(true)
    } finally {
      await ctx.close()
    }
  })
})
