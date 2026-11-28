import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelinePresentationSource } from './timeline-presentation'
import { createTimelineScrollController } from './timeline-scroll'
import { createTimelineViewController, type TimelineRowWindow } from './timeline-view'
import { deferred } from './unread-test-helpers'

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

function makeFakeScrollContainer(
  opts: {
    rows?: FakeRow[]
    top?: number
    bottom?: number
    width?: number
    height?: number
    scrollTop?: number
    scrollHeight?: number
    clientHeight?: number
  } = {},
) {
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

function makeReadyPresentation(
  expectedTopicId: string | null,
  onPresented: (visitId: symbol, seqs: number[]) => void,
  isSearchActive: () => boolean = () => false,
): TimelinePresentationSource {
  const entry = {
    id: Symbol('visit'),
    scope: { topicId: expectedTopicId },
    boundary: 5,
    unreadAtEntry: 0,
  }
  return {
    isEnabled: () => true,
    isAwaitingInitialSenders: () => false,
    isViewSelected: () => true,
    isTargetUnavailable: () => false,
    getExpectedTopicId: () => expectedTopicId,
    getEntry: () => entry,
    isSearchActive,
    isSearchReady: () => true,
    isInitialScrollApplied: () => true,
    isSkipUnreadVisit: () => false,
    needsOlderUnreadPage: () => false,
    isEntryPositionAbandoned: () => false,
    getFirstUnreadMessageId: () => null,
    getScrolledFirstUnreadId: () => null,
    onPresented,
  }
}

const origDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
const origCssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')

beforeEach(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'visible' },
  })
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

describe('timeline-view: ReplyPanel presentation boundary (docs/ui.md §8)', () => {
  it('ReplyPanel configuration (no presentation) never measures or reports a read position', async () => {
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

  it('applyScrollAction waits for async reveal to settle before applying scroll and reporting presented, while reply mode applies directly', async () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      scrollTop: 200,
      rows: [{ id: 'm-1', seq: 1, top: 0, bottom: 50 }],
    })
    const onPresented = vi.fn()
    const revealGate = deferred<void>()
    let revealedId: string | null = null
    const reveal: TimelineRowWindow['reveal'] = vi.fn((id: string) => {
      revealedId = id
      return revealGate.promise
    })
    const mainCtrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => ({ reveal }),
      getFocusableMessageIds: () => ['m-1', 'm-2'],
      setActiveRowId: () => {},
      afterUpdate: async () => {},
      presentation: makeReadyPresentation(null, onPresented),
    })

    mainCtrl.applyScrollAction('preserve_anchor', { messageId: 'm-2', offsetTop: 10 })
    expect(reveal).toHaveBeenCalledWith('m-2')
    // Before reveal settles, scrollTop must stay untouched and presentation must not fire.
    await Promise.resolve()
    expect(container.el.scrollTop).toBe(200)
    expect(onPresented).not.toHaveBeenCalled()

    // Mount the revealed row asynchronously and resolve reveal.
    container.setRows([
      { id: 'm-1', seq: 1, top: 0, bottom: 50 },
      { id: revealedId!, seq: 2, top: 150, bottom: 210 },
    ])
    revealGate.resolve()
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
      presentation: makeReadyPresentation('t-1', onPresented, () => searchActive),
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

  it('jumpToBottom aborts without scrolling or reporting presented if search reopens during the second afterUpdate()', async () => {
    const scrollController = createTimelineScrollController()
    const container = makeFakeScrollContainer({
      scrollTop: 40,
      scrollHeight: 900,
      rows: [{ id: 'm-1', seq: 1, top: 10, bottom: 60 }],
    })
    const events: string[] = []
    let searchActive = true
    let tickCount = 0
    const onPresented = vi.fn(() => events.push('presented'))

    const ctrl = createTimelineViewController({
      scrollController,
      getScrollEl: () => container.el,
      getRowWindow: () => null,
      getFocusableMessageIds: () => ['m-1'],
      setActiveRowId: () => {},
      afterUpdate: async () => {
        tickCount += 1
        events.push(`tick-${tickCount}`)
        if (tickCount === 2) {
          searchActive = true
        }
      },
      presentation: makeReadyPresentation(null, onPresented, () => searchActive),
      search: {
        isActive: () => searchActive,
        jumpToLatest: () => {
          events.push('search.latest')
          searchActive = false
        },
        loadOlder: () => {},
      },
      loadLatest: async () => {
        events.push('loadLatest')
      },
    })

    await ctrl.jumpToBottom()
    expect(events).toEqual(['search.latest', 'tick-1', 'loadLatest', 'tick-2'])
    expect(container.el.scrollTop).toBe(40)
    expect(onPresented).not.toHaveBeenCalled()

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
