/** Maximum characters (Unicode scalar values) of a Message body announced in the polite status region (`docs/ui.md` §6). */
export const LIVE_MESSAGE_PREVIEW_MAX = 80

/** Coalescing window (ms) within which multiple live Messages become `新着メッセージ n件` (`docs/ui.md` §6). */
export const COALESCE_WINDOW_MS = 2_000

/** Delay (ms) offline before showing the reconnecting banner and announcing it (`docs/ui.md` §5, §6). */
export const RECONNECT_ANNOUNCE_DELAY_MS = 2_000

/** Loading timeout (ms) after which a still-loading state shows the retryable error (`docs/ui.md` §5). */
export const LOADING_TIMEOUT_MS = 10_000

export type AnnounceableMessage = {
  id: string
  seq: number
  sender: string
  body: string
  topic_id?: string | null
  reply_to?: string | null
}

export type AnnouncementState = {
  viewId: string
  initialized: boolean
  everLive: boolean
  wasLive: boolean
  minSeq: number | null
  maxSeq: number | null
  seenSeqs: ReadonlySet<number>
  announcedSeqs: ReadonlySet<number>
  burstStartMs: number | null
  burstCount: number
  offlineSinceMs: number | null
  reconnecting: boolean
  lastAnnouncement: string
}

export type AnnouncementInput =
  | {
      type: 'view_changed'
      viewId: string
      kind: 'channel' | 'topic'
      name: string
    }
  | {
      type: 'timeline_updated'
      viewId: string
      topicId?: string | null
      replyChainIds?: ReadonlySet<string>
      status: 'loading' | 'ready' | 'unavailable' | 'error'
      live: boolean
      messages: readonly AnnounceableMessage[]
      selfId: string
      nowMs: number
      resolveSenderName?: (senderId: string) => string
    }
  | {
      type: 'offline_timer_elapsed'
      nowMs: number
    }
  | {
      type: 'topic_summary_moved'
      topicId: string
      lastSeq: number
    }

export type AnnouncementControllerView = {
  reconnecting: boolean
  channelListTimedOut: boolean
}

export type AnnouncementControllerOptions = {
  onAnnounce?: (message: string) => void
  now?: () => number
  reconnectDelayMs?: number
  loadingTimeoutMs?: number
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export type LiveAnnouncementItem = {
  id: number
  text: string
}

/**
 * Assigns a fresh monotonic `id` to every non-empty announcement so keying the single polite
 * `role="status"` region mutates the DOM even when two consecutive announcements share identical text.
 */
export function createLiveAnnouncementQueue() {
  let seq = 0
  let current: LiveAnnouncementItem = { id: 0, text: '' }
  return {
    get current(): LiveAnnouncementItem {
      return current
    },
    enqueue(text: string): LiveAnnouncementItem {
      if (!text) return current
      current = { id: ++seq, text }
      return current
    },
  }
}

function sameSeqs(set: ReadonlySet<number>, list: readonly number[]): boolean {
  if (set.size !== list.length) return false
  for (const seq of list) {
    if (!set.has(seq)) return false
  }
  return true
}

/** Truncates a Message body to at most `maxScalars` Unicode scalar values with collapsed whitespace (`docs/ui.md` §6). */
export function formatMessagePreview(body: string, maxScalars = LIVE_MESSAGE_PREVIEW_MAX): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  const scalars = [...normalized]
  return scalars.slice(0, maxScalars).join('')
}

/** Formats a single live Message announcement (`田中 美咲: 本文の先頭 80 文字`, `docs/ui.md` §6). */
export function formatLiveMessageAnnouncement(senderName: string, body: string): string {
  const name = senderName.trim() || 'メンバー'
  return `${name}: ${formatMessagePreview(body)}`
}

/** Formats a view-change announcement (`# チャンネル名` or `トピック名`, `docs/ui.md` §2, §6). */
export function formatViewAnnouncement(view: { kind: 'channel' | 'topic'; name: string }): string {
  return view.kind === 'channel' ? `# ${view.name}` : view.name
}

export function initialAnnouncementState(): AnnouncementState {
  return {
    viewId: '',
    initialized: false,
    everLive: false,
    wasLive: false,
    minSeq: null,
    maxSeq: null,
    seenSeqs: new Set(),
    announcedSeqs: new Set(),
    burstStartMs: null,
    burstCount: 0,
    offlineSinceMs: null,
    reconnecting: false,
    lastAnnouncement: '',
  }
}

