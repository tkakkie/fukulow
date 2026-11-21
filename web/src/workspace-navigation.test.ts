import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter, type ChannelsAdapter } from './channels.svelte'
import { createNavigation, type Navigation, type NavigationBrowser } from './navigation'
import { createSession } from './session'
import type { MainTimelineLine } from './topic-selectors'
import {
  createChannelSelection,
  parsePanelTab,
  parseReplyMessageId,
  resolveMobileLevel,
  resolveReplyAnchor,
  shouldClosePanelForDm,
} from './workspace-routing'

function selectionHandler(nav: Navigation, channels: ChannelsAdapter, retryAuthors = () => {}) {
  return createChannelSelection({
    getOrganizationId: () => 'org',
    getSelectedId: () => channels.state.selectedId,
    getNavigation: () => nav,
    selectChannel: (id) => channels.select(id),
    isDm: () => false,
    selectDm: () => {},
    retryAuthors,
    getCurrentUnread: () => null,
    onCloseDrawer: () => {},
  })
}

function navigation(topicId: string | null) {
  let href = `/o/org/c/A${topicId ? `/t/${topicId}` : ''}`
  const pushState = vi.fn((_state: unknown, _title: string, url: string) => { href = url })
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => { href = url })
  const nav = createNavigation({
    location: { get href() { return href } },
    history: { state: null, pushState, replaceState },
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as NavigationBrowser)
  return { nav, pushState, replaceState }
}

it.each([null, 'topic'])('explicitly selecting the current C9 Channel from view %s leaves the Topic and retries once without a loop', async topicId => {
  vi.useFakeTimers()
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
  const watch = vi.spyOn(session.sync, 'watch')
  const { nav, pushState, replaceState } = navigation(topicId)
  try {
    net.socket.onReady()
    net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(session.channels.get().selectedId).toBe('A')
    expect(nav.get().target?.topicId).toBe(topicId)
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    expect(watch).toHaveBeenCalledTimes(1)
    expect(net.history).toHaveLength(1)

    const retryAuthors = vi.fn()
    selectionHandler(nav, channelsAdapter(session.channels), retryAuthors)('A')
    expect(retryAuthors).toHaveBeenCalledOnce()
    await settle()
    expect(pushState).toHaveBeenCalledTimes(topicId ? 1 : 0)
    expect(replaceState).not.toHaveBeenCalled()
    expect(nav.get().target).toMatchObject({ channelId: 'A', topicId: null })
    expect(watch).toHaveBeenCalledTimes(2)
    expect(net.history).toHaveLength(2)
    expect(session.sync.get().channels.A.state).toBe('unavailable')

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(net.history).toHaveLength(2)
    expect(pushState).toHaveBeenCalledTimes(topicId ? 1 : 0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    nav.destroy()
    session.close()
    vi.useRealTimers()
  }
})

it.each([null, 'topic'])('explicitly selecting the current ready Channel from view %s leaves the Topic without retrying', async topicId => {
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
  const watch = vi.spyOn(session.sync, 'watch')
  const { nav, pushState, replaceState } = navigation(topicId)
  try {
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 0)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('ready')

    const retryAuthors = vi.fn()
    selectionHandler(nav, channelsAdapter(session.channels), retryAuthors)('A')
    expect(retryAuthors).toHaveBeenCalledOnce()
    await settle()
    expect(nav.get().target).toMatchObject({ channelId: 'A', topicId: null })
    expect(pushState).toHaveBeenCalledTimes(topicId ? 1 : 0)
    expect(replaceState).not.toHaveBeenCalled()
    expect(watch).toHaveBeenCalledTimes(1)
    expect(net.history).toHaveLength(1)
    expect(net.subscribeCount('A')).toBe(1)
  } finally {
    nav.destroy()
    session.close()
  }
})

