import { describe, expect, it } from 'vitest'
import {
  createAnnouncementController,
  formatLiveMessageAnnouncement,
  formatMessagePreview,
  initialAnnouncementState,
  stepAnnouncements,
  type AnnounceableMessage,
} from './announcements'

const msg = (seq: number, sender: string, body: string): AnnounceableMessage => ({
  id: `m-${seq}`,
  seq,
  sender,
  body,
})

const names: Record<string, string> = {
  tanaka: '田中 美咲',
  sato: '佐藤 健',
  me: '自分',
}

describe('announcements: single polite status region rules (docs/ui.md §2, §5, §6)', () => {
  it('truncates Message previews to 80 Unicode scalar values and formats sender + preview', () => {
    const emojiBody = '🌸'.repeat(90)
    expect([...formatMessagePreview(emojiBody)]).toHaveLength(80)
    expect(formatLiveMessageAnnouncement('田中 美咲', 'こんにちは\nよろしくお願いします')).toBe(
      '田中 美咲: こんにちは よろしくお願いします',
    )
  })

  it('announces view changes once as # チャンネル名 or トピック名', () => {
    let s = initialAnnouncementState()

    let res = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c-general',
      kind: 'channel',
      name: 'general',
    })
    s = res.state
    expect(res.announcement).toBe('# general')

    // Re-rendering the same view does not announce again
    res = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c-general',
      kind: 'channel',
      name: 'general',
    })
    expect(res.announcement).toBeNull()

    // Switching to a Topic view announces the Topic name
    res = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 't-release',
      kind: 'topic',
      name: 'リリース計画',
    })
    expect(res.announcement).toBe('リリース計画')
  })

  it('announces live Messages from others once, coalesces bursts within 2 s into 新着メッセージ n件, and resets after 2 s', () => {
    let s = initialAnnouncementState()
    s = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c1',
      kind: 'channel',
      name: 'general',
    }).state

    // Initial history + subscribed confirmation -> never announced
    const init = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(10, 'tanaka', '過去のメッセージ')],
      selfId: 'me',
      nowMs: 1_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = init.state
    expect(init.announcement).toBeNull()

    // 1st live Message from someone else at t = 2000ms
    const live1 = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(10, 'tanaka', '過去のメッセージ'), msg(11, 'tanaka', '本文の先頭 80 文字')],
      selfId: 'me',
      nowMs: 2_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = live1.state
    expect(live1.announcement).toBe('田中 美咲: 本文の先頭 80 文字')

    // 2nd live Message within 2 s (t = 3200ms) -> 新着メッセージ 2件
    const live2 = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(10, 'tanaka', '過去のメッセージ'),
        msg(11, 'tanaka', '本文の先頭 80 文字'),
        msg(12, 'sato', '続けて送信'),
      ],
      selfId: 'me',
      nowMs: 3_200,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = live2.state
    expect(live2.announcement).toBe('新着メッセージ 2件')

    // 3rd live Message within 2 s of burst start (t = 3900ms) -> 新着メッセージ 3件
    const live3 = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(10, 'tanaka', '過去のメッセージ'),
        msg(11, 'tanaka', '本文の先頭 80 文字'),
        msg(12, 'sato', '続けて送信'),
        msg(13, 'tanaka', '3件目'),
      ],
      selfId: 'me',
      nowMs: 3_900,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = live3.state
    expect(live3.announcement).toBe('新着メッセージ 3件')

    // Live Message after the 2 s window (t = 5000ms) -> individual announcement again
    const live4 = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(10, 'tanaka', '過去のメッセージ'),
        msg(11, 'tanaka', '本文の先頭 80 文字'),
        msg(12, 'sato', '続けて送信'),
        msg(13, 'tanaka', '3件目'),
        msg(14, 'sato', '新しい話題です'),
      ],
      selfId: 'me',
      nowMs: 5_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(live4.announcement).toBe('佐藤 健: 新しい話題です')
  })

  it('never announces initial history, older pages, gap fills, replay, reordering, summary moves or own sends', () => {
    let s = initialAnnouncementState()
    s = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c1',
      kind: 'channel',
      name: 'general',
    }).state

    // 1. Initial history (not live yet) -> null
    let res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: false,
      messages: [msg(10, 'tanaka', '初期履歴')],
      selfId: 'me',
      nowMs: 1_000,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // Subscription confirmed -> null
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(10, 'tanaka', '初期履歴')],
      selfId: 'me',
      nowMs: 1_100,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // 2. Own send / own confirmation at tail -> null
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(10, 'tanaka', '初期履歴'), msg(11, 'me', '自分の送信')],
      selfId: 'me',
      nowMs: 1_200,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // 3. Older page prepended (seq 8, 9 < minSeq 10) -> null
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(8, 'tanaka', '古いページ1'),
        msg(9, 'sato', '古いページ2'),
        msg(10, 'tanaka', '初期履歴'),
        msg(11, 'me', '自分の送信'),
      ],
      selfId: 'me',
      nowMs: 1_500,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // 4. Out-of-order jump (seq 13 arrives before 12) and subsequent reordering/gap fill of seq 12 -> null
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(8, 'tanaka', '古いページ1'),
        msg(9, 'sato', '古いページ2'),
        msg(10, 'tanaka', '初期履歴'),
        msg(11, 'me', '自分の送信'),
        msg(13, 'tanaka', '順序飛び'),
      ],
      selfId: 'me',
      nowMs: 1_800,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // Gap fill / reorder inserting seq 12 below maxSeq 13 -> null
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(8, 'tanaka', '古いページ1'),
        msg(9, 'sato', '古いページ2'),
        msg(10, 'tanaka', '初期履歴'),
        msg(11, 'me', '自分の送信'),
        msg(12, 'sato', 'ギャップ補完'),
        msg(13, 'tanaka', '順序飛び'),
      ],
      selfId: 'me',
      nowMs: 1_900,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // 5. Disconnect and replay before subscribed confirmation -> null
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: false,
      messages: [
        msg(8, 'tanaka', '古いページ1'),
        msg(9, 'sato', '古いページ2'),
        msg(10, 'tanaka', '初期履歴'),
        msg(11, 'me', '自分の送信'),
        msg(12, 'sato', 'ギャップ補完'),
        msg(13, 'tanaka', '順序飛び'),
        msg(14, 'tanaka', 'リプレイ分'),
      ],
      selfId: 'me',
      nowMs: 2_100,
    })
    s = res.state
    expect(res.announcement).toBeNull()

    // 6. Topic summary move -> null
    res = stepAnnouncements(s, {
      type: 'topic_summary_moved',
      topicId: 't1',
      lastSeq: 15,
    })
    expect(res.announcement).toBeNull()
  })

  it('announces reconnecting only after 2 s offline and suppresses brief disconnects', () => {
    let s = initialAnnouncementState()
    s = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c1',
      kind: 'channel',
      name: 'general',
    }).state
    s = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(1, 'tanaka', 'hello')],
      selfId: 'me',
      nowMs: 1_000,
    }).state

    // Offline at t = 2000ms
    let res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: false,
      messages: [msg(1, 'tanaka', 'hello')],
      selfId: 'me',
      nowMs: 2_000,
    })
    s = res.state
    expect(res.announcement).toBeNull()
    expect(s.reconnecting).toBe(false)

    // Before 2 s (t = 3500ms) -> not announced
    res = stepAnnouncements(s, { type: 'offline_timer_elapsed', nowMs: 3_500 })
    expect(res.announcement).toBeNull()
    expect(res.state.reconnecting).toBe(false)

    // At 2 s (t = 4000ms) -> announces 再接続しています… and shows banner
    res = stepAnnouncements(s, { type: 'offline_timer_elapsed', nowMs: 4_000 })
    s = res.state
    expect(res.announcement).toBe('再接続しています…')
    expect(s.reconnecting).toBe(true)

    // Reconnected at t = 5000ms -> clears reconnecting banner and announces restoration
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(1, 'tanaka', 'hello')],
      selfId: 'me',
      nowMs: 5_000,
    })
    expect(res.state.reconnecting).toBe(false)
    expect(res.announcement).toBe('接続しました。')
  })

  it('does not treat a slow initial subscribe (> 2 s) as a reconnect before the subscription was ever live', () => {
    let s = initialAnnouncementState()
    s = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c1',
      kind: 'channel',
      name: 'general',
    }).state

    // Initial history ready at t = 1000ms, but WebSocket subscription not yet confirmed (live: false)
    const init = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: false,
      messages: [msg(1, 'tanaka', 'hello')],
      selfId: 'me',
      nowMs: 1_000,
    })
    s = init.state
    expect(s.offlineSinceMs).toBeNull()
    expect(s.reconnecting).toBe(false)

    // Still not live at t = 4000ms (> 2 s later): still connecting for the first time, not reconnecting
    const later = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: false,
      messages: [msg(1, 'tanaka', 'hello')],
      selfId: 'me',
      nowMs: 4_000,
    })
    expect(later.state).toBe(s)
    expect(later.state.offlineSinceMs).toBeNull()
    expect(later.state.reconnecting).toBe(false)

    const timerCheck = stepAnnouncements(later.state, { type: 'offline_timer_elapsed', nowMs: 4_000 })
    expect(timerCheck.state).toBe(s)
    expect(timerCheck.announcement).toBeNull()
  })

  it('createAnnouncementController coordinates view announcements, sender names and timers without state loops', () => {
    let nowMs = 1_000
    const announced: string[] = []
    let scheduledFn: (() => void) | null = null
    const ctrl = createAnnouncementController({
      now: () => nowMs,
      onAnnounce: (m) => announced.push(m),
      schedule: (fn) => {
        scheduledFn = fn
        return 1
      },
      cancel: () => {
        scheduledFn = null
      },
    })

    ctrl.onViewChanged({ viewId: 'c1', kind: 'channel', name: 'general' })
    expect(announced).toEqual(['# general'])

    // Initial ready + live
    ctrl.onTimelineUpdated({
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(1, 'tanaka', '初期')],
      selfId: 'me',
      resolveSenderName: (id) => names[id] ?? 'メンバー',
    })
    expect(announced).toEqual(['# general'])

    // Live message uses resolveSenderName
    nowMs = 1_500
    ctrl.onTimelineUpdated({
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(1, 'tanaka', '初期'), msg(2, 'tanaka', 'お疲れ様です')],
      selfId: 'me',
      resolveSenderName: (id) => names[id] ?? 'メンバー',
    })
    expect(announced).toEqual(['# general', '田中 美咲: お疲れ様です'])

    // Disconnect schedules 2 s reconnect timer, then announces when elapsed
    nowMs = 2_000
    ctrl.onTimelineUpdated({
      viewId: 'c1',
      status: 'ready',
      live: false,
      messages: [msg(1, 'tanaka', '初期'), msg(2, 'tanaka', 'お疲れ様です')],
      selfId: 'me',
      resolveSenderName: (id) => names[id] ?? 'メンバー',
    })
    expect(ctrl.get().reconnecting).toBe(false)
    expect(scheduledFn).not.toBeNull()

    nowMs = 4_000
    scheduledFn!()
    expect(ctrl.get().reconnecting).toBe(true)
    expect(announced.at(-1)).toBe('再接続しています…')

    ctrl.destroy()
  })
})
