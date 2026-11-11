import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createSubscriber } from 'svelte/reactivity'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, sentBy, settle } from './adapter-test-helpers.svelte'
import {
  createAnnouncementController,
  createLiveAnnouncementQueue,
  initialAnnouncementState,
  stepAnnouncements,
  type LiveAnnouncementItem,
} from './announcements'
import { createAuth } from './auth.svelte'
import { channelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import {
  createTimelineScrollController,
  initialTimelineScrollState,
  stepTimelineScroll,
} from './timeline-scroll'

const webDir = resolve(import.meta.dirname, '..')

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

  it('keeps the live session mounted on C10 organization_unavailable while preserving loaded Messages, drafts and discardable pending sends', async () => {
    const net = fakeNetwork()
    const auth = createAuth({
      restore: vi.fn(async () => ({
        screen: 'app' as const,
        identity: {
          account: { id: 'acc-1', email: 'm1@example.com' },
          organizations: [
            { organization_id: 'o', name: 'Org 1' },
            { organization_id: 'other', name: 'Org 2' },
          ],
        },
      })),
      signIn: vi.fn(),
      setupAndSignIn: vi.fn(),
      signOut: vi.fn(async () => true),
      getOrganization: vi.fn(async (id: string) =>
        ok({
          member: { id: 'm1', name: 'm1', role: 'owner' as const },
          organization: { organization_id: id, name: id },
        }),
      ),
      openSession(selfId, onEnded, organizationId) {
        const session = createSession({ selfId, onEnded, organizationId, ...net.options(selfId) })
        return {
          channels: channelsAdapter(session.channels),
          sync: syncAdapter(session.sync),
          close: session.close,
        }
      },
    })

    await auth.load()
    net.socket.onReady()
    net.pages.general = ok({ messages: [record(1, 'general')], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('general', 'general')] }))
    await settle()
    net.subscribed('general', 1)
    await settle()

    const activeSession = auth.session!
    const ch = activeSession.sync.channel('general')
    const sendingPromise = ch.send('送信確認待ちのメッセージ')
    await settle()
    ch.setDraft('入力途中の下書き')
    expect(ch.timeline.pending).toHaveLength(1)
    const pendingId = ch.timeline.pending[0].clientMessageId

    // Trigger C10 Organization unavailability (4003 close) while the session is live
    net.socket.onClose(4003)
    await sendingPromise
    await settle()

    // Session and Organization remain mounted for the live session so Workspace stays rendered
    expect(auth.organizationStatus).toBe('unavailable')
    expect(auth.session).toBe(activeSession)
    expect(auth.organization).not.toBeNull()
    expect(activeSession.sync.unavailable).toBe(true)

    // Loaded Messages, Composer draft and failed pending send remain visible and discardable
    expect(ch.timeline.messages).toEqual([record(1, 'general')])
    expect(ch.timeline.draft).toBe('入力途中の下書き')
    expect(ch.timeline.pending).toEqual([
      { clientMessageId: pendingId, body: '送信確認待ちのメッセージ', status: 'failed', retryable: false },
    ])

    ch.discard(pendingId)
    await settle()
    expect(ch.timeline.pending).toEqual([])
    activeSession.close()
  })

  it('emits a new keyed announcement state for consecutive identical live announcements and wires C10 banner and session-wide beforeunload', async () => {
    const queue = createLiveAnnouncementQueue()
    const observedKeys: number[] = []
    let nowMs = 1_000
    let ctrl!: ReturnType<typeof createAnnouncementController>

    const stop = $effect.root(() => {
      let pageAnnouncement = $state<LiveAnnouncementItem>(queue.current)
      ctrl = createAnnouncementController({
        now: () => nowMs,
        onAnnounce: (msg) => {
          pageAnnouncement = queue.enqueue(msg)
        },
      })

      $effect(() => {
        if (pageAnnouncement.text) {
          observedKeys.push(pageAnnouncement.id)
        }
      })
    })

    try {
      ctrl.onViewChanged({ viewId: 'c1', kind: 'channel', name: 'general' })
      await settle()
      ctrl.onTimelineUpdated({
        viewId: 'c1',
        status: 'ready',
        live: true,
        messages: [msgFor(1, 'alice', '初期')],
        selfId: 'me',
        resolveSenderName: () => '田中 美咲',
      })
      await settle()

      nowMs = 2_000
      ctrl.onTimelineUpdated({
        viewId: 'c1',
        status: 'ready',
        live: true,
        messages: [msgFor(1, 'alice', '初期'), msgFor(2, 'alice', '了解です')],
        selfId: 'me',
        resolveSenderName: () => '田中 美咲',
      })
      await settle()

      // Second identical live Message after the 2 s burst window produces the same string,
      // but must still increment the keyed announcement id so the polite live region mutates.
      nowMs = 5_000
      ctrl.onTimelineUpdated({
        viewId: 'c1',
        status: 'ready',
        live: true,
        messages: [msgFor(1, 'alice', '初期'), msgFor(2, 'alice', '了解です'), msgFor(3, 'alice', '了解です')],
        selfId: 'me',
        resolveSenderName: () => '田中 美咲',
      })

      await settle()
      expect(queue.current.text).toBe('田中 美咲: 了解です')
      expect(observedKeys).toEqual([1, 2, 3])
    } finally {
      stop()
      ctrl.destroy()
    }

    const appSrc = readFileSync(join(webDir, 'src/App.svelte'), 'utf8')
    expect(appSrc).toContain('{#if session && organization}')
    expect(appSrc).not.toContain("auth.organizationStatus !== 'unavailable' && auth.organizationStatus !== 'error'")
    expect(appSrc).toContain('{#key pageAnnouncement.id}')

    const timelineSrc = readFileSync(join(webDir, 'src/Timeline.svelte'), 'utf8')
    expect(timelineSrc).toMatch(/\{#if organizationUnavailable\}[\s\S]*?この組織は利用できません。[\s\S]*?\{:else if s\.status === 'unavailable'\}/)

    const workspaceSrc = readFileSync(join(webDir, 'src/Workspace.svelte'), 'utf8')
    expect(workspaceSrc).toContain('session.sync.hasUnsavedChanges()')
  })
})

function msgFor(seq: number, sender: string, body: string) {
  return { id: `m-${seq}`, seq, sender, body }
}
