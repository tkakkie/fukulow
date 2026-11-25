import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Result, TopicSummaryResponse, UnreadChannel } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { LOADING_TIMEOUT_MS } from './announcements'
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
// The fake network answers with this history generation; another value would read as a reset.
const generation = '00000000-0000-4000-8000-000000000515'

afterEach(() => {
  vi.useRealTimers()
})

async function step() {
  await settle()
  await settle()
  flushSync()
}

type Scope = 'main' | 'topic'
const views = {
  main: { href: '/o/org-1/c/c1', scroll: '.timeline-scroll', overlay: '.timeline-positioning [aria-label="メッセージを読み込み中"]' },
  topic: { href: '/o/org-1/c/c1/t/t1', scroll: '.topic-view__scroll', overlay: '.topic-view__positioning [aria-label="トピックを読み込み中"]' },
} as const

// Opens Workspace directly on an Unread scope of c1 while that scope's entry boundary read is held:
// the Unread Channel list for the main timeline, the トピック summary for トピック t1.
// `holdHistory` also holds the view's first history read; `olderUnread` loads only the newest Unread Messages, so the
// first Unread needs an older page, and holds each older-page read in `olderReads` until the test answers it.
async function openWithHeldBoundary(scope: Scope, opts: { phonePanel?: boolean; holdHistory?: boolean; olderUnread?: boolean } = {}) {
  const net = fakeNetwork()
  const options = net.options('me')
  // Each held older-page read answers with one more Unread Message that is still newer than the boundary.
  const olderReads: (() => void)[] = []
  const topicsApi = options.topicsApi
  if (!topicsApi) throw new Error('fakeNetwork provides topicsApi')
  const { listTimeline, listTopicMessages } = topicsApi
  options.topicsApi = {
    ...topicsApi,
    listTimeline: (c, q, signal) => q?.before_position === undefined ? listTimeline(c, q, signal) : new Promise((resolve) => {
      const message = { ...record(5, 'c1'), id: 'main-older-5', sender: 'other' }
      olderReads.push(() => resolve(ok({ history_generation: generation, as_of_seq: 9, has_more: true, items: [{ kind: 'message' as const, message }] })))
    }),
    listTopicMessages: (c, t, q, signal) => q?.before_seq === undefined ? listTopicMessages(c, t, q, signal) : new Promise((resolve) => {
      olderReads.push(() => resolve(ok({ history_generation: generation, as_of_seq: 9, has_more: true, messages: [topicMsgs[3]] })))
    }),
  }
  const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...options })
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

  const mainMsgs = [1, 2, 9].map((seq) => ({ ...record(seq, 'c1'), sender: 'other', body: `メインメッセージ${seq}` }))
  const topicMsgs = [3, 4, 5, 6, 7, 8].map((seq) => ({
    ...record(seq, 'c1'),
    sender: 'other',
    topic_id: 't1',
    body: `トピックメッセージ${seq}`,
  }))
  const t1Summary = {
    mention_unread_count: 0,
    id: 't1',
    name: 'トピックA',
    first_seq: 3,
    last_seq: 8,
    message_count: 6,
    latest_message: topicMsgs[5],
    read_seq: 4,
    unread_count: 4,
  }
  net.pages.c1 = ok({ history_generation: generation, as_of_seq: 9, messages: mainMsgs, has_more: false })
  const shownMain = opts.olderUnread ? mainMsgs.slice(2) : mainMsgs
  const shownTopic = opts.olderUnread ? topicMsgs.slice(4) : topicMsgs
  const mainPage = ok({
    history_generation: generation,
    as_of_seq: 9,
    has_more: Boolean(opts.olderUnread),
    items: shownMain.map((message) => ({ kind: 'message' as const, message })),
  })
  const topicPage = ok({ history_generation: generation, as_of_seq: 9, messages: shownTopic, has_more: Boolean(opts.olderUnread) })
  net.timelines.c1 = mainPage
  // No projection carries t1, so its entry boundary can come only from the held summary.
  net.topicLists.c1 = ok({ history_generation: generation, as_of_seq: 9, has_more: false, topics: [] })
  net.topicMessages['c1:t1'] = topicPage
  let releaseHistory = () => {}
  let failHistory = () => {}
  const historyFailure = { ok: false as const, kind: 'http' as const, status: 500, error: 'internal_error' }
  if (opts.holdHistory) {
    // Same pending-promise hold as the boundary below; only the read of the scope under test is held.
    if (scope === 'topic') {
      net.topicMessages['c1:t1'] = new Promise((resolve) => {
        releaseHistory = () => resolve(topicPage)
        failHistory = () => resolve(historyFailure)
      }) as unknown as typeof topicPage
    } else {
      net.timelines.c1 = new Promise((resolve) => {
        releaseHistory = () => resolve(mainPage)
        failHistory = () => resolve(historyFailure)
      }) as unknown as typeof mainPage
    }
  }
  const unreadRow = {
    history_generation: generation,
    mention_unread_count: 0,
    main_mention_unread_count: 0,
    ...channel('c1', 'general'),
    as_of_seq: 9,
    read_seq: 2,
    unread_count: 5,
    main_unread_count: 1,
  }
  net.unreadChannels.c1 = unreadRow
  // The fake API returns these values from async functions, so a pending promise holds every read of that boundary.
  let releaseBoundary!: () => void
  let failBoundary!: () => void
  const failure = { ok: false as const, kind: 'http' as const, status: 500, error: 'internal_error' }
  if (scope === 'topic') {
    net.topicSummaries['c1:t1'] = new Promise<Result<TopicSummaryResponse>>((resolve) => {
      releaseBoundary = () => resolve(ok({ history_generation: generation, as_of_seq: 9, topic: t1Summary }))
      failBoundary = () => resolve(failure)
    }) as unknown as Result<TopicSummaryResponse>
  } else {
    net.topicSummaries['c1:t1'] = ok({ history_generation: generation, as_of_seq: 9, topic: t1Summary })
    net.unreadListResult = new Promise<Result<{ history_generation: string; channels: UnreadChannel[] }>>((resolve) => {
      releaseBoundary = () => resolve(ok({ history_generation: generation, channels: [unreadRow] }))
      failBoundary = () => resolve(failure)
    }) as unknown as Result<{ history_generation: string; channels: UnreadChannel[] }>
  }

  net.lists[0].resolve(ok({ history_generation: generation, channels: [channel('c1', 'general')] }))
  await settle()
  net.subscribed('c1', 9)
  await settle()

  if (opts.phonePanel) dom.win.innerWidth = 375
  let href: string = opts.phonePanel ? `${views[scope].href}?panel=topics` : views[scope].href
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
  await settle()
  await settle()
  flushSync()


  const scroll = () => host.querySelector(`#main-content ${views[scope].scroll}`)!
  const positioning = () => {
    const el = scroll()
    return {
      busy: el.getAttribute('aria-busy') === 'true',
      inert: Boolean((el as unknown as { inert?: boolean }).inert) || el.hasAttribute('inert'),
      skeleton: host.querySelector(`#main-content ${views[scope].overlay}`) !== null,
    }
  }
  const skeletons = () => host.querySelectorAll(`#main-content [aria-label="${scope === 'topic' ? 'トピックを読み込み中' : 'メッセージを読み込み中'}"]`).length
  const composer = () => [...host.querySelectorAll('#main-content textarea')].find((el) => el.getAttribute('aria-label') === 'メッセージ')!
  const retry = () => [...host.querySelectorAll('#main-content button')].find((b) => b.textContent.trim() === '再試行')
  const firstUnread = scope === 'topic' ? topicMsgs[2] : mainMsgs[2]
  const latest = scope === 'topic' ? topicMsgs[5] : mainMsgs[2]
  const marker = () => host.querySelector(`#main-content [data-message-id="${firstUnread.id}"] [data-read-marker="true"]`)
  const boundary = () => {
    const entry = sessionModel.unread('c1').state.entry
    return entry?.scope.topicId === (scope === 'topic' ? 't1' : null) ? entry.boundary : null
  }
  const cleanup = async () => {
    navigation.destroy()
    dom.win.innerWidth = 1280
    await unmount(instance)
    sessionModel.close()
  }
  return {
    host, net, navigation, latest, releaseBoundary, failBoundary, releaseHistory, failHistory, olderReads, scroll, positioning, skeletons, composer, retry,
    marker, boundary, cleanup, wantBoundary: scope === 'topic' ? 4 : 2,
  }
}

