import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it } from 'vitest'
import type { TopicSummary } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { createSession } from './session'
import Workspace from './Workspace.svelte'
import { installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'
import {
  createTopicWorkspaceNavigation,
  createTopicWorkspaceSession,
  HISTORY_GENERATION,
  topicSummaryItem,
  topicWorkspaceOrganization,
} from './topic-workspace-test-helpers'

const dom = installMiniDom()

describe('Topic summary lines, TopicList and TopicView states', () => {
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
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const topicMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: '遅延表示の初回本文', topic_id: 't-delayed' }
    net.topicMessages['c1:t-delayed'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([topicMsg1]).at(-1)?.created_seq ?? 0, messages: [topicMsg1], has_more: false })
    net.topicSummaries['c1:t-delayed'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 1,
      topic: topicSummaryItem('t-delayed', '遅延表示トピック', topicMsg1),
    })
    const c2TopicMsg = { ...record(1, 'c2'), id: 'm-c2-1', sender: 'other', body: '旧トピック本文', topic_id: 't-absent' }
    net.topicMessages['c2:t-absent'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([c2TopicMsg]).at(-1)?.created_seq ?? 0, messages: [c2TopicMsg], has_more: false })
    net.topicSummaries['c2:t-absent'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 1,
      topic: topicSummaryItem('t-absent', '不在トピック', c2TopicMsg),
    })
    const c3TopicMsg = { ...record(1, 'c3'), id: 'm-c3-1', sender: 'other', body: 'エラーチャンネル本文', topic_id: 't-err' }
    net.topicMessages['c3:t-err'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([c3TopicMsg]).at(-1)?.created_seq ?? 0, messages: [c3TopicMsg], has_more: false })
    net.topicSummaries['c3:t-err'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 1,
      topic: topicSummaryItem('t-err', 'エラートピック', c3TopicMsg),
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general'), channel('c2', 'other'), channel('c3', 'broken')] }))

    const { navigation, getHref } = createTopicWorkspaceNavigation('/o/org-1/c/c1/t/t-delayed')

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

    expect(getHref()).toBe('/o/org-1/c/c1')
    expect(host.querySelector('#main-content [data-topic-id="t-delayed"]')).toBeNull()
    const c1MainComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!

    // Resolve the delayed main timeline load -> summary line renders and receives focus (not Composer)
    resolveC1Timeline(
      ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 1,
        has_more: false,
        items: [
          { kind: 'topic', topic: topicSummaryItem('t-delayed', '遅延表示トピック', topicMsg1) },
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
    expect(getHref()).toBe('/o/org-1/c/c2/t/t-absent')

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
      ok({ history_generation: HISTORY_GENERATION,
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
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const topicMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'me', body: 'キーボード初回投稿', topic_id: 't-kbd' }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 1,
      has_more: false,
      items: [
        { kind: 'topic', topic: topicSummaryItem('t-kbd', 'キーボード議題', topicMsg1) },
      ],
    })
    net.topicMessages['c1:t-kbd'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([topicMsg1]).at(-1)?.created_seq ?? 0, messages: [topicMsg1], has_more: false })
    net.topicSummaries['c1:t-kbd'] = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 1,
      topic: topicSummaryItem('t-kbd', 'キーボード議題', topicMsg1),
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

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
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'c1本文', topic_id: 't-1' }
    const m2 = { ...record(1, 'c2'), id: 'm-2', sender: 'other', body: 'c2本文', topic_id: 't-2' }
    for (const [ch, tid, msg] of [
      ['c1', 't-1', m1],
      ['c2', 't-2', m2],
    ] as const) {
      net.topicMessages[`${ch}:${tid}`] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([msg]).at(-1)?.created_seq ?? 0, messages: [msg], has_more: false })
      net.topicSummaries[`${ch}:${tid}`] = ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 1,
        topic: topicSummaryItem(tid, `トピック-${tid}`, msg),
      })
    }

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general'), channel('c2', 'other')] }))

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
      ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 1,
        has_more: false,
        items: [
          { kind: 'topic', topic: topicSummaryItem('t-1', 'トピック-t-1', m1) },
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
      ok({ history_generation: HISTORY_GENERATION,
        as_of_seq: 1,
        has_more: false,
        items: [
          { kind: 'topic', topic: topicSummaryItem('t-2', 'トピック-t-2', m2) },
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
})
