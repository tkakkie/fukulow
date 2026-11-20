import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type { Member, Result, TopicSummary } from './api'
import { createAuthors } from './authors'
import { authorsAdapter } from './authors.svelte'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createMembers } from './members'
import { membersAdapter } from './members.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import Timeline from './Timeline.svelte'
import TopicView from './TopicView.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'
import { windowClient } from './message-window-test-helpers'
import { msg, summary } from './topic-test-helpers'
import { buttonsByText, installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Topic summary lines, TopicList and TopicView states', () => {
  it('TopicView handles an active summary evicted by 400 newer main Messages without rejection or a render loop', async () => {
    vi.useFakeTimers()
    const c = windowClient(), report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await c.boot()
      for (let page = 0; page < 7; page++) await c.topics.loadMain('A')
      c.options.listTopicMessages = async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([msg(1, 'T')]).at(-1)?.created_seq ?? 0,  messages: [msg(1, 'T')], has_more: false })
      const getSummary = vi.fn(async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1000, topic: summary('T', 1, 1) }))
      c.options.getTopicSummary = getSummary
      const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
      const instance = mount(TopicView, { target: host as unknown as Element, props: {
        channel: syncAdapter(c.sync).channel('A'), topics: topicsAdapter(c.topics, 'A'),
        channelId: 'A', topicId: 'T', topicName: 'Topic T',
      } })
      try {
        await settle(); await settle()
        await vi.advanceTimersByTimeAsync(60_000); await settle()
        expect(getSummary).toHaveBeenCalledTimes(1)
        expect(report).not.toHaveBeenCalled()
        expect(c.topics.get('A').lines).toHaveLength(400)
        expect(c.topics.get('A').topic('T').messages).toEqual([msg(1, 'T')])
        expect(host.querySelector('[data-message-id="id1"]')).not.toBeNull()
        expect(c.sync.get().channels.A.cursor).toBe(1000)
      } finally { await unmount(instance) }
    } finally { await c.close(); report.mockRestore() }
  })


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
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const chMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'チャンネル本文1', topic_id: null }
    const topicMsg2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '仕様の初回相談', topic_id: 't-1' }
    const chMsg3 = { ...record(3, 'c1'), id: 'm-3', sender: 'other', body: 'チャンネル本文3', topic_id: null }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: chMsg1 },
        {
          kind: 'topic',
          topic: {
            mention_unread_count: 0,
            id: 't-1',
            name: '仕様相談',
            first_seq: 2,
            last_seq: 2,
            message_count: 1,
            latest_message: topicMsg2,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: chMsg3 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([topicMsg2]).at(-1)?.created_seq ?? 0,  messages: [topicMsg2], has_more: false })
    net.topicSummaries['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 3,
      topic: {
        mention_unread_count: 0,
        id: 't-1',
        name: '仕様相談',
        first_seq: 2,
        last_seq: 2,
        message_count: 1,
        latest_message: topicMsg2,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general'), channel('c2', 'empty')] }))

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const announcements: string[] = []
    const navigation = createNavigation({
      location: {
        get href() {
          return href
        },
      },
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _title: string, url: string) {
          historyState = state
          href = url
        },
        replaceState(state: unknown, _title: string, url: string) {
          historyState = state
          href = url
        },
      },
      get innerWidth() {
        return dom.win.innerWidth
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
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
    net.topicSummaries['c1:t-2'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 4,
      topic: {
        mention_unread_count: 0,
        id: 't-2',
        name: 'リリース計画',
        first_seq: 4,
        last_seq: 4,
        message_count: 1,
        latest_message: createdTopicMsg,
        read_seq: 0,
        unread_count: 0,
      },
    })

    const enterEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    enterEvt.key = 'Enter'
    bodyTextarea.dispatchEvent(enterEvt)
    await settle()
    expect(net.sends).toHaveLength(1)
    expect(net.sends[0].body).toEqual({ history_generation: '00000000-0000-4000-8000-000000000515',
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

    net.topicLists.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 5,
      has_more: false,
      topics: [
        {
          mention_unread_count: 0,
          id: 't-2',
          name: 'リリース計画',
          first_seq: 4,
          last_seq: 4,
          message_count: 1,
          latest_message: createdTopicMsg,
          read_seq: 0,
          unread_count: 0,
        },
        {
          mention_unread_count: 0,
          id: 't-1',
          name: '仕様相談',
          first_seq: 2,
          last_seq: 5,
          message_count: 2,
          latest_message: liveTopicMsg,
          read_seq: 0,
          unread_count: 0,
        },
      ],
    })

    buttonsByText(host, 'すべてのトピック(2)›')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(href).toBe('/o/org-1/c/c1?panel=topics')
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

    expect(href).toBe('/o/org-1/c/c1/t/t-1?panel=topics')
    expect(host.querySelector('#main-content h1')?.textContent.trim()).toBe('仕様相談')
    expect(announcements.at(-1)).toBe('仕様相談')

    const topicComposer = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    expect(topicComposer.value).toBe('')
    expect(queryAll(host, '#main-content .topic-view__item').map((el) => el.textContent)).toHaveLength(2)

    topicComposer.value = 'トピックからの返信'
    topicComposer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    const topicForm = host.querySelector('#main-content form')!
    topicForm.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(net.sends.at(-1)?.body).toEqual({ history_generation: '00000000-0000-4000-8000-000000000515',
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

    expect(href).toBe('/o/org-1/c/c1?panel=topics')
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
      const topicAdapters = new Map<string, TopicsAdapter>()
      const sessionModel = {
        channels: channelsAdapter(rawSession.channels),
        sync: syncAdapter(rawSession.sync),
        topics(channelId: string) {
          let a = topicAdapters.get(channelId)
          if (!a) {
            a = topicsAdapter(rawSession.topics, channelId)
            topicAdapters.set(channelId, a)
          }
          return a
        },
        navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
        close: () => rawSession.close(),
      }

      const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'トピック履歴1', topic_id: 't-1' }
      const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: 'チャンネル本文2', topic_id: null }
      net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 2,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              mention_unread_count: 0,
              id: 't-1',
              name: '継続トピック',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: m1,
              read_seq: 0,
              unread_count: 0,
            },
          },
          { kind: 'message', message: m2 },
        ],
      })
      net.topicMessages['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1]).at(-1)?.created_seq ?? 0,  messages: [m1], has_more: false })
      net.topicSummaries['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 2,
        topic: {
          mention_unread_count: 0,
          id: 't-1',
          name: '継続トピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: m1,
          read_seq: 0,
          unread_count: 0,
        },
      })

      net.socket.onReady()
      net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

      let href = '/o/org-1/c/c1/t/t-1'
      let historyState: unknown = null
      const navigation = createNavigation({
        location: { get href() { return href } },
        history: {
          get state() { return historyState },
          pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
          replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        },
        innerWidth: 1280,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as NavigationBrowser)

      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      const instance = mount(Workspace, {
        target: host as unknown as Element,
        props: {
          navigation,
          session: sessionModel,
          organization: {
            member: { id: 'me', name: '自分', role: 'owner' },
            organization: {
              organization_id: 'org-1',
              name: 'Acme',
              capabilities: {
                can_create_channels: { allowed: true },
                can_invite: { allowed: true },
                can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
              },
            },
          },
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
      host.querySelector('#main-content form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
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

  it('confirms before replacing a Topic-name-only draft and restores body with its original Topic intent', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 0)
    await settle()

    const ch = syncAdapter(rawSession.sync).channel('c1')
    const tp = topicsAdapter(rawSession.topics, 'c1')
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Timeline, {
      target: host as unknown as Element,
      props: { channel: ch, topics: tp, channelId: 'c1', selfId: 'me' },
    })
    flushSync()

    // Submit a send to "Original topic" and have the server refuse it (400)
    const topicInput = queryAll(host, 'input').find((el) => el.getAttribute('aria-label') === 'トピック名')!
    const textarea = queryAll(host, 'textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    topicInput.value = 'Original topic'
    topicInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    textarea.value = '拒否されたトピック本文'
    textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    host.querySelector('form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 400 })
    await settle()
    flushSync()

    // Type ONLY "Different topic" into the Topic-name field (body draft stays empty)
    topicInput.value = 'Different topic'
    topicInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(textarea.value).toBe('')

    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('入力中の下書きを置き換えますか？')

    // Cancel keeps both "Different topic" and the failed "Original topic" send
    buttonsByText(host, 'キャンセル')[0].click()
    flushSync()
    expect(topicInput.value).toBe('Different topic')
    expect(ch.timeline.pending).toHaveLength(1)

    // Confirm replaces with both the refused body AND "Original topic"
    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    buttonsByText(host, '置き換える')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(textarea.value).toBe('拒否されたトピック本文')
    expect(topicInput.value).toBe('Original topic')
    expect(ch.timeline.pending).toHaveLength(0)

    await unmount(instance)
    rawSession.close()
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
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m5 = { ...record(5, 'c1'), id: 'm-5', sender: 'other', body: 'クランプ前メッセージ', topic_id: 't-1' }
    const m10 = { ...record(10, 'c1'), id: 'm-10', sender: 'other', body: 'ブートストラップ末尾', topic_id: null }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 10,
      has_more: false,
      items: [
        {
          kind: 'topic',
          topic: {
            mention_unread_count: 0,
            id: 't-1',
            name: 'クランプ検証',
            first_seq: 5,
            last_seq: 5,
            message_count: 1,
            latest_message: m5,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: m10 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m5]).at(-1)?.created_seq ?? 0,  messages: [m5], has_more: false })
    net.topicSummaries['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 10,
      topic: {
        mention_unread_count: 0,
        id: 't-1',
        name: 'クランプ検証',
        first_seq: 5,
        last_seq: 5,
        message_count: 1,
        latest_message: m5,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1/t/t-1'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
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
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 2,
      has_more: false,
      items: [
        {
          kind: 'topic',
          topic: {
            mention_unread_count: 0,
            id: 't-1',
            name: 'クランプ検証',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: m1,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: m2 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1]).at(-1)?.created_seq ?? 0,  messages: [m1], has_more: false })

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

  it('shows initial Topic-list error and retry even when the timeline already supplied Topics', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'タイムライン既知トピック', topic_id: 't-known' }
    const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '一覧で取得される古いトピック', topic_id: 't-older' }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 2,
      has_more: true,
      items: [
        {
          kind: 'topic',
          topic: {
            mention_unread_count: 0,
            id: 't-known',
            name: '既知トピック',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: m1,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: { ...record(2, 'c1'), id: 'm-root', sender: 'other', body: 'root', topic_id: null } },
      ],
    })
    net.topicLists.c1 = { ok: false, kind: 'http', status: 503 }

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 2)
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('トピック: 既知トピック')
    expect(panel.textContent).toContain('トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    const retryBtn = queryAll(panel, 'button').find((b) => b.textContent.trim() === '再試行')
    expect(retryBtn).toBeDefined()

    net.topicLists.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 2,
      has_more: false,
      topics: [
        {
          mention_unread_count: 0,
          id: 't-older',
          name: '古いトピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: m2,
          read_seq: 0,
          unread_count: 0,
        },
        {
          mention_unread_count: 0,
          id: 't-known',
          name: '既知トピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: m1,
          read_seq: 0,
          unread_count: 0,
        },
      ],
    })
    retryBtn!.click()
    flushSync()
    await settle()
    flushSync()

    expect(panel.textContent).toContain('トピック: 古いトピック')
    expect(panel.textContent).not.toContain('トピックを読み込めませんでした。')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('announces the first live Message after opening a Topic whose name was still loading', async () => {
    vi.useFakeTimers()
    let resolveNavSummary!: (res: ReturnType<typeof ok<{ history_generation: string;  as_of_seq: number; topic: TopicSummary }>>) => void
    const navSummaryPromise = new Promise<ReturnType<typeof ok<{ history_generation: string;  as_of_seq: number; topic: TopicSummary }>>>((r) => {
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
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: '既存本文', topic_id: null }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicMessages['c1:t-slow'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0,  messages: [], has_more: false })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const announcements: string[] = []
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
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
      ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 1,
        topic: {
          mention_unread_count: 0,
          id: 't-slow',
          name: '遅延読込トピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: mSlow,
          read_seq: 0,
          unread_count: 0,
        },
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

  it('retries a failed Topic summary read via controller policy and updates both Timeline and TopicList', async () => {
    vi.useFakeTimers()
    let summaryCalls = 0
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        async getTopicSummary(channelId, topicId) {
          if (topicId === 't-retry') {
            summaryCalls++
            if (summaryCalls === 1) return { ok: false, kind: 'http', status: 503 }
            return ok({ history_generation: '00000000-0000-4000-8000-000000000515',
              as_of_seq: 2,
              topic: {
                mention_unread_count: 0,
                id: 't-retry',
                name: '再取得成功トピック',
                first_seq: 2,
                last_seq: 2,
                message_count: 1,
                latest_message: { ...record(2, channelId), id: 'm-2', sender: 'other', body: '本文', topic_id: 't-retry' },
                read_seq: 0,
                unread_count: 0,
              },
            })
          }
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'root', topic_id: null }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicLists.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, has_more: false, topics: [] })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    // Live arrival for unknown Topic t-retry triggers summary read from both Timeline and TopicList (deduped to 1 call)
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '本文', topic_id: 't-retry' }).created_seq,
      message: { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '本文', topic_id: 't-retry' },
    })
    await settle()
    flushSync()
    expect(summaryCalls).toBe(1)
    expect(host.querySelector('#main-content')?.textContent).toContain('トピック: トピック')

    // After backoff elapses, controller retries and both Timeline and TopicList display the resolved Topic name
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    flushSync()
    expect(summaryCalls).toBe(2)
    expect(host.querySelector('#main-content')?.textContent).toContain('トピック: 再取得成功トピック')
    expect(host.querySelector('#panel-content')?.textContent).toContain('トピック: 再取得成功トピック')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('retries transient summary failures without a budget, stops ordinary 4xx and supports explicit retry', async () => {
    vi.useFakeTimers()
    let retryableCalls = 0
    let nonRetryableCalls = 0
    let allowSuccess = false
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        async getTopicSummary(channelId, topicId) {
          if (topicId === 't-503') {
            retryableCalls++
            if (!allowSuccess) return { ok: false, kind: 'http', status: 503 }
            return ok({ history_generation: '00000000-0000-4000-8000-000000000515',
              as_of_seq: 2,
              topic: {
                mention_unread_count: 0,
                id: 't-503',
                name: '手動再試行トピック',
                first_seq: 2,
                last_seq: 2,
                message_count: 1,
                latest_message: { ...record(2, channelId), id: 'm-2', sender: 'other', body: '一時障害本文', topic_id: 't-503' },
                read_seq: 0,
                unread_count: 0,
              },
            })
          }
          if (topicId === 't-400') {
            nonRetryableCalls++
            return { ok: false, kind: 'http', status: 400 }
          }
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'root', topic_id: null }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicLists.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, has_more: false, topics: [] })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    // 1. Live messages arrive for retryable-failing Topic t-503 and non-retryable 400 Topic t-400
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '一時障害本文', topic_id: 't-503' }).created_seq,
      message: { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '一時障害本文', topic_id: 't-503' },
    })
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(3, 'c1'), id: 'm-3', sender: 'other', body: '非再試行本文', topic_id: 't-400' }).created_seq,
      message: { ...record(3, 'c1'), id: 'm-3', sender: 'other', body: '非再試行本文', topic_id: 't-400' },
    })
    await settle()
    flushSync()

    // Non-retryable 400 stops immediately at 1 request with no retry button
    expect(nonRetryableCalls).toBe(1)

    // Persistent 503 keeps retrying beyond the former finite budget; ordinary 400 stays stopped.
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    flushSync()
    expect(retryableCalls).toBeGreaterThan(5)
    expect(nonRetryableCalls).toBe(1)

    const mainRetryButtons = queryAll(host, '#main-content button').filter((b) => b.textContent?.trim() === '再試行')
    const panelRetryButtons = queryAll(host, '#panel-content button').filter((b) => b.textContent?.trim() === '再試行')
    expect(mainRetryButtons).toHaveLength(1)
    expect(panelRetryButtons).toHaveLength(1)

    // Later traffic leaves the permanent refusal stopped while transient failures keep retrying.
    const beforeLater = retryableCalls
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(4, 'c1'), id: 'm-4', sender: 'other', body: '後続メッセージ', topic_id: null }).created_seq,
      message: { ...record(4, 'c1'), id: 'm-4', sender: 'other', body: '後続メッセージ', topic_id: null },
    })
    await settle()
    flushSync()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retryableCalls).toBeGreaterThan(beforeLater)
    expect(nonRetryableCalls).toBe(1)

    // 2. Clicking 再試行 on the summary line restarts and displays the resolved Topic name and count
    allowSuccess = true
    const beforeManual = retryableCalls
    mainRetryButtons[0]!.click()
    await settle()
    flushSync()
    expect(retryableCalls).toBe(beforeManual + 1)
    expect(host.querySelector('#main-content')?.textContent).toContain('トピック: 手動再試行トピック')
    expect(host.querySelector('#main-content')?.textContent).toContain('1件›')
    expect(host.querySelector('#panel-content')?.textContent).toContain('トピック: 手動再試行トピック')
    expect(queryAll(host, '#main-content button').filter((b) => b.textContent?.trim() === '再試行')).toHaveLength(0)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('focuses the returning Topic summary line after a delayed timeline load, and falls back to Composer only when ready and absent or on timeline error', async () => {
    type TimelineRes =
      | ReturnType<
          typeof ok<{ history_generation: string;
            as_of_seq: number
            has_more: boolean
            items: Array<
              | { kind: 'message'; message: ReturnType<typeof record> }
              | {
                  kind: 'topic'
                  topic: TopicSummary
                }
            >
          }>
        >
      | { ok: false; kind: 'http'; status: number }
    let resolveC1Timeline!: (res: TimelineRes) => void
    const c1TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC1Timeline = r
    })
    let resolveC2Timeline!: (res: TimelineRes) => void
    const c2TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC2Timeline = r
    })
    let resolveC3Timeline!: (res: TimelineRes) => void
    const c3TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC3Timeline = r
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
        listTimeline(channelId, query) {
          if (channelId === 'c1' && query?.before_position === undefined) return c1TimelinePromise
          if (channelId === 'c2' && query?.before_position === undefined) return c2TimelinePromise
          if (channelId === 'c3' && query?.before_position === undefined) return c3TimelinePromise
          return baseOptions.topicsApi!.listTimeline(channelId, query)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const topicMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: '遅延表示の初回本文', topic_id: 't-delayed' }
    net.topicMessages['c1:t-delayed'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([topicMsg1]).at(-1)?.created_seq ?? 0,  messages: [topicMsg1], has_more: false })
    net.topicSummaries['c1:t-delayed'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      topic: {
        mention_unread_count: 0,
        id: 't-delayed',
        name: '遅延表示トピック',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: topicMsg1,
        read_seq: 0,
        unread_count: 0,
      },
    })
    const c2TopicMsg = { ...record(1, 'c2'), id: 'm-c2-1', sender: 'other', body: '旧トピック本文', topic_id: 't-absent' }
    net.topicMessages['c2:t-absent'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([c2TopicMsg]).at(-1)?.created_seq ?? 0,  messages: [c2TopicMsg], has_more: false })
    net.topicSummaries['c2:t-absent'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      topic: {
        mention_unread_count: 0,
        id: 't-absent',
        name: '不在トピック',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: c2TopicMsg,
        read_seq: 0,
        unread_count: 0,
      },
    })
    const c3TopicMsg = { ...record(1, 'c3'), id: 'm-c3-1', sender: 'other', body: 'エラーチャンネル本文', topic_id: 't-err' }
    net.topicMessages['c3:t-err'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([c3TopicMsg]).at(-1)?.created_seq ?? 0,  messages: [c3TopicMsg], has_more: false })
    net.topicSummaries['c3:t-err'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      topic: {
        mention_unread_count: 0,
        id: 't-err',
        name: 'エラートピック',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: c3TopicMsg,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general'), channel('c2', 'other'), channel('c3', 'broken')] }))

    let href = '/o/org-1/c/c1/t/t-delayed'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    flushSync()
    expect(host.querySelector('#main-content h1')?.textContent.trim()).toBe('遅延表示トピック')

    // 1. Press チャンネルへ戻る while c1's main timeline load is still in flight
    const backBtn1 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn1.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe('/o/org-1/c/c1')
    expect(host.querySelector('#main-content [data-topic-id="t-delayed"]')).toBeNull()
    const c1MainComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!

    // Resolve the delayed main timeline load -> summary line renders and receives focus (not Composer)
    resolveC1Timeline(
      ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 1,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              mention_unread_count: 0,
              id: 't-delayed',
              name: '遅延表示トピック',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: topicMsg1,
              read_seq: 0,
              unread_count: 0,
            },
          },
        ],
      }),
    )
    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    const returnedSummary = host.querySelector('#main-content [data-topic-id="t-delayed"]')!
    expect(returnedSummary).not.toBeNull()
    expect(dom.doc.activeElement).not.toBe(c1MainComposer)
    expect(dom.doc.activeElement).toBe(returnedSummary)

    // 2. When main timeline finishes loading and the returning Topic is definitively absent, fall back to Composer
    navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
    navigation.navigate({ type: 'topic', topicId: 't-absent', phone: false })
    flushSync()
    await settle()
    flushSync()
    expect(href).toBe('/o/org-1/c/c2/t/t-absent')

    const backBtn2 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn2.click()
    flushSync()
    await settle()
    flushSync()

    const c2Composer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(dom.doc.activeElement).not.toBe(c2Composer)

    const c2RootMsg = { ...record(2, 'c2'), id: 'm-c2-2', sender: 'other', body: '最新通常投稿', topic_id: null }
    resolveC2Timeline(
      ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 2,
        has_more: true,
        items: [{ kind: 'message', message: c2RootMsg }],
      }),
    )
    await settle()
    net.subscribed('c2', 2)
    await settle()
    flushSync()

    expect(host.querySelector('#main-content [data-topic-id="t-absent"]')).toBeNull()
    expect(dom.doc.activeElement).toBe(c2Composer)

    // 3. When main timeline fails with an error, fall back to Composer
    navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c3' })
    navigation.navigate({ type: 'topic', topicId: 't-err', phone: false })
    flushSync()
    await settle()
    flushSync()

    const backBtn3 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn3.click()
    flushSync()
    await settle()
    flushSync()

    const c3Composer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(dom.doc.activeElement).not.toBe(c3Composer)

    resolveC3Timeline({ ok: false, kind: 'http', status: 503 })
    await settle()
    flushSync()
    expect(dom.doc.activeElement).toBe(c3Composer)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('keeps focus on the Topic summary line when an in-flight Topic send settles after returning to the Channel', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const topicMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'me', body: 'キーボード初回投稿', topic_id: 't-kbd' }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      has_more: false,
      items: [
        {
          kind: 'topic',
          topic: {
            mention_unread_count: 0,
            id: 't-kbd',
            name: 'キーボード議題',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: topicMsg1,
            read_seq: 0,
            unread_count: 0,
          },
        },
      ],
    })
    net.topicMessages['c1:t-kbd'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([topicMsg1]).at(-1)?.created_seq ?? 0,  messages: [topicMsg1], has_more: false })
    net.topicSummaries['c1:t-kbd'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 1,
      topic: {
        mention_unread_count: 0,
        id: 't-kbd',
        name: 'キーボード議題',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: topicMsg1,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    // Open Topic view from summary line
    host.querySelector('#main-content [data-topic-id="t-kbd"]')!.click()
    flushSync()
    await settle()
    flushSync()

    // Send inside Topic view via Enter; optimistic item renders immediately while POST /messages stays in flight
    const topicComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    topicComposer.focus()
    topicComposer.value = 'キーボードからの追記'
    topicComposer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    const enterEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    enterEvt.key = 'Enter'
    topicComposer.dispatchEvent(enterEvt)
    await settle()
    flushSync()
    expect(net.sends).toHaveLength(1)
    expect(queryAll(host, '#main-content .topic-view__item')).toHaveLength(2)

    // Navigate back via チャンネルへ戻る BEFORE POST /messages resolves
    const backBtn = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn.click()
    flushSync()
    await tick()
    flushSync()

    const returnedSummary = host.querySelector('#main-content [data-topic-id="t-kbd"]')!
    const channelComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(dom.doc.activeElement).toBe(returnedSummary)

    // Resolve the in-flight Topic send after Timeline has remounted -> focus must stay on returnedSummary
    const sentInTopic = {
      ...record(2, 'c1'),
      id: 'm-2',
      sender: 'me',
      client_message_id: 'me-c1',
      body: 'キーボードからの追記',
      topic_id: 't-kbd',
    }
    net.sends[0].resolve(ok(sentInTopic))
    net.event({ type: 'message', kind: 'create', seq: (sentInTopic).created_seq, message: sentInTopic })
    await settle()
    flushSync()

    expect(returnedSummary.textContent).toContain('2件›')
    expect(dom.doc.activeElement).not.toBe(channelComposer)
    expect(dom.doc.activeElement).toBe(returnedSummary)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('never steals focus when the user moves focus elsewhere before a delayed Topic summary line appears', async () => {
    type TimelineRes = ReturnType<
      typeof ok<{ history_generation: string;
        as_of_seq: number
        has_more: boolean
        items: Array<{
          kind: 'topic'
          topic: TopicSummary
        }>
      }>
    >
    let resolveC1Timeline!: (res: TimelineRes) => void
    const c1TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC1Timeline = r
    })
    let resolveC2Timeline!: (res: TimelineRes) => void
    const c2TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC2Timeline = r
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
        listTimeline(channelId, query) {
          if (channelId === 'c1' && query?.before_position === undefined) return c1TimelinePromise
          if (channelId === 'c2' && query?.before_position === undefined) return c2TimelinePromise
          return baseOptions.topicsApi!.listTimeline(channelId, query)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'c1本文', topic_id: 't-1' }
    const m2 = { ...record(1, 'c2'), id: 'm-2', sender: 'other', body: 'c2本文', topic_id: 't-2' }
    for (const [ch, tid, msg] of [
      ['c1', 't-1', m1],
      ['c2', 't-2', m2],
    ] as const) {
      net.topicMessages[`${ch}:${tid}`] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([msg]).at(-1)?.created_seq ?? 0,  messages: [msg], has_more: false })
      net.topicSummaries[`${ch}:${tid}`] = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 1,
        topic: {
          mention_unread_count: 0,
          id: tid,
          name: `トピック-${tid}`,
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: msg,
          read_seq: 0,
          unread_count: 0,
        },
      })
    }

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general'), channel('c2', 'other')] }))

    let href = '/o/org-1/c/c1/t/t-1'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    flushSync()

    // Case 1: User moves focus immediately after topic-back (before first tick and before summary line renders)
    const railChannelBtn = queryAll(host, 'button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
    const backBtn1 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn1.click()
    flushSync()
    railChannelBtn.focus()
    expect(dom.doc.activeElement).toBe(railChannelBtn)

    await settle()
    flushSync()
    expect(dom.doc.activeElement).toBe(railChannelBtn)

    resolveC1Timeline(
      ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 1,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              mention_unread_count: 0,
              id: 't-1',
              name: 'トピック-t-1',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: m1,
              read_seq: 0,
              unread_count: 0,
            },
          },
        ],
      }),
    )
    await settle()
    flushSync()
    expect(host.querySelector('#main-content [data-topic-id="t-1"]')).not.toBeNull()
    expect(dom.doc.activeElement).toBe(railChannelBtn)

    // Case 2: User moves focus while main timeline is loading (after initial tick, before summary line appears)
    navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
    navigation.navigate({ type: 'topic', topicId: 't-2', phone: false })
    flushSync()
    await settle()
    flushSync()

    const backBtn2 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn2.click()
    flushSync()
    await settle()
    flushSync()

    const panelToggleBtn = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.getAttribute('aria-label')?.startsWith('パネルを開く'),
    )!
    panelToggleBtn.focus()
    expect(dom.doc.activeElement).toBe(panelToggleBtn)

    resolveC2Timeline(
      ok({ history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 1,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              mention_unread_count: 0,
              id: 't-2',
              name: 'トピック-t-2',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: m2,
              read_seq: 0,
              unread_count: 0,
            },
          },
        ],
      }),
    )
    await settle()
    flushSync()
    expect(host.querySelector('#main-content [data-topic-id="t-2"]')).not.toBeNull()
    expect(dom.doc.activeElement).toBe(panelToggleBtn)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })


  it.each([403, 404])('Topic history %s shows Channel denial and keeps the Topic draft', async status => {
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([{ ...record(10), topic_id: 'T' }]).at(-1)?.created_seq ?? 0,  messages: [{ ...record(10), topic_id: 'T' }], has_more: false })
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle(); net.subscribed('A', 10); await settle()
    const ch = syncAdapter(raw.sync).channel('A')
    ch.topic('T').setDraft('失わないトピック下書き')
    net.topicMessages['A:T'] = { ok: false, kind: 'http', status, error: 'channel_not_found' }
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(TopicView, { target: host as unknown as Element,
      props: { channel: ch, topics: topicsAdapter(raw.topics, 'A'), channelId: 'A', topicId: 'T', topicName: 'Topic T', ongoToChannelList: vi.fn() } })
    await settle()
    expect(host.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(host, '再試行')).toHaveLength(0)
    expect(buttonsByText(host, 'チャンネル一覧へ')).toHaveLength(1)
    const textarea = queryAll(host, 'textarea')[0]
    expect(textarea.disabled).toBe(true)
    expect(textarea.value).toBe('失わないトピック下書き')
    expect(await ch.topic('T').submit('Topic T')).toBe(false)
    expect(net.sends).toHaveLength(0)
    await unmount(instance); raw.close()
  })

})