describe('createChannelSelection', () => {
  it('reads live selectedId, reads Unread after selection in order before closing drawer, and skips Unread when recovery does not apply', () => {
    let selectedId: string | null = 'A'
    let orgId = 'org-1'
    const events: string[] = []
    const enterBefore = vi.fn(() => { events.push('unreadBefore.enter') })
    const enterAfter = vi.fn(() => { events.push('unreadAfter.enter') })
    const unreadBefore = { state: { stopped: false, main: { stopped: true } }, enter: enterBefore }
    const unreadAfter = { state: { stopped: false, main: { stopped: true } }, enter: enterAfter }
    let currentUnread = unreadBefore

    const openSearchResult = vi.fn(() => true)
    const navigate = vi.fn(() => true)
    const selectChannel = vi.fn((id: string) => {
      events.push(`select:${id}`)
      selectedId = id
      currentUnread = unreadAfter
    })
    const retryAuthors = vi.fn()
    const getCurrentUnread = vi.fn(() => currentUnread)
    const onCloseDrawer = vi.fn(() => { events.push('closeDrawer') })

    const handle = createChannelSelection({
      getOrganizationId: () => orgId,
      getSelectedId: () => selectedId,
      getNavigation: () => ({ navigate, openSearchResult }),
      selectChannel,
      isDm: () => false,
      selectDm: vi.fn(),
      retryAuthors,
      getCurrentUnread,
      onCloseDrawer,
    })

    const replyHit = { channelId: 'A', topicId: null, replyRootId: 'r1', messageId: 'm2', createdSeq: 2 }
    handle('A', replyHit)
    expect(retryAuthors).toHaveBeenCalledTimes(1)
    expect(openSearchResult).toHaveBeenCalledWith('org-1', replyHit)
    expect(navigate).not.toHaveBeenCalled()
    expect(enterBefore).not.toHaveBeenCalled()
    expect(enterAfter).toHaveBeenCalledWith(null)
    expect(getCurrentUnread).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['select:A', 'unreadAfter.enter', 'closeDrawer'])

    // Mutate live org and selectedId; selecting the new selectedId with a topic hit must
    // see same === true (retryAuthors called) and must not read Unread since recovery does not apply.
    events.length = 0
    orgId = 'org-2'
    selectedId = 'B'
    const otherHit = { channelId: 'B', topicId: 't1', replyRootId: null, messageId: 'm9', createdSeq: 9 }
    handle('B', otherHit)
    expect(retryAuthors).toHaveBeenCalledTimes(2)
    expect(openSearchResult).toHaveBeenLastCalledWith('org-2', otherHit)
    expect(selectChannel).toHaveBeenLastCalledWith('B')
    expect(getCurrentUnread).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['select:B', 'closeDrawer'])
  })

  it('routes DM rows through selectDm instead of selectChannel and closes the drawer', () => {
    const selectChannel = vi.fn()
    const selectDm = vi.fn()
    const onCloseDrawer = vi.fn()
    const navigate = vi.fn(() => false)
    const openSearchResult = vi.fn(() => true)
    const getCurrentUnread = vi.fn(() => null)

    const handle = createChannelSelection({
      getOrganizationId: () => 'org',
      getSelectedId: () => 'dm-1',
      getNavigation: () => ({ navigate, openSearchResult }),
      selectChannel,
      isDm: (id) => id === 'dm-1',
      selectDm,
      retryAuthors: vi.fn(),
      getCurrentUnread,
      onCloseDrawer,
    })

    handle('dm-1')
    expect(navigate).toHaveBeenCalledWith({ type: 'channel', organizationId: 'org', channelId: 'dm-1' })
    expect(selectDm).toHaveBeenCalledWith('dm-1')
    expect(selectChannel).not.toHaveBeenCalled()
    expect(getCurrentUnread).toHaveBeenCalledOnce()
    expect(onCloseDrawer).toHaveBeenCalledOnce()
  })
})

