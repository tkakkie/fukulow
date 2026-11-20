import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type { ReplyChainPage, Result } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { repliesAdapter } from './replies.svelte'
import ReplyPanel from './ReplyPanel.svelte'
import { reply, replyClient, root } from './reply-test-helpers'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'
import { windowClient } from './message-window-test-helpers'
import { replyPage } from './topic-test-helpers'
import { buttonsByText, installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('ReplyPanel states, paging, focus and scroll', () => {
  it('keeps an unknown descendant Reply visible with retry and discard after its parent body is evicted', async () => {
    const c = replyClient(); await c.boot(); c.event(reply(2))
    await c.replies.open('A', reply(2))
    c.sendMessage.mockResolvedValue({ ok: false, kind: 'network' })
    const composer = c.sync.getTimeline('A').reply('id1')
    composer.setDraft('親が消えても残る返信'); await composer.submit('id2')
    await c.replies.open('A', root())
    c.listReplyChain.mockResolvedValue(ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0,  root_id: 'id1', messages: [], has_more: false })))
    await c.replies.loadMore('A')
    const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
    const instance = mount(ReplyPanel, { target: host as unknown as Element, props: {
      channel: syncAdapter(c.sync).channel('A'), replies: repliesAdapter(c.replies, 'A'),
      channelId: 'A', anchorMessageId: 'id1', resolvedAnchor: root(), selfId: 'me',
    } })
    await settle(); flushSync()
    for (let seq = 3; seq <= 500; seq++) c.event(reply(seq))
    await settle(); flushSync()
    expect(c.replies.get('A').messages.some(m => m.id === 'id2')).toBe(false)
    const scroll = host.querySelector('.reply-panel__scroll')!
    scroll.clientHeight = 600; scroll.scrollHeight = 23316; scroll.scrollTop = 22716
    scroll.dispatchEvent(new MiniDomEvent('scroll')); await settle(); flushSync()
    expect(host.textContent).toContain('親が消えても残る返信')
    expect(buttonsByText(host, '再送する')).toHaveLength(1)
    buttonsByText(host, '再送する')[0].click(); await settle(); flushSync()
    expect(c.sendMessage).toHaveBeenCalledTimes(2)
    buttonsByText(host, '破棄')[0].click(); await settle(); flushSync()
    expect(c.sync.get().channels.A.pending).toHaveLength(0)
    expect(host.textContent).not.toContain('親が消えても残る返信')
    await unmount(instance); await c.sync.close()
  })


  it('opens the Reply chain panel from main timeline and Topic view, manages focus (Reply Composer, opener return, user focus preservation, keyboard ↑/R/Esc), and supports phone level', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'タイムライン親メッセージ' }
    const m2 = { ...record(2, 'c1'), body: 'タイムライン2件目' }
    const tm1 = { ...record(3, 'c1'), topic_id: 't-1', body: 'トピック内メッセージ' }
    const r1 = { ...record(4, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '既存の返信1' }
    const tr1 = { ...record(5, 'c1'), topic_id: 't-1', reply_to: tm1.id, reply_root_id: tm1.id, body: 'トピック内への返信1' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'message', message: m2 },
        {
          kind: 'topic',
          topic: {
            mention_unread_count: 0,
            id: 't-1',
            name: '設計相談',
            first_seq: 3,
            last_seq: 3,
            message_count: 1,
            latest_message: tm1,
            read_seq: 0,
            unread_count: 0,
          },
        },
      ],
    })
    net.topicSummaries['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 3,
      topic: {
        mention_unread_count: 0,
        id: 't-1',
        name: '設計相談',
        first_seq: 3,
        last_seq: 3,
        message_count: 1,
        latest_message: tm1,
        read_seq: 0,
        unread_count: 0,
      },
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([tm1]).at(-1)?.created_seq ?? 0,  messages: [tm1], has_more: false })
    net.replyChains[`c1:${m1.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1, r1]).at(-1)?.created_seq ?? 0,
      root_id: m1.id,
      messages: [m1, r1],
      has_more: false,
    }))
    net.replyChains[`c1:${m2.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m2]).at(-1)?.created_seq ?? 0,
      root_id: m2.id,
      messages: [m2],
      has_more: false,
    }))
    net.replyChains[`c1:${tm1.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([tm1, tr1]).at(-1)?.created_seq ?? 0,
      root_id: tm1.id,
      messages: [tm1, tr1],
      has_more: false,
    }))

    net.replyCountPages.c1 = { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 5, counts: [m1, m2, tm1].map(m => ({ message_id: m.id, root_id: m.id, reply_count: m.id === m2.id ? 0 : 1 })) }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      get innerWidth() {
        return dom.win.innerWidth
      },
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // 1. Open Reply chain panel from main timeline by clicking 返信
    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    const m1ReplyBtn = buttonsByText(m1Row, '返信 1件›')[0]
    expect(m1ReplyBtn).toBeDefined()
    m1ReplyBtn.focus()
    m1ReplyBtn.click()
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')
    expect(panel).not.toBeNull()
    expect(panel!.tagName.toLowerCase()).toBe('aside')
    expect(panel!.getAttribute('aria-label')).toBe('返信のつながり')
    expect(panel!.querySelector('h2')?.textContent).toBe('返信のつながり')
    expect(panel!.textContent).toContain('タイムライン親メッセージ')
    expect(panel!.textContent).toContain('既存の返信1')
    // Only 1 listReplyChain request (navigationTargets did not duplicate it)
    expect(net.replyHistory.filter((h) => h.anchor === m1.id)).toHaveLength(1)
    // Reply count updated on m1 row in main timeline
    expect(buttonsByText(m1Row, '返信 1件›')).toHaveLength(1)
    // Focus moved to the Reply Composer
    const replyTextarea = panel!.querySelector('textarea')!
    expect(dom.doc.activeElement).toBe(replyTextarea)

    // 2. Closing via Escape returns focus to the opener button
    const escEvent = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    escEvent.key = 'Escape'
    dom.win.dispatchEvent(escEvent)
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).toBeNull()
    expect(dom.doc.activeElement).toBe(m1ReplyBtn)

    // 3. Keyboard path: ArrowUp from empty main Composer -> latest row -> ArrowUp -> R opens Reply panel -> Escape returns to row -> Escape returns to main Composer
    const mainTextarea = host.querySelector('#main-content textarea')!
    mainTextarea.focus()
    const arrowUpComposer = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    arrowUpComposer.key = 'ArrowUp'
    mainTextarea.dispatchEvent(arrowUpComposer)
    flushSync()

    const m2Article = host.querySelector(`#main-content [data-message-id="${m2.id}"] .ui-message-row`)!
    const m1Article = host.querySelector(`#main-content [data-message-id="${m1.id}"] .ui-message-row`)!
    expect(dom.doc.activeElement).toBe(m2Article)

    const arrowUpRow = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    arrowUpRow.key = 'ArrowUp'
    m2Article.dispatchEvent(arrowUpRow)
    flushSync()
    expect(dom.doc.activeElement).toBe(m1Article)

    const keyR = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    keyR.key = 'r'
    m1Article.dispatchEvent(keyR)
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).not.toBeNull()
    expect(dom.doc.activeElement).toBe(host.querySelector('#panel-content textarea'))

    // Close panel with × button -> returns focus to m1Article (the keyboard opener)
    const closeBtn = queryAll(host, '#panel-content button').find(
      (b) => b.getAttribute('aria-label') === 'パネルを閉じる(Esc)',
    )!
    closeBtn.click()
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).toBeNull()
    expect(dom.doc.activeElement).toBe(m1Article)

    // Escape on focused Message row when panel is closed returns focus to main Composer
    const escToComposer = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    escToComposer.key = 'Escape'
    dom.win.dispatchEvent(escToComposer)
    flushSync()
    expect(dom.doc.activeElement).toBe(mainTextarea)

    // 4. User focus moves are never overridden when opening the Reply panel
    const railChannelBtn = queryAll(host, 'button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
    const m2ReplyBtn = buttonsByText(
      host.querySelector(`#main-content [data-message-id="${m2.id}"]`)!,
      '返信',
    )[0]
    m2ReplyBtn.focus()
    m2ReplyBtn.click()
    flushSync()
    railChannelBtn.focus()
    await settle()
    flushSync()
    expect(dom.doc.activeElement).toBe(railChannelBtn)

    // Close panel before testing Topic view; verify tabs mode keeps complementary landmark name 詳細パネル
    navigation.navigate({ type: 'tab', tab: 'overview' })
    flushSync()
    expect(host.querySelector('aside#panel-content')?.getAttribute('aria-label')).toBe('詳細パネル')
    navigation.navigate({ type: 'close' })
    flushSync()
    await settle()
    flushSync()

    // 5. Open Reply chain from a Topic view (and check phone width < 600px level switching)
    dom.win.innerWidth = 375
    dom.win.dispatchEvent(new MiniDomEvent('resize'))
    navigation.navigate({ type: 'topic', topicId: 't-1', phone: true })
    flushSync()
    await settle()
    flushSync()

    const tm1Row = host.querySelector(`#main-content [data-message-id="${tm1.id}"]`)!
    const tm1ReplyBtn = buttonsByText(tm1Row, '返信 1件›')[0]
    tm1ReplyBtn.focus()
    tm1ReplyBtn.click()
    flushSync()
    await settle()
    flushSync()

    const workspaceEl = host.querySelector('.workspace')!
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('panel')
    const topicReplyPanel = host.querySelector('#panel-content')!
    expect(topicReplyPanel.textContent).toContain('トピック内メッセージ')
    expect(topicReplyPanel.textContent).toContain('トピック内への返信1')
    expect(dom.doc.activeElement).toBe(topicReplyPanel.querySelector('textarea'))

    // Phone back button ‹ in Panel header closes the panel and returns focus to tm1ReplyBtn in TopicView
    const mobileBackBtn = queryAll(topicReplyPanel, 'button').find(
      (b) => b.getAttribute('aria-label') === '前の表示に戻る',
    )!
    mobileBackBtn.click()
    flushSync()
    await settle()
    flushSync()
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('view')
    expect(host.querySelector('#panel-content')).toBeNull()
    expect(dom.doc.activeElement).toBe(tm1ReplyBtn)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('supports Reply chain paging (さらに返信を読み込む), live reply updates, and Reply Composer send/retry/restore/discard without late async focus', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'ルートメッセージ' }
    const r1 = { ...record(2, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '返信ページ1' }
    const r2 = { ...record(3, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '返信ページ2' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      has_more: false,
      items: [{ kind: 'message', message: m1 }],
    })
    net.replyChains[`c1:${m1.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1, r1]).at(-1)?.created_seq ?? 0,
      root_id: m1.id,
      messages: [m1, r1],
      has_more: true,
    }))

    net.replyCountPages.c1 = { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 3, counts: [{ message_id: m1.id, root_id: m1.id, reply_count: 2 }] }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // Open Reply panel for m1
    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    m1Row.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('ルートメッセージ')
    expect(panel.textContent).toContain('返信ページ1')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(1)

    // 1. Paging trigger: clicking さらに返信を読み込む fetches after_seq: 2 and appends r2
    net.replyChains[`c1:${m1.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([r2]).at(-1)?.created_seq ?? 0,
      root_id: m1.id,
      messages: [r2],
      has_more: false,
    }))
    buttonsByText(panel, 'さらに返信を読み込む')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(net.replyHistory.at(-1)).toEqual({
      channel: 'c1',
      anchor: m1.id,
      query: {as_of_seq: 2, history_generation: '00000000-0000-4000-8000-000000000515', after_seq: 2 },
    })
    expect(panel.textContent).toContain('返信ページ2')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(0)

    // 2. Live update: a new reply arriving on the stream appears in the panel immediately
    const liveReply = { ...record(4, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: 'ライブ到着の返信' }
    net.event({ type: 'message', kind: 'create', seq: (liveReply).created_seq, message: liveReply })
    await settle()
    flushSync()
    expect(panel.textContent).toContain('ライブ到着の返信')
    expect(buttonsByText(m1Row, '返信 3件›')).toHaveLength(1)

    // 3. Send a reply from the Reply panel Composer; focus stays in Reply Composer synchronously and never steals focus on async settle
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'パネルからの返信送信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const sendBtn = buttonsByText(panel, '送信')[0]
    sendBtn.click()
    flushSync()
    expect(dom.doc.activeElement).toBe(replyTextarea)
    expect(replyTextarea.value).toBe('')
    expect(panel.textContent).toContain('パネルからの返信送信')
    expect(panel.textContent).toContain('送信中…')

    // User moves focus to main Composer while send is in flight
    const mainTextarea = host.querySelector('#main-content textarea')!
    mainTextarea.focus()
    expect(dom.doc.activeElement).toBe(mainTextarea)

    await settle()
    expect(net.sends[0].body).toMatchObject({
      body: 'パネルからの返信送信',
      reply_to: m1.id,
    })
    expect(net.sends[0].body.topic_name).toBeUndefined()
    const sentMsg = {
      ...record(5, 'c1'),
      sender: 'me',
      client_message_id: net.sends[0].body.client_message_id,
      body: 'パネルからの返信送信',
      reply_to: m1.id,
      reply_root_id: m1.id,
    }
    net.sends[0].resolve(ok(sentMsg))
    net.event({ type: 'message', kind: 'create', seq: (sentMsg).created_seq, message: sentMsg })
    await settle()
    flushSync()

    // Focus remains on mainTextarea (no late async focus steal)
    expect(dom.doc.activeElement).toBe(mainTextarea)
    expect(panel.textContent).not.toContain('送信中…')
    expect(panel.textContent).toContain('パネルからの返信送信')

    // 4. Refused send in panel: 編集して送り直す with non-empty draft opens confirmation Dialog
    replyTextarea.value = '失敗する返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await settle()
    flushSync()

    expect(buttonsByText(panel, '編集して送り直す')).toHaveLength(1)
    replyTextarea.value = '編集中の一時下書き'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    buttonsByText(panel, '編集して送り直す')[0].click()
    flushSync()
    const dialog = panel.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    buttonsByText(dialog, '置き換える')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(replyTextarea.value).toBe('失敗する返信')
    expect(dom.doc.activeElement).toBe(replyTextarea)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('handles Reply panel load error, 404 unavailable, and C9/C10 states (preserving chain messages, draft, and failed pending 破棄)', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'C9確認用ルート' }
    const r1 = { ...record(2, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: 'C9確認用返信' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      has_more: false,
      items: [{ kind: 'message', message: m1 }],
    })
    net.replyChains[`c1:${m1.id}`] = { ok: false, kind: 'network' }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
        organizations: [
          {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          {
            organization_id: 'org-2',
            name: 'Org 2',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        ],
        onselectorganization: () => {},
      },
    })
    await settle()
    flushSync()

    // 0. 404 reply_chain_not_found on URL hint shows unavailable EmptyState and disables Reply Composer while Channel stays usable
    navigation.navigate({ type: 'reply', messageId: 'missing-reply-id' })
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('この返信のつながりは利用できません。')
    expect(panel.textContent).not.toContain('このチャンネルは利用できません。')
    expect(panel.querySelector('textarea')!.disabled).toBe(true)
    expect(host.querySelector('#main-content textarea')!.disabled).toBe(false)

    // 1. Network error on opening Reply chain shows StatusBanner + 再試行
    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    m1Row.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(panel.textContent).toContain('返信のつながりを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    expect(buttonsByText(panel, '再試行')).toHaveLength(1)

    // Retry succeeds
    net.replyChains[`c1:${m1.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1, r1]).at(-1)?.created_seq ?? 0,
      root_id: m1.id,
      messages: [m1, r1],
      has_more: false,
    }))
    buttonsByText(panel, '再試行')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(panel.textContent).toContain('C9確認用ルート')
    expect(panel.textContent).toContain('C9確認用返信')

    // 2. Start an in-flight reply send and type a new Reply Composer draft, then trigger C9 channel_access_lost
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'C9直前の送信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()

    replyTextarea.value = 'C9でも失わない返信下書き'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    net.event({ type: 'channel_access_lost', channel_id: 'c1' })
    await settle()
    flushSync()

    // Panel shows C9 StatusBanner, retains loaded chain messages & draft, disables Composer, and shows only 破棄 on failed pending reply
    expect(panel.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(panel, 'チャンネル一覧へ')).toHaveLength(1)
    expect(panel.textContent).toContain('C9確認用ルート')
    expect(panel.textContent).toContain('C9確認用返信')
    expect(panel.textContent).toContain('C9直前の送信')
    expect(replyTextarea.value).toBe('C9でも失わない返信下書き')
    expect(replyTextarea.disabled).toBe(true)
    expect(buttonsByText(panel, '再送する')).toHaveLength(0)
    expect(buttonsByText(panel, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(panel, '破棄')).toHaveLength(1)

    // Clicking 破棄 removes the failed reply
    buttonsByText(panel, '破棄')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(buttonsByText(panel, '破棄')).toHaveLength(0)
    expect(panel.textContent).not.toContain('C9直前の送信')

    // 3. Re-select c1 (Workspace automatically re-opens the active Reply chain), start an in-flight send, and trigger C10 organization_unavailable (4003 close)
    rawSession.channels.select('c1')
    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()
    await settle()
    flushSync()

    const c10Textarea = panel.querySelector('textarea')!
    c10Textarea.value = 'C10直前の送信'
    c10Textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()

    c10Textarea.value = 'C10でも失わない返信下書き'
    c10Textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    net.socket.onClose(4003)
    await settle()
    flushSync()

    expect(panel.textContent).toContain('この組織は利用できません。')
    expect(buttonsByText(panel, 'メンバー資格を再確認')).toHaveLength(1)
    expect(buttonsByText(panel, '組織を切り替える')).toHaveLength(1)
    expect(buttonsByText(panel, 'チャンネル一覧へ')).toHaveLength(0)
    expect(panel.textContent).toContain('C9確認用ルート')
    expect(panel.textContent).toContain('C9確認用返信')
    expect(panel.textContent).toContain('C10直前の送信')
    expect(c10Textarea.value).toBe('C10でも失わない返信下書き')
    expect(c10Textarea.disabled).toBe(true)
    expect(buttonsByText(panel, '再送する')).toHaveLength(0)
    expect(buttonsByText(panel, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(panel, '破棄')).toHaveLength(1)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('resolves a cold descendant reply URL (?panel=reply:<descendant-id>), renders the chain, pages with さらに返信を読み込む, and sends a reply', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    // mRoot and rDescendant1/rDescendant2 are outside the loaded main timeline window (which only has mRecent at seq 10)
    const mRoot = { ...record(1, 'c1'), id: 'cold-root', body: '未ロードのルートメッセージ' }
    const rDesc1 = { ...record(2, 'c1'), id: 'cold-desc-1', reply_to: mRoot.id, reply_root_id: mRoot.id, body: '未ロードの子孫返信1' }
    const rDesc2 = { ...record(3, 'c1'), id: 'cold-desc-2', reply_to: rDesc1.id, reply_root_id: mRoot.id, body: '未ロードの子孫返信2' }
    const mRecent = { ...record(10, 'c1'), id: 'recent-10', body: '最新タイムラインメッセージ' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 10,
      has_more: true,
      items: [{ kind: 'message', message: mRecent }],
    })
    // Cold URL lookup for rDesc2 with limit: 1 returns the root message (mRoot)
    net.replyChains[`c1:${rDesc2.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([mRoot]).at(-1)?.created_seq ?? 0,
      root_id: mRoot.id,
      messages: [mRoot],
      has_more: true,
    }))
    // Opening the chain from mRoot returns page 1 ([mRoot, rDesc1], has_more: true), then page 2 ([rDesc2], has_more: false)
    net.replyChains[`c1:${mRoot.id}:0`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([mRoot, rDesc1]).at(-1)?.created_seq ?? 0,
      root_id: mRoot.id,
      messages: [mRoot, rDesc1],
      has_more: true,
    }))
    net.replyChains[`c1:${mRoot.id}:2`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([rDesc2]).at(-1)?.created_seq ?? 0,
      root_id: mRoot.id,
      messages: [rDesc2],
      has_more: false,
    }))

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 10)
    await settle()

    let href = `/o/org-1/c/c1?panel=reply:${rDesc2.id}`
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('未ロードのルートメッセージ')
    expect(panel.textContent).toContain('未ロードの子孫返信1')
    expect(panel.textContent).not.toContain('未ロードの子孫返信2')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(1)

    // Send a reply BEFORE paging in rDesc2: reply_to must be the requested descendant (rDesc2.id), not the root
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'ページング前の子孫URLからの返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(buttonsByText(panel, '送信')[0].disabled).toBe(false)
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(net.sends).toHaveLength(1)
    const firstClientMsgId = net.sends[0].body.client_message_id
    expect(net.sends[0].body).toMatchObject({
      body: 'ページング前の子孫URLからの返信',
      reply_to: rDesc2.id,
    })

    // Network failure on the cold descendant send renders 再送する, and clicking 再送する retries before rDesc2 is paged into w.messages
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await settle()
    flushSync()
    expect(buttonsByText(panel, '再送する')).toHaveLength(1)
    buttonsByText(panel, '再送する')[0].click()
    flushSync()
    await settle()
    expect(net.sends).toHaveLength(2)
    expect(net.sends[1].body).toEqual({ history_generation: '00000000-0000-4000-8000-000000000515',
      client_message_id: firstClientMsgId,
      body: 'ページング前の子孫URLからの返信',
      reply_to: rDesc2.id,
    })
    net.sends[1].resolve(
      ok({
        ...record(11, 'c1'),
        id: 'cold-desc-reply-ack',
        sender: 'me',
        client_message_id: firstClientMsgId,
        body: 'ページング前の子孫URLからの返信',
        reply_to: rDesc2.id,
        reply_root_id: mRoot.id,
      }),
    )
    await settle()
    flushSync()

    // Page in rDesc2 with さらに返信を読み込む
    buttonsByText(panel, 'さらに返信を読み込む')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(panel.textContent).toContain('未ロードの子孫返信2')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(0)

    // Send another reply after paging in rDesc2: reply_to remains rDesc2.id
    replyTextarea.value = '子孫URLからの返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(buttonsByText(panel, '送信')[0].disabled).toBe(false)
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(net.sends).toHaveLength(3)
    expect(net.sends[2].body).toMatchObject({
      body: '子孫URLからの返信',
      reply_to: rDesc2.id,
    })

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })


  it('renders 返信 / 返信 n件› on confirmed rows in ReplyPanel and opens a reply row chain via button click or Enter/R (replacing the current one and focusing its Reply Composer while preserving the root row and roving tabindex)', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const mRoot = { ...record(1, 'c1'), id: 'm-root', body: 'ルート本文' }
    const r1 = { ...record(2, 'c1'), id: 'r-1', reply_to: mRoot.id, reply_root_id: mRoot.id, body: '子返信1' }
    const r2 = { ...record(3, 'c1'), id: 'r-2', reply_to: r1.id, reply_root_id: mRoot.id, body: '孫返信2' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      has_more: false,
      items: [{ kind: 'message', message: mRoot }],
    })
    const chainPayload = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([mRoot, r1, r2]).at(-1)?.created_seq ?? 0,
      root_id: mRoot.id,
      messages: [mRoot, r1, r2],
      has_more: false,
    }))
    net.replyChains[`c1:${mRoot.id}`] = chainPayload
    net.replyChains[`c1:${r1.id}`] = chainPayload
    net.replyChains[`c1:${r2.id}`] = chainPayload

    net.replyCountPages.c1 = { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 3, counts: [{ message_id: mRoot.id, root_id: mRoot.id, reply_count: 2 }] }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const pushSpy = vi.fn()
    const replaceSpy = vi.fn()
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          pushSpy(url)
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          replaceSpy(url)
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // Open mRoot's Reply chain from main timeline (pushState)
    const mRootMainRow = host.querySelector(`#main-content [data-message-id="${mRoot.id}"]`)!
    mRootMainRow.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe(`/o/org-1/c/c1?panel=reply:${mRoot.id}`)
    expect(pushSpy).toHaveBeenCalledTimes(1)
    replaceSpy.mockClear()

    const panel = host.querySelector('#panel-content')!
    const rootItem = panel.querySelector(`[data-message-id="${mRoot.id}"]`)!
    const r1Item = panel.querySelector(`[data-message-id="${r1.id}"]`)!
    const r2Item = panel.querySelector(`[data-message-id="${r2.id}"]`)!

    // Root row keeps .reply-panel__item--root, and confirmed rows show replyCount / 返信 actions
    expect(rootItem.classList.contains('reply-panel__item--root')).toBe(true)
    expect(r1Item.classList.contains('reply-panel__item--root')).toBe(false)
    expect(buttonsByText(rootItem, '返信 2件›')).toHaveLength(1)
    expect(buttonsByText(r1Item, '返信 2件›')).toHaveLength(1)
    expect(buttonsByText(r2Item, '返信 2件›')).toHaveLength(1)

    // Roving tabindex defaults to the latest row (r2)
    const panelRows = queryAll(panel, '.ui-message-row[data-focusable="true"]')
    expect(panelRows).toHaveLength(3)
    expect(panelRows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])

    // 1. ArrowUp from empty Reply Composer focuses latest row (r2), ArrowUp moves to r1, and pressing R opens r1's chain (replaceState) and focuses Reply Composer
    const replyTextarea = panel.querySelector('textarea')!
    expect(dom.doc.activeElement).toBe(replyTextarea)
    const upFromComposer = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    upFromComposer.key = 'ArrowUp'
    replyTextarea.dispatchEvent(upFromComposer)
    flushSync()
    expect(dom.doc.activeElement).toBe(panelRows[2])

    const upToR1 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    upToR1.key = 'ArrowUp'
    panelRows[2].dispatchEvent(upToR1)
    flushSync()
    expect(dom.doc.activeElement).toBe(panelRows[1])
    expect(panelRows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])

    const keyR = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    keyR.key = 'r'
    panelRows[1].dispatchEvent(keyR)
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe(`/o/org-1/c/c1?panel=reply:${r1.id}`)
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenCalledWith(`/o/org-1/c/c1?panel=reply:${r1.id}`)
    expect(rawSession.replies.get('c1').anchor?.id).toBe(r1.id)
    expect(dom.doc.activeElement).toBe(panel.querySelector('textarea'))
    expect(panel.querySelector(`[data-message-id="${mRoot.id}"]`)!.classList.contains('reply-panel__item--root')).toBe(true)

    // Submitting now sends reply_to: r1.id
    replyTextarea.value = 'r1への返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(net.sends.at(-1)?.body).toMatchObject({
      body: 'r1への返信',
      reply_to: r1.id,
    })

    // 2. Clicking the inline 返信 button on r2 replaces the chain with r2.id and focuses Reply Composer
    const r2ReplyBtn = buttonsByText(panel.querySelector(`[data-message-id="${r2.id}"]`)!, '返信 2件›')[0]
    r2ReplyBtn.focus()
    r2ReplyBtn.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe(`/o/org-1/c/c1?panel=reply:${r2.id}`)
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenLastCalledWith(`/o/org-1/c/c1?panel=reply:${r2.id}`)
    expect(rawSession.replies.get('c1').anchor?.id).toBe(r2.id)
    expect(dom.doc.activeElement).toBe(panel.querySelector('textarea'))

    // URL navigation has no row-click handler to update the controller's anchor.
    const reads = net.replyHistory.length
    navigation.navigate({ type: 'reply', messageId: r1.id })
    flushSync(); await settle(); flushSync()
    expect(rawSession.replies.get('c1').anchor?.id).toBe(r1.id)
    expect(net.replyHistory).toHaveLength(reads)
    // Rendering and live eviction of that anchor's body must not reopen the chain.
    for (let seq = 4; seq <= 254; seq++) net.event({ type: 'message', kind: 'create', seq: ({
      ...record(seq, 'c1'), sender: 'other', reply_to: mRoot.id, reply_root_id: mRoot.id,
    }).created_seq, message: {
      ...record(seq, 'c1'), sender: 'other', reply_to: mRoot.id, reply_root_id: mRoot.id,
    } })
    await settle(); flushSync()
    expect(rawSession.replies.get('c1').messages.some(m => m.id === r1.id)).toBe(false)
    expect(rawSession.replies.get('c1').anchor?.id).toBe(r1.id)
    expect(net.replyHistory).toHaveLength(reads)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('tracks Reply panel scroll state: follows own sends and pinned live arrivals, and shows 新着 n件 ↓ when unpinned', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'スクロール検証ルート' }
    const r1 = { ...record(2, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '初期返信' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 2,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'message', message: r1 },
      ],
    })
    net.replyChains[`c1:${m1.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1, r1]).at(-1)?.created_seq ?? 0,
      root_id: m1.id,
      messages: [m1, r1],
      has_more: false,
    }))

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 2)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    m1Row.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    const scrollEl = panel.querySelector('.reply-panel__scroll')!
    scrollEl.scrollHeight = 1200
    scrollEl.clientHeight = 300
    scrollEl.scrollTop = 900

    // 1. Pinned live arrival scrolls to the new scrollHeight
    scrollEl.scrollHeight = 1300
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(3, 'c1'), sender: 'other', reply_to: m1.id, reply_root_id: m1.id, body: 'ピン留め中のライブ返信' }).created_seq,
      message: { ...record(3, 'c1'), sender: 'other', reply_to: m1.id, reply_root_id: m1.id, body: 'ピン留め中のライブ返信' },
    })
    await settle()
    flushSync()
    expect(scrollEl.scrollTop).toBe(1300)
    expect(buttonsByText(panel, '新着 1件 ↓')).toHaveLength(0)

    // 2. Scroll up (unpinned): live arrival from another user does not move scrollTop and shows 新着 1件 ↓
    scrollEl.scrollTop = 100
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()

    scrollEl.scrollHeight = 1400
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(4, 'c1'), sender: 'other', reply_to: m1.id, reply_root_id: m1.id, body: '未ピン中のライブ返信' }).created_seq,
      message: { ...record(4, 'c1'), sender: 'other', reply_to: m1.id, reply_root_id: m1.id, body: '未ピン中のライブ返信' },
    })
    await settle()
    flushSync()
    expect(scrollEl.scrollTop).toBe(100)
    expect(buttonsByText(panel, '新着 1件 ↓')).toHaveLength(1)

    // Clicking 新着 1件 ↓ scrolls to bottom and hides the button
    buttonsByText(panel, '新着 1件 ↓')[0].click()
    flushSync()
    expect(scrollEl.scrollTop).toBe(1400)
    expect(buttonsByText(panel, '新着 1件 ↓')).toHaveLength(0)

    // 3. Scroll up again and send own reply -> scrolls to bottom
    scrollEl.scrollTop = 50
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()

    scrollEl.scrollHeight = 1500
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = '自分の返信送信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(scrollEl.scrollTop).toBe(1500)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('preserves a Reply Composer draft typed while a Topic reply URL is still resolving', async () => {
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    let resolveChainLookup!: (result: Result<ReplyChainPage>) => void
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      repliesApi: {
        async listReplyChain(channelId, anchor, query) {
          if (query?.limit === 1 && resolveChainLookup) {
            return new Promise((r) => {
              resolveChainLookup = r
            })
          }
          return baseOptions.repliesApi!.listReplyChain(channelId, anchor, query)
        },
      },
    })
    resolveChainLookup = () => {}
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const topicRoot = { ...record(1, 'c1'), id: 'topic-root-1', topic_id: 't-1', body: 'トピック内ルート' }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      has_more: false,
      items: [],
    })
    net.replyChains[`c1:${topicRoot.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([topicRoot]).at(-1)?.created_seq ?? 0,
      root_id: topicRoot.id,
      messages: [topicRoot],
      has_more: false,
    }))

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    let href = `/o/org-1/c/c1?panel=reply:${topicRoot.id}`
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // While the reply URL lookup is still delayed, user types a draft into the Reply Composer
    const panel = host.querySelector('#panel-content')!
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'URL解決中に入力した返信下書き'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(replyTextarea.value).toBe('URL解決中に入力した返信下書き')

    // Now the lookup resolves with topic_id: 't-1'
    resolveChainLookup(
      ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([topicRoot]).at(-1)?.created_seq ?? 0,
        root_id: topicRoot.id,
        messages: [topicRoot],
        has_more: false,
      })),
    )
    await settle()
    await settle()
    flushSync()

    // Draft is preserved under the resolved (topicRoot.id, 't-1') target and cleared from the temporary (topicRoot.id, null) target
    expect(replyTextarea.value).toBe('URL解決中に入力した返信下書き')
    expect(sessionModel.sync.channel('c1').reply(topicRoot.id, 't-1').composer.draft).toBe('URL解決中に入力した返信下書き')
    expect(sessionModel.sync.channel('c1').reply(topicRoot.id, null).composer.draft).toBe('')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('never offers or confirms restore for a retryable failed Reply send while non-retryable failures still restore', async () => {
    const c = replyClient()
    await c.boot()
    await c.replies.open('A', root())

    const ch = syncAdapter(c.sync).channel('A')
    const rc = ch.reply('id1', null)

    // 1. A failed retryable send (network error) and a failed non-retryable send (400 refusal) in the same chain
    c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'network' })
    rc.setDraft('再送可能な失敗返信')
    await rc.submit('id1')

    c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    rc.setDraft('拒否された失敗返信')
    await rc.submit('id1')

    rc.setDraft('入力中の返信下書き')
    await settle()

    const retryablePending = ch.timeline.pending.find((p) => p.body === '再送可能な失敗返信')!
    const refusedPending = ch.timeline.pending.find((p) => p.body === '拒否された失敗返信')!
    expect(retryablePending.status).toBe('failed')
    expect(retryablePending.retryable).toBe(true)
    expect(refusedPending.status).toBe('failed')
    expect(refusedPending.retryable).toBe(false)

    // Override retryable dynamically for the canRestore guard sub-check without mutating sync internals
    let forceRetryableId = $state<string | null>(null)
    const wrappedChannel = Object.create(ch, {
      timeline: {
        get() {
          const base = ch.timeline
          if (!forceRetryableId) return base
          return {
            ...base,
            pending: base.pending.map((p) =>
              p.clientMessageId === forceRetryableId ? { ...p, retryable: true } : p,
            ),
          }
        },
      },
    }) as typeof ch

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(ReplyPanel, {
      target: host as unknown as Element,
      props: {
        channel: wrappedChannel,
        replies: repliesAdapter(c.replies, 'A'),
        channelId: 'A',
        anchorMessageId: 'id1',
        resolvedAnchor: root(),
        selfId: 'me',
      },
    })
    try {
      await settle()
      flushSync()

      const textarea = host.querySelector('textarea')!
      expect(textarea.value).toBe('入力中の返信下書き')

      // Retryable failed send offers only 再送する / 破棄 (never 編集して送り直す)
      const retryableRow = queryAll(host, '.reply-panel__item').find((el) =>
        el.textContent.includes('再送可能な失敗返信'),
      )!
      expect(retryableRow).toBeDefined()
      expect(retryableRow.textContent).toContain('送信を確認できませんでした。')
      expect(buttonsByText(retryableRow, '再送する')).toHaveLength(1)
      expect(buttonsByText(retryableRow, '編集して送り直す')).toHaveLength(0)
      expect(buttonsByText(retryableRow, '破棄')).toHaveLength(1)
      expect(rc.restore(retryablePending.clientMessageId)).toBe(false)
      expect(rc.composer.draft).toBe('入力中の返信下書き')

      // Non-retryable failed send offers 編集して送り直す (never 再送する)
      const refusedRow = queryAll(host, '.reply-panel__item').find((el) =>
        el.textContent.includes('拒否された失敗返信'),
      )!
      expect(refusedRow).toBeDefined()
      expect(buttonsByText(refusedRow, '再送する')).toHaveLength(0)
      expect(buttonsByText(refusedRow, '編集して送り直す')).toHaveLength(1)

      // Guard in handleConfirmReplace: if the target becomes retryable before 置き換える, canRestore is false and draft is preserved
      buttonsByText(refusedRow, '編集して送り直す')[0].click()
      flushSync()
      await tick()
      const dialog = host.querySelector('[role="dialog"]')!
      expect(dialog).not.toBeNull()
      forceRetryableId = refusedPending.clientMessageId
      flushSync()
      buttonsByText(dialog, '置き換える')[0].click()
      flushSync()
      await settle()
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(rc.composer.draft).toBe('入力中の返信下書き')
      expect(textarea.value).toBe('入力中の返信下書き')
      expect(ch.timeline.pending).toHaveLength(2)

      // When the target remains non-retryable, キャンセル preserves draft and 置き換える restores it into Composer
      forceRetryableId = null
      flushSync()
      buttonsByText(refusedRow, '編集して送り直す')[0].click()
      flushSync()
      buttonsByText(host.querySelector('[role="dialog"]')!, 'キャンセル')[0].click()
      flushSync()
      expect(rc.composer.draft).toBe('入力中の返信下書き')
      expect(ch.timeline.pending).toHaveLength(2)

      buttonsByText(refusedRow, '編集して送り直す')[0].click()
      flushSync()
      buttonsByText(host.querySelector('[role="dialog"]')!, '置き換える')[0].click()
      flushSync()
      await settle()
      flushSync()

      expect(rc.composer.draft).toBe('拒否された失敗返信')
      expect(textarea.value).toBe('拒否された失敗返信')
      expect(dom.doc.activeElement).toBe(textarea)
      expect(ch.timeline.pending).toHaveLength(1)
      expect(ch.timeline.pending[0].clientMessageId).toBe(retryablePending.clientMessageId)
      expect(buttonsByText(host, '再送する')).toHaveLength(1)
      expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    } finally {
      await unmount(instance)
      await c.sync.close()
    }
  })

})
