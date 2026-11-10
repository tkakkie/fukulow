/** Distance from the bottom within which the timeline counts as pinned (`docs/ui.md` §8). */
export const PINNED_THRESHOLD_PX = 64

export type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type ItemRect = {
  id: string
  top: number
  bottom: number
}

export type ScrollAnchor = {
  messageId: string
  offsetTop: number
}

export type ScrollAction = 'none' | 'scroll_bottom' | 'preserve_anchor'

export type TimelineScrollState = {
  channelId: string
  initialized: boolean
  pinned: boolean
  belowCount: number
  minSeq: number | null
  maxSeq: number | null
  seenSeqs: ReadonlySet<number>
  pendingIds: ReadonlySet<string>
}

export type TimelineScrollInput =
  | { type: 'scroll'; metrics: ScrollMetrics }
  | { type: 'jump_to_bottom' }
  | { type: 'user_submit' }
  | {
      type: 'sync'
      channelId: string
      status: 'loading' | 'ready' | 'unavailable' | 'error'
      messages: readonly { id: string; seq: number; sender: string }[]
      pendingIds: readonly string[]
      selfId: string
    }

/** True when the scroll container is within `threshold` px of the bottom (`docs/ui.md` §8). */
export function isPinnedToBottom(metrics: ScrollMetrics, threshold = PINNED_THRESHOLD_PX): boolean {
  const remaining = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return remaining <= threshold
}

/**
 * Finds the first item visible at or below `viewportTop` and records its offset relative to `viewportTop`
 * (`docs/ui.md` §8).
 */
export function findFirstVisibleAnchor(items: readonly ItemRect[], viewportTop: number): ScrollAnchor | null {
  for (const item of items) {
    if (item.bottom > viewportTop) {
      return { messageId: item.id, offsetTop: item.top - viewportTop }
    }
  }
  return null
}

/**
 * Computes the `scrollTop` that keeps the anchored item at its original `offsetTop` relative to `viewportTop`
 * after older pages, gap fills or reordered items are inserted above it (`docs/ui.md` §8).
 */
export function computeAnchoredScrollTop(
  currentScrollTop: number,
  anchor: ScrollAnchor,
  newItemTop: number,
  viewportTop: number,
): number {
  const currentOffset = newItemTop - viewportTop
  const delta = currentOffset - anchor.offsetTop
  return Math.max(0, currentScrollTop + delta)
}

export function initialTimelineScrollState(channelId = ''): TimelineScrollState {
  return {
    channelId,
    initialized: false,
    pinned: true,
    belowCount: 0,
    minSeq: null,
    maxSeq: null,
    seenSeqs: new Set(),
    pendingIds: new Set(),
  }
}

export function stepTimelineScroll(
  prev: TimelineScrollState,
  input: TimelineScrollInput,
): { state: TimelineScrollState; action: ScrollAction } {
  switch (input.type) {
    case 'scroll': {
      const pinned = isPinnedToBottom(input.metrics)
      const belowCount = pinned ? 0 : prev.belowCount
      if (pinned === prev.pinned && belowCount === prev.belowCount) {
        return { state: prev, action: 'none' }
      }
      return { state: { ...prev, pinned, belowCount }, action: 'none' }
    }
    case 'jump_to_bottom':
    case 'user_submit': {
      return {
        state: { ...prev, pinned: true, belowCount: 0 },
        action: 'scroll_bottom',
      }
    }
    case 'sync': {
      const minSeq = input.messages[0]?.seq ?? null
      const maxSeq = input.messages.at(-1)?.seq ?? null
      const seenSeqs = new Set(input.messages.map((m) => m.seq))
      const pendingIds = new Set(input.pendingIds)
      const hasContent = input.messages.length > 0 || input.pendingIds.length > 0

      if (input.channelId !== prev.channelId || !prev.initialized) {
        const initialized = hasContent || input.status === 'ready'
        return {
          state: {
            channelId: input.channelId,
            initialized,
            pinned: true,
            belowCount: 0,
            minSeq,
            maxSeq,
            seenSeqs,
            pendingIds,
          },
          action: hasContent ? 'scroll_bottom' : 'none',
        }
      }

      const newPendingAdded = input.pendingIds.some((id) => !prev.pendingIds.has(id))
      const addedMessages = input.messages.filter((m) => !prev.seenSeqs.has(m.seq))
      const insertedAboveTail = addedMessages.filter((m) => prev.maxSeq !== null && m.seq < prev.maxSeq)
      const appendedAtTail = addedMessages.filter((m) => prev.maxSeq === null || m.seq > prev.maxSeq)
      const ownSendAtTail =
        newPendingAdded || (appendedAtTail.length > 0 && appendedAtTail.every((m) => m.sender === input.selfId))

      if (ownSendAtTail) {
        return {
          state: {
            ...prev,
            pinned: true,
            belowCount: 0,
            minSeq,
            maxSeq,
            seenSeqs,
            pendingIds,
          },
          action: 'scroll_bottom',
        }
      }

      if (insertedAboveTail.length > 0 && appendedAtTail.length === 0) {
        return {
          state: {
            ...prev,
            minSeq,
            maxSeq,
            seenSeqs,
            pendingIds,
          },
          action: 'preserve_anchor',
        }
      }

      if (appendedAtTail.length > 0) {
        if (prev.pinned) {
          return {
            state: {
              ...prev,
              pinned: true,
              belowCount: 0,
              minSeq,
              maxSeq,
              seenSeqs,
              pendingIds,
            },
            action: 'scroll_bottom',
          }
        }
        const newFromOthers = appendedAtTail.filter((m) => m.sender !== input.selfId).length
        return {
          state: {
            ...prev,
            belowCount: prev.belowCount + newFromOthers,
            minSeq,
            maxSeq,
            seenSeqs,
            pendingIds,
          },
          action: insertedAboveTail.length > 0 ? 'preserve_anchor' : 'none',
        }
      }

      return {
        state: {
          ...prev,
          minSeq,
          maxSeq,
          seenSeqs,
          pendingIds,
        },
        action: 'none',
      }
    }
  }
}