describe('resolveReplyAnchor', () => {
  const msg = (id: string, channelId: string, body: string) => ({ ...record(1, channelId), id, body })

  it('follows the exact lookup order, ignores a lastOpenedAnchor from another Channel, and reads snapshots lazily', () => {
    const lastSame = msg('m1', 'ch-1', 'last-same')
    const lastOther = msg('m1', 'ch-2', 'last-other')
    const timeline = msg('m1', 'ch-1', 'timeline')
    const topicLine = msg('m1', 'ch-1', 'topic-line')
    const routedTopic = msg('m1', 'ch-1', 'routed-topic')
    const repliesAnchor = msg('m1', 'ch-1', 'replies-anchor')
    const repliesMessage = msg('m1', 'ch-1', 'replies-message')
    const lines: MainTimelineLine[] = [
      { kind: 'topic', topicId: 't1', position: 1, baseline: null, latestMessage: msg('m1', 'ch-1', 'topic-summary'), messageCount: 1, summaryError: null },
      { kind: 'message', message: topicLine },
    ]

    const timelineSpy = vi.fn(() => [timeline])
    const topicLinesSpy = vi.fn(() => lines)
    const routedTopicSpy = vi.fn(() => [routedTopic])
    const repliesSpy = vi.fn(() => ({ anchor: repliesAnchor, messages: [repliesMessage] }))

    // When lastOpenedAnchor wins, later snapshot getters are not called.
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => lastSame,
      timelineMessages: timelineSpy,
      topicLines: topicLinesSpy,
      routedTopicMessages: routedTopicSpy,
      replies: repliesSpy,
    })).toBe(lastSame)
    expect(timelineSpy).not.toHaveBeenCalled()
    expect(topicLinesSpy).not.toHaveBeenCalled()
    expect(routedTopicSpy).not.toHaveBeenCalled()
    expect(repliesSpy).not.toHaveBeenCalled()

    // Other-Channel lastOpenedAnchor is ignored; timeline wins next.
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => lastOther,
      timelineMessages: () => [timeline],
      topicLines: () => lines,
      routedTopicMessages: () => [routedTopic],
      replies: () => ({ anchor: repliesAnchor, messages: [repliesMessage] }),
    })).toBe(timeline)

    // Topic message line wins over routed Topic and replies (summary line is ignored).
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => null,
      timelineMessages: () => [],
      topicLines: () => lines,
      routedTopicMessages: () => [routedTopic],
      replies: () => ({ anchor: repliesAnchor, messages: [repliesMessage] }),
    })).toBe(topicLine)

    // Routed Topic messages win over replies.
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => null,
      timelineMessages: () => [],
      topicLines: () => [lines[0]],
      routedTopicMessages: () => [routedTopic],
      replies: () => ({ anchor: repliesAnchor, messages: [repliesMessage] }),
    })).toBe(routedTopic)

    // Replies anchor wins over replies messages.
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => null,
      replies: () => ({ anchor: repliesAnchor, messages: [repliesMessage] }),
    })).toBe(repliesAnchor)

    // Replies messages fallback.
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => null,
      replies: () => ({ anchor: null, messages: [repliesMessage] }),
    })).toBe(repliesMessage)

    // Missing everywhere or missing inputs -> null (and getters skipped when inactive).
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'missing',
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: () => lastSame,
      timelineMessages: () => [timeline],
    })).toBeNull()
    const lastOpenedSpy = vi.fn(() => lastSame)
    expect(resolveReplyAnchor({
      activeReplyMessageId: null,
      selectedChannelId: 'ch-1',
      lastOpenedAnchor: lastOpenedSpy,
      timelineMessages: timelineSpy,
    })).toBeNull()
    expect(lastOpenedSpy).not.toHaveBeenCalled()
    expect(timelineSpy).not.toHaveBeenCalled()
    expect(resolveReplyAnchor({
      activeReplyMessageId: 'm1',
      selectedChannelId: undefined,
      lastOpenedAnchor: lastOpenedSpy,
    })).toBeNull()
    expect(lastOpenedSpy).not.toHaveBeenCalled()
  })
})

describe('resolveMobileLevel', () => {
  it('resolves channels, view, panel, and promotes channels to view while search is open', () => {
    const searchClosed = vi.fn(() => false)
    const searchOpen = vi.fn(() => true)
    expect(resolveMobileLevel(null, searchClosed)).toBe('channels')
    expect(resolveMobileLevel({ channelId: null, panel: null }, searchClosed)).toBe('channels')
    expect(resolveMobileLevel({ channelId: null, panel: null }, searchOpen)).toBe('view')
    searchOpen.mockClear()
    expect(resolveMobileLevel({ channelId: 'ch-1', panel: null }, searchClosed)).toBe('view')
    expect(resolveMobileLevel({ channelId: 'ch-1', panel: null }, searchOpen)).toBe('view')
    expect(resolveMobileLevel({ channelId: 'ch-1', panel: 'topics' }, searchClosed)).toBe('panel')
    expect(resolveMobileLevel({ channelId: 'ch-1', panel: 'reply:m1' }, searchOpen)).toBe('panel')
    expect(searchOpen).not.toHaveBeenCalled()
  })
})

describe('panel route parsing', () => {
  it('parses reply id, panel tab, and DM non-reply close predicate', () => {
    expect(parseReplyMessageId('reply:m42')).toBe('m42')
    expect(parseReplyMessageId('topics')).toBeNull()
    expect(parseReplyMessageId(null)).toBeNull()
    expect(parseReplyMessageId(undefined)).toBeNull()

    expect(parsePanelTab('topics')).toBe('topics')
    expect(parsePanelTab('overview')).toBe('overview')
    expect(parsePanelTab('members')).toBe('members')
    expect(parsePanelTab('reply:m42')).toBe('topics')
    expect(parsePanelTab(null)).toBe('topics')
    expect(parsePanelTab(undefined)).toBe('topics')

    const panelSpy = vi.fn(() => 'topics' as const)
    expect(shouldClosePanelForDm('dm', () => 'topics')).toBe(true)
    expect(shouldClosePanelForDm('dm', () => 'overview')).toBe(true)
    expect(shouldClosePanelForDm('dm', () => 'members')).toBe(true)
    expect(shouldClosePanelForDm('dm', () => 'reply:m42')).toBe(false)
    expect(shouldClosePanelForDm('dm', () => null)).toBe(false)
    expect(shouldClosePanelForDm('channel', panelSpy)).toBe(false)
    expect(shouldClosePanelForDm(undefined, panelSpy)).toBe(false)
    expect(panelSpy).not.toHaveBeenCalled()
  })
})
