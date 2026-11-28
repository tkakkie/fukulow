import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTimelineScrollController } from './timeline-scroll'
import {
  createTimelineViewController,
  isDocumentVisible,
  type TimelinePresentationState,
  type TimelineRowWindow,
} from './timeline-view'

type FakeRow = {
  id: string
  seq?: number
  top: number
  bottom: number
  width?: number
  height?: number
}

function makeFakeRowNode(row: FakeRow): HTMLElement {
  const height = row.height ?? Math.max(0, row.bottom - row.top)
  const width = row.width ?? 300
  return {
    getAttribute(name: string) {
      if (name === 'data-message-id') return row.id
      if (name === 'data-confirmed-seq') return row.seq !== undefined ? String(row.seq) : null
      return null
    },
    getBoundingClientRect() {
      return { top: row.top, bottom: row.bottom, width, height }
    },
    closest(selector: string) {
      return selector === '[data-message-id]' ? this : null
    },
  } as unknown as HTMLElement
}

function makeFakeScrollContainer(opts: {
  rows?: FakeRow[]
  top?: number
  bottom?: number
  width?: number
  height?: number
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
} = {}) {
  let rows = opts.rows ?? []
  const top = opts.top ?? 0
  const height = opts.height ?? 400
  const bottom = opts.bottom ?? top + height
  const width = opts.width ?? 600
  const el = {
    scrollTop: opts.scrollTop ?? 0,
    scrollHeight: opts.scrollHeight ?? 1000,
    clientHeight: opts.clientHeight ?? height,
    getBoundingClientRect() {
      return { top, bottom, width, height }
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-message-id]') {
        return rows.map(makeFakeRowNode)
      }
      if (selector === '[data-confirmed-seq]') {
        return rows.filter((r) => r.seq !== undefined).map(makeFakeRowNode)
      }
      return []
    },
    querySelector(selector: string) {
      const match = selector.match(/^\[data-message-id="(.+)"\]$/)
      if (match) {
        const found = rows.find((r) => r.id === match[1])
        return found ? makeFakeRowNode(found) : null
      }
      return null
    },
  } as unknown as HTMLElement
  return {
    el,
    setRows(next: FakeRow[]) {
      rows = next
    },
  }
}

function makeKeyEvent(rowId: string | null, key: string): KeyboardEvent {
  const preventDefault = vi.fn()
  const currentTarget = {
    closest(selector: string) {
      if (selector !== '[data-message-id]' || rowId === null) return null
      return { getAttribute: (name: string) => (name === 'data-message-id' ? rowId : null) }
    },
  }
  return {
    key,
    currentTarget,
    preventDefault,
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  } as unknown as KeyboardEvent
}

const origDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
const origCssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')

function setVisibilityState(state: string | undefined) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: state },
  })
}

function clearDocument() {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: undefined,
  })
}

beforeEach(() => {
  setVisibilityState('visible')
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (s: string) => s },
  })
})

afterEach(() => {
  if (origDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', origDocumentDescriptor)
  } else {
    delete (globalThis as { document?: unknown }).document
  }
  if (origCssDescriptor) {
    Object.defineProperty(globalThis, 'CSS', origCssDescriptor)
  } else {
    delete (globalThis as { CSS?: unknown }).CSS
  }
})

describe('timeline-view: isDocumentVisible', () => {
  it('returns true when document is absent, visible, or visibilityState is undefined, and false when hidden', () => {
    clearDocument()
    expect(isDocumentVisible()).toBe(true)

    setVisibilityState('visible')
    expect(isDocumentVisible()).toBe(true)

    setVisibilityState(undefined)
    expect(isDocumentVisible()).toBe(true)

    setVisibilityState('hidden')
    expect(isDocumentVisible()).toBe(false)
  })
})

