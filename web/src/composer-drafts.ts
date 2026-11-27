import type { Result } from './api'
import type { DraftStore, DraftTarget } from './drafts'
import { messageBodyError, topicNameError } from './message-rules'

export type TopicComposerState = {
  draft: string
  composerError: string | null
}

export type ChannelComposerState = TopicComposerState & {
  topicDraft: string
}

export type ComposerTarget = {
  channelId: string
  topicId?: string | null
  replyRootId?: string | null
}

export type SubmitDraftOptions = {
  target: ComposerTarget
  /** Optional Topic name validation before body validation; `required` rejects empty names (Topic composer). */
  topicName?: { value: string; required: boolean }
  canSend: () => boolean
  send: (body: string, restore: () => void) => Promise<boolean>
}

export type ComposerDraftsOptions = {
  organizationId?: string
  drafts?: DraftStore
}

export const DEFINITE_REFUSAL_STATUSES = [400, 403, 404, 409, 413, 415] as const

const emptyChannelComposer: ChannelComposerState = { draft: '', topicDraft: '', composerError: null }
const emptyScopedComposer: TopicComposerState = { draft: '', composerError: null }

const isChannelTarget = (target: ComposerTarget): boolean =>
  (target.topicId ?? null) === null && (target.replyRootId ?? null) === null

const keyOf = (target: ComposerTarget): string => {
  if (target.replyRootId != null) {
    return JSON.stringify([target.channelId, target.topicId ?? null, target.replyRootId])
  }
  if (target.topicId != null) {
    return JSON.stringify([target.channelId, target.topicId])
  }
  return JSON.stringify([target.channelId])
}

/**
 * Per-Organization composer draft store and submit/restore/validation coordinator
 * for Channel, Topic, and Reply composers (layer 3 controller, no `$state`).
 */