export function stepAnnouncements(
  prev: AnnouncementState,
  input: AnnouncementInput,
): { state: AnnouncementState; announcement: string | null } {
  switch (input.type) {
    case 'view_changed': {
      if (input.viewId === prev.viewId) {
        return { state: prev, announcement: null }
      }
      const announcement = formatViewAnnouncement(input)
      return {
        state: {
          viewId: input.viewId,
          initialized: false,
          everLive: false,
          wasLive: false,
          minSeq: null,
          maxSeq: null,
          seenSeqs: new Set(),
          announcedSeqs: new Set(),
          burstStartMs: null,
          burstCount: 0,
          offlineSinceMs: null,
          reconnecting: false,
          lastAnnouncement: announcement,
        },
        announcement,
      }
    }

    case 'topic_summary_moved': {
      return { state: prev, announcement: null }
    }

    case 'offline_timer_elapsed': {
      if (
        prev.offlineSinceMs !== null &&
        !prev.reconnecting &&
        input.nowMs - prev.offlineSinceMs >= RECONNECT_ANNOUNCE_DELAY_MS
      ) {
        const announcement = '再接続しています…'
        return {
          state: {
            ...prev,
            reconnecting: true,
            lastAnnouncement: announcement,
          },
          announcement,
        }
      }
      return { state: prev, announcement: null }
    }

    case 'timeline_updated': {
      const minSeq = input.messages[0]?.seq ?? null
      const maxSeq = input.messages.at(-1)?.seq ?? null
      const seqList = input.messages.map((m) => m.seq)

      if (input.viewId !== prev.viewId || !prev.initialized) {
        const initialized = input.status === 'ready' || input.messages.length > 0
        const everLive = input.live
        if (
          input.viewId === prev.viewId &&
          initialized === prev.initialized &&
          everLive === prev.everLive &&
          input.live === prev.wasLive &&
          minSeq === prev.minSeq &&
          maxSeq === prev.maxSeq &&
          sameSeqs(prev.seenSeqs, seqList) &&
          prev.offlineSinceMs === null &&
          !prev.reconnecting
        ) {
          return { state: prev, announcement: null }
        }
        const seenSeqs = new Set(seqList)
        return {
          state: {
            ...prev,
            viewId: input.viewId,
            initialized,
            everLive,
            wasLive: input.live,
            minSeq,
            maxSeq,
            seenSeqs,
            announcedSeqs: new Set(seenSeqs),
            offlineSinceMs: null,
            reconnecting: false,
          },
          announcement: null,
        }
      }

      const everLive = prev.everLive || input.live
      let offlineSinceMs = prev.offlineSinceMs
      let reconnecting = prev.reconnecting
      let connectionAnnouncement: string | null = null

      if (input.live) {
        if (prev.reconnecting) {
          connectionAnnouncement = '接続しました。'
        }
        offlineSinceMs = null
        reconnecting = false
      } else if (everLive && input.status === 'ready') {
        if (offlineSinceMs === null) {
          offlineSinceMs = input.nowMs
        }
      } else {
        offlineSinceMs = null
        reconnecting = false
      }

      const seqsUnchanged =
        minSeq === prev.minSeq && maxSeq === prev.maxSeq && sameSeqs(prev.seenSeqs, seqList)

      if (
        seqsUnchanged &&
        everLive === prev.everLive &&
        input.live === prev.wasLive &&
        offlineSinceMs === prev.offlineSinceMs &&
        reconnecting === prev.reconnecting &&
        connectionAnnouncement === null
      ) {
        return { state: prev, announcement: null }
      }

      const seenSeqs = seqsUnchanged ? prev.seenSeqs : new Set(seqList)
      const added = seqsUnchanged ? [] : input.messages.filter((m) => !prev.seenSeqs.has(m.seq))
      const addedAtTail = added.filter((m) => prev.maxSeq === null || m.seq > prev.maxSeq)
      const addedBelowTail = added.filter((m) => prev.maxSeq !== null && m.seq <= prev.maxSeq)

      const isContiguousTail =
        addedAtTail.length > 0 &&
        addedAtTail.every((m, idx) =>
          idx === 0 ? prev.maxSeq === null || m.seq === prev.maxSeq + 1 : m.seq === addedAtTail[idx - 1].seq + 1,
        )

      // Per spec S3, replay finishes before `subscribed` (`live`), and pages/fills either insert below `maxSeq` or jump non-contiguously.
      const isLiveTailDelivery =
        prev.wasLive &&
        input.live &&
        input.status === 'ready' &&
        addedBelowTail.length === 0 &&
        isContiguousTail

      const liveFromOthers = isLiveTailDelivery
        ? addedAtTail.filter(
            (m) =>
              m.sender !== input.selfId &&
              !prev.announcedSeqs.has(m.seq) &&
              ((input.replyChainIds !== undefined &&
                (input.replyChainIds.has(m.id) ||
                  (m.reply_to != null && input.replyChainIds.has(m.reply_to)))) ||
                input.topicId === undefined ||
                (input.topicId === null
                  ? (m.topic_id ?? null) === null && (m.reply_to ?? null) === null
                  : m.topic_id === input.topicId)),
          )
        : []

      let announcedSeqs = prev.announcedSeqs
      if (!seqsUnchanged) {
        const nextAnnounced = new Set(prev.announcedSeqs)
        for (const s of seenSeqs) nextAnnounced.add(s)
        announcedSeqs = nextAnnounced
      }

      if (liveFromOthers.length === 0) {
        return {
          state: {
            ...prev,
            everLive,
            wasLive: input.live,
            minSeq,
            maxSeq,
            seenSeqs,
            announcedSeqs,
            offlineSinceMs,
            reconnecting,
            lastAnnouncement: connectionAnnouncement ?? prev.lastAnnouncement,
          },
          announcement: connectionAnnouncement,
        }
      }

      const inBurstWindow =
        prev.burstStartMs !== null &&
        input.nowMs >= prev.burstStartMs &&
        input.nowMs - prev.burstStartMs <= COALESCE_WINDOW_MS

      let burstStartMs: number
      let burstCount: number
      let messageAnnouncement: string

      if (inBurstWindow) {
        burstStartMs = prev.burstStartMs!
        burstCount = prev.burstCount + liveFromOthers.length
        messageAnnouncement = `新着メッセージ ${burstCount}件`
      } else if (liveFromOthers.length === 1) {
        const msg = liveFromOthers[0]
        const senderName = input.resolveSenderName ? input.resolveSenderName(msg.sender) : 'メンバー'
        burstStartMs = input.nowMs
        burstCount = 1
        messageAnnouncement = formatLiveMessageAnnouncement(senderName, msg.body)
      } else {
        burstStartMs = input.nowMs
        burstCount = liveFromOthers.length
        messageAnnouncement = `新着メッセージ ${burstCount}件`
      }

      return {
        state: {
          ...prev,
          everLive,
          wasLive: input.live,
          minSeq,
          maxSeq,
          seenSeqs,
          announcedSeqs,
          burstStartMs,
          burstCount,
          offlineSinceMs,
          reconnecting,
          lastAnnouncement: messageAnnouncement,
        },
        announcement: messageAnnouncement,
      }
    }
  }
}