describe('timeline-view: reportPresented per scope (docs/ui.md §8)', () => {
  function basePresentation(
    expectedTopicId: string | null,
    overrides: Partial<TimelinePresentationState> = {},
  ): TimelinePresentationState {
    return {
      awaitingInitialSenders: false,
      viewSelected: true,
      targetUnavailable: false,
      expectedTopicId,
      entry: {
        id: Symbol('visit'),
        scope: { topicId: expectedTopicId },
        boundary: 5,
        unreadAtEntry: 0,
      },
      searchActive: false,
      searchReady: false,
      initialScrollApplied: true,
      skipUnreadVisit: false,
      needsOlderUnreadPage: false,
      entryPositionAbandoned: false,
      firstUnreadMessageId: null,
      scrolledFirstUnreadId: null,
      onPresented: vi.fn(),
      ...overrides,
    }
  }

  for (const scope of [
    { label: 'main', topicId: null, wrongTopicId: 't-other' },
    { label: 'topic', topicId: 't-1', wrongTopicId: null },
  ] as const) {
    it(`[${scope.label}] reports visible confirmed seqs when ready and rejects mismatched scope`, () => {
      const scrollController = createTimelineScrollController()
      const container = makeFakeScrollContainer({
        rows: [
          { id: 'm-1', seq: 1, top: -100, bottom: -20 },
          { id: 'm-2', seq: 2, top: 20, bottom: 80 },
          { id: 'm-3', seq: 3, top: 90, bottom: 150 },
        ],
      })
      let presentation = basePresentation(scope.topicId)
      const ctrl = createTimelineViewController({
        scrollController,
        getScrollEl: () => container.el,
        getRowWindow: () => null,
        getFocusableMessageIds: () => ['m-1', 'm-2', 'm-3'],
        setActiveRowId: () => {},
        afterUpdate: async () => {},
        getPresentation: () => presentation,
      })

      ctrl.reportPresented()
      expect(presentation.onPresented).toHaveBeenCalledTimes(1)
      expect(presentation.onPresented).toHaveBeenCalledWith(presentation.entry!.id, [2, 3])

      // Mismatched entry scope is rejected
      const mismatched = basePresentation(scope.topicId, {
        entry: { id: Symbol('wrong'), scope: { topicId: scope.wrongTopicId }, boundary: 5, unreadAtEntry: 0 },
      })
      presentation = mismatched
      ctrl.reportPresented()
      expect(mismatched.onPresented).not.toHaveBeenCalled()

      scrollController.destroy()
    })
  }

  it('enforces all presentation guards (senders, display, unavailable, visibility, search, unread positioning)', () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      rows: [{ id: 'm-1', seq: 1, top: 10, bottom: 60 }],
    })
    let presentation: TimelinePresentationState | null = basePresentation(null)
    let scrollEl: HTMLElement | null = container.el
    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => scrollEl,
      getRowWindow: () => null,
      getFocusableMessageIds: () => ['m-1'],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
      getPresentation: () => presentation,
    })

    const assertBlocked = (patch: Partial<TimelinePresentationState>) => {
      const onPresented = vi.fn()
      presentation = basePresentation(null, { ...patch, onPresented })
      ctrl.reportPresented()
      expect(onPresented).not.toHaveBeenCalled()
    }

    assertBlocked({ awaitingInitialSenders: true })
    assertBlocked({ viewSelected: false })
    assertBlocked({ targetUnavailable: true })
    assertBlocked({ entry: null })

    // Hidden document blocks reporting
    setVisibilityState('hidden')
    assertBlocked({})
    setVisibilityState('visible')

    // Zero-geometry container blocks reporting
    scrollEl = makeFakeScrollContainer({ width: 0, height: 0, rows: [{ id: 'm-1', seq: 1, top: 10, bottom: 60 }] }).el
    assertBlocked({})
    scrollEl = container.el

    // Search requires initialScrollApplied && searchReady
    assertBlocked({ searchActive: true, searchReady: false, initialScrollApplied: true })
    assertBlocked({ searchActive: true, searchReady: true, initialScrollApplied: false })
    const onSearchOk = vi.fn()
    presentation = basePresentation(null, {
      searchActive: true,
      searchReady: true,
      initialScrollApplied: true,
      onPresented: onSearchOk,
    })
    ctrl.reportPresented()
    expect(onSearchOk).toHaveBeenCalledWith(presentation.entry!.id, [1])

    // Non-search, !skipUnreadVisit guards
    assertBlocked({ entry: { id: Symbol('v'), scope: { topicId: null }, boundary: null, unreadAtEntry: 0 } })
    assertBlocked({ needsOlderUnreadPage: true })
    assertBlocked({ initialScrollApplied: false })

    // Unread at entry (> 0) requires scrolledFirstUnreadId === firstUnreadMessageId unless abandoned
    assertBlocked({
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      firstUnreadMessageId: 'm-1',
      scrolledFirstUnreadId: null,
    })
    assertBlocked({
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      firstUnreadMessageId: null,
      scrolledFirstUnreadId: null,
    })
    const onUnreadMatched = vi.fn()
    presentation = basePresentation(null, {
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      firstUnreadMessageId: 'm-1',
      scrolledFirstUnreadId: 'm-1',
      onPresented: onUnreadMatched,
    })
    ctrl.reportPresented()
    expect(onUnreadMatched).toHaveBeenCalledTimes(1)

    // Abandoned entry position falls back to initialScrollApplied
    assertBlocked({
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      entryPositionAbandoned: true,
      initialScrollApplied: false,
    })
    const onAbandonedReady = vi.fn()
    presentation = basePresentation(null, {
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      entryPositionAbandoned: true,
      initialScrollApplied: true,
      onPresented: onAbandonedReady,
    })
    ctrl.reportPresented()
    expect(onAbandonedReady).toHaveBeenCalledTimes(1)

    // skipUnreadVisit bypasses boundary / initialScrollApplied checks
    const onSkipUnread = vi.fn()
    presentation = basePresentation(null, {
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: null, unreadAtEntry: 3 },
      skipUnreadVisit: true,
      initialScrollApplied: false,
      onPresented: onSkipUnread,
    })
    ctrl.reportPresented()
    expect(onSkipUnread).toHaveBeenCalledTimes(1)

    // Empty visible confirmed seqs does not call onPresented
    container.setRows([])
    const onEmpty = vi.fn()
    presentation = basePresentation(null, { onPresented: onEmpty })
    ctrl.reportPresented()
    expect(onEmpty).not.toHaveBeenCalled()

    scrollController.destroy()
  })

  it('ReplyPanel configuration (no getPresentation) never measures or reports a read position (docs/ui.md §8)', async () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      rows: [
        { id: 'r-1', seq: 10, top: 10, bottom: 60 },
        { id: 'r-2', seq: 11, top: 70, bottom: 120 },
      ],
    })
    const queryAllSpy = vi.spyOn(container.el, 'querySelectorAll')
    const loadLatest = vi.fn(async () => {})
    const replyCtrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => null,
      getFocusableMessageIds: () => ['r-1', 'r-2'],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
      revealBeforeApply: false,
      hasNewer: () => true,
      loadLatest,
    })

    replyCtrl.reportPresented()
    replyCtrl.applyScrollAction('scroll_bottom', null)
    await replyCtrl.jumpToBottom()

    expect(loadLatest).toHaveBeenCalledTimes(1)
    expect(container.el.scrollTop).toBe(container.el.scrollHeight)
    const confirmedSeqQueries = queryAllSpy.mock.calls.filter(([sel]) => sel === '[data-confirmed-seq]')
    expect(confirmedSeqQueries).toHaveLength(0)
    scrollController.destroy()
  })
})