describe('Entry position before the first-Unread boundary resolves (#968)', () => {
  it.each<Scope>(['topic', 'main'])('keeps %s rows hidden and inert behind a Skeleton until the delayed boundary positions the view at the first Unread', async (scope) => {
    const v = await openWithHeldBoundary(scope)
    try {
      // The rows are already mounted (positioning needs them), but nobody can see, scroll or activate them yet.
      expect(v.scroll().querySelector(`[data-message-id="${v.latest.id}"]`)).not.toBeNull()
      expect(v.positioning()).toEqual({ busy: true, inert: true, skeleton: true })
      expect(v.boundary()).toBeNull()

      v.releaseBoundary()
      await settle()
      await settle()
      flushSync()

      expect(v.boundary()).toBe(v.wantBoundary)
      expect(v.marker()).not.toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('falls back to the %s bottom without a marker after the loading timeout, and a boundary arriving later does not move the view', async (scope) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary(scope)
    try {
      expect(v.positioning().busy).toBe(true)

      vi.advanceTimersByTime(LOADING_TIMEOUT_MS)
      await settle()
      await settle()
      flushSync()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
      expect(v.marker()).toBeNull()

      v.releaseBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBe(v.wantBoundary)
      expect(v.marker()).toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
    } finally {
      await v.cleanup()
    }
  })
  it.each<Scope>(['topic', 'main'])('falls back to the %s bottom without a marker as soon as the boundary read fails', async (scope) => {
    const v = await openWithHeldBoundary(scope)
    try {
      expect(v.positioning().busy).toBe(true)
      v.failBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBeNull()
      expect(v.marker()).toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('starts the %s loading timeout only once a phone panel stops hiding the view, so the first Unread survives a long panel stay', async (scope) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary(scope, { phonePanel: true })
    try {
      v.releaseBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBe(v.wantBoundary)
      // The panel hides the view, which defers positioning to its display; that wait is the user's, not a load.
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS * 2)
      await settle()
      flushSync()
      expect(v.positioning().busy).toBe(true)

      v.navigation.navigate({ type: 'close' })
      await settle()
      await settle()
      flushSync()
      expect(v.marker()).not.toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
    } finally {
      await v.cleanup()
    }
  })
  // A トピック send needs the トピック name, which the held summary also carries, so only the main timeline can send here.
  it('opens at the bottom on an own send while positioning, and the boundary arriving later does not move the view', async () => {
    const v = await openWithHeldBoundary('main')
    try {
      expect(v.positioning().busy).toBe(true)
      const composer = v.composer()
      composer.value = '位置決め中の送信'
      composer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      v.host.querySelector('#main-content form.composer')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      await settle()
      flushSync()
      const sent = v.net.sends.at(-1)!
      expect(sent.body.body).toBe('位置決め中の送信')
      // The send is your action once accepted (`docs/ui.md` §8), so its acceptance ends the wait for the entry position.
      sent.resolve(ok({ ...record(10, 'c1'), id: 'm-10', sender: 'me', body: '位置決め中の送信', client_message_id: sent.body.client_message_id }))
      await settle()
      await settle()
      flushSync()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })

      v.releaseBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBe(v.wantBoundary)
      expect(v.marker()).toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
    } finally {
      await v.cleanup()
    }
  })

  // Review findings on #976: each case below fails without its fix.
  it.each<Scope>(['topic', 'main'])('shows exactly one Skeleton while the %s view positions with no rows yet', async (scope) => {
    const v = await openWithHeldBoundary(scope, { holdHistory: true })
    try {
      // The inner loading Skeleton sits in the hidden scroll container, so only the overlay can be seen.
      expect(v.scroll().querySelector('[data-message-id]')).toBeNull()
      expect(v.positioning()).toEqual({ busy: true, inert: true, skeleton: true })
      expect(v.skeletons()).toBe(1)

      v.releaseHistory()
      await step()
      expect(v.scroll().querySelector(`[data-message-id="${v.latest.id}"]`)).not.toBeNull()
      expect(v.positioning()).toEqual({ busy: true, inert: true, skeleton: true })
      expect(v.skeletons()).toBe(1)

      v.releaseBoundary()
      await step()
      expect(v.marker()).not.toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
      expect(v.skeletons()).toBe(0)
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('shows the retryable error instead of the positioning Skeleton when the first %s history read fails', async (scope) => {
    const v = await openWithHeldBoundary(scope, { holdHistory: true })
    try {
      v.failHistory()
      await step()
      expect(v.retry()).toBeDefined()
      expect(v.skeletons()).toBe(0)
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('loads an older %s page while positioning when the first Unread is older than the loaded rows', async (scope) => {
    const v = await openWithHeldBoundary(scope, { olderUnread: true })
    try {
      expect(v.olderReads).toEqual([])
      v.releaseBoundary()
      await step()
      expect(v.boundary()).toBe(v.wantBoundary)
      expect(v.olderReads).toHaveLength(1)
      expect(v.positioning().busy).toBe(true)
    } finally {
      await v.cleanup()
    }
  })

  // A トピック summary still held at the loading timeout fails the トピック itself, so the boundary arrives first here and
  // the timeout abandons positioning with an older page in flight.
  it.each<Scope>(['topic', 'main'])('loads no further older %s page for the first Unread once the loading timeout abandoned positioning', async (scope) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary(scope, { olderUnread: true })
    try {
      v.releaseBoundary()
      await step()
      expect(v.olderReads).toHaveLength(1)

      vi.advanceTimersByTime(LOADING_TIMEOUT_MS)
      await step()
      expect(v.positioning().busy).toBe(false)

      // The page in flight still leaves the first Unread older than the loaded rows.
      v.olderReads[0]()
      await step()
      expect(v.olderReads).toHaveLength(1)
      expect(v.marker()).toBeNull()
      expect(v.positioning().busy).toBe(false)
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('positions the %s view at the first Unread after 再試行 following an initial-load timeout', async (scope) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary(scope, { holdHistory: true })
    try {
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS)
      await step()
      const retry = v.retry()
      expect(retry).toBeDefined()
      retry!.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
      await step()
      expect(v.positioning()).toEqual({ busy: true, inert: true, skeleton: true })

      v.releaseHistory()
      v.releaseBoundary()
      await step()
      expect(v.boundary()).toBe(v.wantBoundary)
      expect(v.marker()).not.toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('keeps focus in the empty %s Composer on ↑ while positioning', async (scope) => {
    const v = await openWithHeldBoundary(scope)
    try {
      expect(v.positioning().busy).toBe(true)
      const composer = v.composer()
      composer.focus()
      const up = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      up.key = 'ArrowUp'
      composer.dispatchEvent(up)
      await step()
      expect(dom.doc.activeElement).toBe(composer)
    } finally {
      await v.cleanup()
    }
  })
})