export function createComposerDrafts(options: ComposerDraftsOptions = {}) {
  const organizationId = options.organizationId ?? ''
  const drafts = options.drafts
  const states = new Map<string, ChannelComposerState | TopicComposerState>()
  const listeners = new Map<string, Set<() => void>>()
  const revisions = new Map<string, number>()
  const submitted = new Map<string, { channel: string; detached: boolean; restore: () => void }>()
  let unsubscribeDrafts: (() => void) | undefined

  const draftTargetOf = (target: ComposerTarget): DraftTarget => ({
    organizationId,
    channelId: target.channelId,
    topicId: target.topicId ?? null,
    replyRootId: target.replyRootId ?? null,
  })

  const revisionOf = (key: string): number => revisions.get(key) ?? 0
  const bumpRevision = (key: string): void => {
    revisions.set(key, revisionOf(key) + 1)
  }
  const notifyKey = (key: string): void => {
    listeners.get(key)?.forEach(listener => listener())
  }

  function getRaw(target: ComposerTarget): ChannelComposerState | TopicComposerState {
    const key = keyOf(target)
    const existing = states.get(key)
    if (existing) return existing
    const dt = draftTargetOf(target)
    const draft = drafts?.get(dt) ?? ''
    if (isChannelTarget(target)) {
      const topicDraft = drafts?.getTopicDraft(dt) ?? ''
      if (!draft && !topicDraft) return emptyChannelComposer
      const extra: ChannelComposerState = { ...emptyChannelComposer, draft, topicDraft }
      states.set(key, extra)
      return extra
    }
    if (!draft) return emptyScopedComposer
    const extra: TopicComposerState = { ...emptyScopedComposer, draft }
    states.set(key, extra)
    return extra
  }

  function put(target: ComposerTarget, patch: Partial<ChannelComposerState>): boolean {
    const key = keyOf(target)
    const isChannel = isChannelTarget(target)
    const prev = getRaw(target)
    const prevTopicDraft = isChannel ? (prev as ChannelComposerState).topicDraft : ''
    if (
      (patch.draft === undefined || patch.draft === prev.draft) &&
      (!isChannel || patch.topicDraft === undefined || patch.topicDraft === prevTopicDraft) &&
      (patch.composerError === undefined || patch.composerError === prev.composerError)
    ) {
      return false
    }
    const draft = patch.draft ?? prev.draft
    const composerError = patch.composerError !== undefined ? patch.composerError : prev.composerError
    if (isChannel) {
      const topicDraft = patch.topicDraft ?? prevTopicDraft
      if (draft === '' && topicDraft === '' && composerError === null) states.delete(key)
      else states.set(key, { draft, topicDraft, composerError })
      if (patch.draft !== undefined || patch.topicDraft !== undefined) {
        drafts?.set(draftTargetOf(target), draft, topicDraft)
      }
    } else {
      if (draft === '' && composerError === null) states.delete(key)
      else states.set(key, { draft, composerError })
      if (patch.draft !== undefined) {
        drafts?.set(draftTargetOf(target), draft)
      }
    }
    return true
  }

  function set(target: ComposerTarget, patch: Partial<ChannelComposerState>): void {
    if (put(target, patch)) notifyKey(keyOf(target))
  }

  function setDraft(target: ComposerTarget, draft: string): void {
    if (draft === getRaw(target).draft) return
    bumpRevision(keyOf(target))
    set(target, { draft, composerError: null })
  }

  function setTopicDraft(channelId: string, topicDraft: string): void {
    const target: ComposerTarget = { channelId }
    if (topicDraft === (getRaw(target) as ChannelComposerState).topicDraft) return
    bumpRevision(keyOf(target))
    set(target, { topicDraft, composerError: null })
  }

  function migrateReplyDraft(
    channelId: string,
    fromReplyRootId: string,
    fromTopicId: string | null,
    toReplyRootId: string,
    toTopicId: string | null,
  ): void {
    if (fromReplyRootId === toReplyRootId && fromTopicId === toTopicId) return
    const fromTarget: ComposerTarget = { channelId, topicId: fromTopicId, replyRootId: fromReplyRootId }
    const tempDraft = getRaw(fromTarget).draft
    if (!tempDraft) return
    const toTarget: ComposerTarget = { channelId, topicId: toTopicId, replyRootId: toReplyRootId }
    const existing = getRaw(toTarget).draft
    setDraft(fromTarget, '')
    bumpRevision(keyOf(toTarget))
    set(toTarget, {
      draft: existing ? `${existing}\n${tempDraft}` : tempDraft,
      composerError: null,
    })
  }

  return {
    getChannel: (channelId: string): ChannelComposerState =>
      getRaw({ channelId }) as ChannelComposerState,

    getScoped: (target: ComposerTarget): TopicComposerState =>
      getRaw(target) as TopicComposerState,

    subscribe(target: ComposerTarget, listener: () => void) {
      const key = keyOf(target)
      let setForKey = listeners.get(key)
      if (!setForKey) {
        setForKey = new Set()
        listeners.set(key, setForKey)
      }
      setForKey.add(listener)
      return () => {
        setForKey.delete(listener)
        if (setForKey.size === 0 && listeners.get(key) === setForKey) listeners.delete(key)
      }
    },

    setDraft,
    setTopicDraft,

    async submit(opts: SubmitDraftOptions): Promise<boolean> {
      const { target, canSend, send } = opts
      const key = keyOf(target)
      const isChannel = isChannelTarget(target)
      const current = getRaw(target)
      const text = current.draft
      const channelTopicDraft = isChannel ? (current as ChannelComposerState).topicDraft : ''
      if (!text.trim()) return false
      if (opts.topicName !== undefined) {
        if (opts.topicName.required || opts.topicName.value.length > 0) {
          const nameError = topicNameError(opts.topicName.value)
          if (nameError !== null) {
            set(target, { composerError: nameError })
            return false
          }
        }
      }
      const bodyError = messageBodyError(text)
      if (bodyError !== null) {
        set(target, { composerError: bodyError })
        return false
      }
      if (!canSend()) return false
      const revision = revisionOf(key)
      set(
        target,
        isChannel
          ? { draft: '', topicDraft: '', composerError: null }
          : { draft: '', composerError: null },
      )
      const dt = draftTargetOf(target)
      const storeRevision = drafts?.revision(dt)
      const restore = () => {
        const now = getRaw(target)
        const unchanged =
          revisionOf(key) === revision &&
          drafts?.revision(dt) === storeRevision &&
          now.draft === '' &&
          (!isChannel || (now as ChannelComposerState).topicDraft === '')
        if (unchanged) {
          set(target, isChannel ? { draft: text, topicDraft: channelTopicDraft } : { draft: text })
        }
      }
      const accepted = await send(text, restore)
      if (!accepted) restore()
      return accepted
    },

    restoreFailed(target: ComposerTarget, body: string, topicName?: string | null): void {
      const key = keyOf(target)
      const current = getRaw(target)
      bumpRevision(key)
      const draft = current.draft ? `${current.draft}\n${body}` : body
      set(
        target,
        isChannelTarget(target)
          ? { draft, topicDraft: topicName ?? '', composerError: null }
          : { draft, composerError: null },
      )
    },

    migrateReplyDraft,

    reconcileReplyDrafts(channelId: string, replyRootId: string, topicId: string | null): void {
      const target = draftTargetOf({ channelId, topicId, replyRootId })
      for (const fromTopicId of drafts?.replyDraftTopics(target) ?? []) {
        migrateReplyDraft(channelId, replyRootId, fromTopicId, replyRootId, topicId)
      }
    },

    trackSubmitted(clientMessageId: string, channel: string, restore: () => void): void {
      submitted.set(clientMessageId, { channel, detached: false, restore })
    },

    dropSubmitted(clientMessageId: string): void {
      submitted.delete(clientMessageId)
    },

    detachSubmitted(shouldDetach: (channel: string, clientMessageId: string) => boolean): void {
      for (const [id, entry] of submitted) {
        // A repeated stop sees no pending state; it must not undo an earlier detachment (C10).
        if (entry.detached) continue
        entry.detached = shouldDetach(entry.channel, id)
      }
    },

    observeSendResult(clientMessageId: string, result: Result<unknown>): void {
      const entry = submitted.get(clientMessageId)
      // Network includes admission 503; keep the restore while a same-key retry is possible.
      if (entry?.detached || result.ok || (result.kind === 'http' && result.status !== 429)) {
        submitted.delete(clientMessageId)
      }
      // A closed Organization has no failed Message UI; retain a definite refusal's unedited text.
      if (
        entry?.detached &&
        !result.ok &&
        result.kind === 'http' &&
        (DEFINITE_REFUSAL_STATUSES as readonly number[]).includes(result.status)
      ) {
        entry.restore()
      }
    },

    resetSession(mode: 'start' | 'stop'): () => void {
      const changedKeys = [...states.keys()]
      states.clear()
      for (const [id, entry] of submitted) {
        if (!entry.detached) submitted.delete(id)
      }
      if (mode === 'stop') {
        unsubscribeDrafts?.()
        unsubscribeDrafts = undefined
      } else {
        unsubscribeDrafts ??= drafts?.subscribe(target => {
          if (target.organizationId !== organizationId) return
          const composerTarget: ComposerTarget = {
            channelId: target.channelId,
            topicId: target.topicId ?? null,
            replyRootId: target.replyRootId ?? null,
          }
          const key = keyOf(composerTarget)
          const draft = drafts.get(target)
          // Detached restores write the Account Session store, outside this controller's lifetime.
          if (isChannelTarget(composerTarget)) {
            const extra = (states.get(key) as ChannelComposerState | undefined) ?? emptyChannelComposer
            const topicDraft = drafts.getTopicDraft(target)
            if (extra.draft === draft && extra.topicDraft === topicDraft) return
            states.set(key, { ...extra, draft, topicDraft })
            notifyKey(key)
          } else {
            const extra = (states.get(key) as TopicComposerState | undefined) ?? emptyScopedComposer
            if (extra.draft === draft) return
            states.set(key, { ...extra, draft })
            notifyKey(key)
          }
        })
      }
      return () => {
        for (const key of changedKeys) notifyKey(key)
      }
    },

    hasDrafts(): boolean {
      if (drafts?.hasDrafts()) return true
      for (const extra of states.values()) {
        if (extra.draft.length > 0 || ('topicDraft' in extra && extra.topicDraft.length > 0)) return true
      }
      return false
    },
  }
}