describe('timeline-view: focusMessage and handleRowKeydown', () => {
  it('focuses and reveals target row, and blocks while positioning or when id is empty', async () => {
    const scrollController = createTimelineScrollController()
    const reveal = vi.fn(async () => {})
    const setActiveRowId = vi.fn()
    let positioning = true
    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => null,
      getRowWindow: () => ({ reveal }),
      getFocusableMessageIds: () => ['m-1', 'm-2', 'm-3'],
      setActiveRowId,
      afterUpdate: async () => {},
      isPositioning: () => positioning,
    })

    await ctrl.focusMessage('m-2')
    expect(setActiveRowId).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()

    positioning = false
    await ctrl.focusMessage(undefined)
    await ctrl.focusMessage('')
    expect(setActiveRowId).not.toHaveBeenCalled()

    await ctrl.focusMessage('m-2')
    expect(setActiveRowId).toHaveBeenCalledWith('m-2')
    expect(reveal).toHaveBeenCalledWith('m-2', true)

    scrollController.destroy()
  })

  it('navigates focusable rows on ArrowUp/ArrowDown/Home/End and ignores non-navigation keys', async () => {
    const scrollController = createTimelineScrollController()
    const reveal = vi.fn(async () => {})
    const active: string[] = []
    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => null,
      getRowWindow: () => ({ reveal }),
      getFocusableMessageIds: () => ['m-1', 'm-2', 'm-3'],
      setActiveRowId: (id) => active.push(id),
      afterUpdate: async () => {},
    })

    const down = makeKeyEvent('m-1', 'ArrowDown')
    ctrl.handleRowKeydown(down)
    await Promise.resolve()
    expect(down.preventDefault).toHaveBeenCalledTimes(1)
    expect(active).toEqual(['m-2'])
    expect(reveal).toHaveBeenLastCalledWith('m-2', true)

    const end = makeKeyEvent('m-1', 'End')
    ctrl.handleRowKeydown(end)
    await Promise.resolve()
    expect(end.preventDefault).toHaveBeenCalledTimes(1)
    expect(active).toEqual(['m-2', 'm-3'])

    const unrelated = makeKeyEvent('m-2', 'a')
    ctrl.handleRowKeydown(unrelated)
    expect(unrelated.preventDefault).not.toHaveBeenCalled()
    expect(active).toEqual(['m-2', 'm-3'])

    scrollController.destroy()
  })
})