/**
 * Layer-3 controller owning announcement stepping, the 2 s Message coalescing/offline timers and the 10 s
 * Channel-list loading timeout (`docs/ui.md` §2, §5, §6). Holds no `$state`; notifies subscribers
 * only when `reconnecting` or `channelListTimedOut` changes.
 */
export function createAnnouncementController(options: AnnouncementControllerOptions = {}) {
  const now = options.now ?? (() => Date.now())
  const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_ANNOUNCE_DELAY_MS
  const loadingTimeoutMs = options.loadingTimeoutMs ?? LOADING_TIMEOUT_MS
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let state = initialAnnouncementState()
  let messageTimer: unknown = null
  let pendingMessageAnnouncement: string | null = null
  let offlineTimer: unknown = null
  let offlineScheduledFor: number | null = null
  let channelListTimedOut = false
  let channelListTimer: unknown = null
  let channelListLoadingActive = false
  let view: AnnouncementControllerView = {
    reconnecting: state.reconnecting,
    channelListTimedOut,
  }
  const listeners = new Set<() => void>()

  function notifyIfViewChanged() {
    if (view.reconnecting === state.reconnecting && view.channelListTimedOut === channelListTimedOut) {
      return
    }
    view = {
      reconnecting: state.reconnecting,
      channelListTimedOut,
    }
    listeners.forEach((l) => l())
  }

  function clearOfflineTimer() {
    if (offlineTimer !== null) {
      cancel(offlineTimer)
      offlineTimer = null
      offlineScheduledFor = null
    }
  }

  function clearMessageTimer() {
    if (messageTimer !== null) cancel(messageTimer)
    messageTimer = null
    pendingMessageAnnouncement = null
  }

  function flushMessageAnnouncement() {
    const message = pendingMessageAnnouncement
    clearMessageTimer()
    state = { ...state, burstStartMs: null, burstCount: 0 }
    if (message) options.onAnnounce?.(message)
  }

  function queueMessageAnnouncement(message: string) {
    pendingMessageAnnouncement = message
    // Keep one fixed window from its first Message. Announcing each intermediate
    // count would cause several polite-region updates for the same burst.
    if (messageTimer === null) messageTimer = schedule(flushMessageAnnouncement, COALESCE_WINDOW_MS)
  }

  function clearChannelListTimer() {
    if (channelListTimer !== null) {
      cancel(channelListTimer)
      channelListTimer = null
    }
  }

  function syncOfflineTimer() {
    const offlineSince = state.offlineSinceMs
    if (offlineSince === null || state.reconnecting) {
      clearOfflineTimer()
      return
    }
    if (offlineTimer !== null && offlineScheduledFor === offlineSince) {
      return
    }
    clearOfflineTimer()
    offlineScheduledFor = offlineSince
    const elapsed = now() - offlineSince
    const waitMs = Math.max(0, reconnectDelayMs - elapsed)
    offlineTimer = schedule(() => {
      offlineTimer = null
      offlineScheduledFor = null
      const res = stepAnnouncements(state, {
        type: 'offline_timer_elapsed',
        nowMs: now(),
      })
      state = res.state
      if (res.announcement) options.onAnnounce?.(res.announcement)
      notifyIfViewChanged()
    }, waitMs)
  }

  return {
    get(): AnnouncementControllerView {
      return view
    },
    getState(): AnnouncementState {
      return state
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onViewChanged(input: { viewId: string; kind: 'channel' | 'topic'; name: string }): void {
      if (input.viewId !== state.viewId) clearMessageTimer()
      const res = stepAnnouncements(state, { type: 'view_changed', ...input })
      state = res.state
      syncOfflineTimer()
      if (res.announcement) options.onAnnounce?.(res.announcement)
      notifyIfViewChanged()
    },
    onTimelineUpdated(input: {
      viewId: string
      topicId?: string | null
      replyChainIds?: ReadonlySet<string>
      status: 'loading' | 'ready' | 'unavailable' | 'error'
      live: boolean
      messages: readonly AnnounceableMessage[]
      selfId: string
      resolveSenderName?: (senderId: string) => string
    }): void {
      if (input.viewId !== state.viewId) clearMessageTimer()
      // A delayed timer must not merge Messages from a later window into the old one.
      if (pendingMessageAnnouncement && state.burstStartMs !== null && now() - state.burstStartMs > COALESCE_WINDOW_MS) {
        flushMessageAnnouncement()
      }
      const res = stepAnnouncements(state, {
        type: 'timeline_updated',
        ...input,
        nowMs: now(),
      })
      const hasNewLiveMessages = res.state.burstStartMs !== state.burstStartMs || res.state.burstCount !== state.burstCount
      state = res.state
      syncOfflineTimer()
      if (res.announcement) {
        if (hasNewLiveMessages) queueMessageAnnouncement(res.announcement)
        else options.onAnnounce?.(res.announcement)
      }
      notifyIfViewChanged()
    },
    syncChannelListLoading(isLoadingEmpty: boolean): void {
      if (isLoadingEmpty === channelListLoadingActive) return
      channelListLoadingActive = isLoadingEmpty
      clearChannelListTimer()
      if (!isLoadingEmpty) {
        channelListTimedOut = false
        notifyIfViewChanged()
        return
      }
      channelListTimedOut = false
      notifyIfViewChanged()
      channelListTimer = schedule(() => {
        channelListTimer = null
        channelListTimedOut = true
        notifyIfViewChanged()
      }, loadingTimeoutMs)
    },
    resetChannelListTimeout(): void {
      channelListLoadingActive = false
      clearChannelListTimer()
      channelListTimedOut = false
      notifyIfViewChanged()
    },
    destroy(): void {
      clearMessageTimer()
      clearOfflineTimer()
      clearChannelListTimer()
      listeners.clear()
    },
  }
}
