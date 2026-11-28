import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isDocumentVisible,
  reportTimelinePresented,
  type TimelinePresentationEntry,
  type TimelinePresentationSource,
} from './timeline-presentation'

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
  } as unknown as HTMLElement
}

function makeFakeScrollContainer(
  opts: {
    rows?: FakeRow[]
    top?: number
    bottom?: number
    width?: number
    height?: number
  } = {},
) {
  let rows = opts.rows ?? []
  const top = opts.top ?? 0
  const height = opts.height ?? 400
  const bottom = opts.bottom ?? top + height
  const width = opts.width ?? 600
  const el = {
    getBoundingClientRect() {
      return { top, bottom, width, height }
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-confirmed-seq]') {
        return rows.filter((r) => r.seq !== undefined).map(makeFakeRowNode)
      }
      return []
    },
  } as unknown as HTMLElement
  return {
    el,
    setRows(next: FakeRow[]) {
      rows = next
    },
  }
}

type PresentationValues = {
  enabled: boolean
  awaitingInitialSenders: boolean
  viewSelected: boolean
  targetUnavailable: boolean
  expectedTopicId: string | null
  entry: TimelinePresentationEntry | null
  searchActive: boolean
  searchReady: boolean
  initialScrollApplied: boolean
  skipUnreadVisit: boolean
  needsOlderUnreadPage: boolean
  entryPositionAbandoned: boolean
  firstUnreadMessageId: string | null
  scrolledFirstUnreadId: string | null
  onPresented: (visitId: symbol, seqs: number[]) => void
}

function makePresentationSource(
  expectedTopicId: string | null,
  overrides: Partial<PresentationValues> = {},
): { source: TimelinePresentationSource; values: PresentationValues } {
  const values: PresentationValues = {
    enabled: true,
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
  const source: TimelinePresentationSource = {
    isEnabled: () => values.enabled,
    isAwaitingInitialSenders: () => values.awaitingInitialSenders,
    isViewSelected: () => values.viewSelected,
    isTargetUnavailable: () => values.targetUnavailable,
    getExpectedTopicId: () => values.expectedTopicId,
    getEntry: () => values.entry,
    isSearchActive: () => values.searchActive,
    isSearchReady: () => values.searchReady,
    isInitialScrollApplied: () => values.initialScrollApplied,
    isSkipUnreadVisit: () => values.skipUnreadVisit,
    needsOlderUnreadPage: () => values.needsOlderUnreadPage,
    isEntryPositionAbandoned: () => values.entryPositionAbandoned,
    getFirstUnreadMessageId: () => values.firstUnreadMessageId,
    getScrolledFirstUnreadId: () => values.scrolledFirstUnreadId,
    onPresented: (visitId, seqs) => values.onPresented(visitId, seqs),
  }
  return { source, values }
}

const origDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

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
})

afterEach(() => {
  if (origDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', origDocumentDescriptor)
  } else {
    delete (globalThis as { document?: unknown }).document
  }
})

