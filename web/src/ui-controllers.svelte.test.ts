import { createSubscriber } from 'svelte/reactivity'
import { describe, expect, it } from 'vitest'
import { channel, fakeNetwork, ok, record, sentBy, settle } from './adapter-test-helpers.svelte'
import {
  createAnnouncementController,
  initialAnnouncementState,
  stepAnnouncements,
} from './announcements'
import { channelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import {
  createTimelineScrollController,
  initialTimelineScrollState,
  stepTimelineScroll,
} from './timeline-scroll'

describe('UI controllers under Svelte 5 $effect.root: one step per update, no effect loops', () => {
  it('Timeline and Workspace controller effects run exactly once per timeline update', async () => {
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    const channels = channelsAdapter(session.channels)
    const sync = syncAdapter(session.sync)

    const scrollCtrl = createTimelineScrollController()
    const subScroll = createSubscriber((u) => scrollCtrl.subscribe(u))

    const announced: string[] = []
    const announceCtrl = createAnnouncementController({
      onAnnounce: (m) => announced.push(m),
    })
    const subAnnounce = createSubscriber((u) => announceCtrl.subscribe(u))

    let timelineEffectRuns = 0
    let announceEffectRuns = 0
    let lastViewId = ''

    const stop = $effect.root(() => {
      const s = $derived(channels.state)
      const selected = $derived(s.channels.find((c) => c.id === s.selectedId))
      const currentChannel = $derived(selected ? sync.channel(selected.id) : null)
      const currentTimeline = $derived(currentChannel ? currentChannel.timeline : null)
      const currentLive = $derived(currentChannel ? currentChannel.live : false)
      const scrollView = $derived.by(() => {
        subScroll()
        return scrollCtrl.get()
      })
      const announceView = $derived.by(() => {
        subAnnounce()
        return announceCtrl.get()
      })

      // Also observe the derived views as the templates do
      $effect(() => {
        void scrollView.pinned
        void scrollView.belowCount
        void announceView.reconnecting
      })

      $effect(() => {
        if (!selected) return
        if (selected.id === lastViewId) return
        lastViewId = selected.id
        announceCtrl.onViewChanged({ viewId: selected.id, kind: 'channel', name: selected.name })
      })

      $effect(() => {
        if (!selected || !currentTimeline) return
        announceEffectRuns++
        announceCtrl.onTimelineUpdated({
          viewId: selected.id,
          status: currentTimeline.status,
          live: currentLive,
          messages: currentTimeline.messages,
          selfId: 'me',
          resolveSenderName: (id) => (id === 'alice' ? '田中 美咲' : 'メンバー'),
        })
      })

      $effect(() => {
        if (!selected || !currentTimeline) return
        timelineEffectRuns++
        scrollCtrl.sync({
          channelId: selected.id,
          status: currentTimeline.status,
          messages: currentTimeline.messages,
          pendingIds: currentTimeline.pending.map((p) => p.clientMessageId),
          selfId: 'me',
        })
      })
    })

    try {
      // 1. Resolve Channel list and initial history
      net.pages.general = ok({ messages: [record(1, 'general')], has_more: false })
      net.lists[0].resolve(ok({ channels: [channel('general', 'general')] }))
      await settle()
      net.subscribed('general', 1)
      await settle()

      const runsAfterOpen = timelineEffectRuns
      expect(runsAfterOpen).toBeGreaterThan(0)
      expect(runsAfterOpen).toBeLessThanOrEqual(4)
      expect(announced).toEqual(['# general'])

      // 2. Send a Message: one pending update + one ack update -> exactly 1 run per change, no loop
      const ch = sync.channel('general')
      ch.setDraft('こんにちは')
      const submitPromise = ch.submit()
      await settle()
      const runsAfterPending = timelineEffectRuns
      expect(runsAfterPending - runsAfterOpen).toBe(1)

      net.sends[0].resolve(ok(sentBy('me', 2, 'me-c1', 'こんにちは', 'general')))
      await submitPromise
      await settle()
      expect(timelineEffectRuns - runsAfterPending).toBe(1)

      // 3. Receive a live Message from another member -> 1 run, announces with resolved sender name
      const announceRunsBeforeLive = announceEffectRuns
      net.event({
        type: 'message',
        message: { ...record(3, 'general'), sender: 'alice', body: 'ようこそ' },
      })
      await settle()
      expect(announceEffectRuns - announceRunsBeforeLive).toBe(1)
      expect(announced).toEqual(['# general', '田中 美咲: ようこそ'])
    } finally {
      stop()
      scrollCtrl.destroy()
      announceCtrl.destroy()
      session.close()
    }
  })

  it('stepTimelineScroll and stepAnnouncements are idempotent even if read and written in the same $effect', async () => {
    let scrollRuns = 0
    let announceRuns = 0

    const stop = $effect.root(() => {
      let scrollState = $state(initialTimelineScrollState('c1'))
      let announceState = $state(initialAnnouncementState())
      const messages = [{ id: 'm1', seq: 1, sender: 'alice', body: 'hi' }]

      $effect(() => {
        scrollRuns++
        scrollState = stepTimelineScroll(scrollState, {
          type: 'sync',
          channelId: 'c1',
          status: 'ready',
          messages,
          pendingIds: [],
          selfId: 'me',
        }).state
      })

      $effect(() => {
        announceRuns++
        announceState = stepAnnouncements(announceState, {
          type: 'timeline_updated',
          viewId: 'c1',
          status: 'ready',
          live: true,
          messages,
          selfId: 'me',
          nowMs: 1_000,
        }).state
      })
    })

    try {
      await settle()
      // First run transitions from uninitialized -> initialized; second run sees identical inputs and returns `prev`.
      expect(scrollRuns).toBeLessThanOrEqual(2)
      expect(announceRuns).toBeLessThanOrEqual(2)
    } finally {
      stop()
    }
  })
})
