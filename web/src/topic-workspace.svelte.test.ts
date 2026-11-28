import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type { Member, TopicSummary } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { createMembers } from './members'
import { membersAdapter } from './members.svelte'
import { createSession } from './session'
import Workspace from './Workspace.svelte'
import { buttonsByText, installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'
import {
  createTopicWorkspaceNavigation,
  createTopicWorkspaceSession,
  HISTORY_GENERATION,
  topicSummaryItem,
  topicWorkspaceOrganization,
} from './topic-workspace-test-helpers'

const dom = installMiniDom()

describe('Topic summary lines, TopicList and TopicView states', () => {
  it('renders Topic summary lines at latest activity, creates Topics from Composer, expands sidebar/panel Topic lists, and operates Topic view with isolated drafts and return focus', async () => {
    vi.useFakeTimers()
    let directory: Member[] = []
    let deactivated = false
    const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers: async () => ok({ members: directory }),
      lookupAuthors: async () => ok({ identities: [{ id: 'other', name: '田中', deactivated }] }),
      changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await memberController.load()
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const chMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'チャンネル本文1', topic_id: null }
    const topicMsg2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '仕様の初回相談', topic_id: 't-1' }
    const chMsg3 = { ...record(3, 'c1'), id: 'm-3', sender: 'other', body: 'チャンネル本文3', topic_id: null }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: chMsg1 },
        { kind: 'topic', topic: topicSummaryItem('t-1', '仕様相談', topicMsg2) },
        { kind: 'message', message: chMsg3 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([topicMsg2]).at(-1)?.created_seq ?? 0, messages: [topicMsg2], has_more: false })
    net.topicSummaries['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 3,
      topic: topicSummaryItem('t-1', '仕様相談', topicMsg2),
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general'), channel('c2', 'empty')] }))

    const announcements: string[] = []
    const { navigation, getHref } = createTopicWorkspaceNavigation('/o/org-1/c/c1', () => dom.win.innerWidth)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: topicWorkspaceOrganization(),
        selectedOrganizationId: 'org-1',
        members: membersAdapter(memberController),
        onannounce: (msg: string) => announcements.push(msg),
      },
    })
    flushSync()
    await settle()
    net.subscribed('c1', 3)
    await settle()
    flushSync()

    // 1. Main timeline shows MessageRows + TopicSummaryLine in position order [1, 2, 3]; no inline Topic MessageRow
    const mainItems = queryAll(host, '#main-content .timeline-list__item')
    expect(mainItems).toHaveLength(3)
    expect(mainItems[0].textContent).toContain('チャンネル本文1')
    expect(mainItems[1].textContent).toContain('トピック: 仕様相談')
    expect(mainItems[1].textContent).toContain('1件›')
    expect(mainItems[1].textContent).toContain('仕様の初回相談')
    expect(mainItems[2].textContent).toContain('チャンネル本文3')
    expect(queryAll(host, '#main-content .ui-message-row').map((el) => el.textContent)).toHaveLength(2)

    // Sidebar accordion expands for selected c1 showing recent Topic + すべてのトピック(1)›, while c2 has no child Topic rows
    const sidebarButtons = queryAll(host, '#channel-content .channel-list button')
    expect(sidebarButtons.map((b) => b.textContent.trim())).toEqual([
      '# general',
      '💬 仕様相談',
      'すべてのトピック(1)›',
      '# empty',
    ])

    // 2. Create a new Topic from the main Channel Composer (トピック名 + メッセージ + Enter)
    const topicInput = queryAll(host, '#main-content input').find((el) => el.getAttribute('aria-label') === 'トピック名')!
    const bodyTextarea = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    topicInput.value = 'リリース計画'
    topicInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    bodyTextarea.value = '初回のトピック投稿'
    bodyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const createdTopicMsg = {
      ...record(4, 'c1'),
      id: 'm-4',
      sender: 'me',
      client_message_id: 'me-c1',
      body: '初回のトピック投稿',
      topic_id: 't-2',
    }
    net.topicSummaries['c1:t-2'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 4,
      topic: topicSummaryItem('t-2', 'リリース計画', createdTopicMsg),
    })

    const enterEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    enterEvt.key = 'Enter'
    bodyTextarea.dispatchEvent(enterEvt)
    await settle()
    expect(net.sends).toHaveLength(1)
    expect(net.sends[0].body).toEqual({ history_generation: HISTORY_GENERATION,
      client_message_id: 'me-c1',
      body: '初回のトピック投稿',
      topic_name: 'リリース計画',
    })
    net.sends[0].resolve(ok(createdTopicMsg))
    net.event({ type: 'message', kind: 'create', seq: (createdTopicMsg).created_seq, message: createdTopicMsg })
    await settle()
    await settle()
    flushSync()

    expect(topicInput.value).toBe('')
    expect(bodyTextarea.value).toBe('')
    expect(queryAll(host, '#main-content .timeline-list__item').at(-1)!.textContent).toContain('トピック: リリース計画')

    // 3. Live message in t-1 moves its summary line to the tail (after t-2) WITHOUT triggering a live status announcement
    announcements.length = 0
    const liveTopicMsg = { ...record(5, 'c1'), id: 'm-5', sender: 'other', body: '仕様の追記です', topic_id: 't-1' }
    net.event({ type: 'message', kind: 'create', seq: (liveTopicMsg).created_seq, message: liveTopicMsg })
    await settle()
    flushSync()
    const afterMoveItems = queryAll(host, '#main-content .timeline-list__item')
    expect(afterMoveItems.at(-1)!.textContent).toContain('トピック: 仕様相談')
    expect(afterMoveItems.at(-1)!.textContent).toContain('2件›')
    expect(afterMoveItems.at(-1)!.textContent).toContain('仕様の追記です')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(announcements).toEqual([])

    // 4. Open すべてのトピック(2)› -> right panel TopicList shows both Topics and ＋ 新しいトピック focuses トピック名
    bodyTextarea.value = 'チャンネルに残す下書き'
    bodyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    net.topicLists.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 5,
      has_more: false,
      topics: [
        topicSummaryItem('t-2', 'リリース計画', createdTopicMsg),
        topicSummaryItem('t-1', '仕様相談', liveTopicMsg, { firstSeq: 2, lastSeq: 5, messageCount: 2 }),
      ],
    })

    buttonsByText(host, 'すべてのトピック(2)›')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(getHref()).toBe('/o/org-1/c/c1?panel=topics')
    const panelTopicItems = queryAll(host, '#panel-content .topic-list-panel__item')
    expect(panelTopicItems).toHaveLength(2)
    expect(panelTopicItems[0].textContent).toContain('トピック: 仕様相談')
    expect(panelTopicItems[1].textContent).toContain('トピック: リリース計画')

    buttonsByText(host, '＋ 新しいトピック')[0].click()
    flushSync()
    await tick()
    expect(dom.doc.activeElement).toBe(topicInput)

    // 5. Open Topic t-1 -> isolated Composer draft, filtered Topic messages, send in Topic, live announcement in Topic view, and return focus on チャンネルへ戻る
    const summaryBtn = host.querySelector('#main-content [data-topic-id="t-1"]')!
    summaryBtn.click()
    flushSync()
    await settle()
    flushSync()

    expect(getHref()).toBe('/o/org-1/c/c1/t/t-1?panel=topics')
    expect(host.querySelector('#main-content h1')?.textContent.trim()).toBe('仕様相談')
    expect(announcements.at(-1)).toBe('仕様相談')

    const topicComposer = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    expect(topicComposer.value).toBe('')
    expect(queryAll(host, '#main-content .topic-view__item').map((el) => el.textContent)).toHaveLength(2)

    topicComposer.value = 'トピックからの返信'
    topicComposer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    const topicForm = host.querySelector('#main-content form.composer')!
    topicForm.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(net.sends.at(-1)?.body).toEqual({ history_generation: HISTORY_GENERATION,
      client_message_id: 'me-c2',
      body: 'トピックからの返信',
      topic_name: '仕様相談',
    })
    const sentInTopic = {
      ...record(6, 'c1'),
      id: 'm-6',
      sender: 'me',
      client_message_id: 'me-c2',
      body: 'トピックからの返信',
      topic_id: 't-1',
    }
    net.sends.at(-1)!.resolve(ok(sentInTopic))
    net.event({ type: 'message', kind: 'create', seq: (sentInTopic).created_seq, message: sentInTopic })
    await settle()
    flushSync()
    expect(queryAll(host, '#main-content .topic-view__item')).toHaveLength(3)

    // Live arrival in open Topic view IS announced
    announcements.length = 0
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(7, 'c1'), id: 'm-7', sender: 'other', body: 'トピックへの新着通知', topic_id: 't-1' }).created_seq,
      message: { ...record(7, 'c1'), id: 'm-7', sender: 'other', body: 'トピックへの新着通知', topic_id: 't-1' },
    })
    await settle()
    flushSync()
    expect(announcements).toEqual([])
    await vi.advanceTimersByTimeAsync(1_999)
    expect(announcements).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    flushSync()
    expect(announcements).toEqual(['田中: トピックへの新着通知'])

    // Active Topic in panel TopicList carries aria-current="true", inactive Topics do not
    const panelButtons = queryAll(host, '#panel-content button[data-topic-id]')
    const activePanelBtn = panelButtons.find((b) => b.getAttribute('data-topic-id') === 't-1')!
    const inactivePanelBtn = panelButtons.find((b) => b.getAttribute('data-topic-id') === 't-2')!
    expect(activePanelBtn.getAttribute('aria-current')).toBe('true')
    expect(inactivePanelBtn.getAttribute('aria-current')).toBeNull()

    // Header shows # general › and a back button whose accessible name contains its visible text (WCAG 2.5.3)
    expect(host.querySelector('#main-content .main-card__crumb')?.textContent.trim()).toBe('# general ›')
    const backToChannelBtn = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    expect(backToChannelBtn).toBeDefined()
    expect(backToChannelBtn.getAttribute('aria-label')).toBeNull()
    const accessibleBtnText = queryAll(backToChannelBtn, 'span:not([aria-hidden="true"])')
      .map((el) => el.textContent.trim())
      .join('')
    expect(accessibleBtnText).toBe('チャンネルへ戻る')
    backToChannelBtn.click()
    flushSync()
    await tick()
    flushSync()

    expect(getHref()).toBe('/o/org-1/c/c1?panel=topics')
    const returnedSummary = host.querySelector('#main-content [data-topic-id="t-1"]')!
    expect(dom.doc.activeElement).toBe(returnedSummary)
    const restoredMainComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(restoredMainComposer.value).toBe('チャンネルに残す下書き')

    // Main-timeline names absent from the directory refresh both cached states on list fetch.
    deactivated = true
    await memberController.load()
    await settle()
    flushSync()
    expect(queryAll(host, '#main-content .ui-message-row__sender').some(el => el.textContent === '田中（無効）')).toBe(true)
    directory = [{ id: 'other', name: '田中', role: 'member' }]
    deactivated = false
    await memberController.load()
    await settle()
    flushSync()
    expect(queryAll(host, '#main-content .ui-message-row__sender').some(el => el.textContent === '田中')).toBe(true)
    expect(host.textContent).not.toContain('田中（無効）')

    // 6. Unknown Topic (404 topic_not_found) shows unavailable EmptyState and disables Topic Composer while Channel stays usable
    navigation.navigate({ type: 'topic', topicId: 'missing-topic', phone: false })
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#main-content')?.textContent).toContain('このトピックは利用できません。')
    const disabledComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(disabledComposer.disabled).toBe(true)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
    memberController.close()
  })

  it('keeps TopicView, Topic draft, loaded Topic history and failed Topic send 破棄 visible across C9 and C10', async () => {
    for (const loss of ['c9', 'c10'] as const) {
      const net = fakeNetwork()
      const rawSession = createSession({
        selfId: 'me',
        organizationId: 'org-1',
        onEnded: () => {},
        ...net.options('me'),
      })
      const sessionModel = createTopicWorkspaceSession(rawSession)

      const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'トピック履歴1', topic_id: 't-1' }
      const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: 'チャンネル本文2', topic_id: null }
      net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 2,
        has_more: false,
        items: [
          { kind: 'topic', topic: topicSummaryItem('t-1', '継続トピック', m1) },
          { kind: 'message', message: m2 },
        ],
      })
      net.topicMessages['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([m1]).at(-1)?.created_seq ?? 0, messages: [m1], has_more: false })
      net.topicSummaries['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 2,
        topic: topicSummaryItem('t-1', '継続トピック', m1),
      })

      net.socket.onReady()
      net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

      const { navigation } = createTopicWorkspaceNavigation('/o/org-1/c/c1/t/t-1')

      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      const instance = mount(Workspace, {
        target: host as unknown as Element,
        props: {
          navigation,
          session: sessionModel,
          organization: topicWorkspaceOrganization(),
          selectedOrganizationId: 'org-1',
          onselectorganization: () => {},
        },
      })

      await settle()
      net.subscribed('c1', 2)
      await settle()
      flushSync()

      // Send from Topic t-1 (stays in flight) and type a new Topic draft
      const topicTextarea = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
      topicTextarea.value = 'トピックから送信中だった本文'
      topicTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      host.querySelector('#main-content form.composer')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      flushSync()

      topicTextarea.value = '消えてはいけないトピック下書き'
      topicTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()

      if (loss === 'c9') {
        net.event({ type: 'channel_access_lost', channel_id: 'c1' })
      } else {
        await rawSession.sync.unavailable()
      }
      await settle()
      flushSync()

      expect(host.querySelector('#main-content .topic-view')).not.toBeNull()
      expect(host.querySelector('#main-content')?.textContent).toContain(
        loss === 'c9' ? 'このチャンネルは利用できません。' : 'この組織は利用できません。',
      )
      expect(host.querySelector('#main-content')?.textContent).toContain('トピック履歴1')
      expect(host.querySelector('#main-content')?.textContent).toContain('トピックから送信中だった本文')

      const afterTextarea = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
      expect(afterTextarea.value).toBe('消えてはいけないトピック下書き')
      expect(afterTextarea.disabled).toBe(true)

      const discardBtns = buttonsByText(host, '破棄')
      expect(discardBtns).toHaveLength(1)
      discardBtns[0].click()
      flushSync()
      await settle()
      flushSync()
      expect(host.querySelector('#main-content')?.textContent).not.toContain('トピックから送信中だった本文')

      navigation.destroy()
      await unmount(instance)
      sessionModel.close()
    }
  })

  it('recovers an open Topic history after a C8 cursor clamp without remounting TopicView', async () => {
    vi.useFakeTimers()
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const m5 = { ...record(5, 'c1'), id: 'm-5', sender: 'other', body: 'クランプ前メッセージ', topic_id: 't-1' }
    const m10 = { ...record(10, 'c1'), id: 'm-10', sender: 'other', body: 'ブートストラップ末尾', topic_id: null }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 10,
      has_more: false,
      items: [
        { kind: 'topic', topic: topicSummaryItem('t-1', 'クランプ検証', m5) },
        { kind: 'message', message: m10 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([m5]).at(-1)?.created_seq ?? 0, messages: [m5], has_more: false })
    net.topicSummaries['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 10,
      topic: topicSummaryItem('t-1', 'クランプ検証', m5),
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

    const { navigation } = createTopicWorkspaceNavigation('/o/org-1/c/c1/t/t-1')

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: topicWorkspaceOrganization(),
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 10)
    await settle()
    flushSync()
    const sectionBefore = host.querySelector('#main-content .topic-view')
    expect(sectionBefore).not.toBeNull()
    expect(host.querySelector('#main-content')?.textContent).toContain('クランプ前メッセージ')

    // Reconnect with C8 clamp (caught_up_seq=2 < after_seq=10)
    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'クランプ後のTopic履歴', topic_id: 't-1' }
    const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: 'クランプ後の末尾', topic_id: null }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 2,
      has_more: false,
      items: [
        { kind: 'topic', topic: topicSummaryItem('t-1', 'クランプ検証', m1) },
        { kind: 'message', message: m2 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([m1]).at(-1)?.created_seq ?? 0, messages: [m1], has_more: false })

    net.socket.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    net.socket.onReady()
    await settle()
    net.subscribed('c1', 2)
    await settle()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('#main-content .topic-view')).toBe(sectionBefore)
    expect(host.querySelector('#main-content')?.textContent).toContain('クランプ後のTopic履歴')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('announces the first live Message after opening a Topic whose name was still loading', async () => {
    vi.useFakeTimers()
    let resolveNavSummary!: (res: ReturnType<typeof ok<{ history_generation: string; as_of_seq: number; topic: TopicSummary }>>) => void
    const navSummaryPromise = new Promise<ReturnType<typeof ok<{ history_generation: string; as_of_seq: number; topic: TopicSummary }>>>((r) => {
      resolveNavSummary = r
    })
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        getTopicSummary(channelId, topicId) {
          if (topicId === 't-slow') return navSummaryPromise
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: '既存本文', topic_id: null }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicMessages['c1:t-slow'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 0, messages: [], has_more: false })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

    const announcements: string[] = []
    const { navigation } = createTopicWorkspaceNavigation('/o/org-1/c/c1')

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: topicWorkspaceOrganization(),
        selectedOrganizationId: 'org-1',
        resolveSenderName: (id) => (id === 'other' ? '佐藤' : '自分'),
        onannounce: (msg) => announcements.push(msg),
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()
    expect(announcements.at(-1)).toBe('# general')

    // Open Topic t-slow while its summary/name is still loading
    navigation.navigate({ type: 'topic', topicId: 't-slow', phone: false })
    flushSync()
    await settle()
    flushSync()

    // Now resolve the Topic name (without changing currentTimeline)
    const mSlow = { ...record(1, 'c1'), id: 'm-slow', sender: 'other', body: '初回', topic_id: 't-slow' }
    resolveNavSummary(
      ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 1,
        topic: topicSummaryItem('t-slow', '遅延読込トピック', mSlow),
      }),
    )
    await settle()
    flushSync()
    expect(announcements.at(-1)).toBe('遅延読込トピック')

    // First live arrival in t-slow must be announced, NOT eaten as the initial baseline!
    announcements.length = 0
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '遅延後の最初の新着', topic_id: 't-slow' }).created_seq,
      message: { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '遅延後の最初の新着', topic_id: 't-slow' },
    })
    await settle()
    flushSync()
    await vi.advanceTimersByTimeAsync(2_000)
    flushSync()
    expect(announcements).toEqual(['佐藤: 遅延後の最初の新着'])

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })
})
