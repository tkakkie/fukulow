import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { createSession } from './session'
import Workspace from './Workspace.svelte'
import { installMiniDom, queryAll } from './svelte-dom-test-helpers'
import {
  createTopicWorkspaceNavigation,
  createTopicWorkspaceSession,
  HISTORY_GENERATION,
  topicSummaryItem,
  topicWorkspaceOrganization,
} from './topic-workspace-test-helpers'

const dom = installMiniDom()

describe('Topic summary lines, TopicList and TopicView states', () => {
  it('shows initial Topic-list error and retry even when the timeline already supplied Topics', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'タイムライン既知トピック', topic_id: 't-known' }
    const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '一覧で取得される古いトピック', topic_id: 't-older' }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 2,
      has_more: true,
      items: [
        { kind: 'topic', topic: topicSummaryItem('t-known', '既知トピック', m1) },
        { kind: 'message', message: { ...record(2, 'c1'), id: 'm-root', sender: 'other', body: 'root', topic_id: null } },
      ],
    })
    net.topicLists.c1 = { ok: false, kind: 'http', status: 503 }

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

    const { navigation } = createTopicWorkspaceNavigation('/o/org-1/c/c1?panel=topics')

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
    net.subscribed('c1', 2)
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('トピック: 既知トピック')
    expect(panel.textContent).toContain('トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    const retryBtn = queryAll(panel, 'button').find((b) => b.textContent.trim() === '再試行')
    expect(retryBtn).toBeDefined()

    net.topicLists.c1 = ok({ history_generation: HISTORY_GENERATION,
      as_of_seq: 2,
      has_more: false,
      topics: [
        topicSummaryItem('t-older', '古いトピック', m2, { firstSeq: 1, lastSeq: 1 }),
        topicSummaryItem('t-known', '既知トピック', m1),
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
            const latest = { ...record(2, channelId), id: 'm-2', sender: 'other', body: '本文', topic_id: 't-retry' }
            return ok({ history_generation: HISTORY_GENERATION,
              as_of_seq: 2,
              topic: topicSummaryItem('t-retry', '再取得成功トピック', latest),
            })
          }
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'root', topic_id: null }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicLists.c1 = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 1, has_more: false, topics: [] })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

    const { navigation } = createTopicWorkspaceNavigation('/o/org-1/c/c1?panel=topics')

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
            const latest = { ...record(2, channelId), id: 'm-2', sender: 'other', body: '一時障害本文', topic_id: 't-503' }
            return ok({ history_generation: HISTORY_GENERATION,
              as_of_seq: 2,
              topic: topicSummaryItem('t-503', '手動再試行トピック', latest),
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
    const sessionModel = createTopicWorkspaceSession(rawSession)

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'root', topic_id: null }
    net.timelines.c1 = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicLists.c1 = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 1, has_more: false, topics: [] })

    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('c1', 'general')] }))

    const { navigation } = createTopicWorkspaceNavigation('/o/org-1/c/c1?panel=topics')

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
})
