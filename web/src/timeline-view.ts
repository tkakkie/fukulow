import { stepMessageRowIndex } from './composer-keys'
import {
  reportTimelinePresented,
  type TimelinePresentationSource,
} from './timeline-presentation'
import {
  applyTimelineScrollAction,
  measureTimelineItems,
  type ScrollAction,
  type ScrollAnchor,
  type TimelineScrollController,
} from './timeline-scroll'

export type TimelineRowWindow = {
  reveal(id: string, focus?: boolean, align?: 'start' | 'end'): Promise<void>
}

export type TimelineSearchControl = {
  isActive: () => boolean
  jumpToLatest: () => void
  loadOlder: () => void
}

export type TimelineViewControllerOptions = {
  scrollController: Pick<TimelineScrollController, 'captureAnchor' | 'jumpToBottom'> &
    Partial<Pick<TimelineScrollController, 'onScroll'>>
  getScrollEl: () => HTMLElement | null
  getRowWindow: () => TimelineRowWindow | null
  getFocusableMessageIds: () => readonly string[]
  setActiveRowId: (id: string) => void
  afterUpdate: () => Promise<void>
  isPositioning?: () => boolean
  /** Omitted by ReplyPanel so reply chains never report read positions (`docs/ui.md` §8). */
  presentation?: TimelinePresentationSource
  /** Whether `applyScrollAction` reveals an unmounted target row before applying scroll; defaults to `true`. */
  revealBeforeApply?: boolean
  search?: TimelineSearchControl
  hasNewer?: () => boolean
  loadLatest?: () => Promise<unknown>
  loadOlder?: () => void
}

function scrollTargetId(
  action: ScrollAction,
  anchor: ScrollAnchor | null,
  targetId?: string | null,
): string | null {
  if (action === 'scroll_first_unread' || action === 'scroll_search_anchor') return targetId ?? null
  if (action === 'preserve_anchor') return anchor?.messageId ?? null
  return null
}

/**
 * Layer-3 controller coordinating shared timeline view DOM actions (message focus, scroll target
 * reveal/application, jump-to-bottom and anchor-preserving older loads) without `$state`.
 */
export function createTimelineViewController(options: TimelineViewControllerOptions) {
  function reportPresented(): void {
    reportTimelinePresented(options.getScrollEl, options.presentation)
  }

  async function focusMessage(id: string | undefined): Promise<void> {
    // Hidden rows cannot take focus, and revealing one would scroll the list positioning still owns.
    if (!id || options.isPositioning?.()) return
    options.setActiveRowId(id)
    await options.getRowWindow()?.reveal(id, true)
  }

  function handleRowKeydown(e: KeyboardEvent): void {
    const id = (e.currentTarget as HTMLElement)
      .closest<HTMLElement>('[data-message-id]')
      ?.getAttribute('data-message-id')
    const ids = options.getFocusableMessageIds()
    const next = stepMessageRowIndex(ids.indexOf(id ?? ''), ids.length, e)
    if (next === null) return
    e.preventDefault()
    void focusMessage(ids[next]).catch(console.error)
  }

  async function revealScrollTarget(
    action: ScrollAction,
    anchor: ScrollAnchor | null,
    targetId?: string | null,
  ): Promise<void> {
    const id = scrollTargetId(action, anchor, targetId)
    if (id && !options.getScrollEl()?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)) {
      await options.getRowWindow()?.reveal(id)
    }
  }

  function captureCurrentAnchor(): void {
    const scrollEl = options.getScrollEl()
    if (!scrollEl) return
    options.scrollController.captureAnchor(measureTimelineItems(scrollEl))
  }

  function applyScrollAction(
    action: ScrollAction,
    anchor: ScrollAnchor | null,
    targetId?: string | null,
  ): void {
    const id = scrollTargetId(action, anchor, targetId)
    const scrollEl = options.getScrollEl()
    if (
      options.revealBeforeApply !== false &&
      id &&
      !scrollEl?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
    ) {
      void revealScrollTarget(action, anchor, targetId)
        .then(() => {
          applyTimelineScrollAction(options.getScrollEl(), options.scrollController, action, anchor, targetId)
          reportPresented()
        })
        .catch(console.error)
    } else {
      applyTimelineScrollAction(scrollEl, options.scrollController, action, anchor, targetId)
    }
  }

  async function jumpToBottom(): Promise<void> {
    if (options.search?.isActive()) {
      options.search.jumpToLatest()
      await options.afterUpdate()
      if (options.search.isActive()) return
      await options.loadLatest?.()
      await options.afterUpdate()
      if (options.search.isActive()) return
    }
    if (options.hasNewer?.()) {
      await options.loadLatest?.()
      await options.afterUpdate()
    }
    const action = options.scrollController.jumpToBottom()
    applyScrollAction(action, null)
    reportPresented()
  }

  function loadOlderWithAnchor(): void {
    captureCurrentAnchor()
    if (options.search?.isActive()) {
      options.search.loadOlder()
    } else {
      options.loadOlder?.()
    }
  }

  return {
    reportPresented,
    focusMessage,
    handleRowKeydown,
    revealScrollTarget,
    captureCurrentAnchor,
    applyScrollAction,
    jumpToBottom,
    loadOlderWithAnchor,
  }
}

export type TimelineViewController = ReturnType<typeof createTimelineViewController>