describe('timeline-view: revealScrollTarget, captureCurrentAnchor and applyScrollAction', () => {
  it('revealScrollTarget reveals unmounted targets for unread, search anchor, and preserve_anchor only', async () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      rows: [{ id: 'm-mounted', seq: 1, top: 0, bottom: 50 }],
    })
    const reveal = vi.fn(async () => {})
    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => ({ reveal }),
      getFocusableMessageIds: () => [],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
    })

    await ctrl.revealScrollTarget('scroll_first_unread', null, 'm-mounted')
    expect(reveal).not.toHaveBeenCalled()

    await ctrl.revealScrollTarget('scroll_first_unread', null, 'm-unread')
    expect(reveal).toHaveBeenLastCalledWith('m-unread')

    await ctrl.revealScrollTarget('scroll_search_anchor', null, 'm-search')
    expect(reveal).toHaveBeenLastCalledWith('m-search')

    await ctrl.revealScrollTarget('preserve_anchor', { messageId: 'm-anchor', offsetTop: 12 })
    expect(reveal).toHaveBeenLastCalledWith('m-anchor')

    await ctrl.revealScrollTarget('scroll_bottom', { messageId: 'm-anchor', offsetTop: 12 }, 'm-unread')
    expect(reveal).toHaveBeenCalledTimes(3)

    scrollController.destroy()
  })

  it('captureCurrentAnchor measures container items and no-ops when scrollEl is null', () => {
    const scrollController = createTimelineScrollController()
    const captureSpy = vi.spyOn(scrollController, 'captureAnchor')
    const container = makeFakeScrollContainer({
      top: 100,
      rows: [
        { id: 'm-1', seq: 1, top: 80, bottom: 130 },
        { id: 'm-2', seq: 2, top: 140, bottom: 200 },
      ],
    })
    let scrollEl: HTMLElement | null = null
    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => scrollEl,
      getRowWindow: () => null,
      getFocusableMessageIds: () => [],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
    })

    ctrl.captureCurrentAnchor()
    expect(captureSpy).not.toHaveBeenCalled()

    scrollEl = container.el
    ctrl.captureCurrentAnchor()
    expect(captureSpy).toHaveBeenCalledWith([
      { id: 'm-1', top: -20, bottom: 30 },
      { id: 'm-2', top: 40, bottom: 100 },
    ])

    scrollController.destroy()
  })

  it('applyScrollAction reveals unmounted targets then applies scroll and reports presented, while reply mode applies directly', async () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      scrollTop: 200,
      rows: [{ id: 'm-1', seq: 1, top: 0, bottom: 50 }],
    })
    const onPresented = vi.fn()
    const reveal: TimelineRowWindow['reveal'] = vi.fn(async (id: string) => {
      container.setRows([
        { id: 'm-1', seq: 1, top: 0, bottom: 50 },
        { id, seq: 2, top: 150, bottom: 210 },
      ])
    })
    const mainCtrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => ({ reveal }),
      getFocusableMessageIds: () => ['m-1', 'm-2'],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
      getPresentation: () => ({
        awaitingInitialSenders: false,
        viewSelected: true,
        targetUnavailable: false,
        expectedTopicId: null,
        entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 0 },
        searchActive: false,
        searchReady: false,
        initialScrollApplied: true,
        skipUnreadVisit: false,
        needsOlderUnreadPage: false,
        entryPositionAbandoned: false,
        firstUnreadMessageId: null,
        scrolledFirstUnreadId: null,
        onPresented,
      }),
    })

    mainCtrl.applyScrollAction('preserve_anchor', { messageId: 'm-2', offsetTop: 10 })
    expect(reveal).toHaveBeenCalledWith('m-2')
    await Promise.resolve()
    await Promise.resolve()
    // 200 + (150 - 10) = 340
    expect(container.el.scrollTop).toBe(340)
    expect(onPresented).toHaveBeenCalledTimes(1)

    // ReplyPanel mode (`revealBeforeApply: false`) never calls reveal
    const replyReveal = vi.fn(async () => {})
    const replyCtrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => ({ reveal: replyReveal }),
      getFocusableMessageIds: () => [],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
      revealBeforeApply: false,
    })
    replyCtrl.applyScrollAction('preserve_anchor', { messageId: 'm-missing', offsetTop: 0 })
    expect(replyReveal).not.toHaveBeenCalled()

    scrollController.destroy()
  })
})

