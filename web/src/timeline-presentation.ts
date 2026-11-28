import { isTimelineDisplayed, measureVisibleConfirmedSeqs } from './timeline-scroll'

export type TimelinePresentationEntry = {
  id: symbol
  scope: { topicId: string | null }
  boundary: number | null
  unreadAtEntry?: number | null
}

/**
 * Lazy getters read in guard order so Svelte `$effect` callers do not subscribe to Unread
 * or positioning state while the view is hidden or unselected (`docs/ui.md` §8).
 */
export type TimelinePresentationSource = {
  isEnabled: () => boolean
  isAwaitingInitialSenders: () => boolean
  isViewSelected: () => boolean
  isTargetUnavailable: () => boolean
  getExpectedTopicId: () => string | null
  getEntry: () => TimelinePresentationEntry | null
  isSearchActive: () => boolean
  isSearchReady: () => boolean
  isInitialScrollApplied: () => boolean
  isSkipUnreadVisit: () => boolean
  needsOlderUnreadPage: () => boolean
  isEntryPositionAbandoned: () => boolean
  getFirstUnreadMessageId: () => string | null
  getScrolledFirstUnreadId: () => string | null
  onPresented: (visitId: symbol, seqs: number[]) => void
}

/** True when `document` is absent or currently visible (`docs/ui.md` §8). */
export function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true
  return (document.visibilityState ?? 'visible') === 'visible'
}

/**
 * Reports visible confirmed Message sequence numbers to Unread when the active timeline view
 * is displayed, visible, and positioned (`docs/ui.md` §8).
 */
export function reportTimelinePresented(
  getScrollEl: () => HTMLElement | null,
  source: TimelinePresentationSource | undefined,
): void {
  if (!source) return
  if (source.isAwaitingInitialSenders() || !source.isEnabled()) return
  const scrollEl = getScrollEl()
  if (!isTimelineDisplayed(scrollEl, source.isViewSelected()) || source.isTargetUnavailable()) return
  if (!isDocumentVisible()) return
  const currentEntry = source.getEntry()
  if (!currentEntry || currentEntry.scope.topicId !== source.getExpectedTopicId()) return
  if (source.isSearchActive()) {
    if (!source.isInitialScrollApplied() || !source.isSearchReady()) return
  } else if (!source.isSkipUnreadVisit()) {
    if (currentEntry.boundary === null || source.needsOlderUnreadPage()) return
    // A visit that opened at the bottom without a marker presents what is visible, as with no Unread.
    if ((currentEntry.unreadAtEntry ?? 0) > 0 && !source.isEntryPositionAbandoned()) {
      const firstUnreadId = source.getFirstUnreadMessageId()
      if (!firstUnreadId || source.getScrolledFirstUnreadId() !== firstUnreadId) return
    } else if (!source.isInitialScrollApplied()) {
      return
    }
  }
  const seqs = measureVisibleConfirmedSeqs(scrollEl!)
  if (seqs.length > 0) {
    source.onPresented(currentEntry.id, seqs)
  }
}
