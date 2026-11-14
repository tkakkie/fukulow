import { describe, expect, it } from 'vitest'
import {
  createAnnouncementController,
  createLiveAnnouncementQueue,
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

  it.each([
    { rootId: 'm-1', expected: '田中 美咲: 未読込の親への返信' },
    { rootId: 'other-root', expected: null },
  ])('announces a cold-descendant Reply only for the open root ($rootId)', ({ rootId, expected }) => {
    const viewId = 'c1/'
    const replyChainIds = new Set(['m-1'])
    const history = [msg(10, 'tanaka', '初期履歴')]
    let state = stepAnnouncements(initialAnnouncementState(), {
      type: 'view_changed', viewId, kind: 'channel', name: 'general',
    }).state
    state = stepAnnouncements(state, {
      type: 'timeline_updated', viewId, topicId: null, replyChainIds,
      status: 'ready', live: true, messages: history, selfId: 'me', nowMs: 1_000,
    }).state

    // Neither the live Reply nor its parent is in the loaded chain window.
    const reply = {
      ...msg(11, 'tanaka', '未読込の親への返信'),
      topic_id: null, reply_to: 'm-5', reply_root_id: rootId,
    }
    const result = stepAnnouncements(state, {
      type: 'timeline_updated', viewId, topicId: null, replyChainIds,
      status: 'ready', live: true, messages: [...history, reply], selfId: 'me', nowMs: 2_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(result.announcement).toBe(expected)
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
    expect(announced).toEqual(['# general'])
    nowMs = 3_500
    scheduledFn!()
    expect(announced).toEqual(['# general', '田中 美咲: お疲れ様です'])

    // Disconnect schedules 2 s reconnect timer, then announces when elapsed
    nowMs = 4_000
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

    nowMs = 6_000
    scheduledFn!()
    expect(ctrl.get().reconnecting).toBe(true)
    expect(announced.at(-1)).toBe('再接続しています…')

    ctrl.destroy()
  })

  it('emits one final burst update after 2 s, keeps duplicate snapshots silent and cancels stale view timers', () => {
    let nowMs = 1_000
    const announced: string[] = []
    const timers = new Map<number, () => void>()
    let timerId = 0
    const ctrl = createAnnouncementController({
      now: () => nowMs,
      onAnnounce: (text) => announced.push(text),
      schedule: (fn) => { timers.set(++timerId, fn); return timerId },
      cancel: (id) => { timers.delete(id as number) },
    })
    const update = (messages: AnnounceableMessage[]) => ctrl.onTimelineUpdated({
      viewId: 'c1', status: 'ready', live: true, messages, selfId: 'me', resolveSenderName: () => '田中 美咲',
    })
    ctrl.onViewChanged({ viewId: 'c1', kind: 'channel', name: 'general' })
    update([msg(1, 'tanaka', '履歴')])
    nowMs = 2_000
    update([msg(1, 'tanaka', '履歴'), msg(2, 'tanaka', '1')])
    nowMs = 2_500
    update([msg(1, 'tanaka', '履歴'), msg(2, 'tanaka', '1'), msg(3, 'tanaka', '2')])
    nowMs = 3_000
    const messages = [msg(1, 'tanaka', '履歴'), msg(2, 'tanaka', '1'), msg(3, 'tanaka', '2'), msg(4, 'tanaka', '3')]
    update(messages)
    update(messages)
    expect(announced).toEqual(['# general'])
    expect(timers.size).toBe(1)
    nowMs = 4_000
    const flush = [...timers.values()][0]
    flush()
    expect(announced).toEqual(['# general', '新着メッセージ 3件'])
    update(messages)
    expect(timers.size).toBe(0)
    // A separate window returns to the individual preview; changing view drops it.
    nowMs = 5_000
    update([...messages, msg(5, 'tanaka', '古い表示')])
    expect(timers.size).toBe(1)
    ctrl.onViewChanged({ viewId: 'c2', kind: 'channel', name: 'other' })
    expect(timers.size).toBe(0)
    expect(announced).toEqual(['# general', '新着メッセージ 3件', '# other'])
    ctrl.onTimelineUpdated({ viewId: 'c2', status: 'ready', live: true, messages: [], selfId: 'me' })
    ctrl.onTimelineUpdated({ viewId: 'c2', status: 'ready', live: true, messages: [msg(1, 'tanaka', '終了後は読まない')], selfId: 'me' })
    expect(timers.size).toBe(1)
    ctrl.destroy()
    expect(timers.size).toBe(0)
  })

  it('coalesces a contiguous batch of multiple live Messages in one update and ignores non-contiguous batches', () => {
    let s = initialAnnouncementState()
    s = stepAnnouncements(s, {
      type: 'view_changed',
      viewId: 'c1',
      kind: 'channel',
      name: 'general',
    }).state

    // Initialize at seq 10
    s = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(10, 'tanaka', '初期')],
      selfId: 'me',
      nowMs: 1_000,
      resolveSenderName: (id) => names[id] ?? id,
    }).state

    // Two contiguous live Messages from others arrive in a single batched update -> 新着メッセージ 2件
    const batch1 = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [msg(10, 'tanaka', '初期'), msg(11, 'tanaka', '1件目'), msg(12, 'sato', '2件目')],
      selfId: 'me',
      nowMs: 2_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = batch1.state
    expect(batch1.announcement).toBe('新着メッセージ 2件')
    expect(s.burstCount).toBe(2)

    // Another contiguous batch within the 2 s window -> accumulates into 新着メッセージ 4件
    const batch2 = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(10, 'tanaka', '初期'),
        msg(11, 'tanaka', '1件目'),
        msg(12, 'sato', '2件目'),
        msg(13, 'tanaka', '3件目'),
        msg(14, 'sato', '4件目'),
      ],
      selfId: 'me',
      nowMs: 3_500,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = batch2.state
    expect(batch2.announcement).toBe('新着メッセージ 4件')
    expect(s.burstCount).toBe(4)

    // Contiguous batch after the 2 s window containing own send + 1 message from another -> announces the 1 message
    const batchMixed = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(10, 'tanaka', '初期'),
        msg(11, 'tanaka', '1件目'),
        msg(12, 'sato', '2件目'),
        msg(13, 'tanaka', '3件目'),
        msg(14, 'sato', '4件目'),
        msg(15, 'me', '自分の送信'),
        msg(16, 'tanaka', '相手の返信'),
      ],
      selfId: 'me',
      nowMs: 6_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    s = batchMixed.state
    expect(batchMixed.announcement).toBe('田中 美咲: 相手の返信')

    // Non-contiguous batch (gap at seq 18) -> not announced
    const gapped = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1',
      status: 'ready',
      live: true,
      messages: [
        msg(10, 'tanaka', '初期'),
        msg(11, 'tanaka', '1件目'),
        msg(12, 'sato', '2件目'),
        msg(13, 'tanaka', '3件目'),
        msg(14, 'sato', '4件目'),
        msg(15, 'me', '自分の送信'),
        msg(16, 'tanaka', '相手の返信'),
        msg(17, 'tanaka', 'ギャップ前'),
        msg(19, 'sato', 'ギャップ後'),
      ],
      selfId: 'me',
      nowMs: 9_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(gapped.announcement).toBeNull()
  })

  it('releases only the ready prefix in arrival order, coalescing pending then known together once settled', () => {
    let state = stepAnnouncements(initialAnnouncementState(), {
      type: 'timeline_updated', viewId: 'c1', status: 'ready', live: true,
      messages: [], selfId: 'me', nowMs: 0,
    }).state
    let pending = true
    const update = (messages: AnnounceableMessage[], nowMs: number) => {
      const result = stepAnnouncements(state, {
        type: 'timeline_updated', viewId: 'c1', status: 'ready', live: true,
        messages, selfId: 'me', nowMs,
        isSenderPending: id => id === 'unknown' && pending,
        resolveSenderName: id => names[id] ?? '新しい著者',
      })
      state = result.state
      return result.announcement
    }
    const known = msg(1, 'tanaka', '既知')
    const unknown = msg(2, 'unknown', '先着')
    const later = msg(3, 'sato', '後着')
    // A ready prefix is processed immediately, even with a pending sender behind it.
    expect(update([known, unknown], 1_000)).toBe('田中 美咲: 既知')
    expect(state.deferredMessages).toEqual([unknown])
    // A later known sender cannot overtake the pending sender, even after 2 s.
    expect(update([known, unknown, later], 4_000)).toBeNull()
    expect(state.deferredMessages).toEqual([unknown, later])
    pending = false
    // Release the entire ready prefix into one normal coalescing window. No extra wait
    // for the known sender, and no per-Message duplicate of the combined announcement.
    expect(update([known, unknown, later], 5_000)).toBe('新着メッセージ 2件')
    expect(state.deferredMessages).toEqual([])
    expect(update([known, unknown, later], 8_000)).toBeNull()
  })

  it.each(['view change', 'timeline reset', 'destroy'])('drops deferred Messages on %s', action => {
    const announced: string[] = []
    const ctrl = createAnnouncementController({ onAnnounce: text => announced.push(text) })
    const update = (viewId: string, messages: AnnounceableMessage[], pending: boolean) => ctrl.onTimelineUpdated({
      viewId, status: 'ready', live: true, messages, selfId: 'me',
      isSenderPending: () => pending, resolveSenderName: () => '田中 美咲',
    })
    update('c1', [], false)
    const messages = [msg(1, 'tanaka', '古い表示')]
    update('c1', messages, true)
    expect(ctrl.getState().deferredMessages).toEqual(messages)
    if (action === 'destroy') ctrl.destroy()
    else if (action === 'view change') ctrl.onViewChanged({ viewId: 'c2', kind: 'channel', name: 'other' })
    else update('c2', [], false)
    expect(ctrl.getState().deferredMessages).toEqual([])
    const before = [...announced]
    if (action !== 'destroy') update('c2', [], false)
    expect(announced).toEqual(before)
    ctrl.destroy()
  })

  it('createLiveAnnouncementQueue produces a distinct keyed item for consecutive identical announcement strings', () => {
    const queue = createLiveAnnouncementQueue()
    expect(queue.current).toEqual({ id: 0, text: '' })

    const first = queue.enqueue('田中 美咲: こんにちは')
    const second = queue.enqueue('田中 美咲: こんにちは')

    expect(first).toEqual({ id: 1, text: '田中 美咲: こんにちは' })
    expect(second).toEqual({ id: 2, text: '田中 美咲: こんにちは' })
    expect(second.id).not.toBe(first.id)
    expect(queue.enqueue('')).toBe(second)
  })

  it('suppresses Topic summary moves in Channel view while announcing live arrivals in an open Topic view', () => {
    const names: Record<string, string> = { tanaka: '田中 美咲', sato: '佐藤 健' }
    let s = initialAnnouncementState()
    s = stepAnnouncements(s, { type: 'view_changed', viewId: 'c1/', kind: 'channel', name: 'general' }).state
    s = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1/',
      topicId: null,
      status: 'ready',
      live: true,
      messages: [{ ...msg(1, 'tanaka', '初期'), topic_id: null, reply_to: null }],
      selfId: 'me',
      nowMs: 1_000,
    }).state

    // Live Topic message at seq 2 in Channel view (topicId: null) -> suppressed (Topic summary move), advances maxSeq
    let res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1/',
      topicId: null,
      status: 'ready',
      live: true,
      messages: [
        { ...msg(1, 'tanaka', '初期'), topic_id: null, reply_to: null },
        { ...msg(2, 'sato', 'トピック発言'), topic_id: 't1', reply_to: null },
      ],
      selfId: 'me',
      nowMs: 4_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(res.announcement).toBeNull()
    s = res.state

    // Subsequent top-level Channel message at seq 3 -> still contiguous (2 -> 3) and announced
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1/',
      topicId: null,
      status: 'ready',
      live: true,
      messages: [
        { ...msg(1, 'tanaka', '初期'), topic_id: null, reply_to: null },
        { ...msg(2, 'sato', 'トピック発言'), topic_id: 't1', reply_to: null },
        { ...msg(3, 'tanaka', 'チャンネル発言'), topic_id: null, reply_to: null },
      ],
      selfId: 'me',
      nowMs: 7_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(res.announcement).toBe('田中 美咲: チャンネル発言')

    // Switch to Topic t1 view -> announces Topic name, ignores Channel/t2 arrivals, announces t1 live arrival
    const switched = stepAnnouncements(res.state, {
      type: 'view_changed',
      viewId: 'c1/t1',
      kind: 'topic',
      name: '日報',
    })
    expect(switched.announcement).toBe('日報')
    s = stepAnnouncements(switched.state, {
      type: 'timeline_updated',
      viewId: 'c1/t1',
      topicId: 't1',
      status: 'ready',
      live: true,
      messages: [
        { ...msg(1, 'tanaka', '初期'), topic_id: null, reply_to: null },
        { ...msg(2, 'sato', 'トピック発言'), topic_id: 't1', reply_to: null },
        { ...msg(3, 'tanaka', 'チャンネル発言'), topic_id: null, reply_to: null },
      ],
      selfId: 'me',
      nowMs: 8_000,
    }).state

    // Live message in another Topic t2 at seq 4 -> not announced in t1, advances maxSeq
    res = stepAnnouncements(s, {
      type: 'timeline_updated',
      viewId: 'c1/t1',
      topicId: 't1',
      status: 'ready',
      live: true,
      messages: [
        { ...msg(1, 'tanaka', '初期'), topic_id: null, reply_to: null },
        { ...msg(2, 'sato', 'トピック発言'), topic_id: 't1', reply_to: null },
        { ...msg(3, 'tanaka', 'チャンネル発言'), topic_id: null, reply_to: null },
        { ...msg(4, 'tanaka', '別トピック'), topic_id: 't2', reply_to: null },
      ],
      selfId: 'me',
      nowMs: 11_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(res.announcement).toBeNull()

    // Live message in t1 at seq 5 -> contiguous (4 -> 5) and announced
    res = stepAnnouncements(res.state, {
      type: 'timeline_updated',
      viewId: 'c1/t1',
      topicId: 't1',
      status: 'ready',
      live: true,
      messages: [
        { ...msg(1, 'tanaka', '初期'), topic_id: null, reply_to: null },
        { ...msg(2, 'sato', 'トピック発言'), topic_id: 't1', reply_to: null },
        { ...msg(3, 'tanaka', 'チャンネル発言'), topic_id: null, reply_to: null },
        { ...msg(4, 'tanaka', '別トピック'), topic_id: 't2', reply_to: null },
        { ...msg(5, 'sato', '日報の更新です'), topic_id: 't1', reply_to: null },
      ],
      selfId: 'me',
      nowMs: 14_000,
      resolveSenderName: (id) => names[id] ?? id,
    })
    expect(res.announcement).toBe('佐藤 健: 日報の更新です')
  })
})
