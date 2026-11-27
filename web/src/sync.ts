import { newerMentionResponse, rememberIdentityResponse } from './identity-order'
import type { ActivityNotice } from './activity'
import {
  createComposerDrafts,
  type ChannelComposerState,
  type ComposerTarget,
  type TopicComposerState,
} from './composer-drafts'
import type { DraftStore } from './drafts'
import * as api from './api'
import { createRequestDeadlines } from './request-deadlines'
import { backoffCap, reconnectDelay } from './reconnect'
import type { ListMessagesQuery, Message, MessagePage, Result, SendMessageRequest } from './api'
import { connectRealtime, type Connection, type RealtimeHandlers } from './realtime'
import { createCore, inputMessages } from '#sync-core'
import { messageBodyError, topicNameError } from './message-rules'
import type { SyncCore } from './protocol-types'
import type { ChannelState, Effect, Input, MoveVersion } from './protocol-types'

export { foldTopicName, MESSAGE_BODY_MAX, messageBodyError, TOPIC_NAME_MAX, topicNameError } from './message-rules'
export type { ChannelComposerState, TopicComposerState }

export type TimelineApi = {
  listChannelEvents(channel: string, query: api.ListChannelEventsQuery): Promise<Result<api.ChannelEventPage>>
  listMessages(channel: string, query?: ListMessagesQuery, signal?: AbortSignal): Promise<Result<MessagePage>>
  sendMessage(channel: string, body: SendMessageRequest): Promise<Result<Message>>
}
export const timelineApi = (organizationId: string): TimelineApi => ({
  listChannelEvents: (channel, query) => api.listChannelEvents(organizationId, channel, query),
  listMessages: (channel, query, signal) => api.listMessages(organizationId, channel, query, undefined, signal),
  sendMessage: (channel, body) => api.sendMessage(organizationId, channel, body),
})
type Wait = Extract<Effect, { type: 'wait' }>
type SyncAccessSource = { close(): Promise<void>; unavailable(): Promise<void> }
export type SyncOptions = {
  selfId: string
  drafts?: DraftStore
  organizationId?: string
  checkMembership?: () => Promise<Result<unknown>>
  api?: TimelineApi
  connect?: (handlers: RealtimeHandlers) => Connection
  newId?: () => string
  onSessionEnded?: () => void
  reportSyncAccess?: (result: Result<unknown>, source?: SyncAccessSource) => void
  reportOrganizationUnavailable?: (apply: () => Promise<void>) => void
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
  replyRootId?: string
  status: 'sending' | 'throttled' | 'failed'
  retryable: boolean
  failureCode?: string
}
export type TimelineState = {
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  messages: Message[]
  pending: PendingMessageState[]
  hasOlder: boolean
  loadingOlder: boolean
  olderError: boolean
}

type SyncListener = (changedChannels: ReadonlySet<string>, records?: ReadonlyMap<string, Message[]>, moves?: readonly MoveVersion[]) => void

