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
}

export type MessageSource =
  | 'auto'
  | 'live'
  | 'initial_history'
  | 'older_page'
  | 'gap_fill'
  | 'replay'
  | 'reorder'

export type AnnouncementState = {
  viewId: string
  initialized: boolean
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
      status: 'loading' | 'ready' | 'unavailable' | 'error'
      live: boolean
      messages: readonly AnnounceableMessage[]
      selfId: string
      nowMs: number
      resolveSenderName?: (senderId: string) => string
      source?: MessageSource
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
      const seenSeqs = new Set(input.messages.map((m) => m.seq))
      const source = input.source ?? 'auto'

      if (input.viewId !== prev.viewId || !prev.initialized) {
        const initialized = input.status === 'ready' || input.messages.length > 0
        return {
          state: {
            ...prev,
            viewId: input.viewId,
            initialized,
            wasLive: input.live,
            minSeq,
            maxSeq,
            seenSeqs,
            announcedSeqs: new Set(seenSeqs),
            offlineSinceMs: initialized && !input.live ? input.nowMs : null,
            reconnecting: false,
          },
          announcement: null,
        }
      }

      let offlineSinceMs = prev.offlineSinceMs
      let reconnecting = prev.reconnecting
      let connectionAnnouncement: string | null = null

      if (input.live) {
        if (prev.reconnecting) {
          connectionAnnouncement = '接続しました。'
        }
        offlineSinceMs = null
        reconnecting = false
      } else if (input.status === 'ready') {
        if (offlineSinceMs === null) {
          offlineSinceMs = input.nowMs
        }
      } else {
        offlineSinceMs = null
        reconnecting = false
      }

      const isSuppressedSource =
        source === 'initial_history' ||
        source === 'older_page' ||
        source === 'gap_fill' ||
        source === 'replay' ||
        source === 'reorder'

      // Live messages can only be announced when the subscription was ALREADY live before this step and stays live.
      const canAnnounceLive = !isSuppressedSource && prev.wasLive && input.live && input.status === 'ready'

      const added = input.messages.filter((m) => !prev.seenSeqs.has(m.seq))
      const addedAtTail = added.filter((m) => prev.maxSeq === null || m.seq > prev.maxSeq)
      const addedBelowTail = added.filter((m) => prev.maxSeq !== null && m.seq <= prev.maxSeq)

      // Under 'auto', a single contiguous message at the tail with no holes filled below is a live WebSocket event.
      // Batch page merges (addedAtTail.length > 1) or non-contiguous jumps (seq > prev.maxSeq + 1) are history/gap-fill pages.
      const isLiveTailDelivery =
        source === 'live' ||
        (source === 'auto' &&
          addedBelowTail.length === 0 &&
          addedAtTail.length === 1 &&
          (prev.maxSeq === null || addedAtTail[0].seq === prev.maxSeq + 1))

      const liveFromOthers =
        canAnnounceLive && isLiveTailDelivery
          ? addedAtTail.filter((m) => m.sender !== input.selfId && !prev.announcedSeqs.has(m.seq))
          : []

      const announcedSeqs = new Set(prev.announcedSeqs)
      for (const s of seenSeqs) announcedSeqs.add(s)

      if (liveFromOthers.length === 0) {
        return {
          state: {
            ...prev,
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
