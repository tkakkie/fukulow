import type { DraftStore } from './drafts'
import * as api from './api'
import { backoffCap, reconnectDelay } from './reconnect'
import type { ListMessagesQuery, Message, MessagePage, Result, SendMessageRequest } from './api'
import { connectRealtime, type Connection, type RealtimeHandlers } from './realtime'
import { initialState, step, type ChannelState, type Effect, type Input } from './protocol'

export type TimelineApi = {
  listMessages(channel: string, query?: ListMessagesQuery): Promise<Result<MessagePage>>
  sendMessage(channel: string, body: SendMessageRequest): Promise<Result<Message>>
}
type Wait = Extract<Effect, { type: 'wait' }>
export type SyncOptions = {
  selfId: string
  drafts?: DraftStore
  organizationId?: string
  checkMembership?: () => Promise<Result<unknown>>
  api?: TimelineApi
  connect?: (handlers: RealtimeHandlers) => Connection
  newId?: () => string
  onSessionEnded?: () => void
  graceMs?: number
  delay?: (attempt: number) => number
  random?: () => number
  requestTimeoutMs?: number
  schedule?: (fn: () => void, ms: number, effect: Wait) => unknown
  cancel?: (handle: unknown) => void
}
export type PendingMessageState = {
  clientMessageId: string
  body: string
  topicName?: string
  topicId?: string
  replyTo?: string
  status: 'sending' | 'throttled' | 'failed'
  retryable: boolean
}
export type TopicComposerState = {
  draft: string
  composerError: string | null
}
export type ChannelComposerState = TopicComposerState & {
  topicDraft: string
}
export type TimelineState = {
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  messages: Message[]
  pending: PendingMessageState[]
  hasOlder: boolean
  loadingOlder: boolean
  olderError: boolean
}

/** Max Message body length in Unicode scalar values (API rule; a test compares it to openapi.json). */
export const MESSAGE_BODY_MAX = 4000

/** Max Topic name length in Unicode scalar values (API rule; a test compares it to openapi.json). */
export const TOPIC_NAME_MAX = 60

/** Channel-scoped ASCII case fold matching the server's `to_ascii_lowercase()` Topic identity. */
export const foldTopicName = (name: string): string => name.replace(/[A-Z]/g, ch => ch.toLowerCase())

/** Japanese message when the Message body violates API scalar/NUL rules, else null. */
export function messageBodyError(body: string): string | null {
  if (body.includes('\0')) return 'メッセージにNUL文字は含められません。'
  let count = 0
  for (const ch of body) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) return 'メッセージに使用できない文字が含まれています。'
    if (++count > MESSAGE_BODY_MAX) return `メッセージは${MESSAGE_BODY_MAX}文字以内にしてください。`
  }
  return null
}

/** Japanese message when a Topic name violates API scalar/NUL/whitespace rules, else null. */
export function topicNameError(name: string): string | null {
  if (name.includes('\0')) return 'トピック名にNUL文字は含められません。'
  if (name.length === 0 || /^\p{White_Space}|\p{White_Space}$/u.test(name)) {
    return `トピック名の前後に空白を入れず、1〜${TOPIC_NAME_MAX}文字にしてください。`
  }
  let count = 0
  for (const ch of name) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) return 'トピック名に使用できない文字が含まれています。'
    if (++count > TOPIC_NAME_MAX) return `トピック名は${TOPIC_NAME_MAX}文字以内にしてください。`
  }
  return null
}

const emptyComposer: ChannelComposerState = { draft: '', topicDraft: '', composerError: null }
const emptyTopicExtra: TopicComposerState = { draft: '', composerError: null }