describe('timeline-view: jumpToBottom and loadOlderWithAnchor per scope', () => {
  it('jumpToBottom exits search, loads latest when needed, scrolls to bottom and reports presented', async () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      scrollTop: 50,
      scrollHeight: 900,
      rows: [{ id: 'm-1', seq: 1, top: 10, bottom: 60 }],
    })
    const events: string[] = []
    let searchActive = true
    let hasNewer = false
    const onPresented = vi.fn(() => events.push('presented'))

    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => null,
      getFocusableMessageIds: () => ['m-1'],
      setActiveRowId: () => {},
      afterUpdate: async () => {
        events.push('tick')
      },
      getPresentation: () => ({
        awaitingInitialSenders: false,
        viewSelected: true,
        targetUnavailable: false,
        expectedTopicId: 't-1',
        entry: { id: Symbol('t'), scope: { topicId: 't-1' }, boundary: 5, unreadAtEntry: 0 },
        searchActive,
        searchReady: true,
        initialScrollApplied: true,
        skipUnreadVisit: false,
        needsOlderUnreadPage: false,
        entryPositionAbandoned: false,
        firstUnreadMessageId: null,
        scrolledFirstUnreadId: null,
        onPresented,
      }),
      search: {
        isActive: () => searchActive,
        jumpToLatest: () => {
          events.push('search.latest')
          searchActive = false
        },
        loadOlder: () => events.push('search.loadOlder'),
      },
      hasNewer: () => hasNewer,
      loadLatest: async () => {
        events.push('loadLatest')
      },
    })

    await ctrl.jumpToBottom()
    expect(events).toEqual(['search.latest', 'tick', 'loadLatest', 'tick', 'presented'])
    expect(container.el.scrollTop).toBe(900)

    // If search stays active after jumpToLatest(), jumpToBottom aborts without loading latest or scrolling
    events.length = 0
    searchActive = true
    container.el.scrollTop = 10
    const stickyCtrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => null,
      getFocusableMessageIds: () => [],
      setActiveRowId: () => {},
      afterUpdate: async () => {
        events.push('tick')
      },
      search: {
        isActive: () => true,
        jumpToLatest: () => events.push('search.latest'),
        loadOlder: () => {},
      },
      loadLatest: async () => {
        events.push('loadLatest')
      },
    })
    await stickyCtrl.jumpToBottom()
    expect(events).toEqual(['search.latest', 'tick'])
    expect(container.el.scrollTop).toBe(10)

    // Non-search with hasNewer loads latest before scrolling
    events.length = 0
    searchActive = false
    hasNewer = true
    await ctrl.jumpToBottom()
    expect(events).toEqual(['loadLatest', 'tick', 'presented'])

    scrollController.destroy()
  })

  it('loadOlderWithAnchor captures anchor first and routes to search or scope loader', () => {
    const scrollController = createTimelineScrollController()
    const order: string[] = []
    vi.spyOn(scrollController, 'captureAnchor').mockImplementation(() => {
      order.push('captureAnchor')
    })
    const container = makeFakeScrollContainer({
      rows: [{ id: 'm-1', seq: 1, top: 0, bottom: 50 }],
    })
    let searchActive = false
    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => null,
      getFocusableMessageIds: () => [],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
      search: {
        isActive: () => searchActive,
        jumpToLatest: () => {},
        loadOlder: () => order.push('search.loadOlder'),
      },
      loadOlder: () => order.push('scope.loadOlder'),
    })

    ctrl.loadOlderWithAnchor()
    expect(order).toEqual(['captureAnchor', 'scope.loadOlder'])

    order.length = 0
    searchActive = true
    ctrl.loadOlderWithAnchor()
    expect(order).toEqual(['captureAnchor', 'search.loadOlder'])

    scrollController.destroy()
  })
})
