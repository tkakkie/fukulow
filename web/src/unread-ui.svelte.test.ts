import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type { ReadPosition, Result } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { repliesAdapter } from './replies.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import Workspace from './Workspace.svelte'
import { installMiniDom, MiniDomEvent } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Unread badges, enter/leave lifecycle and recovery', () => {
  it('renders Channel and Topic Unread badges across sidebar, accordion, Topic list panel and timeline summary lines, and hides badges when counts are null or zero', async () => {
    const net = fakeNetwork()
    // Start with failed Channel-list baseline so counts are unresolved (null)
    net.unreadListResult = { ok: false, kind: 'http', status: 500, error: 'internal_error' }
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const t1Latest = { ...record(5, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック1最新' }
    const t2Latest = { ...record(6, 'c1'), sender: 'other', topic_id: 't2', body: 'トピック2最新' }
    const t1Summary = {
      mention_unread_count: 1,
      id: 't1',
      name: '進行中トピック',
      first_seq: 5,
      last_seq: 5,
      message_count: 2,
      latest_message: t1Latest,
      read_seq: 3,
      unread_count: 2,
    }
    const t2Summary = {
      mention_unread_count: 0,
      id: 't2',
      name: '既読トピック',
      first_seq: 6,
      last_seq: 6,
      message_count: 1,
      latest_message: t2Latest,
      read_seq: 6,
      unread_count: 0,
    }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 6,
      has_more: false,
      items: [
        { kind: 'topic', topic: t1Summary },
        { kind: 'topic', topic: t2Summary },
      ],
    })
    net.topicLists.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 6,
      has_more: false,
      topics: [t1Summary, t2Summary],
    })
    net.topicSummaries['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 6, topic: t1Summary })
    net.topicSummaries['c1:t2'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 6, topic: t2Summary })
    net.topicSummaries['c1:t3'] = { ok: false, kind: 'http', status: 500 }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general'), channel('c2', 'random')] }))
    await settle()
    net.subscribed('c1', 6)
    await settle()
    // Deliver a live message in t3 while its summary recovery fails -> t3 has unreadCount === null
    net.event({
      type: 'message', kind: 'create', seq: ({ ...record(7, 'c1'), topic_id: 't3', sender: 'other', body: 't3の新着メッセージ' }).created_seq,
      message: { ...record(7, 'c1'), topic_id: 't3', sender: 'other', body: 't3の新着メッセージ' },
    })
    await settle()

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
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

    // While Channel-list baseline failed (null), Channel and Topic badges are hidden
    const channelNav = host.querySelector('#channel-content')!
    expect(channelNav.querySelectorAll('.ui-badge--unread')).toHaveLength(0)
    expect(host.querySelectorAll('#main-content .ui-topic-summary .ui-badge--unread')).toHaveLength(0)
    expect(host.querySelectorAll('#panel-content .ui-topic-summary .ui-badge--unread')).toHaveLength(0)

    // Now resolve the Channel-list baseline: c1 has 2 Unread (from t1), c2 has 4 Unread
    net.unreadListResult = null
    net.unreadChannels.c1 = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 1, main_mention_unread_count: 0,
      ...channel('c1', 'general'),
      as_of_seq: 6,
      read_seq: 6,
      unread_count: 2,
      main_unread_count: 0,
    }
    net.unreadChannels.c2 = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 2, main_mention_unread_count: 2,
      ...channel('c2', 'random'),
      as_of_seq: 4,
      read_seq: 0,
      unread_count: 4,
      main_unread_count: 4,
    }
    await rawSession.unread.refresh()
    await settle()
    flushSync()

    // Topic t1 has unread_count = 2 -> shown in accordion, main timeline summary line, and right panel Topic list
    // Topic t2 has unread_count = 0 -> no badge shown
    // Topic t3 has unreadCount === null (summary fetch failed) -> no badge shown
    expect(sessionModel.unread('c1').state.topics.t3?.unreadCount ?? null).toBeNull()
    const accordionBadges = channelNav.querySelectorAll('.ui-list-row-group--topic .ui-badge--unread')
    expect(accordionBadges).toHaveLength(1)
    expect(accordionBadges[0].getAttribute('aria-label')).toBe('未読 2件')

    const allSidebarBadges = channelNav.querySelectorAll('.ui-badge--unread')
    // 2 Channel row badges (c1: 未読 3件 including seq 7 > as_of_seq 6, c2: 未読 4件) + 1 accordion Topic badge (t1: 未読 2件)
    expect(allSidebarBadges.map((b) => b.getAttribute('aria-label'))).toEqual(['未読 3件', '未読 2件', '未読 4件'])

    const timelineBadges = host.querySelectorAll('#main-content .ui-topic-summary .ui-badge--unread')
    expect(timelineBadges).toHaveLength(1)
    expect(timelineBadges[0].getAttribute('aria-label')).toBe('未読 2件')

    const panelBadges = host.querySelectorAll('#panel-content .ui-topic-summary .ui-badge--unread')
    expect(panelBadges).toHaveLength(1)
    expect(panelBadges[0].getAttribute('aria-label')).toBe('未読 2件')

    expect(channelNav.querySelectorAll('.ui-badge--mention').map(b => b.getAttribute('aria-label'))).toEqual(['メンションあり', 'メンションあり', 'メンション 2件'])
    expect(host.querySelectorAll('#main-content .ui-badge--mention')).toHaveLength(1)
    expect(host.querySelectorAll('#panel-content .ui-badge--mention')).toHaveLength(1)
    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })


  it('calls enter and leave on navigating between main timeline and Topic views, marks only the active Topic, and opens without a marker on a revisit after reading', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const t1m1 = { ...record(1, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック1の未読1' }
    const t1m2 = { ...record(2, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック1の未読2' }
    const t2m1 = { ...record(3, 'c1'), sender: 'other', topic_id: 't2', body: 'トピック2の未読1' }

    const t1Summary = {
      mention_unread_count: 0,
      id: 't1',
      name: 'トピックA',
      first_seq: 1,
      last_seq: 2,
      message_count: 2,
      latest_message: t1m2,
      read_seq: 0,
      unread_count: 2,
    }
    const t2Summary = {
      mention_unread_count: 0,
      id: 't2',
      name: 'トピックB',
      first_seq: 3,
      last_seq: 3,
      message_count: 1,
      latest_message: t2m1,
      read_seq: 0,
      unread_count: 1,
    }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'topic', topic: t1Summary },
        { kind: 'topic', topic: t2Summary },
      ],
    })
    net.topicSummaries['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 3, topic: t1Summary })
    net.topicSummaries['c1:t2'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 3, topic: t2Summary })
    net.topicMessages['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([t1m1, t1m2]).at(-1)?.created_seq ?? 0,  messages: [t1m1, t1m2], has_more: false })
    net.topicMessages['c1:t2'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([t2m1]).at(-1)?.created_seq ?? 0,  messages: [t2m1], has_more: false })
    net.unreadChannels.c1 = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0, main_mention_unread_count: 0,
      ...channel('c1', 'general'),
      as_of_seq: 3,
      read_seq: 3,
      unread_count: 3,
      main_unread_count: 0,
    }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    const enterSpy = vi.spyOn(rawSession.unread, 'enter')
    const leaveSpy = vi.spyOn(rawSession.unread, 'leave')

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
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

    // 1. Entered main timeline (topicId: null) with 0 main Unread -> no read marker
    expect(enterSpy).toHaveBeenCalledWith({ channel: 'c1', topicId: null })
    expect(host.querySelector('[data-read-marker="true"]')).toBeNull()
    expect(net.markReads).toHaveLength(0)
    sessionModel.sync.channel('c1').setDraft('main draft')
    flushSync()
    expect(leaveSpy).toHaveBeenCalledTimes(0)

    // 2. Click Topic t1 summary line -> leaves main timeline and enters Topic t1
    const t1LineBtn = host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!
    t1LineBtn.click()
    flushSync()
    await settle()
    await settle()
    flushSync()

    expect(leaveSpy).toHaveBeenCalledTimes(1)
    expect(enterSpy).toHaveBeenLastCalledWith({ channel: 'c1', topicId: 't1' })

    // Topic t1 shows read marker on t1m1, marks only t1 read, and leaves t2 Unread
    const t1m1Item = host.querySelector(`#main-content [data-message-id="${t1m1.id}"]`)!
    expect(t1m1Item.querySelector('[data-read-marker="true"]')?.textContent.trim()).toBe('未読')
    expect(net.markReads).toEqual([{ scope: { channel: 'c1', topicId: 't1' }, body: { history_generation: '00000000-0000-4000-8000-000000000515', read_seq: 2 } }])
    expect(sessionModel.unread('c1').state.topics.t1?.unreadCount).toBe(0)
    expect(sessionModel.unread('c1').state.topics.t2?.unreadCount).toBe(1)
    expect(sessionModel.unread('c1').state.unreadCount).toBe(1)

    // Marker remains visible for the rest of the visit to t1 even across timeline state updates
    sessionModel.sync.channel('c1').setDraft('updated draft')
    flushSync()
    await settle()
    flushSync()
    expect(leaveSpy).toHaveBeenCalledTimes(1)
    expect(t1m1Item.querySelector('[data-read-marker="true"]')).not.toBeNull()

    // 3. Return to main timeline and re-enter Topic t1 -> now t1 has 0 Unread so it opens pinned at bottom with no marker
    host
      .querySelectorAll('#main-content .main-card__header button')
      .find((b) => b.textContent.includes('チャンネルへ戻る'))!
      .click()
    flushSync()
    await settle()
    flushSync()
    expect(leaveSpy).toHaveBeenCalledTimes(2)
    expect(enterSpy).toHaveBeenLastCalledWith({ channel: 'c1', topicId: null })

    host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!.click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenLastCalledWith({ channel: 'c1', topicId: 't1' })
    expect(host.querySelector('[data-read-marker="true"]')).toBeNull()

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('stops automatic Unread re-entry on Channel or Topic 404 while sync remains ready, recovers on C8 clamp, and restarts on explicit user selection', async () => {
    const net = fakeNetwork()
    let markReadResponses: Array<Result<ReadPosition>> = [
      { ok: false, kind: 'http', status: 404, error: 'channel_not_found' },
      { ok: false, kind: 'http', status: 404, error: 'channel_not_found' },
    ]
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      sync: {
        ...baseOptions.sync,
        schedule: (fn) => {
          fn()
          return 0
        },
      },
      unreadApi: {
        ...baseOptions.unreadApi!,
        markRead: async (scope, body) => {
          net.markReads.push({ scope, body })
          const next = markReadResponses.shift()
          if (next) return next
          return ok({ history_generation: '00000000-0000-4000-8000-000000000515', read_seq: body.read_seq })
        },
      },
    })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), sender: 'other', body: '未読メッセージ1' }
    const t1m1 = { ...record(2, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック未読1' }
    const t1Summary = {
      mention_unread_count: 0,
      id: 't1',
      name: 'トピックA',
      first_seq: 2,
      last_seq: 2,
      message_count: 1,
      latest_message: t1m1,
      read_seq: 0,
      unread_count: 1,
    }

    net.pages.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m1, t1m1]).at(-1)?.created_seq ?? 0,  messages: [m1, t1m1], has_more: false })
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 2,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'topic', topic: t1Summary },
      ],
    })
    net.topicSummaries['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 2, topic: t1Summary })
    net.topicMessages['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([t1m1]).at(-1)?.created_seq ?? 0,  messages: [t1m1], has_more: false })
    net.unreadChannels.c1 = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0, main_mention_unread_count: 0,
      ...channel('c1', 'general'),
      as_of_seq: 2,
      read_seq: 0,
      unread_count: 2,
      main_unread_count: 1,
    }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 2)
    await settle()

    const enterSpy = vi.spyOn(rawSession.unread, 'enter')

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
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

    const scrollEl = host.querySelector('#main-content .timeline-scroll')!
    scrollEl.clientHeight = 100
    scrollEl.scrollHeight = 100

    await settle()
    await settle()
    flushSync()
    await settle()
    flushSync()

    // 1. Two 404s queued, but the 1st 404 stops automatic Unread work while sync stays ready (only 1 enter & 1 markRead, never 3)
    expect(sessionModel.sync.channel('c1').timeline.status).toBe('ready')
    expect(enterSpy).toHaveBeenCalledTimes(1)
    expect(net.markReads).toHaveLength(1)
    expect(sessionModel.unread('c1').state.stopped).toBe(true)

    const selectChannelBtn = () =>
      host.querySelectorAll('#channel-content button').find((b) => b.textContent.includes('general'))!
    const selectTopicBtn = () =>
      host.querySelectorAll('#channel-content button').find((b) => b.textContent.includes('トピックA'))!

    // 2. Explicit user selection of Channel c1 restarts Unread work once, consumes the 2nd 404, and stops again without looping
    selectChannelBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(2)
    expect(net.markReads).toHaveLength(2)
    expect(sessionModel.unread('c1').state.stopped).toBe(true)

    // 3. Explicit user selection when server allows markRead recovers and marks read
    selectChannelBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(3)
    expect(net.markReads).toHaveLength(3)
    expect(sessionModel.unread('c1').state.stopped).toBe(false)
    expect(sessionModel.unread('c1').state.main.unreadCount).toBe(0)

    // 4. C8 clamp (reconnect with caught_up_seq < cursor -> resetHistory) automatically creates a new visit for the new generation
    const visitBeforeC8 = sessionModel.unread('c1').state.entry?.id
    net.socket.onClose(1006)
    await settle()
    net.socket.onReady()
    await settle()
    net.subscribed('c1', 0)
    await settle()
    await settle()
    flushSync()
    expect(sessionModel.unread('c1').state.entry?.id).toBeDefined()
    expect(sessionModel.unread('c1').state.entry?.id).not.toBe(visitBeforeC8)
    expect(net.markReads).toHaveLength(4)

    // 5. Open Topic t1 where markRead returns a Topic 404 (topic_not_found) and then a Channel 404: stops until explicit selection
    markReadResponses = [
      { ok: false, kind: 'http', status: 404, error: 'topic_not_found' },
      { ok: false, kind: 'http', status: 404, error: 'channel_not_found' },
    ]
    host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!.click()
    flushSync()
    const topicScrollEl = host.querySelector('#main-content .topic-view__scroll')!
    topicScrollEl.clientHeight = 100
    topicScrollEl.scrollHeight = 100
    await settle()
    await settle()
    flushSync()
    await settle()
    flushSync()

    expect(enterSpy).toHaveBeenCalledTimes(4)
    expect(net.markReads).toHaveLength(5)
    expect(sessionModel.unread('c1').state.topics.t1?.stopped).toBe(true)

    // Explicit user selection of Topic t1 in sidebar restarts once, hits Channel 404, and stops without looping
    selectTopicBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(5)
    expect(net.markReads).toHaveLength(6)
    expect(sessionModel.unread('c1').state.stopped).toBe(true)

    // Explicit user selection of Topic t1 again when server allows markRead succeeds
    selectTopicBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(6)
    expect(net.markReads).toHaveLength(7)
    expect(sessionModel.unread('c1').state.stopped).toBe(false)
    expect(sessionModel.unread('c1').state.topics.t1?.unreadCount).toBe(0)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })


  it('subscribes to Unread per Channel in Workspace/ChannelList and does not re-read timeline when typing in Timeline composer', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    let c2UnreadReads = 0
    let c1TimelineReads = 0
    const baseSync = syncAdapter(rawSession.sync)
    const c1Channel = baseSync.channel('c1')
    const wrappedC1: typeof c1Channel = {
      ...c1Channel,
      get timeline() {
        c1TimelineReads++
        return c1Channel.timeline
      },
      get composer() {
        return c1Channel.composer
      },
      get live() {
        return c1Channel.live
      },
    }
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: {
        ...baseSync,
        get unavailable() {
          return baseSync.unavailable
        },
        channel: (id: string) => (id === 'c1' ? wrappedC1 : baseSync.channel(id)),
      },
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) {
          const base = unreadAdapter(rawSession.unread, id)
          a =
            id === 'c2'
              ? {
                  ...base,
                  get state() {
                    c2UnreadReads++
                    return base.state
                  },
                }
              : base
          unreadAdapters.set(id, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()
    net.pages.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(1, 'c1')]).at(-1)?.created_seq ?? 0,  messages: [record(1, 'c1')], has_more: false })
    net.pages.c2 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(1, 'c2')]).at(-1)?.created_seq ?? 0,  messages: [record(1, 'c2')], has_more: false })
    net.unreadChannels.c1 = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0, main_mention_unread_count: 0,
      ...channel('c1', 'general'),
      as_of_seq: 1,
      read_seq: 0,
      unread_count: 1,
      main_unread_count: 1,
    }
    net.unreadChannels.c2 = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0, main_mention_unread_count: 0,
      ...channel('c2', 'random'),
      as_of_seq: 1,
      read_seq: 0,
      unread_count: 2,
      main_unread_count: 2,
    }
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general'), channel('c2', 'random')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    dom.win.innerWidth = 1280
    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
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

    const c2ReadsBefore = c2UnreadReads
    // Live message on c1 changes c1's Unread -> must NOT re-read c2's Unread in Workspace/ChannelList.
    net.event({ type: 'message', kind: 'create', seq: ({ ...record(2, 'c1'), sender: 'other', body: 'c1新着' }).created_seq, message: { ...record(2, 'c1'), sender: 'other', body: 'c1新着' } })
    await settle()
    flushSync()
    expect(c2UnreadReads).toBe(c2ReadsBefore)

    // Typing in c1's Composer -> must NOT re-read c1's timeline in Workspace/Timeline.
    const c1TimelineReadsBefore = c1TimelineReads
    const c1TimelineRefBefore = c1Channel.timeline
    c1Channel.setDraft('キーストロークテスト')
    c1Channel.setTopicDraft('トピック名テスト')
    await settle()
    flushSync()
    expect(c1TimelineReads).toBe(c1TimelineReadsBefore)
    expect(c1Channel.timeline).toBe(c1TimelineRefBefore)
    const textarea = host.querySelector('#main-content textarea') as unknown as { value: string } | null
    expect(textarea?.value).toBe('キーストロークテスト')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('creates a distinct Unread visit with the recovered read boundary after same-Channel C9 reselection', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const msgs = [1, 2, 3, 4, 5, 6].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      body: `メッセージ${seq}`,
    }))
    net.pages.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 6, messages: msgs, has_more: false })
    net.timelines.c1 = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 6,
      has_more: false,
      items: msgs.map((message) => ({ kind: 'message' as const, message })),
    })
    net.unreadChannels.c1 = {
      history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0,
      main_mention_unread_count: 0,
      ...channel('c1', 'general'),
      as_of_seq: 6,
      read_seq: 6,
      unread_count: 0,
      main_unread_count: 0,
    }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 6)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
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
              can_deactivate_members: { allowed: true },
              can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    try {
      await settle()
      await settle()
      flushSync()

      const firstVisitId = sessionModel.unread('c1').state.entry?.id
      expect(firstVisitId).toBeDefined()
      expect(sessionModel.unread('c1').state.entry?.boundary).toBe(6)

      // Lose Channel access via C9
      net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'c1' })
      await settle()
      flushSync()
      expect(sessionModel.sync.channel('c1').timeline.status).toBe('unavailable')

      // Access returns with boundary 20 and 0 Unread; user explicitly reselects Channel c1
      net.unreadChannels.c1 = {
        history_generation: '00000000-0000-4000-8000-000000000515',
        mention_unread_count: 0,
        main_mention_unread_count: 0,
        ...channel('c1', 'general'),
        as_of_seq: 20,
        read_seq: 20,
        unread_count: 0,
        main_unread_count: 0,
      }
      host
        .querySelectorAll('#channel-content button')
        .find((b) => b.textContent.includes('general'))!
        .click()
      flushSync()
      await settle()
      net.subscribed('c1', 20)
      await settle()
      await settle()
      flushSync()

      const secondVisitId = sessionModel.unread('c1').state.entry?.id
      expect(secondVisitId).toBeDefined()
      expect(secondVisitId).not.toBe(firstVisitId)
      expect(sessionModel.unread('c1').state.entry?.boundary).toBe(20)
    } finally {
      navigation.destroy()
      await unmount(instance)
      sessionModel.close()
    }
  })

  it('sets the nonzero Topic entry boundary and marks the first Unread Topic Message on entering TopicView', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const mainMsgs = [1, 2, 3, 4, 5, 6].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      body: `メインメッセージ${seq}`,
    }))
    const topicMsgs = [7, 8, 9, 10, 11, 12].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      topic_id: 't1',
      body: `トピックメッセージ${seq}`,
    }))
    const t1Summary = {
      mention_unread_count: 0,
      id: 't1',
      name: 'トピックA',
      first_seq: 7,
      last_seq: 12,
      message_count: 6,
      latest_message: topicMsgs[5],
      read_seq: 8,
      unread_count: 4,
    }

    net.pages.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 12, messages: [...mainMsgs, ...topicMsgs], has_more: false })
    net.timelines.c1 = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 12,
      has_more: false,
      items: [
        ...mainMsgs.map((message) => ({ kind: 'message' as const, message })),
        { kind: 'topic' as const, topic: t1Summary },
      ],
    })
    net.topicLists.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 12, has_more: false, topics: [t1Summary] })
    net.topicSummaries['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 12, topic: t1Summary })
    net.topicMessages['c1:t1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 12, messages: topicMsgs, has_more: false })
    net.unreadChannels.c1 = {
      history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0,
      main_mention_unread_count: 0,
      ...channel('c1', 'general'),
      as_of_seq: 12,
      read_seq: 2,
      unread_count: 8,
      main_unread_count: 4,
    }

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 12)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
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
              can_deactivate_members: { allowed: true },
              can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    try {
      await settle()
      await settle()
      flushSync()

      expect(sessionModel.unread('c1').state.entry?.scope).toEqual({ channel: 'c1', topicId: null })
      expect(sessionModel.unread('c1').state.entry?.boundary).toBe(2)

      host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!.click()
      flushSync()
      await settle()
      await settle()
      flushSync()

      expect(sessionModel.unread('c1').state.entry?.scope).toEqual({ channel: 'c1', topicId: 't1' })
      expect(sessionModel.unread('c1').state.entry?.boundary).toBe(8)
      expect(host.querySelector(`#main-content [data-message-id="${topicMsgs[2].id}"] [data-read-marker="true"]`)).not.toBeNull()
    } finally {
      navigation.destroy()
      await unmount(instance)
      sessionModel.close()
    }
  })
})
