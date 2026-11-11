import { LOADING_TIMEOUT_MS } from './announcements'

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

export type ScrollAction = 'none' | 'scroll_bottom' | 'preserve_anchor' | 'scroll_first_unread'

export type TimelineScrollState = {
  channelId: string
  initialized: boolean
  pinned: boolean
  belowCount: number
  minSeq: number | null
  maxSeq: number | null
  seenSeqs: ReadonlySet<number>
  pendingIds: ReadonlySet<string>
  firstUnreadScrolledId?: string | null
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
      firstUnreadMessageId?: string | null
      awaitingFirstUnread?: boolean
    }

export type TimelineScrollView = {
  pinned: boolean
  belowCount: number
  loadingTimedOut: boolean
}

export type TimelineScrollControllerOptions = {
  channelId?: string
  loadingTimeoutMs?: number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

function sameItems<T>(set: ReadonlySet<T>, list: readonly T[]): boolean {
  if (set.size !== list.length) return false
  for (const item of list) {
    if (!set.has(item)) return false
  }
  return true
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
      if (prev.pinned && prev.belowCount === 0) {
        return { state: prev, action: 'scroll_bottom' }
      }
      return {
        state: { ...prev, pinned: true, belowCount: 0 },
        action: 'scroll_bottom',
      }
    }
    case 'sync': {
      const minSeq = input.messages[0]?.seq ?? null
      const maxSeq = input.messages.at(-1)?.seq ?? null
      const messageSeqs = input.messages.map((m) => m.seq)
      const hasContent = input.messages.length > 0 || input.pendingIds.length > 0
      const targetUnreadId = input.firstUnreadMessageId ?? null
      const hasTargetUnread =
        targetUnreadId !== null && input.messages.some((m) => m.id === targetUnreadId)
      const awaitingUnread =
        Boolean(input.awaitingFirstUnread) || (targetUnreadId !== null && !hasTargetUnread)
      const channelChanged = input.channelId !== prev.channelId
      const prevScrolledUnreadId = channelChanged ? null : (prev.firstUnreadScrolledId ?? null)

      if (channelChanged || !prev.initialized) {
        if (awaitingUnread) {
          if (
            !channelChanged &&
            !prev.initialized &&
            prev.pinned &&
            prev.belowCount === 0 &&
            minSeq === prev.minSeq &&
            maxSeq === prev.maxSeq &&
            sameItems(prev.seenSeqs, messageSeqs) &&
            sameItems(prev.pendingIds, input.pendingIds) &&
            prevScrolledUnreadId === null
          ) {
            return { state: prev, action: 'none' }
          }
          return {
            state: {
              channelId: input.channelId,
              initialized: false,
              pinned: true,
              belowCount: 0,
              minSeq,
              maxSeq,
              seenSeqs: new Set(messageSeqs),
              pendingIds: new Set(input.pendingIds),
              ...(prevScrolledUnreadId !== null ? { firstUnreadScrolledId: null } : {}),
            },
            action: 'none',
          }
        }
        const initialized = hasContent || input.status === 'ready'
        const nextScrolledUnreadId = hasTargetUnread ? targetUnreadId : prevScrolledUnreadId
        if (
          !channelChanged &&
          initialized === prev.initialized &&
          prev.pinned &&
          prev.belowCount === 0 &&
          minSeq === prev.minSeq &&
          maxSeq === prev.maxSeq &&
          sameItems(prev.seenSeqs, messageSeqs) &&
          sameItems(prev.pendingIds, input.pendingIds) &&
          nextScrolledUnreadId === prevScrolledUnreadId
        ) {
          return { state: prev, action: 'none' }
        }
        return {
          state: {
            channelId: input.channelId,
            initialized,
            pinned: true,
            belowCount: 0,
            minSeq,
            maxSeq,
            seenSeqs: new Set(messageSeqs),
            pendingIds: new Set(input.pendingIds),
            ...(nextScrolledUnreadId !== null ? { firstUnreadScrolledId: nextScrolledUnreadId } : {}),
          },
          action: hasContent ? (hasTargetUnread ? 'scroll_first_unread' : 'scroll_bottom') : 'none',
        }
      }

      if (hasTargetUnread && targetUnreadId !== prevScrolledUnreadId) {
        return {
          state: {
            ...prev,
            minSeq,
            maxSeq,
            seenSeqs: new Set(messageSeqs),
            pendingIds: new Set(input.pendingIds),
            firstUnreadScrolledId: targetUnreadId,
          },
          action: 'scroll_first_unread',
        }
      }

      const seqsUnchanged =
        minSeq === prev.minSeq && maxSeq === prev.maxSeq && sameItems(prev.seenSeqs, messageSeqs)
      const pendingUnchanged = sameItems(prev.pendingIds, input.pendingIds)
      if (seqsUnchanged && pendingUnchanged) {
        return { state: prev, action: 'none' }
      }

      const seenSeqs = seqsUnchanged ? prev.seenSeqs : new Set(messageSeqs)
      const pendingIds = pendingUnchanged ? prev.pendingIds : new Set(input.pendingIds)
      const newPendingAdded = !pendingUnchanged && input.pendingIds.some((id) => !prev.pendingIds.has(id))
      const addedMessages = seqsUnchanged ? [] : input.messages.filter((m) => !prev.seenSeqs.has(m.seq))
      const insertedAboveTail = addedMessages.filter((m) => prev.maxSeq !== null && m.seq < prev.maxSeq)
      const removedAboveTail =
        !seqsUnchanged &&
        prev.maxSeq !== null &&
        [...prev.seenSeqs].some((seq) => seq < prev.maxSeq! && !seenSeqs.has(seq))
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

      if ((insertedAboveTail.length > 0 || removedAboveTail) && appendedAtTail.length === 0) {
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
          action: insertedAboveTail.length > 0 || removedAboveTail ? 'preserve_anchor' : 'none',
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

/**
 * Layer-3 controller owning timeline scroll state, anchor preservation and the 10 s loading timeout
 * (`docs/ui.md` §5, §8). Holds no `$state`; notifies subscribers only when `pinned`, `belowCount`
 * or `loadingTimedOut` changes.
 */
export function createTimelineScrollController(options: TimelineScrollControllerOptions = {}) {
  const timeoutMs = options.loadingTimeoutMs ?? LOADING_TIMEOUT_MS
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let state = initialTimelineScrollState(options.channelId ?? '')
  let savedAnchor: ScrollAnchor | null = null
  let loadingTimedOut = false
  let loadingTimer: unknown = null
  let lastStatus: 'loading' | 'ready' | 'unavailable' | 'error' | null = null
  let view: TimelineScrollView = {
    pinned: state.pinned,
    belowCount: state.belowCount,
    loadingTimedOut,
  }
  const listeners = new Set<() => void>()

  function notifyIfViewChanged() {
    if (
      view.pinned === state.pinned &&
      view.belowCount === state.belowCount &&
      view.loadingTimedOut === loadingTimedOut
    ) {
      return
    }
    view = {
      pinned: state.pinned,
      belowCount: state.belowCount,
      loadingTimedOut,
    }
    listeners.forEach((l) => l())
  }

  function clearLoadingTimer() {
    if (loadingTimer !== null) {
      cancel(loadingTimer)
      loadingTimer = null
    }
  }

  function updateLoadingStatus(status: 'loading' | 'ready' | 'unavailable' | 'error') {
    if (status === lastStatus) return
    lastStatus = status
    clearLoadingTimer()
    if (status !== 'loading') {
      loadingTimedOut = false
      return
    }
    loadingTimedOut = false
    loadingTimer = schedule(() => {
      loadingTimer = null
      loadingTimedOut = true
      notifyIfViewChanged()
    }, timeoutMs)
  }

  return {
    get(): TimelineScrollView {
      return view
    },
    getState(): TimelineScrollState {
      return state
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    captureAnchor(items: readonly ItemRect[]): void {
      savedAnchor = findFirstVisibleAnchor(items, 0)
    },
    onScroll(metrics: ScrollMetrics, items: readonly ItemRect[]): void {
      savedAnchor = findFirstVisibleAnchor(items, 0)
      const next = stepTimelineScroll(state, { type: 'scroll', metrics })
      state = next.state
      notifyIfViewChanged()
    },
    sync(input: Omit<Extract<TimelineScrollInput, { type: 'sync' }>, 'type'>): {
      action: ScrollAction
      anchor: ScrollAnchor | null
    } {
      updateLoadingStatus(input.status)
      const anchor = savedAnchor
      const next = stepTimelineScroll(state, { type: 'sync', ...input })
      state = next.state
      notifyIfViewChanged()
      return { action: next.action, anchor }
    },
    jumpToBottom(): ScrollAction {
      const next = stepTimelineScroll(state, { type: 'jump_to_bottom' })
      state = next.state
      notifyIfViewChanged()
      return next.action
    },
    onUserSubmit(): ScrollAction {
      const next = stepTimelineScroll(state, { type: 'user_submit' })
      state = next.state
      notifyIfViewChanged()
      return next.action
    },
    resetLoadingTimeout(): void {
      lastStatus = null
      clearLoadingTimer()
      loadingTimedOut = false
      notifyIfViewChanged()
    },
    destroy(): void {
      clearLoadingTimer()
      listeners.clear()
    },
  }
}

export type TimelineScrollController = ReturnType<typeof createTimelineScrollController>

/** Measures `[data-message-id]` item offsets relative to a timeline scroll container (`docs/ui.md` §8). */
export function measureTimelineItems(container: HTMLElement): ItemRect[] {
  const cRect = container.getBoundingClientRect()
  const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]')
  const items: ItemRect[] = []
  for (const node of nodes) {
    const id = node.getAttribute('data-message-id')
    if (!id) continue
    const r = node.getBoundingClientRect()
    items.push({ id, top: r.top - cRect.top, bottom: r.bottom - cRect.top })
  }
  return items
}

/**
 * Measures confirmed Message rows (`[data-confirmed-seq]`) whose bounding rect intersects the
 * timeline scroll container's viewport (`docs/ui.md` §8).
 */
export function measureVisibleConfirmedSeqs(container: HTMLElement): number[] {
  const cRect = container.getBoundingClientRect()
  if (cRect.height <= 0 || cRect.width <= 0) return []
  const viewTop = cRect.top
  const viewBottom = cRect.bottom
  const nodes = container.querySelectorAll<HTMLElement>('[data-confirmed-seq]')
  const seqs: number[] = []
  for (const node of nodes) {
    const raw = node.getAttribute('data-confirmed-seq')
    if (!raw) continue
    const seq = Number(raw)
    if (!Number.isInteger(seq) || seq <= 0) continue
    const r = node.getBoundingClientRect()
    if (r.height <= 0 || r.width <= 0) continue
    if (r.bottom > viewTop && r.top < viewBottom) {
      seqs.push(seq)
    }
  }
  return seqs
}

/** Reports scroll container metrics and visible item rects to the timeline scroll controller (`docs/ui.md` §8). */
export function handleTimelineContainerScroll(
  container: HTMLElement | null,
  controller: Pick<TimelineScrollController, 'onScroll'>,
): void {
  if (!container) return
  controller.onScroll(
    {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    },
    measureTimelineItems(container),
  )
}

/** Applies a `ScrollAction` (`scroll_bottom`, `scroll_first_unread` or `preserve_anchor`) to a timeline scroll container (`docs/ui.md` §8). */
export function applyTimelineScrollAction(
  container: HTMLElement | null,
  controller: Pick<TimelineScrollController, 'captureAnchor'> & Partial<Pick<TimelineScrollController, 'onScroll'>>,
  action: ScrollAction,
  anchor: ScrollAnchor | null,
  firstUnreadMessageId?: string | null,
): void {
  if (!container || action === 'none') return
  if (action === 'scroll_bottom') {
    container.scrollTop = container.scrollHeight
    controller.captureAnchor(measureTimelineItems(container))
    return
  }
  if (action === 'scroll_first_unread') {
    const marker = container.querySelector<HTMLElement>('[data-read-marker="true"]')
    const targetEl =
      marker ??
      (firstUnreadMessageId
        ? container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(firstUnreadMessageId)}"]`)
        : null)
    if (targetEl) {
      const cRect = container.getBoundingClientRect()
      const r = targetEl.getBoundingClientRect()
      container.scrollTop = Math.max(0, container.scrollTop + (r.top - cRect.top))
    }
    const items = measureTimelineItems(container)
    controller.captureAnchor(items)
    controller.onScroll?.(
      {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      },
      items,
    )
    return
  }
  if (action === 'preserve_anchor' && anchor) {
    const el = container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.messageId)}"]`)
    if (el) {
      const cRect = container.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      container.scrollTop = computeAnchoredScrollTop(container.scrollTop, anchor, r.top - cRect.top, 0)
    }
    controller.captureAnchor(measureTimelineItems(container))
  }
}
