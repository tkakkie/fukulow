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
// `holdHistory` also holds the view's first history read. `reopen-main` bootstraps c1 on an earlier visit so the
// held history read on re-entry is independent of the sync cursor. `olderUnread` loads only the newest Unread Messages, so the
// first Unread needs an older page, and holds each older-page read in `olderReads` until the test answers it.
// `latestOnly` loads only the latest Message with older history left, so the first Unread is on an older page; its
// older-page reads reach the fake network unheld and `olderReadCount` counts them.
// `emptyMain` opens a main timeline with no Messages and nothing Unread; `unreadRow` is what later boundary reads return.
async function openWithHeldBoundary(
  scope: Scope,
  opts: { phonePanel?: boolean; holdHistory?: boolean | 'reopen-main'; olderUnread?: boolean; latestOnly?: boolean; emptyMain?: boolean } = {},
) {
  const net = fakeNetwork()
  const options = net.options('me')
  const reopenMain = opts.holdHistory === 'reopen-main'
  // Each held older-page read answers with one more Unread Message that is still newer than the boundary.
  const olderReads: (() => void)[] = []
  const topicsApi = options.topicsApi
  if (!topicsApi) throw new Error('fakeNetwork provides topicsApi')
  const { listTimeline, listTopicMessages } = topicsApi
  if (opts.olderUnread) options.topicsApi = {
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
  const shownMain = opts.emptyMain ? [] : opts.olderUnread || opts.latestOnly ? mainMsgs.slice(2) : mainMsgs
  const shownTopic = opts.olderUnread ? topicMsgs.slice(4) : opts.latestOnly ? topicMsgs.slice(5) : topicMsgs
  const mainItems = shownMain.map((message) => ({ kind: 'message' as const, message }))
  const mainPage = ok({
    history_generation: generation,
    as_of_seq: 9,
    has_more: Boolean(opts.olderUnread || opts.latestOnly),
    items: mainItems,
  })
  const topicPage = ok({ history_generation: generation, as_of_seq: 9, messages: shownTopic, has_more: Boolean(opts.olderUnread || opts.latestOnly) })
  net.timelines.c1 = mainPage
  // No projection carries t1, so its entry boundary can come only from the held summary.
  net.topicLists.c1 = ok({ history_generation: generation, as_of_seq: 9, has_more: false, topics: [] })
  net.topicMessages['c1:t1'] = topicPage
  let releaseHistory = () => {}
  let failHistory = () => {}
  let heldMainPage = mainPage
  const historyFailure = { ok: false as const, kind: 'http' as const, status: 500, error: 'internal_error' }
  if (opts.holdHistory) {
    // Same pending-promise hold as the boundary below; only the read of the scope under test is held.
    if (scope === 'topic') {
      net.topicMessages['c1:t1'] = new Promise((resolve) => {
        releaseHistory = () => resolve(topicPage)
        failHistory = () => resolve(historyFailure)
      }) as unknown as typeof topicPage
    } else {
      heldMainPage = new Promise((resolve) => {
        releaseHistory = () => resolve(mainPage)
        failHistory = () => resolve(historyFailure)
      }) as unknown as typeof mainPage
      net.timelines.c1 = reopenMain
        ? ok({ history_generation: generation, as_of_seq: 2, has_more: false, items: mainItems.slice(0, 2) })
        : heldMainPage
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
  if (opts.emptyMain) Object.assign(unreadRow, { read_seq: 9, unread_count: 0, main_unread_count: 0 })
  // The fake API returns these values from async functions, so a pending promise holds every read of that boundary.
  let releaseBoundary!: () => void
  let failBoundary!: () => void
  const failure = { ok: false as const, kind: 'http' as const, status: 500, error: 'internal_error' }
  // Later reads of the boundary (the unread controller's retries) succeed at once.
  const succeedRetries = () => {
    if (scope === 'topic') net.topicSummaries['c1:t1'] = ok({ history_generation: generation, as_of_seq: 9, topic: t1Summary })
    else net.unreadListResult = ok({ history_generation: generation, channels: [unreadRow] })
  }
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

  const channelRows = [channel('c1', 'general')]
  if (reopenMain) channelRows.push(channel('c2', 'other'))
  net.lists[0].resolve(ok({ history_generation: generation, channels: channelRows }))
  await settle()
  net.subscribed('c1', reopenMain ? 2 : 9)
  await settle()
  if (reopenMain) {
    rawSession.channels.select('c2')
    await settle()
    net.subscribed('c2', 0)
    await settle()
    net.timelines.c1 = heldMainPage
    rawSession.channels.select('c1')
    await settle()
    net.subscribed('c1', 2)
    await settle()
  }

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
  if (reopenMain) {
    expect(rawSession.sync.get().channels.c1).toMatchObject({ watched: true, cursor: 2 })
    expect(rawSession.topics.get('c1').main.asOfSeq).toBeUndefined()
    expect(rawSession.topics.get('c1').main.loading).toBe(true)
  }


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
  // Unheld older-page reads of the opened scope.
  const olderReadCount = () => scope === 'topic'
    ? net.topicHistory.filter((h) => h.topic === 't1' && h.beforeSeq !== undefined).length
    : net.history.filter((h) => h.channel === 'c1' && h.query?.before_seq !== undefined).length
  return {
    host, net, navigation, latest, releaseBoundary, failBoundary, succeedRetries, releaseHistory, failHistory, olderReads, olderReadCount, unreadRow,
    scroll, positioning, skeletons, composer, retry, marker, boundary, cleanup, wantBoundary: scope === 'topic' ? 4 : 2, latestSeq: latest.created_seq,
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
      expect(v.net.markReads.at(-1)?.body.read_seq).toBe(v.latestSeq)
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

  it.each<Scope>(['topic', 'main'])('keeps the %s bottom fallback after a failed boundary read when the retried read later resolves the boundary', async (scope) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary(scope)
    try {
      v.failBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
      expect(v.marker()).toBeNull()

      // The failure was retryable, so the unread controller retries after its backoff and now gets the boundary.
      v.succeedRetries()
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS)
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBe(v.wantBoundary)
      // The visit already opened at the bottom, so the later boundary neither adds the marker nor moves the view (`docs/ui.md` §8).
      expect(v.marker()).toBeNull()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
      // Visible rows still count as presented, so the read position advances without the first-Unread scroll.
      expect(v.net.markReads.at(-1)?.body.read_seq).toBe(v.latestSeq)
    } finally {
      await v.cleanup()
    }
  })

  it.each<Scope>(['topic', 'main'])('stops loading older %s pages toward the first Unread once a failed boundary read opened the visit at the bottom', async (scope) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary(scope, { latestOnly: true })
    try {
      v.failBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.marker()).toBeNull()

      v.succeedRetries()
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS)
      await settle()
      await settle()
      flushSync()
      if (scope === 'topic') {
        // The failed read also failed the トピック's own details, so the view shows its error until the user retries.
        v.host.querySelector('#main-content .topic-view__banner button')!.click()
        await settle()
        await settle()
        flushSync()
      }
      expect(v.boundary()).toBe(v.wantBoundary)
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })
      // The first Unread is older than the loaded page, but the visit no longer positions there, so it pages no older history
      // toward it, which could trim the newest rows the visit is showing. The トピック's one read is the user's retry itself.
      expect(v.olderReadCount()).toBe(scope === 'topic' ? 1 : 0)
      expect(v.marker()).toBeNull()
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
  it('keeps an empty main timeline opened after a failed boundary read in place when a live Message is Unread at the retried boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const v = await openWithHeldBoundary('main', { emptyMain: true })
    try {
      v.failBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.positioning()).toEqual({ busy: false, inert: false, skeleton: false })

      const live = { ...record(10, 'c1'), id: 'm-live', sender: 'other', body: 'あとから届いたメッセージ' }
      v.net.event({ type: 'message', kind: 'create', seq: 10, message: live })
      await settle()
      flushSync()
      expect(v.host.querySelector('#main-content [data-message-id="m-live"]')).not.toBeNull()

      // The retried read sees the live Message as Unread, but the visit already opened, so it gets no marker (`docs/ui.md` §8).
      Object.assign(v.unreadRow, { as_of_seq: 10, unread_count: 1, main_unread_count: 1 })
      v.succeedRetries()
      vi.advanceTimersByTime(LOADING_TIMEOUT_MS)
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBe(9)
      expect(v.host.querySelector('#main-content [data-message-id="m-live"] [data-read-marker="true"]')).toBeNull()
    } finally {
      await v.cleanup()
    }
  })

  it('keeps waiting for the first Unread while the main history loads, even with an own send still pending', async () => {
    const v = await openWithHeldBoundary('main', { holdHistory: 'reopen-main' })
    try {
      v.releaseBoundary()
      await settle()
      await settle()
      flushSync()
      expect(v.boundary()).toBe(v.wantBoundary)
      const composer = [...v.host.querySelectorAll('#main-content textarea')].find((el) => el.getAttribute('aria-label') === 'メッセージ')!
      composer.value = '読み込み中の送信'
      composer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      v.host.querySelector('#main-content form.composer')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      await settle()
      flushSync()
      // The send is not accepted, so its pending row alone does not open the visit at the bottom (`docs/ui.md` §8).
      expect(v.net.sends.at(-1)!.body.body).toBe('読み込み中の送信')
      expect(v.positioning().busy).toBe(true)

      v.releaseHistory()
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