/** One controller per signed-in session; subscribers only observe, never control its lifetime. */
export function createSync(options: SyncOptions) {
  const transport = options.api ?? timelineApi(options.organizationId ?? '')
  const connect = options.connect ?? (handlers => connectRealtime(handlers, undefined, options.organizationId))
  const newId = options.newId ?? (() => crypto.randomUUID())
  const fillDelay = options.delay ?? backoffCap
  const random = options.random ?? Math.random
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const reportOrganizationUnavailable = options.reportOrganizationUnavailable ?? (apply => { void apply() })
  const reportAccess: NonNullable<SyncOptions['reportSyncAccess']> = options.reportSyncAccess ?? ((result, source) => {
    if (api.isSessionEnded(result)) {
      void (source?.close() ?? dispatch({ type: 'stop' }))
      options.onSessionEnded?.()
    } else if (api.isOrganizationUnavailable(result)) {
      void (source?.unavailable() ?? dispatch({ type: 'organization_unavailable' }))
    }
  })
  const core = createCore(options.selfId)
  let state = core.get()
  let socket: { transport: Connection; subscriptions: Map<string, number[]> } | undefined
  const timers = new Map<number, unknown>()
  const requests = createRequestDeadlines()
  const noticeListeners = new Set<(notice: ActivityNotice) => void>()
  const inputListeners = new Set<(input: Input, result: ReturnType<SyncCore['step']>, previous: ReturnType<SyncCore['get']>) => void>()
  const listeners = new Set<SyncListener>()
  const channelListeners = new Map<string, Set<() => void>>()
  const timelines = new Map<string, ReturnType<typeof timeline>>()
  const olderErrors = new Set<string>()
  const pendingTopics = new Map<string, string>()
  const composerDrafts = createComposerDrafts({
    organizationId: options.organizationId,
    drafts: options.drafts,
  })
  const replyKey = (channel: string, replyRootId: string, topicId: string | null) =>
    JSON.stringify([channel, topicId, replyRootId])
  function putOlderError(channel: string, value: boolean): boolean {
    if (olderErrors.has(channel) === value) return false
    if (value) olderErrors.add(channel)
    else olderErrors.delete(channel)
    return true
  }
  function clearOlderError(channel: string, prev: ChannelState | undefined, next: ChannelState | undefined): boolean {
    return ((prev?.older === undefined && next?.older !== undefined) ||
      !next?.watched || next.state === 'unavailable' || next.cursor === null || !next.hasOlder) &&
      putOlderError(channel, false)
  }

  function dispatch(input: Input): Promise<void> {
    if (input.type === 'event' && input.event.type === 'message' && 'message' in input.event) rememberIdentityResponse(input.event.message)
    else if (input.type === 'ack') rememberIdentityResponse(input.message)
    else if (input.type === 'history_result' || input.type === 'events_result') rememberIdentityResponse(input.page)
    else if (input.type === 'settle_history') rememberIdentityResponse(input.messages)
    if (inputMessages(input).some(message => newerMentionResponse(state.channels[message.channel_id]?.messages ?? [], message)))
      input = { ...input, refreshMentionNames: true }
    const previous = state
    if (input.type === 'stop') {
      composerDrafts.detachSubmitted((channel, id) =>
        previous.channels[channel]?.pending.some(p => {
          const request = core.request(p.request)
          return p.clientMessageId === id && p.state !== 'unknown' && request !== undefined && !request.stale
        }) ?? false,
      )
    }
    const previousRequest = input.type === 'history_failed' ? core.request(input.request) : undefined
    const result = core.step(input)
    state = core.get()
    const extraChanged = new Set<string>()
    let notifyChangedComposers: (() => void) | undefined
    if (input.type === 'session_start' || input.type === 'session_replaced' || input.type === 'stop') {
      for (const channel of olderErrors) extraChanged.add(channel)
      olderErrors.clear()
      pendingTopics.clear()
      notifyChangedComposers = composerDrafts.resetSession(input.type === 'stop' ? 'stop' : 'start')
    } else {
      if (input.type === 'history_failed') {
        const req = previousRequest
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
          if (!activeIds.has(p.clientMessageId)) {
            pendingTopics.delete(p.clientMessageId)
            composerDrafts.dropSubmitted(p.clientMessageId)
          }
        }
        if (clearOlderError(channel, previous.channels[channel], state.channels[channel])) {
          extraChanged.add(channel)
        }
      }
    }
    if (result.stateChanged) listeners.forEach(l => l(result.changedChannels, result.records, result.moves))
    for (const channel of result.changedChannels) {
      channelListeners.get(channel)?.forEach(l => l())
    }
    for (const channel of extraChanged) {
      if (!result.changedChannels.has(channel)) channelListeners.get(channel)?.forEach(l => l())
    }
    notifyChangedComposers?.()
    inputListeners.forEach(listener => listener(input, result, previous))
    return Promise.all(result.effects.map(execute)).then(() => {})
  }

  // A send can become unknown while HTTP is still in flight. Late results still reach the Session owner.
  async function request<T>(run: () => Promise<Result<T>>): Promise<Result<T> & { timedOut?: true }> {
    const deadline = requests.start<Result<T> & { timedOut?: true }>({ ok: false, kind: 'network' }, {
      timeoutMs: options.requestTimeoutMs ?? 30_000,
      onTimeout: () => ({ ok: false, kind: 'network', timedOut: true }),
    })
    try {
      return await Promise.race([run(), deadline.until])
    } catch { return { ok: false, kind: 'network' } }
    finally { deadline.clear() }
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
              if (event.type !== 'message' && event.type !== 'subscribed' && event.type !== 'channel_access_lost' && event.type !== 'error') {
                if (state.connection === effect.id && state.running && state.organization === 'available') noticeListeners.forEach(l => l(event))
                return
              }
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
                if (code === 4003) {
                  if (state.connection === effect.id) reportOrganizationUnavailable(
                    () => dispatch({ type: 'socket_closed', connection: effect.id, code }))
                  return
                }
                void dispatch({ type: 'socket_closed', connection: effect.id, code }); return
              }
              // Browsers hide rejected upgrade responses. Only REST can establish Membership loss.
              void request(options.checkMembership).then(result => {
                if (state.connection !== effect.id || !state.running) return
                if (api.isOrganizationUnavailable(result)) {
                  reportOrganizationUnavailable(() => dispatch({ type: 'organization_unavailable' }))
                } else if (api.isSessionEnded(result)) void dispatch({ type: 'socket_closed', connection: effect.id, code: 4001 })
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
        requests.cancel()
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
            ? { type: 'subscribe', channel_id: effect.channel, after_seq: effect.after_seq, history_generation: effect.history_generation }
            : { type: 'unsubscribe', channel_id: effect.channel })
        } catch {
          if (state.connection !== null) void dispatch({ type: 'socket_closed', connection: state.connection, code: 1006 })
        }
        break
      case 'fetch_history': {
        if (effect.page === 'after') {
          const result = await request(() => transport.listChannelEvents(effect.channel, { after_seq: effect.seq!, history_generation: effect.history_generation }))
          await dispatch(result.ok ? { type: 'events_result', request: effect.id, page: result.data }
            : { type: 'history_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network', error: result.kind === 'http' ? result.error : undefined })
          break
        }
        const query = { before_seq: effect.seq, as_of_seq: effect.as_of_seq, history_generation: effect.history_generation }
        const result = await request(() => effect.page === 'latest'
          ? transport.listMessages(effect.channel, { history_generation: effect.history_generation }) : transport.listMessages(effect.channel, query))
        await dispatch(result.ok ? { type: 'history_result', request: effect.id, page: result.data }
          : { type: 'history_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network', error: result.kind === 'http' ? result.error : undefined })
        break
      }
      case 'send': {
        const result = await request(() => transport.sendMessage(effect.channel,
          { history_generation: effect.history_generation, client_message_id: effect.client_message_id, body: effect.body,
            ...(effect.reply_to ? { reply_to: effect.reply_to } : {}),
            ...(effect.topic_name ? { topic_name: effect.topic_name } : {}) }).then(result => {
          composerDrafts.observeSendResult(effect.client_message_id, result)
          return result
        }))
        // Close cancels the wait while detached sends still observe definite refusals.
        if (result.timedOut) composerDrafts.dropSubmitted(effect.client_message_id)
        await dispatch(result.ok ? { type: 'ack', request: effect.id, message: result.data }
          : { type: 'send_failed', request: effect.id, status: result.kind === 'http' ? result.status : 'network',
            retryAfterMs: result.retryAfterMs, error: result.kind === 'http' ? result.error : undefined })
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
            if (!core.timer(effect.id)) return
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
    let snapshot: TimelineState
    let last: ChannelState | undefined | null = null
    let lastOlderError: boolean | null = null
    const topicComposers = new Map<string, ReturnType<typeof createTopicComposer>>()
    const replyComposers = new Map<string, ReturnType<typeof createReplyComposer>>()
    const listeners = new Set<() => void>()
    channelListeners.set(channel, listeners)
    const channelTarget: ComposerTarget = { channelId: channel }
    const canSend = () =>
      state.running && state.organization !== 'unavailable' && state.channels[channel]?.state !== 'unavailable'
    function restorePending(target: ComposerTarget, clientMessageId: string): boolean {
      if (!state.running) return false
      const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
      if (p?.state !== 'failed') return false
      composerDrafts.restoreFailed(target, p.body, p.topic_name)
      void dispatch({ type: 'user_discard', channel, clientMessageId })
      return true
    }
    async function send(
      body: string,
      target: Pick<SendMessageRequest, 'reply_to' | 'topic_name'> & { replyRootId?: string } = {},
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
      if (restore) composerDrafts.trackSubmitted(clientMessageId, channel, restore)
      if (originTopicId) pendingTopics.set(clientMessageId, originTopicId)
      const before = state.channels[channel]?.pending
      const completion = dispatch({ type: 'user_send', channel, clientMessageId, body, ...target })
      const accepted = state.channels[channel]?.pending !== before
      if (!accepted) {
        composerDrafts.dropSubmitted(clientMessageId)
        pendingTopics.delete(clientMessageId)
      }
      await completion
      return accepted
    }
    function createTopicComposer(topicId: string) {
      const target: ComposerTarget = { channelId: channel, topicId }
      return {
        get: (): TopicComposerState => composerDrafts.getScoped(target),
        subscribe: (listener: () => void) => composerDrafts.subscribe(target, listener),
        setDraft: (draft: string) => composerDrafts.setDraft(target, draft),
        submit: (topicName: string) =>
          composerDrafts.submit({
            target,
            topicName: { value: topicName, required: true },
            canSend,
            send: (body, restore) => send(body, { topic_name: topicName }, restore, topicId),
          }),
        restore: (clientMessageId: string): boolean => restorePending(target, clientMessageId),
      }
    }
    function createReplyComposer(replyRootId: string, topicId: string | null) {
      const target: ComposerTarget = { channelId: channel, topicId, replyRootId }
      return {
        get: (): TopicComposerState => composerDrafts.getScoped(target),
        subscribe: (listener: () => void) => composerDrafts.subscribe(target, listener),
        setDraft: (draft: string) => composerDrafts.setDraft(target, draft),
        submit: (replyTo: string = replyRootId) =>
          composerDrafts.submit({
            target,
            canSend,
            send: (body, restore) => send(body, { reply_to: replyTo, replyRootId }, restore, topicId ?? undefined),
          }),
        retry(clientMessageId: string): Promise<void> {
          const p = state.channels[channel]?.pending.find(entry => entry.clientMessageId === clientMessageId)
          if (!p?.reply_to) return Promise.resolve()
          return dispatch({ type: 'user_retry', channel, clientMessageId })
        },
        restore: (clientMessageId: string): boolean => restorePending(target, clientMessageId),
        migrateDraftFrom(fromReplyRootId: string, fromTopicId: string | null = null): void {
          composerDrafts.migrateReplyDraft(channel, fromReplyRootId, fromTopicId, replyRootId, topicId)
        },
        reconcileDrafts(): void {
          composerDrafts.reconcileReplyDrafts(channel, replyRootId, topicId)
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
            ...(p.reply_to ? { replyTo: p.reply_to, replyRootId: p.replyRootId } : {}),
            status: p.state === 'sending' || p.state === 'throttled' ? p.state : 'failed',
            retryable: p.state !== 'failed',
            failureCode: p.failureCode,
          })),
          hasOlder: c?.hasOlder ?? false, loadingOlder: c?.older !== undefined,
          olderError,
        }
        return snapshot
      },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      composer: {
        get: (): ChannelComposerState => composerDrafts.getChannel(channel),
        subscribe: (listener: () => void) => composerDrafts.subscribe(channelTarget, listener),
      },
      loadLatest: () => dispatch({ type: 'refresh', channel }),
      loadOlder: () => dispatch({ type: 'load_older', channel }),
      setDraft: (draft: string) => composerDrafts.setDraft(channelTarget, draft),
      setTopicDraft: (topicDraft: string) => composerDrafts.setTopicDraft(channel, topicDraft),
      submit() {
        const topicName = composerDrafts.getChannel(channel).topicDraft
        return composerDrafts.submit({
          target: channelTarget,
          topicName: { value: topicName, required: false },
          canSend,
          send: (body, restore) => send(body, topicName ? { topic_name: topicName } : {}, restore),
        })
      },
      send,
      retry: (clientMessageId: string) => dispatch({ type: 'user_retry', channel, clientMessageId }),
      restore: (clientMessageId: string): boolean => restorePending(channelTarget, clientMessageId),
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
    onInput(listener: (input: Input, result: ReturnType<SyncCore['step']>, previous: ReturnType<SyncCore['get']>) => void) { inputListeners.add(listener); return () => { inputListeners.delete(listener) } },
    onActivity(listener: (notice: ActivityNotice) => void) { noticeListeners.add(listener); return () => { noticeListeners.delete(listener) } },
    get: () => state,
    reportAccess,
    request: (id: number) => core.request(id),
    timer: (id: number) => core.timer(id),
    subscribe(listener: SyncListener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => dispatch({ type: 'session_start', selfId: options.selfId }),
    replaceSession: (selfId: string) => dispatch({ type: 'session_replaced', selfId }),
    watch: (channel: string) => dispatch({ type: 'watch', channel }),
    channelUnavailable: (channel: string) => dispatch({ type: 'channel_unavailable', channel }),
    unwatch: (channel: string) => dispatch({ type: 'unwatch', channel }),
    close: () => dispatch({ type: 'stop' }),
    unavailable: () => dispatch({ type: 'organization_unavailable' }),
    observeHistoryGeneration(generation?: string) {
      const before = state.historyEpoch
      void dispatch({ type: 'history_generation', generation })
      return before === state.historyEpoch
    },
    settleHistory: (channel: string, messages: Message[]) => dispatch({ type: 'settle_history', channel, messages }),
    hasUnsavedChanges(): boolean {
      return composerDrafts.hasDrafts() || core.hasPending()
    },
    getTimeline(channel: string) {
      let t = timelines.get(channel)
      if (!t) { t = timeline(channel); timelines.set(channel, t) }
      return t
    },
  }
}
