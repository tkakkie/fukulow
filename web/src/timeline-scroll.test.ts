import { describe, expect, it, vi } from 'vitest'
import {
  computeAnchoredScrollTop,
  createTimelineScrollController,
  findFirstVisibleAnchor,
  initialTimelineScrollState,
  isPinnedToBottom,
  PINNED_THRESHOLD_PX,
  stepTimelineScroll,
} from './timeline-scroll'

const msg = (seq: number, sender = 'other') => ({ id: `m-${seq}`, seq, sender })

describe('timeline-scroll: follow-only-at-bottom and scroll anchoring (docs/ui.md §8)', () => {
  it('treats scroll positions within 64px of the bottom as pinned', () => {
    expect(PINNED_THRESHOLD_PX).toBe(64)
    expect(isPinnedToBottom({ scrollTop: 436, scrollHeight: 1000, clientHeight: 500 })).toBe(true)
    expect(isPinnedToBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 })).toBe(true)
    expect(isPinnedToBottom({ scrollTop: 435, scrollHeight: 1000, clientHeight: 500 })).toBe(false)
  })

  it('returns the exact previous state reference when sync or scroll inputs are unchanged', () => {
    const s0 = initialTimelineScrollState('c1')
    // Repeated loading sync with no messages returns s0
    const s0Again = stepTimelineScroll(s0, {
      type: 'sync',
      channelId: 'c1',
      status: 'loading',
      messages: [],
      pendingIds: [],
      selfId: 'me',
    })
    expect(s0Again.state).toBe(s0)

    const s1 = stepTimelineScroll(s0, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2)],
      pendingIds: ['p-1'],
      selfId: 'me',
    }).state

    const s1Repeat = stepTimelineScroll(s1, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2)],
      pendingIds: ['p-1'],
      selfId: 'me',
    })
    expect(s1Repeat.state).toBe(s1)
    expect(s1Repeat.action).toBe('none')

    const jumpRepeat = stepTimelineScroll(s1, { type: 'jump_to_bottom' })
    expect(jumpRepeat.state).toBe(s1)
    expect(jumpRepeat.action).toBe('scroll_bottom')
  })

  it('createTimelineScrollController runs one step per sync and manages the 10 s loading timeout', () => {
    let pendingTimer: (() => void) | null = null
    const ctrl = createTimelineScrollController({
      loadingTimeoutMs: 10_000,
      schedule: (fn) => {
        pendingTimer = fn
        return 1
      },
      cancel: () => {
        pendingTimer = null
      },
    })
    const notifications = vi.fn()
    const unsub = ctrl.subscribe(notifications)

    // Loading state schedules 10s timeout
    ctrl.sync({
      channelId: 'c1',
      status: 'loading',
      messages: [],
      pendingIds: [],
      selfId: 'me',
    })
    expect(ctrl.get().loadingTimedOut).toBe(false)
    expect(pendingTimer).not.toBeNull()

    pendingTimer!()
    expect(ctrl.get().loadingTimedOut).toBe(true)
    expect(notifications).toHaveBeenCalledTimes(1)

    // Transition to ready clears timeout and scrolls to bottom on initial content
    const res = ctrl.sync({
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2)],
      pendingIds: [],
      selfId: 'me',
    })
    expect(res.action).toBe('scroll_bottom')
    expect(ctrl.get().loadingTimedOut).toBe(false)
    expect(notifications).toHaveBeenCalledTimes(2)

    // Subsequent live messages while pinned do not fire redundant view notifications
    const res2 = ctrl.sync({
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2), msg(3)],
      pendingIds: [],
      selfId: 'me',
    })
    expect(res2.action).toBe('scroll_bottom')
    expect(notifications).toHaveBeenCalledTimes(2)

    unsub()
    ctrl.destroy()
  })

  it('follows new Messages at the bottom when pinned, and stays put with 新着 n件 ↓ count when unpinned', () => {
    let s = initialTimelineScrollState('c1')

    // Initial history load scrolls to bottom and pins
    let step = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2)],
      pendingIds: [],
      selfId: 'me',
    })
    s = step.state
    expect(step.action).toBe('scroll_bottom')
    expect(s.pinned).toBe(true)
    expect(s.belowCount).toBe(0)

    // New live Message while pinned -> follows to bottom
    step = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2), msg(3, 'alice')],
      pendingIds: [],
      selfId: 'me',
    })
    s = step.state
    expect(step.action).toBe('scroll_bottom')
    expect(s.belowCount).toBe(0)

    // User scrolls up above the 64px threshold -> unpinned
    step = stepTimelineScroll(s, {
      type: 'scroll',
      metrics: { scrollTop: 100, scrollHeight: 1000, clientHeight: 500 },
    })
    s = step.state
    expect(s.pinned).toBe(false)

    // Two new Messages from others arrive while unpinned -> does NOT scroll, increments belowCount
    step = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2), msg(3, 'alice'), msg(4, 'bob')],
      pendingIds: [],
      selfId: 'me',
    })
    s = step.state
    expect(step.action).toBe('none')
    expect(s.pinned).toBe(false)
    expect(s.belowCount).toBe(1)

    step = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2), msg(3, 'alice'), msg(4, 'bob'), msg(5, 'carol')],
      pendingIds: [],
      selfId: 'me',
    })
    s = step.state
    expect(step.action).toBe('none')
    expect(s.belowCount).toBe(2)

    // Clicking 新着 n件 ↓ jumps to bottom, pins, and clears belowCount
    step = stepTimelineScroll(s, { type: 'jump_to_bottom' })
    s = step.state
    expect(step.action).toBe('scroll_bottom')
    expect(s.pinned).toBe(true)
    expect(s.belowCount).toBe(0)
  })

  it('scrolls to the bottom on your own send even when not pinned', () => {
    let s = initialTimelineScrollState('c1')
    s = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(10), msg(11)],
      pendingIds: [],
      selfId: 'me',
    }).state

    // Scroll up (not pinned) and accumulate unread below
    s = stepTimelineScroll(s, {
      type: 'scroll',
      metrics: { scrollTop: 0, scrollHeight: 1200, clientHeight: 400 },
    }).state
    s = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(10), msg(11), msg(12, 'alice')],
      pendingIds: [],
      selfId: 'me',
    }).state
    expect(s.pinned).toBe(false)
    expect(s.belowCount).toBe(1)

    // Own pending send added -> scrolls to bottom and clears belowCount
    const onSend = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(10), msg(11), msg(12, 'alice')],
      pendingIds: ['client-1'],
      selfId: 'me',
    })
    expect(onSend.action).toBe('scroll_bottom')
    expect(onSend.state.pinned).toBe(true)
    expect(onSend.state.belowCount).toBe(0)
  })

  it('preserves the first visible Message offset when older pages, gap fills or reordered Messages insert above', () => {
    // 1. Anchor measurement & restoration math
    const itemsBefore = [
      { id: 'm-10', top: -120, bottom: -20 },
      { id: 'm-11', top: -10, bottom: 50 }, // first visible item straddling top of viewport (0)
      { id: 'm-12', top: 58, bottom: 118 },
    ]
    const anchor = findFirstVisibleAnchor(itemsBefore, 0)
    expect(anchor).toEqual({ messageId: 'm-11', offsetTop: -10 })

    // Suppose 3 older messages totaling 240px height are prepended above m-10;
    // m-11's new top relative to viewport is now 230px while currentScrollTop was 300px.
    const nextScrollTop = computeAnchoredScrollTop(300, anchor!, 230, 0)
    expect(nextScrollTop).toBe(540) // 300 + (230 - (-10)) = 540, keeping m-11 at -10px

    // 2. State machine triggers preserve_anchor on older page prepend and gap fill
    let s = initialTimelineScrollState('c1')
    s = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(10), msg(12)],
      pendingIds: [],
      selfId: 'me',
    }).state

    // Older page prepended (seq 8, 9)
    const olderStep = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(8), msg(9), msg(10), msg(12)],
      pendingIds: [],
      selfId: 'me',
    })
    expect(olderStep.action).toBe('preserve_anchor')

    // Gap fill / reorder inserted between 10 and 12 (seq 11)
    const gapStep = stepTimelineScroll(olderStep.state, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(8), msg(9), msg(10), msg(11), msg(12)],
      pendingIds: [],
      selfId: 'me',
    })
    expect(gapStep.action).toBe('preserve_anchor')
  })

  it('preserves visual scroll anchor when a Topic summary line moves from above the viewport to the tail while unpinned', () => {
    let s = initialTimelineScrollState('c1')
    s = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [{ id: 'topic:t1:2', seq: 2, sender: 'other' }, msg(3), msg(5)],
      pendingIds: [],
      selfId: 'me',
    }).state
    s = stepTimelineScroll(s, {
      type: 'scroll',
      metrics: { scrollTop: 50, scrollHeight: 1000, clientHeight: 500 },
    }).state
    expect(s.pinned).toBe(false)

    // Topic t1 moves from position 2 (above tail 5) to position 6 (at tail) due to another member's message
    const moved = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(3), msg(5), { id: 'topic:t1:6', seq: 6, sender: 'other' }],
      pendingIds: [],
      selfId: 'me',
    })
    expect(moved.action).toBe('preserve_anchor')
    expect(moved.state.pinned).toBe(false)
    expect(moved.state.belowCount).toBe(1)
  })

  it('positions at the first Unread Message after loading needed older pages, then preserves anchor on further older loads', () => {
    let s = initialTimelineScrollState('c1')

    // 1. Initial page (seq 3, 4) arrives while older pages are still loading to reach first Unread (m-2)
    let step = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(3), msg(4)],
      pendingIds: [],
      selfId: 'me',
      firstUnreadMessageId: null,
      awaitingFirstUnread: true,
    })
    s = step.state
    expect(step.action).toBe('none')
    expect(s.initialized).toBe(false)

    // 2. Older page (seq 1, 2) arrives and resolves firstUnreadMessageId = 'm-2'
    step = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2), msg(3), msg(4)],
      pendingIds: [],
      selfId: 'me',
      firstUnreadMessageId: 'm-2',
      awaitingFirstUnread: false,
    })
    s = step.state
    expect(step.action).toBe('scroll_first_unread')
    expect(s.initialized).toBe(true)
    expect(s.firstUnreadScrolledId).toBe('m-2')

    // 3. Repeating sync with the same firstUnreadMessageId does not re-scroll
    const repeat = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(1), msg(2), msg(3), msg(4)],
      pendingIds: [],
      selfId: 'me',
      firstUnreadMessageId: 'm-2',
      awaitingFirstUnread: false,
    })
    expect(repeat.action).toBe('none')
    expect(repeat.state).toBe(s)

    // 4. User loads an even older page above m-1 -> preserves anchor rather than re-jumping to m-2
    const older = stepTimelineScroll(s, {
      type: 'sync',
      channelId: 'c1',
      status: 'ready',
      messages: [msg(0), msg(1), msg(2), msg(3), msg(4)],
      pendingIds: [],
      selfId: 'me',
      firstUnreadMessageId: 'm-2',
      awaitingFirstUnread: false,
    })
    expect(older.action).toBe('preserve_anchor')
    expect(older.state.firstUnreadScrolledId).toBe('m-2')
  })
})