describe('timeline-presentation: isDocumentVisible', () => {
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

describe('timeline-presentation: reportTimelinePresented per scope (docs/ui.md §8)', () => {
  for (const scope of [
    { label: 'main', topicId: null, wrongTopicId: 't-other' },
    { label: 'topic', topicId: 't-1', wrongTopicId: null },
  ] as const) {
    it(`[${scope.label}] reports visible confirmed seqs when ready and rejects mismatched scope`, () => {
      const container = makeFakeScrollContainer({
        rows: [
          { id: 'm-1', seq: 1, top: -100, bottom: -20 },
          { id: 'm-2', seq: 2, top: 20, bottom: 80 },
          { id: 'm-3', seq: 3, top: 90, bottom: 150 },
        ],
      })
      const { source, values } = makePresentationSource(scope.topicId)

      reportTimelinePresented(() => container.el, source)
      expect(values.onPresented).toHaveBeenCalledTimes(1)
      expect(values.onPresented).toHaveBeenCalledWith(values.entry!.id, [2, 3])

      const mismatched = makePresentationSource(scope.topicId, {
        entry: { id: Symbol('wrong'), scope: { topicId: scope.wrongTopicId }, boundary: 5, unreadAtEntry: 0 },
      })
      reportTimelinePresented(() => container.el, mismatched.source)
      expect(mismatched.values.onPresented).not.toHaveBeenCalled()
    })
  }

  it('does not read Unread entry or positioning getters before the display/selection guard passes', () => {
    const container = makeFakeScrollContainer({
      rows: [{ id: 'm-1', seq: 1, top: 10, bottom: 60 }],
    })
    const getEntry = vi.fn(() => ({
      id: Symbol('visit'),
      scope: { topicId: null },
      boundary: 5,
      unreadAtEntry: 0,
    }))
    const needsOlderUnreadPage = vi.fn(() => false)
    const getFirstUnreadMessageId = vi.fn(() => null)
    const onPresented = vi.fn()

    reportTimelinePresented(() => container.el, {
      isEnabled: () => true,
      isAwaitingInitialSenders: () => false,
      isViewSelected: () => false,
      isTargetUnavailable: () => false,
      getExpectedTopicId: () => null,
      getEntry,
      isSearchActive: () => false,
      isSearchReady: () => false,
      isInitialScrollApplied: () => true,
      isSkipUnreadVisit: () => false,
      needsOlderUnreadPage,
      isEntryPositionAbandoned: () => false,
      getFirstUnreadMessageId,
      getScrolledFirstUnreadId: () => null,
      onPresented,
    })

    expect(getEntry).not.toHaveBeenCalled()
    expect(needsOlderUnreadPage).not.toHaveBeenCalled()
    expect(getFirstUnreadMessageId).not.toHaveBeenCalled()
    expect(onPresented).not.toHaveBeenCalled()
  })

  it('enforces all presentation guards (senders, enabled, display, unavailable, visibility, search, unread positioning)', () => {
    const container = makeFakeScrollContainer({
      rows: [{ id: 'm-1', seq: 1, top: 10, bottom: 60 }],
    })
    let scrollEl: HTMLElement | null = container.el

    const assertBlocked = (patch: Partial<PresentationValues>) => {
      const onPresented = vi.fn()
      const { source } = makePresentationSource(null, { ...patch, onPresented })
      reportTimelinePresented(() => scrollEl, source)
      expect(onPresented).not.toHaveBeenCalled()
    }

    assertBlocked({ enabled: false })
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
    const searchOk = makePresentationSource(null, {
      searchActive: true,
      searchReady: true,
      initialScrollApplied: true,
      onPresented: onSearchOk,
    })
    reportTimelinePresented(() => scrollEl, searchOk.source)
    expect(onSearchOk).toHaveBeenCalledWith(searchOk.values.entry!.id, [1])

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
    const unreadMatched = makePresentationSource(null, {
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      firstUnreadMessageId: 'm-1',
      scrolledFirstUnreadId: 'm-1',
      onPresented: onUnreadMatched,
    })
    reportTimelinePresented(() => scrollEl, unreadMatched.source)
    expect(onUnreadMatched).toHaveBeenCalledTimes(1)

    // Abandoned entry position falls back to initialScrollApplied
    assertBlocked({
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      entryPositionAbandoned: true,
      initialScrollApplied: false,
    })
    const onAbandonedReady = vi.fn()
    const abandonedReady = makePresentationSource(null, {
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: 5, unreadAtEntry: 2 },
      entryPositionAbandoned: true,
      initialScrollApplied: true,
      onPresented: onAbandonedReady,
    })
    reportTimelinePresented(() => scrollEl, abandonedReady.source)
    expect(onAbandonedReady).toHaveBeenCalledTimes(1)

    // skipUnreadVisit bypasses boundary / initialScrollApplied checks
    const onSkipUnread = vi.fn()
    const skipUnread = makePresentationSource(null, {
      entry: { id: Symbol('v'), scope: { topicId: null }, boundary: null, unreadAtEntry: 3 },
      skipUnreadVisit: true,
      initialScrollApplied: false,
      onPresented: onSkipUnread,
    })
    reportTimelinePresented(() => scrollEl, skipUnread.source)
    expect(onSkipUnread).toHaveBeenCalledTimes(1)

    // Empty visible confirmed seqs does not call onPresented
    container.setRows([])
    const onEmpty = vi.fn()
    const empty = makePresentationSource(null, { onPresented: onEmpty })
    reportTimelinePresented(() => scrollEl, empty.source)
    expect(onEmpty).not.toHaveBeenCalled()
  })
})