/** One controller per signed-in session; subscribers only observe, never control its lifetime. */
export function createSync(options: SyncOptions) {
  const transport = options.api ?? {
    listMessages: (channel: string, query?: ListMessagesQuery) => api.listMessages(options.organizationId ?? '', channel, query),
    sendMessage: (channel: string, body: SendMessageRequest) => api.sendMessage(options.organizationId ?? '', channel, body),
  }
  const connect = options.connect ?? (handlers => connectRealtime(handlers, undefined, options.organizationId))
  const newId = options.newId ?? (() => crypto.randomUUID())
  const fillDelay = options.delay ?? backoffCap
  const random = options.random ?? Math.random
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let state = initialState(options.selfId)
  let socket: { transport: Connection; subscriptions: Map<string, number[]> } | undefined
  const timers = new Map<number, unknown>()
  const requests = new Map<number, () => void>()
  const listeners = new Set<(changedChannels: ReadonlySet<string>) => void>()
  const channelListeners = new Map<string, Set<() => void>>()
  const composerListeners = new Map<string, Set<() => void>>()
  const topicComposerListeners = new Map<string, Set<() => void>>()
  const replyComposerListeners = new Map<string, Set<() => void>>()
  const timelines = new Map<string, ReturnType<typeof timeline>>()
  const olderErrors = new Set<string>()
  const composers = new Map<string, ChannelComposerState>()
  const topicExtras = new Map<string, TopicComposerState>()
  const replyExtras = new Map<string, TopicComposerState>()
  const pendingTopics = new Map<string, string>()
  const submitted = new Map<string, { channel: string; detached: boolean; restore: () => void }>()
  let unsubscribeDrafts: (() => void) | undefined

  const draftTarget = (channel: string, topicId: string | null = null, replyRootId: string | null = null) => ({
    organizationId: options.organizationId ?? '',
    channelId: channel,
    topicId,
    replyRootId,
  })
  const topicKey = (channel: string, topicId: string) => JSON.stringify([channel, topicId])
  const replyKey = (channel: string, replyRootId: string, topicId: string | null) =>
    JSON.stringify([channel, topicId, replyRootId])
  const getComposer = (channel: string): ChannelComposerState => {
    const existing = composers.get(channel)
    if (existing) return existing
    const draft = options.drafts?.get(draftTarget(channel)) ?? ''
    const topicDraft = options.drafts?.getTopicDraft(draftTarget(channel)) ?? ''
    if (!draft && !topicDraft) return emptyComposer
    const extra = { ...emptyComposer, draft, topicDraft }
    composers.set(channel, extra)
    return extra
  }
  function putComposer(channel: string, patch: Partial<ChannelComposerState>): boolean {
    const prev = getComposer(channel)
    if (
      (patch.draft === undefined || patch.draft === prev.draft) &&
      (patch.topicDraft === undefined || patch.topicDraft === prev.topicDraft) &&
      (patch.composerError === undefined || patch.composerError === prev.composerError)
    ) {
      return false
    }
    const draft = patch.draft ?? prev.draft
    const topicDraft = patch.topicDraft ?? prev.topicDraft
    const composerError = patch.composerError !== undefined ? patch.composerError : prev.composerError
    if (draft === '' && topicDraft === '' && composerError === null) composers.delete(channel)
    else composers.set(channel, { draft, topicDraft, composerError })
    if (patch.draft !== undefined || patch.topicDraft !== undefined) options.drafts?.set(draftTarget(channel), draft, topicDraft)
    return true
  }
  function setComposer(channel: string, patch: Partial<ChannelComposerState>) {
    if (putComposer(channel, patch)) composerListeners.get(channel)?.forEach(l => l())
  }
  function putOlderError(channel: string, value: boolean): boolean {
    if (olderErrors.has(channel) === value) return false
    if (value) olderErrors.add(channel)
    else olderErrors.delete(channel)
    return true
  }
  const getTopicExtra = (channel: string, topicId: string): TopicComposerState => {
    const key = topicKey(channel, topicId)
    const existing = topicExtras.get(key)
    if (existing) return existing
    const draft = options.drafts?.get(draftTarget(channel, topicId)) ?? ''
    if (!draft) return emptyTopicExtra
    const extra = { ...emptyTopicExtra, draft }
    topicExtras.set(key, extra)
    return extra
  }
  function putTopicExtra(channel: string, topicId: string, patch: Partial<TopicComposerState>): boolean {
    const key = topicKey(channel, topicId)
    const prev = getTopicExtra(channel, topicId)
    if (
      (patch.draft === undefined || patch.draft === prev.draft) &&
      (patch.composerError === undefined || patch.composerError === prev.composerError)
    ) {
      return false
    }
    const draft = patch.draft ?? prev.draft
    const composerError = patch.composerError !== undefined ? patch.composerError : prev.composerError
    if (draft === '' && composerError === null) topicExtras.delete(key)
    else topicExtras.set(key, { draft, composerError })
    if (patch.draft !== undefined) options.drafts?.set(draftTarget(channel, topicId), draft)
    return true
  }
  function setTopicExtra(channel: string, topicId: string, patch: Partial<TopicComposerState>) {
    if (putTopicExtra(channel, topicId, patch)) topicComposerListeners.get(topicKey(channel, topicId))?.forEach(l => l())
  }
  const getReplyExtra = (channel: string, replyRootId: string, topicId: string | null): TopicComposerState => {
    const key = replyKey(channel, replyRootId, topicId)
    const existing = replyExtras.get(key)
    if (existing) return existing
    const draft = options.drafts?.get(draftTarget(channel, topicId, replyRootId)) ?? ''
    if (!draft) return emptyTopicExtra
    const extra = { ...emptyTopicExtra, draft }
    replyExtras.set(key, extra)
    return extra
  }
  function putReplyExtra(
    channel: string,
    replyRootId: string,
    topicId: string | null,
    patch: Partial<TopicComposerState>,
  ): boolean {
    const key = replyKey(channel, replyRootId, topicId)
    const prev = getReplyExtra(channel, replyRootId, topicId)
    if (
      (patch.draft === undefined || patch.draft === prev.draft) &&
      (patch.composerError === undefined || patch.composerError === prev.composerError)
    ) {
      return false
    }
    const draft = patch.draft ?? prev.draft
    const composerError = patch.composerError !== undefined ? patch.composerError : prev.composerError
    if (draft === '' && composerError === null) replyExtras.delete(key)
    else replyExtras.set(key, { draft, composerError })
    if (patch.draft !== undefined) options.drafts?.set(draftTarget(channel, topicId, replyRootId), draft)
    return true
  }
  function setReplyExtra(
    channel: string,
    replyRootId: string,
    topicId: string | null,
    patch: Partial<TopicComposerState>,
  ) {
    if (putReplyExtra(channel, replyRootId, topicId, patch)) {
      replyComposerListeners.get(replyKey(channel, replyRootId, topicId))?.forEach(l => l())
    }
  }
  function clearOlderError(channel: string, prev: ChannelState | undefined, next: ChannelState | undefined): boolean {
    return ((prev?.older === undefined && next?.older !== undefined) ||
      !next?.watched || next.state === 'unavailable' || next.cursor === null || !next.hasOlder) &&
      putOlderError(channel, false)
  }

  function dispatch(input: Input): Promise<void> {
    const previous = state
    if (input.type === 'stop') {
      for (const [id, draft] of submitted) {
        draft.detached = previous.channels[draft.channel]?.pending.some(p => {
          const request = previous.requests[p.request]
          return p.clientMessageId === id && p.state !== 'unknown' && request !== undefined && !request.stale
        }) ?? false
      }
    }
    const result = step(state, input)
    state = result.state
    const extraChanged = new Set<string>()
    const changedComposers = new Set<string>()
    const changedTopicComposers = new Set<string>()
    const changedReplyComposers = new Set<string>()
    if (input.type === 'session_start' || input.type === 'session_replaced' || input.type === 'stop') {
      for (const channel of olderErrors) extraChanged.add(channel)
      for (const channel of composers.keys()) changedComposers.add(channel)
      for (const key of topicExtras.keys()) changedTopicComposers.add(key)
      for (const key of replyExtras.keys()) changedReplyComposers.add(key)
      olderErrors.clear()
      composers.clear()
      topicExtras.clear()
      replyExtras.clear()
      pendingTopics.clear()
      if (input.type === 'stop') {
        unsubscribeDrafts?.()
        unsubscribeDrafts = undefined
      } else {
        unsubscribeDrafts ??= options.drafts?.subscribe(target => {
          if (target.organizationId !== (options.organizationId ?? '')) return
          const draft = options.drafts?.get(target) ?? ''
          // Detached restores write the Account Session store, outside this controller's lifetime.
          if (target.replyRootId != null) {
            const key = replyKey(target.channelId, target.replyRootId, target.topicId ?? null)
            const extra = replyExtras.get(key) ?? emptyTopicExtra
            if (extra.draft === draft) return
            replyExtras.set(key, { ...extra, draft })
            replyComposerListeners.get(key)?.forEach(listener => listener())
          } else if (target.topicId != null) {
            const key = topicKey(target.channelId, target.topicId)
            const extra = topicExtras.get(key) ?? emptyTopicExtra
            if (extra.draft === draft) return
            topicExtras.set(key, { ...extra, draft })
            topicComposerListeners.get(key)?.forEach(listener => listener())
          } else {
            const extra = composers.get(target.channelId) ?? emptyComposer
            const topicDraft = options.drafts?.getTopicDraft(target) ?? ''
            if (extra.draft === draft && extra.topicDraft === topicDraft) return
            composers.set(target.channelId, { ...extra, draft, topicDraft })
            composerListeners.get(target.channelId)?.forEach(listener => listener())
          }
        })
      }
    } else {
      if (input.type === 'history_failed') {
        const req = previous.requests[input.request]
        if (req?.type === 'history' && req.page === 'before' && !req.stale) {
          const next = state.channels[req.channel]
          if (state.running && next && next.state !== 'unavailable' && putOlderError(req.channel, true)) {
            extraChanged.add(req.channel)
          }
        }
      }
      for (const channel of result.changedChannels) {
        const activeIds = new Set(state.channels[channel]?.pending.map(p => p.clientMessageId) ?? [])
        for (const p of previous.channels[channel]?.pending ?? []) {
          if (!activeIds.has(p.clientMessageId)) pendingTopics.delete(p.clientMessageId)
        }
        if (clearOlderError(channel, previous.channels[channel], state.channels[channel])) {
          extraChanged.add(channel)
        }
      }
    }
    if (state !== previous) listeners.forEach(l => l(result.changedChannels))
    for (const channel of result.changedChannels) {
      channelListeners.get(channel)?.forEach(l => l())
    }
    for (const channel of extraChanged) {
      if (!result.changedChannels.has(channel)) channelListeners.get(channel)?.forEach(l => l())
    }
    for (const channel of changedComposers) {
      composerListeners.get(channel)?.forEach(l => l())
    }
    for (const key of changedTopicComposers) {
      topicComposerListeners.get(key)?.forEach(l => l())
    }
    for (const key of changedReplyComposers) {
      replyComposerListeners.get(key)?.forEach(l => l())
    }
    return Promise.all(result.effects.map(execute)).then(() => {})
  }

  // A transport that never answers is an unknown outcome, rather than a permanently sending entry.
  // Deadlines/cancellation fence results but do not abort HTTP; a retry may overlap the underlying request.
  async function request<T>(id: number, run: () => Promise<Result<T>>): Promise<Result<T> & { cancelled?: true }> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const cancelled = new Promise<Result<T> & { cancelled?: true }>(resolve => {
        requests.set(id, () => resolve({ ok: false, kind: 'network', cancelled: true }))
        timeout = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
      })
      return await Promise.race([run(), cancelled])
    } catch { return { ok: false, kind: 'network' } }
    finally {
      if (timeout !== undefined) clearTimeout(timeout)
      requests.delete(id)
    }
  }

  async function execute(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'connect': {
        socket?.transport.close()
        try {
          let opened = false
          const subscriptions = new Map<string, number[]>()
          const confirmed = new Map<string, number>()
          const transport = connect({
            onReady: () => { opened = true; void dispatch({ type: 'connection_ready', connection: effect.id }) },
            onEvent: event => {
              const isReply = event.type === 'subscribed' || event.type === 'channel_access_lost' || (event.type === 'error' &&
                (event.code === 'channel_not_found' || event.code === 'subscription_limit'))
              let subscription: number | undefined
              if (isReply && event.channel_id) {
                const channel = event.channel_id
                const pending = subscriptions.get(channel)
                if (event.type === 'channel_access_lost' || (event.type === 'error' && event.code === 'channel_not_found')) {
                  // With no pending control this belongs to the confirmed generation, even after unwatch.
                  // With no prior confirmation, ordered replies pair with queued subscribe generations.
                  // A prior confirmed subscription plus a pending subscribe is ambiguous: the wire has
                  // no generation id, so this could be an old async error or the new refusal. Do not
                  // consume a reply or invalidate either generation; reconnect to establish a wire fence.
                  // The server serializes controls/live delivery: a new subscribed handoff ends that ambiguity.
                  // Unwatched Channels consume late replies without reconnecting.
                  if (state.channels[channel]?.watched && ((confirmed.has(channel) && pending?.length) || (event.type === 'channel_access_lost' && (pending?.length || !confirmed.has(channel) || confirmed.get(channel) !== state.channels[channel]?.subscription?.id) && state.channels[channel]?.state !== 'unavailable'))) {
                    if (state.connection === effect.id && state.connected) {
                      const own = socket?.transport
                      void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 })
                      own?.close()
                    }
                    return
                  }
                  subscription = pending?.shift() ?? confirmed.get(channel) ?? -1
                  confirmed.delete(channel)
                } else {
                  subscription = pending?.shift() ?? -1
                  if (event.type === 'subscribed' && subscription !== -1) confirmed.set(channel, subscription)
                }
              }
              void dispatch({ type: 'event', connection: effect.id, event, subscription })
            },
            onClose: code => {
              if (opened || !options.checkMembership) {
                void dispatch({ type: 'socket_closed', connection: effect.id, code }); return
              }
              // Browsers hide rejected upgrade responses. Only REST can establish Membership loss.
              void request(effect.id, options.checkMembership).then(result => {
                if (state.connection !== effect.id || !state.running) return
                if (api.isOrganizationUnavailable(result)) void dispatch({ type: 'organization_unavailable' })
                else if (!result.ok && result.kind === 'http' && result.status === 401) void dispatch({ type: 'socket_closed', connection: effect.id, code: 4001 })
                else void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 })
              }, () => { void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 }) })
            },
          })
          socket = { transport, subscriptions }
        } catch { void dispatch({ type: 'socket_closed', connection: effect.id, code: 1006 }) }
        break
      }
      case 'close':
        socket?.transport.close(); socket = undefined
        requests.forEach(cancel => cancel())
        break
      case 'subscribe':
      case 'unsubscribe':
        try {
          if (effect.type === 'subscribe' && socket) {
            const pending = socket.subscriptions.get(effect.channel) ?? []
            pending.push(effect.id)
            socket.subscriptions.set(effect.channel, pending)
          }
          socket?.transport.send(effect.type === 'subscribe'
            ? { type: 'subscribe', channel_id: effect.channel, after_seq: effect.after_seq }
            : { type: 'unsubscribe', channel_id: effect.channel })
        } catch {
          if (state.connection !== null) void dispatch({ type: 'socket_closed', connection: state.connection, code: 1006 })
        }
        break
      case 'fetch_history': {
        const query = effect.page === 'after' ? { after_seq: effect.seq } : { before_seq: effect.seq }
        const result = await request(effect.id, () => effect.page === 'latest'
          ? transport.listMessages(effect.channel) : transport.listMessages(effect.channel, query))
        await dispatch(result.ok ? { type: 'history_result', request: effect.id, page: result.data }
          : { type: 'history_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network' })
        break
      }
      case 'send': {
        const result = await request(effect.id, () => transport.sendMessage(effect.channel,
          { client_message_id: effect.client_message_id, body: effect.body,
            ...(effect.reply_to ? { reply_to: effect.reply_to } : {}),
            ...(effect.topic_name ? { topic_name: effect.topic_name } : {}) }).then(result => {
          const draft = submitted.get(effect.client_message_id)
          submitted.delete(effect.client_message_id)
          // A closed Organization has no failed Message UI; retain a definite refusal's unedited text.
          if (draft?.detached && !result.ok && result.kind === 'http' && [400, 403, 404, 409, 413, 415].includes(result.status)) draft.restore()
          return result
        }))
        // Close cancels the wait while detached sends still observe definite refusals.
        if (!result.ok && result.kind === 'network' && !result.cancelled) submitted.delete(effect.client_message_id)
        await dispatch(result.ok ? { type: 'ack', request: effect.id, message: result.data }
          : { type: 'send_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network',
            retryAfterMs: result.retryAfterMs })
        break
      }
      case 'wait': {
        const ms = effect.purpose === 'send_retry' ? effect.delayMs
          : effect.purpose === 'reorder_grace' ? options.graceMs ?? 100
          : effect.purpose === 'reconnect_backoff' ? reconnectDelay(effect.attempt, random) : fillDelay(effect.attempt)
        // Browser timers overflow above signed 32-bit milliseconds; split long waits to avoid an early send.
        const arm = (remaining: number) => {
          const chunk = Math.min(remaining, 2_147_483_647)
          timers.set(effect.id, schedule(() => {
            if (!state.timers[effect.id]) return
            if (remaining > chunk) { arm(remaining - chunk); return }
            timers.delete(effect.id)
            void dispatch({ type: 'timer_elapsed', id: effect.id })
          }, chunk, effect))
        }
        arm(ms)
        break
      }
      case 'cancel_timer':
        if (timers.has(effect.id)) { cancel(timers.get(effect.id)); timers.delete(effect.id) }
        break
      case 'sign_in': options.onSessionEnded?.(); break
    }
  }

  function timeline(channel: string) {
    // An empty draft can still have been edited since submit.
    let draftRevision = 0
    let snapshot: TimelineState
    let last: ChannelState | undefined | null = null
    let lastOlderError: boolean | null = null
    const topicComposers = new Map<string, ReturnType<typeof createTopicComposer>>()
    const replyComposers = new Map<string, ReturnType<typeof createReplyComposer>>()
    const listeners = new Set<() => void>()
    const compListeners = new Set<() => void>()
    channelListeners.set(channel, listeners)
    composerListeners.set(channel, compListeners)
    async function send(
      body: string,
      target: Pick<SendMessageRequest, 'reply_to' | 'topic_name'> = {},
      restore?: () => void,
      originTopicId?: string,
    ) {
      if (!body.trim() || messageBodyError(body) !== null || !state.running || state.organization === 'unavailable') {
        return false
      }
      if (target.topic_name !== undefined && target.topic_name !== null && topicNameError(target.topic_name) !== null) {
        return false
      }
      const clientMessageId = newId()
      if (restore) submitted.set(clientMessageId, { channel, detached: false, restore })
      if (originTopicId) pendingTopics.set(clientMessageId, originTopicId)
      const before = state.channels[channel]?.pending
      const completion = dispatch({ type: 'user_send', channel, clientMessageId, body, ...target })
      const accepted = state.channels[channel]?.pending !== before
      if (!accepted) {
        submitted.delete(clientMessageId)
        pendingTopics.delete(clientMessageId)
      }
      await completion
      return accepted
    }
    function createTopicComposer(topicId: string) {
      let topicDraftRevision = 0
      const target = draftTarget(channel, topicId)
      const key = topicKey(channel, topicId)
      return {
        get: (): TopicComposerState => getTopicExtra(channel, topicId),
        subscribe(listener: () => void) {
          let tcListeners = topicComposerListeners.get(key)
          if (!tcListeners) {
            tcListeners = new Set()
            topicComposerListeners.set(key, tcListeners)
          }
          tcListeners.add(listener)
          return () => {
            tcListeners.delete(listener)
            if (tcListeners.size === 0 && topicComposerListeners.get(key) === tcListeners) topicComposerListeners.delete(key)
          }
        },
        setDraft(draft: string) {
          if (draft === getTopicExtra(channel, topicId).draft) return
          topicDraftRevision++
          setTopicExtra(channel, topicId, { draft, composerError: null })
        },
        async submit(topicName: string) {
          const text = getTopicExtra(channel, topicId).draft
          if (!text.trim()) return false
          const nameError = topicNameError(topicName)
          if (nameError !== null) {
            setTopicExtra(channel, topicId, { composerError: nameError })
            return false
          }
          const bodyError = messageBodyError(text)
          if (bodyError !== null) {
            setTopicExtra(channel, topicId, { composerError: bodyError })
            return false
          }
          if (!state.running || state.organization === 'unavailable' || state.channels[channel]?.state === 'unavailable') {
            return false
          }
          const revision = topicDraftRevision
          setTopicExtra(channel, topicId, { draft: '', composerError: null })
          const storeRevision = options.drafts?.revision(target)
          const restore = () => {
            if (
              topicDraftRevision === revision &&
              options.drafts?.revision(target) === storeRevision &&
              getTopicExtra(channel, topicId).draft === ''
            ) {
              setTopicExtra(channel, topicId, { draft: text })
            }
          }
          const accepted = await send(text, { topic_name: topicName }, restore, topicId)
          if (!accepted) restore()
          return accepted
        },
        restore(clientMessageId: string): boolean {
          if (!state.running) return false
          const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
          if (p?.state !== 'failed') return false
          const current = getTopicExtra(channel, topicId).draft
          topicDraftRevision++
          setTopicExtra(channel, topicId, { draft: current ? `${current}\n${p.body}` : p.body, composerError: null })
          void dispatch({ type: 'user_discard', channel, clientMessageId })
          return true
        },
      }
    }
    function createReplyComposer(replyRootId: string, topicId: string | null) {
      let replyDraftRevision = 0
      const target = draftTarget(channel, topicId, replyRootId)
      const key = replyKey(channel, replyRootId, topicId)
      return {
        get: (): TopicComposerState => getReplyExtra(channel, replyRootId, topicId),
        subscribe(listener: () => void) {
          let rcListeners = replyComposerListeners.get(key)
          if (!rcListeners) {
            rcListeners = new Set()
            replyComposerListeners.set(key, rcListeners)
          }
          rcListeners.add(listener)
          return () => {
            rcListeners.delete(listener)
            if (rcListeners.size === 0 && replyComposerListeners.get(key) === rcListeners) replyComposerListeners.delete(key)
          }
        },
        setDraft(draft: string) {
          if (draft === getReplyExtra(channel, replyRootId, topicId).draft) return
          replyDraftRevision++
          setReplyExtra(channel, replyRootId, topicId, { draft, composerError: null })
        },
        async submit(replyTo: string = replyRootId) {
          const text = getReplyExtra(channel, replyRootId, topicId).draft
          if (!text.trim()) return false
          const bodyError = messageBodyError(text)
          if (bodyError !== null) {
            setReplyExtra(channel, replyRootId, topicId, { composerError: bodyError })
            return false
          }
          if (!state.running || state.organization === 'unavailable' || state.channels[channel]?.state === 'unavailable') {
            return false
          }
          const revision = replyDraftRevision
          setReplyExtra(channel, replyRootId, topicId, { draft: '', composerError: null })
          const storeRevision = options.drafts?.revision(target)
          const restore = () => {
            if (
              replyDraftRevision === revision &&
              options.drafts?.revision(target) === storeRevision &&
              getReplyExtra(channel, replyRootId, topicId).draft === ''
            ) {
              setReplyExtra(channel, replyRootId, topicId, { draft: text })
            }
          }
          const accepted = await send(text, { reply_to: replyTo }, restore, topicId ?? undefined)
          if (!accepted) restore()
          return accepted
        },
        retry(clientMessageId: string): Promise<void> {
          const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
          if (!p?.reply_to) return Promise.resolve()
          return dispatch({ type: 'user_retry', channel, clientMessageId })
        },
        restore(clientMessageId: string): boolean {
          if (!state.running) return false
          const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
          if (p?.state !== 'failed') return false
          const current = getReplyExtra(channel, replyRootId, topicId).draft
          replyDraftRevision++
          setReplyExtra(channel, replyRootId, topicId, {
            draft: current ? `${current}\n${p.body}` : p.body,
            composerError: null,
          })
          void dispatch({ type: 'user_discard', channel, clientMessageId })
          return true
        },
        migrateDraftFrom(fromReplyRootId: string, fromTopicId: string | null = null): void {
          if (fromReplyRootId === replyRootId && fromTopicId === topicId) return
          const tempDraft = getReplyExtra(channel, fromReplyRootId, fromTopicId).draft
          if (!tempDraft) return
          const existing = getReplyExtra(channel, replyRootId, topicId).draft
          const fromComposer = replyComposers.get(replyKey(channel, fromReplyRootId, fromTopicId))
          if (fromComposer) fromComposer.setDraft('')
          else setReplyExtra(channel, fromReplyRootId, fromTopicId, { draft: '', composerError: null })
          replyDraftRevision++
          setReplyExtra(channel, replyRootId, topicId, {
            draft: existing ? `${existing}\n${tempDraft}` : tempDraft,
            composerError: null,
          })
        },
      }
    }
    return {
      get(): TimelineState {
        const c = state.channels[channel]
        const olderError = olderErrors.has(channel)
        if (last === c && lastOlderError === olderError) return snapshot
        last = c
        lastOlderError = olderError
        snapshot = {
          // Content visibility depends on the base; subscription confirmation drives the separate live indicator.
          status: c?.state === 'unavailable' ? 'unavailable' : c?.historyError ? 'error' : c && c.cursor !== null ? 'ready' : 'loading',
          messages: c?.messages ?? [],
          pending: (c?.pending ?? []).map(p => ({
            clientMessageId: p.clientMessageId,
            body: p.body,
            ...(p.topic_name ? { topicName: p.topic_name } : {}),
            ...(pendingTopics.get(p.clientMessageId) ? { topicId: pendingTopics.get(p.clientMessageId) } : {}),
            ...(p.reply_to ? { replyTo: p.reply_to } : {}),
            status: p.state === 'sending' || p.state === 'throttled' ? p.state : 'failed',
            retryable: p.state !== 'failed',
          })),
          hasOlder: c?.hasOlder ?? false, loadingOlder: c?.older !== undefined,
          olderError,
        }
        return snapshot
      },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      composer: {
        get: (): ChannelComposerState => getComposer(channel),
        subscribe(listener: () => void) { compListeners.add(listener); return () => { compListeners.delete(listener) } },
      },
      loadLatest: () => dispatch({ type: 'refresh', channel }),
      loadOlder: () => dispatch({ type: 'load_older', channel }),
      setDraft(draft: string) {
        if (draft === getComposer(channel).draft) return
        draftRevision++
        setComposer(channel, { draft, composerError: null })
      },
      setTopicDraft(topicDraft: string) {
        if (topicDraft === getComposer(channel).topicDraft) return
        draftRevision++
        setComposer(channel, { topicDraft, composerError: null })
      },
      async submit() {
        const current = getComposer(channel)
        const text = current.draft
        const topicName = current.topicDraft
        if (!text.trim()) return false
        if (topicName.length > 0) {
          const nameError = topicNameError(topicName)
          if (nameError !== null) {
            setComposer(channel, { composerError: nameError })
            return false
          }
        }
        const error = messageBodyError(text)
        if (error !== null) {
          setComposer(channel, { composerError: error })
          return false
        }
        if (!state.running || state.organization === 'unavailable' || state.channels[channel]?.state === 'unavailable') {
          return false
        }
        const revision = draftRevision
        setComposer(channel, { draft: '', topicDraft: '', composerError: null })
        const storeRevision = options.drafts?.revision(draftTarget(channel))
        const restore = () => {
          if (
            draftRevision === revision &&
            options.drafts?.revision(draftTarget(channel)) === storeRevision &&
            getComposer(channel).draft === '' &&
            getComposer(channel).topicDraft === ''
          ) {
            setComposer(channel, { draft: text, topicDraft: topicName })
          }
        }
        const accepted = await send(text, topicName ? { topic_name: topicName } : {}, restore)
        if (!accepted) restore()
        return accepted
      },
      send,
      retry: (clientMessageId: string) => dispatch({ type: 'user_retry', channel, clientMessageId }),
      restore(clientMessageId: string): boolean {
        if (!state.running) return false
        const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
        if (p?.state !== 'failed') return false
        const current = getComposer(channel)
        draftRevision++
        setComposer(channel, {
          draft: current.draft ? `${current.draft}\n${p.body}` : p.body,
          topicDraft: p.topic_name ?? '',
          composerError: null,
        })
        void dispatch({ type: 'user_discard', channel, clientMessageId })
        return true
      },
      discard: (clientMessageId: string) => { void dispatch({ type: 'user_discard', channel, clientMessageId }) },
      topic(topicId: string) {
        let tc = topicComposers.get(topicId)
        if (!tc) { tc = createTopicComposer(topicId); topicComposers.set(topicId, tc) }
        return tc
      },
      reply(replyRootId: string, topicId: string | null = null) {
        const key = replyKey(channel, replyRootId, topicId)
        let rc = replyComposers.get(key)
        if (!rc) { rc = createReplyComposer(replyRootId, topicId); replyComposers.set(key, rc) }
        return rc
      },
    }
  }

  return {
    get: () => state,
    subscribe(listener: (changedChannels: ReadonlySet<string>) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => dispatch({ type: 'session_start', selfId: options.selfId }),
    replaceSession: (selfId: string) => dispatch({ type: 'session_replaced', selfId }),
    watch: (channel: string) => dispatch({ type: 'watch', channel }),
    channelUnavailable: (channel: string) => dispatch({ type: 'channel_unavailable', channel }),
    unwatch: (channel: string) => dispatch({ type: 'unwatch', channel }),
    close: () => dispatch({ type: 'stop' }),
    unavailable: () => dispatch({ type: 'organization_unavailable' }),
    settleHistory: (channel: string, messages: Message[]) => dispatch({ type: 'settle_history', channel, messages }),
    hasUnsavedChanges(): boolean {
      if (options.drafts?.hasDrafts()) return true
      for (const extra of composers.values()) {
        if (extra.draft.length > 0 || extra.topicDraft.length > 0) return true
      }
      for (const extra of topicExtras.values()) {
        if (extra.draft.length > 0) return true
      }
      for (const extra of replyExtras.values()) {
        if (extra.draft.length > 0) return true
      }
      for (const c of Object.values(state.channels)) {
        if (c.pending.length > 0) return true
      }
      return false
    },
    getTimeline(channel: string) {
      let t = timelines.get(channel)
      if (!t) { t = timeline(channel); timelines.set(channel, t) }
      return t
    },
  }
}
