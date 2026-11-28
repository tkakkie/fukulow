import { createActivityTarget, type Activity, type ActivityRead } from './activity'
import * as api from './api'
import { createRequestDeadlines } from './request-deadlines'
import type { InitialRead, InitialTimeline } from './initial-timeline'
import { observeGeneration } from './observe-generation'
import type { ListTimelineQuery, ListTopicsQuery, Message, MessagePage, Result, TimelinePage,
  TopicHistoryQuery, TopicPage, TopicSummaryResponse } from './api'
import { coversTopicCounts, readActivitySummary, stampTopicEvidence, topicBaselineStarts, type TopicCountRequirement } from './topic-summary-requests'
import { completeCountFields } from './unread-counts'
import { backoffCap } from './reconnect'
import type { createSync } from './sync'
import { selectMainTimeline, selectTopicMessages, type TopicBaseline, type TopicSummaryError } from './topic-selectors'
import { countSequencesAfter, rememberTopicMessages, trimMessages, topicEvidence, boundTopicEvidence } from './message-window'
import { MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT } from './protocol-types'
import { latestMessageCopy, knownMessageState } from './identity-order'

type Sync = ReturnType<typeof createSync>
export type TopicsApi = {
  listTimeline(channel: string, query?: ListTimelineQuery, signal?: AbortSignal): Promise<Result<TimelinePage>>
  listTopics(channel: string, query?: ListTopicsQuery, signal?: AbortSignal): Promise<Result<TopicPage>>
  getTopicSummary(channel: string, topic: string, signal?: AbortSignal): Promise<Result<TopicSummaryResponse>>
  listTopicMessages(channel: string, topic: string, query?: TopicHistoryQuery, signal?: AbortSignal): Promise<Result<MessagePage>>
}
export const topicsApi = (organizationId: string, generation: () => string | undefined = () => undefined): TopicsApi => ({
  listTimeline: (c, q, signal) => api.listTimeline(organizationId, c, { history_generation: generation(), ...q }, undefined, signal),
  listTopics: (c, q, signal) => api.listTopics(organizationId, c, { history_generation: generation(), ...q }, undefined, signal),
  getTopicSummary: (c, t, signal) => api.getTopicSummary(organizationId, c, t, undefined, signal, { history_generation: generation() }),
  listTopicMessages: (c, t, q, signal) => api.listTopicMessages(organizationId, c, t, q, undefined, signal),
})
const MAX_SUMMARY_RETRIES = 4
type Paging = { asOfSeq?: number; before?: number; through?: number; hasMore: boolean; hasNewer: boolean; following: boolean; newerCount: number; loading: boolean; error: boolean }
type TopicWindow = { asOfSeq?: number; messages: Map<number, Message>; before?: number; through?: number; initialized: boolean; hasMore: boolean; hasNewer: boolean; following: boolean; newerCount: number; loading: boolean; error: boolean; notFound: boolean }
type SummaryRetry = { attempt: number; timer?: ReturnType<typeof setTimeout>; terminal?: TopicSummaryError }
const isRetryableSummaryFailure = <T>(r: Exclude<Result<T>, { ok: true }>) =>
  r.kind === 'network' || (r.kind === 'http' && r.status >= 500)
const paging = (): Paging => ({ hasMore: true, hasNewer: false, following: true, newerCount: 0, loading: false, error: false })
const topicWindow = (): TopicWindow => ({ messages: new Map(), initialized: false, hasMore: true, hasNewer: false, following: true, newerCount: 0, loading: false, error: false, notFound: false })
const window = (channel: string, generation: number) => ({ channel, generation, main: paging(), list: paging(), messages: new Map<number, Message>(),
  listRead: Promise.resolve(), listVersion: 0, listPage: undefined as symbol | undefined,
  moveRefresh: undefined as { main: boolean; list: boolean; summaries: Set<string> } | undefined,
  activeTopic: undefined as string | undefined,
  mainTopics: new Set<string>(), listTopics: new Set<string>(), mainPositions: new Map<string, number>(), baselines: new Map<string, TopicBaseline>(), topics: new Map<string, TopicWindow>(),
  evidence: topicEvidence(), evidenceRefresh: new Set<string>(),
  summaryThrough: new Map<string, number>(),
  summaries: new Set<string>(), summaryDemands: new Map<string, number>(), summaryRetries: new Map<string, SummaryRetry>(), reads: new Map<ReadSlot, symbol>(), unavailable: false })
type Window = ReturnType<typeof window>
type ReadSlot = 'main' | 'list' | `summary:${string}` | `topic:${string}`

/** Session-owned projection windows around the existing unfiltered sync controller. No protocol state is copied. */
// Compose only via createTopicSync, or call replaceSession/close on topics before sync with a test.
export function createTopics(sync: Sync, options: { api: TopicsApi; requestTimeoutMs?: number; activity?: Activity; initialTimeline?: InitialTimeline; isDm?(channel: string): boolean }) {
  const canonical = (channel: string, held: Message | undefined, incoming: Message) =>
    knownMessageState(sync.get().channels[channel], held, incoming)
  const windows = new Map<string, Window>()
  let mainLimit = MAIN_MESSAGE_LIMIT
  let topicLimit = TOPIC_MESSAGE_LIMIT
  const activityTargets = new Map<string, { close(): void; release(): void; target: ReturnType<typeof createActivityTarget>; summaryTarget?: ReturnType<typeof createActivityTarget<TopicSummaryResponse>> }>()
  const listeners = new Set<(channels: ReadonlySet<string>) => void>()
  const channelListeners = new Map<string, Set<() => void>>()
  const summaryListeners = new Set<(channel: string, response: TopicSummaryResponse, startedAt: number) => void>()
  const pendingChannels = new Set<string>()
  const deadlines = createRequestDeadlines()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  let closed = false
  let batching = false
  let sessionToken = 0
  let nextGeneration = 1
  const clearSummaryRetry = (w: Window, topicId: string) => {
    const retry = w.summaryRetries.get(topicId)
    if (!retry) return
    if (retry.timer !== undefined) clearTimeout(retry.timer)
    w.summaryRetries.delete(topicId)
  }
  const clearWindowTimers = (w: Window) => {
    for (const retry of w.summaryRetries.values()) {
      if (retry.timer !== undefined) clearTimeout(retry.timer)
    }
    w.summaryRetries.clear()
  }
  const freezeWindow = (w: Window) => {
    clearWindowTimers(w)
    w.reads.clear()
    w.listVersion++
    w.listPage = undefined
    w.summaries.clear()
    w.main.loading = false
    w.list.loading = false
    for (const t of w.topics.values()) t.loading = false
  }
  const cancelReads = () => {
    for (const w of windows.values()) clearWindowTimers(w)
    deadlines.cancel()
  }
  let previous = sync.get()
  const notify = (channel?: string | Iterable<string>) => {
    if (channel === undefined) {
      const all = new Set([...windows.keys(), ...snapshots.keys(), ...channelListeners.keys()])
      snapshots.clear()
      pendingChannels.clear()
      for (const ls of channelListeners.values()) ls.forEach(l => l())
      listeners.forEach(l => l(all))
      return
    }
    const ids = typeof channel === 'string' ? [channel] : channel
    for (const id of ids) {
      snapshots.delete(id)
      pendingChannels.add(id)
    }
    if (batching || pendingChannels.size === 0) return
    const changed = new Set(pendingChannels)
    pendingChannels.clear()
    for (const id of changed) channelListeners.get(id)?.forEach(l => l())
    listeners.forEach(l => l(changed))
  }
  function refetchMovedWindow(channel: string, stale: Window) {
    const prefix = `topic:${channel}:`
    const refresh = {
      main: stale.main.asOfSeq !== undefined || stale.main.loading || !!stale.moveRefresh?.main,
      list: stale.list.asOfSeq !== undefined || stale.list.loading || !!stale.moveRefresh?.list || activityTargets.has(`main:${channel}`),
      summaries: new Set([...(stale.moveRefresh?.summaries ?? []), ...stale.topics.keys(), ...stale.summaries, ...stale.summaryRetries.keys()]),
    }
    for (const [id] of stale.baselines) if (!stale.mainTopics.has(id) && !stale.listTopics.has(id)) refresh.summaries.add(id)
    for (const key of activityTargets.keys()) if (key.startsWith(prefix)) refresh.summaries.add(key.slice(prefix.length))
    const topic = stale.activeTopic
    if (topic !== undefined) refresh.summaries.add(topic)
    freezeWindow(stale)
    clearActivity(channel)
    const fresh = window(channel, nextGeneration++)
    fresh.moveRefresh = refresh
    fresh.activeTopic = topic
    if (topic !== undefined) fresh.topics.set(topic, topicWindow())
    windows.set(channel, fresh)
    queueMicrotask(() => {
      if (!current(channel, fresh)) return
      const pages = []
      if (refresh.main && fresh.main.asOfSeq === undefined) pages.push(loadMainPage(channel))
      if (refresh.list && fresh.list.asOfSeq === undefined) pages.push(controller.loadList(channel))
      if (topic !== undefined && fresh.activeTopic === topic && !fresh.topics.get(topic)?.initialized) void controller.loadTopic(channel, topic)
      if (topic !== undefined && refresh.summaries.has(topic)) void ensureSummary(channel, topic)
      // A first page can cover most held summaries in one request.
      void Promise.allSettled(pages).then(() => {
        if (!current(channel, fresh)) return
        fresh.moveRefresh = undefined
        for (const id of refresh.summaries) if (id !== topic) void ensureSummary(channel, id)
      })
    })
  }
  const reconcileSync = (syncChanged?: ReadonlySet<string>, records?: ReadonlyMap<string, Message[]>) => {
    const next = sync.get()
    if (next === previous) return false
    const globalChange = previous.running !== next.running || previous.organization !== next.organization
    const candidates = globalChange
      ? new Set([...windows.keys(), ...snapshots.keys(), ...channelListeners.keys()])
      : syncChanged ?? new Set(
          [...windows.keys(), ...snapshots.keys(), ...channelListeners.keys(), ...Object.keys(previous.channels), ...Object.keys(next.channels)].filter(
            id => previous.channels[id] !== next.channels[id],
          ),
        )
    for (const id of candidates) {
      const w = windows.get(id)
      if (w) {
        const before = previous.channels[id], after = next.channels[id]
        if (before && after && before.versionEpoch !== after.versionEpoch) freezeWindow(w)
        if (
          !after ||
          (before?.watched && !after.watched) ||
          (!before?.watched && after.watched && w.unavailable) ||
          (before?.cursor != null && after.cursor === null) || previous.historyEpoch !== next.historyEpoch
        ) {
          clearWindowTimers(w)
          w.messages.clear(); w.baselines.clear(); w.listTopics.clear(); w.reads.clear()
          for (const t of w.topics.values()) t.messages.clear()
          w.topics.clear()
          clearActivity(id); windows.delete(id)
        } else if ((before?.state === 'unavailable' || w.unavailable) && after.state !== 'unavailable') {
          clearWindowTimers(w)
          w.unavailable = false
          w.generation = nextGeneration++
        } else if (!next.running || next.organization === 'unavailable' || after.state === 'unavailable') {
          clearActivity(id); freezeWindow(w)
        } else if (after.moveEpoch !== undefined && before?.moveEpoch !== after.moveEpoch) {
          refetchMovedWindow(id, w)
        } else if (before?.messages !== after.messages || records?.has(id)) {
          const incoming = records?.get(id) ?? after.messages
          rememberTopicMessages(w.evidence, incoming)
          if (!w.main.following && w.messages.size + w.baselines.size >= mainLimit) w.main.hasNewer = true
          for (const m of incoming) {
            const baseline = m.topic_id && w.baselines.get(m.topic_id)
            if (baseline && baseline.summary.latest_message.id === m.id) {
              baseline.summary = { ...baseline.summary, latest_message: latestMessageCopy(baseline.summary.latest_message, m) }
            }
            const arrived = m.created_seq > (before?.cursor ?? Infinity) && !before?.messages.some(old => old.created_seq === m.created_seq)
            if (arrived && w.main.hasNewer) w.main.newerCount++
            if (w.messages.get(m.created_seq)?.id === m.id || (!m.deleted && m.version === m.created_seq && m.created_seq > (w.main.asOfSeq ?? 0) && (!w.main.hasNewer || (m.topic_id && w.baselines.has(m.topic_id))))) { const state = canonical(id, w.messages.get(m.created_seq), m); if (state) w.messages.set(m.created_seq, state) }
            for (const [topicId, t] of w.topics) {
              if (m.topic_id !== topicId) {
                const held = t.messages.get(m.created_seq)
                if (held?.id === m.id && held.version < m.version) t.messages.delete(m.created_seq)
                continue
              }
              if (!t.following && t.messages.size >= topicLimit) t.hasNewer = true
              if (arrived && t.hasNewer) t.newerCount++
              if (!t.hasNewer || t.messages.has(m.created_seq)) { const state = canonical(id, t.messages.get(m.created_seq), m); if (state) t.messages.set(m.created_seq, state) }
            }
          }
          trimMain(w, w.main.hasNewer ? 'older' : 'newer')
          for (const t of w.topics.values()) trimTopic(t, 'newer')
        }
      }
      snapshots.delete(id)
      pendingChannels.add(id)
    }
    if (!next.running) cancelReads()
    previous = next
    return true
  }
  const withSync = (channel: string, fn: () => void) => {
    snapshots.delete(channel)
    pendingChannels.add(channel)
    batching = true
    try { fn() } finally { batching = false }
  }
  const getWindow = (channel: string) => {
    let w = windows.get(channel)
    if (!w) {
      windows.set(channel, w = window(channel, nextGeneration++))
      rememberTopicMessages(w.evidence, sync.get().channels[channel]?.messages ?? [])
    }
    return w
  }
  const unsubscribe = sync.subscribe((changedChannels, records) => {
    reconcileSync(changedChannels, records)
    if (!batching) notify([])
  })
  const current = (channel: string, w: Window) => {
    if (!closed) reconcileSync()
    const s = sync.get()
    return !closed && s.running &&
      s.organization === 'available' && windows.get(channel) === w && !w.unavailable &&
      s.channels[channel]?.watched === true && s.channels[channel]?.state !== 'unavailable'
  }
  const needsSummary = (w: Window, topicId: string) => {
    const baseline = w.baselines.get(topicId)
    if (!baseline || baseline.asOfSeq < w.evidence.floor) return true
    const known = w.evidence.sequences.get(topicId)?.at(-1)?.end ?? 0
    return known > baseline.summary.latest_message.created_seq && w.messages.get(known)?.topic_id !== topicId &&
      known > (w.summaryThrough.get(topicId) ?? 0)
  }

  async function read<T>(channel: string, w: Window, slot: ReadSlot, run: () => Promise<Result<T>>, bootstrap = false, withTimeout = true, signal?: AbortSignal, early?: InitialRead<T & Pick<TimelinePage, 'history_generation'>>) {
    const started = sync.get().channels[channel]
    const mutationFloor = started?.mutationSeq ?? 0
    const versionEpoch = started?.versionEpoch
    const token = Symbol(slot)
    w.reads.set(slot, token)
    const isCurrent = () => {
      if (!current(channel, w) || w.reads.get(slot) !== token) return false
      const active = sync.get().channels[channel]
      return active?.versionEpoch === versionEpoch && (!early || active?.latest === started?.latest)
    }
    let startedAt = 0
    const prefetched = early && await early.result
    if (early && !isCurrent()) return { result: { ok: false, kind: 'network' } as Result<T>, isCurrent, startedAt }
    const knownGeneration = sync.get().historyGeneration
    // An unversioned startup read cannot supersede a generation learned while it was in flight.
    const reuse = !early?.signal.aborted && prefetched &&
      (!prefetched.ok || knownGeneration === undefined || prefetched.data?.history_generation === knownGeneration)
    // Session replacement fences late authentication failures; same-session late 401 remains authoritative.
    const session = sessionToken
    const operation = (reuse ? Promise.resolve(prefetched) : Promise.resolve().then(() => { startedAt = stampTopicEvidence(); return run() })).catch((): Result<T> => ({ ok: false, kind: 'network' }))
    void operation.then(r => {
      if (session === sessionToken) sync.reportAccess(r, sync)
    })
    const deadline = withTimeout || signal ? deadlines.start<Result<T>>({ ok: false, kind: 'network' }, {
      timeoutMs: withTimeout ? options.requestTimeoutMs ?? 30_000 : undefined,
      signal,
    }) : undefined
    try {
      const response = reuse ? prefetched : await (deadline ? Promise.race([operation, deadline.until]) : operation)
      if (isCurrent() && observeGeneration(sync, response) === 'stale') {
        const result: Result<T> = response.ok ? { ok: false, kind: 'network' } : response
        return { result, isCurrent: () => false, startedAt }
      }
      const state = sync.get().channels[channel]
      const mutationSeq = state?.mutationSeq ?? 0
      const floor = mutationFloor < mutationSeq ? mutationSeq : state?.moveSeq ?? 0
      const belowFloor = response.ok && response.data && typeof response.data === 'object' &&
        'as_of_seq' in response.data && typeof response.data.as_of_seq === 'number' && response.data.as_of_seq < floor
      const result: Result<T> = belowFloor ? { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' } : response.ok && !completeCountFields(response.data) ? { ok: false, kind: 'network' } : response
      // Bootstrap denials belong to sync's history request; C10 must never become a C9 denial.
      if (!bootstrap && !api.isOrganizationUnavailable(result) && isCurrent() &&
        api.isChannelDenial(result, { statuses: [403, 404], localNotFound: 'topic_not_found' })) {
        // C9: refuse sends and resubscription until explicit user selection.
        w.unavailable = true
        freezeWindow(w)
        withSync(channel, () => { void sync.channelUnavailable(channel) })
        windows.set(channel, w)
        notify(channel)
      }
      return { result, startedAt, isCurrent: reuse ? () => !early?.signal.aborted && isCurrent() : isCurrent }
    } finally { deadline?.clear() }
  }
  function mergeBaselines(w: Window, response: Pick<TopicPage, 'as_of_seq' | 'topics'>, startedAt: number, fromList = false) {
    const { channel } = w
    if (windows.get(channel) !== w) return
    for (const summary of response.topics) {
      holdSummary(w, summary.id)
      const old = w.baselines.get(summary.id)
      const held = old?.summary.latest_message
      const state = canonical(channel, held?.id === summary.latest_message.id ? held : undefined, summary.latest_message)
      if (!state) continue
      if (fromList) w.listTopics.add(summary.id)
      const latestMessage = held ? latestMessageCopy(held, state) : state
      const equal = old && response.as_of_seq === old.asOfSeq && summary.read_seq === old.summary.read_seq
      if (!old || response.as_of_seq > old.asOfSeq || (response.as_of_seq === old.asOfSeq && summary.read_seq >= old.summary.read_seq)) {
        const baseline = { asOfSeq: response.as_of_seq, summary: equal
          ? { ...summary, latest_message: latestMessage, unread_count: Math.min(summary.unread_count, old.summary.unread_count),
            mention_unread_count: Math.min(summary.mention_unread_count, old.summary.mention_unread_count) }
          : { ...summary, latest_message: latestMessage } }
        topicBaselineStarts.set(baseline, startedAt)
        w.baselines.set(summary.id, baseline)
      } else if (old) {
        old.summary = { ...old.summary, latest_message: latestMessage }
      }
    }
  }
  function holdSummary(w: Window, topic: string) {
    const { channel } = w
    if (windows.get(channel) !== w || !options.activity) return
    const key = `topic:${channel}:${topic}`
    const existing = activityTargets.get(key)
    if (existing) return existing.summaryTarget
    let through = 0
    const target = createActivityTarget<TopicSummaryResponse>({
      stampRead: stampTopicEvidence,
      retryQueuedTerminal: true,
      async load(signal) {
        w.summaries.add(topic)
        through = w.evidence.sequences.get(topic)?.at(-1)?.end ?? 0
        const epoch = sync.get().channels[channel]?.versionEpoch
        const pending = options.api.getTopicSummary(channel, topic, signal)
        try {
          const { result } = await read(channel, w, `summary:${topic}`, () => pending, false, false, signal)
          if (sync.get().channels[channel]?.versionEpoch !== epoch) return { ok: false, kind: 'network' }
          // A concurrent mutation can make a server-selected summary transiently stale; never turn it into a terminal 4xx.
          return !result.ok && result.kind === 'http' && result.status === 409 && result.error === 'snapshot_expired'
            ? { ok: false, kind: 'network' }
            : result
        }
        finally { if (signal.aborted) w.summaries.delete(topic) }
      },
      hide: () => { w.reads.delete(`summary:${topic}`); clearSummaryRetry(w, topic) },
      accept: (response, startedAt) => {
        if (!current(channel, w)) return
        w.summaryThrough.set(topic, through)
        const t = w.topics.get(topic)
        if (t) t.notFound = false
        mergeBaselines(w, { as_of_seq: response.as_of_seq, topics: [response.topic] }, startedAt)
        trimMain(w, w.main.hasNewer ? 'older' : 'newer')
        // A successful but insufficient checkpoint must retain main's finite retry budget.
        const baseline = w.baselines.get(topic)
        if (needsSummary(w, topic) && (baseline || w.topics.has(topic))) {
          const attempt = w.summaryRetries.get(topic)?.attempt ?? 0
          if (!baseline || baseline.asOfSeq >= w.evidence.floor) w.summaryRetries.set(topic, { attempt, terminal: 'non_retryable' })
          else if (attempt >= MAX_SUMMARY_RETRIES) w.summaryRetries.set(topic, { attempt, terminal: 'retryable' })
          else {
            const timer = setTimeout(() => {
              const entry = w.summaryRetries.get(topic)
              if (entry) entry.timer = undefined
              void ensureSummary(channel, topic)
            }, backoffCap(attempt))
            w.summaryRetries.set(topic, { attempt: attempt + 1, timer })
          }
        }
        w.summaries.delete(topic)
        withSync(channel, () => { void sync.settleHistory(channel, [response.topic.latest_message]) })
        notify(channel)
        summaryListeners.forEach(listener => listener(channel, response, startedAt))
      },
      error: r => {
        if (!current(channel, w)) return
        w.summaries.delete(topic)
        clearSummaryRetry(w, topic)
        if (r.kind === 'http' && r.status === 404 && r.error === 'topic_not_found') {
          let t = w.topics.get(topic)
          if (!t) w.topics.set(topic, t = topicWindow())
          t.notFound = true
        } else w.summaryRetries.set(topic, { attempt: 0, terminal: r.kind === 'network' || r.status === 429 || r.status >= 500 ? 'retryable' : 'non_retryable' })
        notify(channel)
      },
      terminal: r => !r.ok && r.kind === 'http' && (api.isSessionEnded(r) || r.status === 403 || r.status === 404),
      timeoutMs: options.requestTimeoutMs,
    })
    activityTargets.set(key, { close: target.close, release: options.activity.hold(key, target), target, summaryTarget: target })
    return target
  }
  async function readList(channel: string, w: Window, run: () => Promise<Result<TopicPage>>, withTimeout = true, signal?: AbortSignal) {
    const version = w.listVersion, previous = w.listRead
    let release!: () => void
    w.listRead = new Promise<void>(resolve => { release = resolve })
    try {
      await previous
      if (!current(channel, w) || w.listVersion !== version) return { result: { ok: false, kind: 'network' } as Result<TopicPage>, isCurrent: () => false, startedAt: 0 }
      return await read(channel, w, 'list', run, false, withTimeout, signal)
    } finally { release() }
  }
  function holdMain(w: Window) {
    const { channel } = w
    if (windows.get(channel) !== w || !options.activity) return
    const key = `main:${channel}`
    const existing = activityTargets.get(key)
    if (existing) return existing.target
    const target = createActivityTarget<{ page: TopicPage; startedAt: number }>({
      load: async signal => {
        const epoch = sync.get().channels[channel]?.versionEpoch
        const { result, startedAt } = await readList(channel, w, () => options.api.listTopics(channel, undefined, signal), false, signal)
        if (sync.get().channels[channel]?.versionEpoch !== epoch) return { ok: false, kind: 'network' }
        return result.ok ? { ok: true, data: { page: result.data, startedAt } } : result
      },
      hide: () => { w.listVersion++; w.reads.delete('list') },
      accept: ({ page: response, startedAt }) => {
        if (!current(channel, w)) return
        mergeBaselines(w, response, startedAt, true)
        trimMain(w, w.main.hasNewer ? 'older' : 'newer')
        withSync(channel, () => { void sync.settleHistory(channel, response.topics.map(t => t.latest_message)) })
        notify(channel)
      },
      error: r => {
        if (!api.isOrganizationUnavailable(r) && r.kind === 'http' &&
          (r.status === 403 || (r.status === 404 && r.error !== 'topic_not_found'))) void sync.channelUnavailable(channel)
      },
      terminal: r => !r.ok && r.kind === 'http' && (api.isSessionEnded(r) || r.status === 403 || r.status === 404),
      timeoutMs: options.requestTimeoutMs,
    })
    activityTargets.set(key, { close: target.close, release: options.activity.hold(key, target), target })
    return target
  }
  function releaseActivity(key: string) {
    const target = activityTargets.get(key)
    if (target) { target.close(); target.release(); activityTargets.delete(key) }
  }
  function clearActivity(channel?: string) {
    for (const key of activityTargets.keys()) if (channel === undefined || key.startsWith(`topic:${channel}:`) || key === `main:${channel}`) releaseActivity(key)
  }
  function pruneActivity(w: Window) {
    const { channel } = w
    if (windows.get(channel) !== w) return
    // An awaited activitySummary() or queued non-retry follow-up owns its target until it settles.
    const retained = new Set([...w.baselines.keys(), ...w.topics.keys(), ...w.summaryDemands.keys()])
    for (const m of w.messages.values()) if (m.topic_id) retained.add(m.topic_id)
    for (const [key, entry] of activityTargets) if (key.startsWith(`topic:${channel}:`) &&
      !retained.has(key.slice(`topic:${channel}:`.length)) && !entry.target.pendingNotice()) releaseActivity(key)
  }
  async function ensureSummaryForWindow(w: Window, topicId: string) {
    if (w.evidenceRefresh.has(topicId)) return
    w.evidenceRefresh.add(topicId)
    try {
      await Promise.resolve()
      if (windows.get(w.channel) === w && current(w.channel, w)) await ensureSummary(w.channel, topicId)
    } finally { w.evidenceRefresh.delete(topicId) }
  }
  function trimTopic(t: TopicWindow, edge: 'older' | 'newer') {
    if (!trimMessages(t.messages, topicLimit, edge)) return
    if (edge === 'older') {
      t.hasNewer = true
      t.through = Math.max(...t.messages.keys())
    } else {
      t.hasMore = true
      t.before = Math.min(...t.messages.keys())
    }
  }
  function trimMain(w: Window, edge: 'older' | 'newer') {
    const lines = selectMainTimeline([], w.messages.values(), w.baselines.values(), w.evidence)
    const liveTopics = new Set([...w.messages.values()].flatMap(m => m.topic_id ? [m.topic_id] : []))
    const kept = [...lines]
    const cost = (line: typeof lines[number]) => line.kind === 'message' ? 1 :
      Number(w.baselines.has(line.topicId)) + Number(liveTopics.has(line.topicId))
    let size = kept.reduce((sum, l) => sum + cost(l), 0)
    const trimmed = size > mainLimit
    while (size > mainLimit) size -= cost(edge === 'older' ? kept.pop()! : kept.shift()!)
    const ids = new Set(kept.filter(l => l.kind === 'topic').map(l => l.topicId))
    const seqs = new Set(kept.filter(l => l.kind === 'message').map(l => l.message.created_seq))
    for (const [seq, m] of w.messages) if (m.topic_id ? !ids.has(m.topic_id) : !seqs.has(seq)) w.messages.delete(seq)
    for (const id of w.baselines.keys()) if (!ids.has(id)) {
      w.baselines.delete(id); w.mainTopics.delete(id); w.listTopics.delete(id); w.mainPositions.delete(id); w.summaryThrough.delete(id)
      if (!w.topics.has(id)) { w.reads.delete(`summary:${id}`); w.summaries.delete(id); clearSummaryRetry(w, id) }
    }
    // Only the latest body of each Topic is needed; its count evidence has a separate lifetime.
    const latest = new Map<string, number>()
    for (const m of w.messages.values()) if (m.topic_id) latest.set(m.topic_id, Math.max(latest.get(m.topic_id) ?? 0, m.created_seq))
    for (const [seq, m] of w.messages) if (m.topic_id && seq !== latest.get(m.topic_id)) w.messages.delete(seq)
    if (trimmed) {
      // Auxiliary summaries do not prove that any main-page history was fetched.
      const covered = kept.filter(l => l.kind === 'message' || w.mainTopics.has(l.topicId) || liveTopics.has(l.topicId))
      const positions = covered.map(l => l.kind === 'message' ? l.message.created_seq : w.mainPositions.get(l.topicId) ?? l.position)
      if (positions.length) w.main.before = Math.min((w.main.asOfSeq ?? Infinity) + 1, ...positions)
      if (edge === 'older') {
        w.main.hasNewer = true
        w.main.through = positions.length ? Math.min(w.main.through ?? Infinity, Math.max(...positions)) : 0
      }
      else w.main.hasMore = true
    }
    boundTopicEvidence(w.evidence)
    for (const [id, baseline] of w.baselines) {
      if (!needsSummary(w, id)) clearSummaryRetry(w, id)
      else if (baseline.asOfSeq < w.evidence.floor && !w.summaries.has(id)) void ensureSummaryForWindow(w, id)
    }
    let total = [...windows.values()].reduce((n, value) => n + value.messages.size + value.baselines.size, 0)
    for (const [id, other] of windows) {
      if (total <= mainLimit) break
      if (other === w) continue
      total -= other.messages.size + other.baselines.size
      other.messages.clear(); other.baselines.clear(); other.mainTopics.clear(); other.mainPositions.clear()
      other.main = paging(); other.list = paging()
      other.summaryThrough.clear(); other.summaries.clear(); other.evidence = topicEvidence()
      for (const slot of other.reads.keys()) if (!slot.startsWith('topic:')) other.reads.delete(slot)
      clearActivity(id); clearWindowTimers(other)
      snapshots.delete(id); pendingChannels.add(id)
    }
    pruneActivity(w)
  }
  function applyMain(w: Window, page: TimelinePage, startedAt: number) {
    const { channel } = w
    if (windows.get(channel) !== w) return
    const older = w.main.asOfSeq !== undefined
    for (const item of page.items) {
      if (item.kind === 'message') { const state = canonical(channel, w.messages.get(item.message.created_seq), item.message); if (state) w.messages.set(item.message.created_seq, state) }
      else {
        w.mainTopics.add(item.topic.id)
        w.mainPositions.set(item.topic.id, item.topic.last_seq)
        mergeBaselines(w, { as_of_seq: page.as_of_seq, topics: [item.topic] }, startedAt)
      }
    }
    holdMain(w)
    w.main.asOfSeq = page.as_of_seq
    w.main.through ??= page.as_of_seq
    w.main.before = page.items[0] && (page.items[0].kind === 'message' ? page.items[0].message.created_seq : page.items[0].topic.last_seq)
    w.main.hasMore = page.has_more
    trimMain(w, older ? 'older' : 'newer')
  }

  async function loadMainPage(channel: string, bootstrap = false, latest = false, restarted = false): Promise<Result<TimelinePage>> {
    if (bootstrap) {
      const w = getWindow(channel)
      w.main = paging(); w.messages.clear(); w.mainTopics.clear()
      for (const m of sync.get().channels[channel]?.messages ?? []) { const state = canonical(channel, w.messages.get(m.created_seq), m); if (state) w.messages.set(m.created_seq, state) }
      trimMain(w, 'newer')
    }
    const w = getWindow(channel), p = w.main, generation = w.generation
    if (!current(channel, w) || p.loading || !p.hasMore) return { ok: false, kind: 'network' }
    p.loading = true; p.error = false; notify(channel)
    const query: ListTimelineQuery = p.asOfSeq === undefined ? { history_generation: sync.get().historyGeneration } : { history_generation: sync.get().historyGeneration, as_of_seq: p.asOfSeq, before_position: p.before }
    const early = bootstrap ? options.initialTimeline?.take(channel) : undefined
    const { result, isCurrent, startedAt } = await read(channel, w, 'main', () => bootstrap && options.isDm?.(channel)
      ? Promise.resolve({ ok: false, kind: 'network' })
      : options.api.listTimeline(channel, early ? { history_generation: sync.get().historyGeneration } : query),
    bootstrap, true, undefined, early)
    if (isCurrent() && !result.ok && result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
      for (const id of w.mainTopics) if (!w.listTopics.has(id) && !w.topics.has(id)) w.baselines.delete(id)
      w.main = paging(); w.messages.clear(); w.mainTopics.clear(); w.mainPositions.clear()
      return loadMainPage(channel, bootstrap, latest, true)
    }
    // An empty log has no Message identities or Unread baselines to invalidate.
    // Its zero bootstrap cursor replays every Message, including post-snapshot arrivals.
    const accepted = () => isCurrent() || (bootstrap && w.generation !== generation &&
      current(channel, w) && w.main === p && !w.reads.has('main') &&
      result.ok && result.data.as_of_seq === 0 && result.data.items.length === 0 && !result.data.has_more)
    if (accepted() && w.main === p) {
      p.loading = false; p.error = !result.ok
      if (result.ok) {
        if (latest) {
          w.messages.clear(); w.mainTopics.clear(); w.baselines.clear(); w.listTopics.clear(); w.mainPositions.clear(); w.list = paging()
          w.summaryThrough.clear(); pruneActivity(w)
        }
        applyMain(w, result.data, startedAt)
        if (query.as_of_seq === undefined) {
          const messages = sync.get().channels[channel]?.messages ?? []
          rememberTopicMessages(w.evidence, messages)
          const cursor = sync.get().channels[channel]?.cursor ?? 0
          const suffix = messages.filter(m => m.created_seq > result.data.as_of_seq)
          const missing = cursor > result.data.as_of_seq && (sync.get().channels[channel]?.streamBase ?? Infinity) > result.data.as_of_seq
          if (missing) w.main.hasNewer = true
          else for (const m of suffix) { const state = canonical(channel, w.messages.get(m.created_seq), m); if (state) w.messages.set(m.created_seq, state) }
          trimMain(w, 'newer')
        }
        withSync(channel, () => { void sync.settleHistory(channel, result.data.items.map(i => i.kind === 'message' ? i.message : i.topic.latest_message)) })
      }
      notify(channel)
    }
    return accepted() ? result : { ok: false, kind: 'network' }
  }
  async function reanchorMain(channel: string, w: Window) {
    if (!current(channel, w)) return false
    const p = w.main
    p.loading = true; p.error = false; p.hasNewer = true; notify(channel)
    const { result, isCurrent } = await read(channel, w, 'main', () => options.api.listTimeline(channel, {}))
    if (!isCurrent() || w.main !== p) return false
    p.loading = false; p.error = !result.ok
    if (result.ok) {
      p.through = Math.min(result.data.as_of_seq, Math.max(p.through ?? p.asOfSeq ?? 0, sync.get().channels[channel]?.cursor ?? 0))
      p.asOfSeq = result.data.as_of_seq
      for (const id of w.mainTopics) {
        const ranges = w.evidence.sequences.get(id) ?? []
        const range = [...ranges].reverse().find(r => r.start <= p.asOfSeq!)
        if (range) w.mainPositions.set(id, Math.max(w.mainPositions.get(id) ?? 0, Math.min(range.end, p.asOfSeq)))
      }
      const lines = snapshot(channel).lines
      p.before = Math.min(...lines.map(l => l.kind === 'message' ? l.message.created_seq : w.mainPositions.get(l.topicId) ?? l.position))
      p.hasMore = true
      withSync(channel, () => { void sync.settleHistory(channel, result.data.items.map(i => i.kind === 'message' ? i.message : i.topic.latest_message)) })
    }
    notify(channel)
    return result.ok
  }
  function snapshot(channel: string) {
    const w = closed ? window(channel, 0) : getWindow(channel)
    const syncState = closed ? undefined : sync.get()
    const c = syncState?.channels[channel]
    const messages = w.main.asOfSeq === undefined ? (c?.messages ?? []) : []
    const summaryErrorFor = (topicId: string): TopicSummaryError | null =>
      (w.baselines.has(topicId) && !needsSummary(w, topicId)) || w.topics.get(topicId)?.notFound
        ? null
        : (w.summaryRetries.get(topicId)?.terminal ?? null)
    const merged = selectMainTimeline(messages, w.messages.values(), w.baselines.values(), w.evidence)
    for (const item of merged) {
      if (item.kind === 'topic') item.summaryError = summaryErrorFor(item.topicId)
    }
    // List/summary baselines supply counts, while main pages and sync records supply main membership.
    const visibleTopics = new Set([...w.mainTopics, ...[...w.messages.values(), ...messages].flatMap(m => m.topic_id ? [m.topic_id] : [])])
    const lines = merged.filter(l => l.kind === 'message' || visibleTopics.has(l.topicId))
    const topicSnapshots = new Map<string, ReturnType<typeof topic>>()
    function topic(topicId: string) {
      const t = w.topics.get(topicId)
      return { messages: selectTopicMessages(topicId, t ? [] : (c?.messages ?? []), t?.messages.values() ?? []).slice(-TOPIC_MESSAGE_LIMIT),
        before: t?.before, through: t?.through,
        initialized: t?.initialized ?? false,
        loading: t?.loading ?? false, hasMore: t?.hasMore ?? true, hasNewer: t?.hasNewer ?? false, newerCount: t?.newerCount ?? 0, error: t?.error ?? false,
        notFound: t?.notFound ?? false, summaryError: summaryErrorFor(topicId) }
    }
    return { generation: w.generation, lines, topics: merged.filter(l => l.kind === 'topic'),
      main: { ...w.main }, list: { ...w.list },
      unavailable: w.unavailable || c?.state === 'unavailable' || syncState?.organization === 'unavailable',
      topic(topicId: string) {
        let value = topicSnapshots.get(topicId)
        if (!value) topicSnapshots.set(topicId, value = topic(topicId))
        return value
      } }
  }
  async function fetchSummary(channel: string, topicId: string, restarted = false): Promise<Result<TopicSummaryResponse> | undefined> {
    const w = getWindow(channel)
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const pendingRetry = w.summaryRetries.get(topicId)
    if (pendingRetry?.timer !== undefined) {
      clearTimeout(pendingRetry.timer)
      pendingRetry.timer = undefined
    }
    w.summaries.add(topicId)
    const through = w.evidence.sequences.get(topicId)?.at(-1)?.end ?? 0
    const { result, isCurrent, startedAt } = await read(channel, w, `summary:${topicId}`, () => options.api.getTopicSummary(channel, topicId))
    if (!isCurrent()) return
    if (!result.ok && result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
      w.summaries.delete(topicId)
      return fetchSummary(channel, topicId, true)
    }
    if (result.ok) {
      w.summaryThrough.set(topicId, through)
      const existing = w.topics.get(topicId)
      if (existing) existing.notFound = false
      mergeBaselines(w, { as_of_seq: result.data.as_of_seq, topics: [result.data.topic] }, startedAt)
      trimMain(w, 'newer')
      withSync(channel, () => { void sync.settleHistory(channel, [result.data.topic.latest_message]) })
    } else if (result.kind === 'http' && result.status === 404 && result.error === 'topic_not_found') {
      clearSummaryRetry(w, topicId)
      let t = w.topics.get(topicId)
      if (!t) w.topics.set(topicId, t = topicWindow())
      t.notFound = true
    }
    return result
  }
  async function loadSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w)) { clearSummaryRetry(w, topicId); await holdSummary(w, topicId)?.refresh() }; return }
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const hadTerminal = w.summaryRetries.get(topicId)?.terminal !== undefined
    clearSummaryRetry(w, topicId)
    const pending = fetchSummary(channel, topicId)
    if (hadTerminal) notify(channel)
    const result = await pending
    if (!result) return
    w.summaries.delete(topicId)
    if (
      !result.ok &&
      current(channel, w) &&
      needsSummary(w, topicId) &&
      !w.topics.get(topicId)?.notFound
    ) {
      w.summaryRetries.set(topicId, {
        attempt: MAX_SUMMARY_RETRIES,
        terminal: isRetryableSummaryFailure(result) ? 'retryable' : 'non_retryable',
      })
    }
    notify(channel)
    return result
  }
  async function ensureSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) {
      const retry = w.summaryRetries.get(topicId)
      if (current(channel, w) && needsSummary(w, topicId) && !w.topics.get(topicId)?.notFound &&
        !w.summaries.has(topicId) && retry?.timer === undefined && retry?.terminal === undefined) await holdSummary(w, topicId)?.ensure()
      return
    }
    const existingRetry = w.summaryRetries.get(topicId)
    if (
      !current(channel, w) ||
      !needsSummary(w, topicId) ||
      w.topics.get(topicId)?.notFound ||
      w.summaries.has(topicId) ||
      existingRetry?.timer !== undefined ||
      existingRetry?.terminal !== undefined
    ) {
      return
    }
    const result = await fetchSummary(channel, topicId)
    if (!result) return
    try {
      const latestRetry = w.summaryRetries.get(topicId)
      if (
        !current(channel, w) ||
        !needsSummary(w, topicId) ||
        w.topics.get(topicId)?.notFound ||
        latestRetry?.timer !== undefined ||
        latestRetry?.terminal !== undefined
      ) {
        return
      }
      const attempt = latestRetry?.attempt ?? 0
      const baseline = w.baselines.get(topicId)
      if (result.ok && !baseline && !w.topics.has(topicId)) return
      // An evicted baseline cannot be restored by repeatedly fetching the same old Topic.
      if ((result.ok && (!baseline || baseline.asOfSeq >= w.evidence.floor)) || (!result.ok && !isRetryableSummaryFailure(result))) {
        w.summaryRetries.set(topicId, { attempt, terminal: 'non_retryable' })
        return
      }
      if (attempt >= MAX_SUMMARY_RETRIES) {
        w.summaryRetries.set(topicId, { attempt, terminal: 'retryable' })
        return
      }
      const timer = setTimeout(() => {
        const entry = w.summaryRetries.get(topicId)
        if (entry) entry.timer = undefined
        void ensureSummary(channel, topicId)
      }, backoffCap(attempt))
      w.summaryRetries.set(topicId, { attempt: attempt + 1, timer })
    } finally {
      // Publish only after retry/terminal state is ready for component effects to re-enter.
      w.summaries.delete(topicId)
      if (current(channel, w)) notify(channel)
    }
  }
  async function retrySummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w)) { clearSummaryRetry(w, topicId); await holdSummary(w, topicId)?.retryNow() }; return }
    if (!current(channel, w)) return
    if (w.summaries.has(topicId)) {
      const entry = w.summaryRetries.get(topicId)
      if (entry) {
        entry.attempt = 0
        entry.terminal = undefined
      }
      return
    }
    const hadTerminal = w.summaryRetries.get(topicId)?.terminal !== undefined
    clearSummaryRetry(w, topicId)
    const pending = ensureSummary(channel, topicId)
    if (hadTerminal) notify(channel)
    await pending
  }
  function subscribe(listener: (channels: ReadonlySet<string>) => void, channel?: string): () => void {
    if (channel !== undefined) {
      const wrapped = () => listener(new Set([channel]))
      let set = channelListeners.get(channel)
      if (!set) channelListeners.set(channel, set = new Set())
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
        if (set?.size === 0) channelListeners.delete(channel)
      }
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const controller = {
    reserveSearch(channel: string | undefined, scope: 'main' | 'topic', records: number) {
      const nextMain = MAIN_MESSAGE_LIMIT - (scope === 'main' ? records : 0)
      const nextTopic = TOPIC_MESSAGE_LIMIT - (scope === 'topic' ? records : 0)
      const trimMainNow = nextMain < mainLimit
      const trimTopicNow = nextTopic < topicLimit
      mainLimit = nextMain
      topicLimit = nextTopic
      if (trimMainNow) {
        const entry = channel !== undefined && windows.has(channel)
          ? [channel, windows.get(channel)!] as const : windows.entries().next().value
        if (entry) {
          const [id, w] = entry
          trimMain(w, w.main.hasNewer ? 'older' : 'newer')
          notify(id)
        }
      }
      if (trimTopicNow) for (const [id, w] of windows) {
        if (!w.topics.size) continue
        for (const t of w.topics.values()) trimTopic(t, t.hasNewer ? 'older' : 'newer')
        notify(id)
      }
    },
    countMessages(channel: string): Iterable<Message>[] {
      const w = windows.get(channel)
      return w ? [w.messages.values(), ...[...w.topics.values()].map(t => t.messages.values())] : []
    },
    subscribe,
    subscribeSummary(listener: (channel: string, response: TopicSummaryResponse, startedAt: number) => void): () => void {
      summaryListeners.add(listener)
      return () => { summaryListeners.delete(listener) }
    },
    activityAccess(channel: string) {
      const w = windows.get(channel)
      if (!w) return
      freezeWindow(w)
      w.generation = nextGeneration++; w.baselines.clear()
      for (const [key, entry] of activityTargets) if (key.startsWith(`topic:${channel}:`) || key === `main:${channel}`) entry.target.invalidate('access')
      notify(channel)
    },
    hasActivitySummary(channel: string, topic: string) {
      return activityTargets.has(`topic:${channel}:${topic}`)
    },
    async readTopicSummary(channel: string, topic: string, requirement: TopicCountRequirement, allowCached = false): Promise<ActivityRead<TopicSummaryResponse> | undefined> {
      const w = getWindow(channel)
      if (!current(channel, w)) return
      const target = holdSummary(w, topic)
      if (!target) return
      const cached = w.baselines.get(topic)
      if (allowCached && cached && target.idle()) {
        const startedAt = topicBaselineStarts.get(cached) ?? 0
        const asOfSeq = Math.max(requirement.asOfSeq, sync.get().channels[channel]?.cursor ?? 0)
        if (coversTopicCounts({ ...requirement, asOfSeq }, cached.asOfSeq, cached.summary.read_seq, startedAt)) {
          return { startedAt, result: { ok: true, data: {
            history_generation: cached.summary.latest_message.history_generation, as_of_seq: cached.asOfSeq, topic: cached.summary,
          } } }
        }
      }
      w.summaryDemands.set(topic, (w.summaryDemands.get(topic) ?? 0) + 1)
      try {
        return await readActivitySummary(target, requirement, () => current(channel, w))
      } finally {
        const left = (w.summaryDemands.get(topic) ?? 1) - 1
        if (left > 0) w.summaryDemands.set(topic, left)
        else w.summaryDemands.delete(topic)
      }
    },
    async activitySummary(channel: string, topic: string, minimumPosition = 0, minimumAsOfSeq?: number): Promise<Result<TopicSummaryResponse>> {
      const requirement = { asOfSeq: minimumAsOfSeq ?? sync.get().channels[channel]?.cursor ?? 0, readSeq: minimumPosition, after: 0 }
      const read = await controller.readTopicSummary(channel, topic, requirement)
      if (read && (!read.result.ok ||
        coversTopicCounts(requirement, read.result.data.as_of_seq, read.result.data.topic.read_seq, read.startedAt))) return read.result
      return { ok: false, kind: 'network' }
    },
    get(channel: string) {
      if (!closed) reconcileSync()
      let value = snapshots.get(channel)
      if (!value) snapshots.set(channel, value = snapshot(channel))
      return value
    },
    async loadMain(channel: string): Promise<boolean> {
      if (sync.get().channels[channel]?.cursor === null) {
        await sync.getTimeline(channel).loadLatest()
        return sync.get().channels[channel]?.cursor !== null
      }
      const w = getWindow(channel), p = w.main
      const first = snapshot(channel).lines[0]
      if (p.asOfSeq !== undefined && first && !p.loading &&
        (first.kind === 'message' ? first.message.created_seq : first.position) > p.asOfSeq &&
        !(await reanchorMain(channel, w))) return false
      return (await loadMainPage(channel)).ok
    },
    async loadMainLatest(channel: string) {
      const w = getWindow(channel)
      if (!current(channel, w)) return
      options.initialTimeline?.discard(channel)
      const previous = w.main, next = paging()
      w.reads.delete('main'); w.main = next
      const result = await loadMainPage(channel, false, true)
      if (!result.ok && current(channel, w) && w.main === next) {
        w.main = { ...previous, loading: false, error: true }; notify(channel)
      }
      return result
    },
    releaseTopic(channel: string, topicId: string) {
      const w = windows.get(channel)
      if (!w) return
      if (w.activeTopic === topicId) { w.activeTopic = undefined; w.moveRefresh?.summaries.delete(topicId) }
      w.topics.get(topicId)?.messages.clear()
      if (!w.baselines.has(topicId)) clearSummaryRetry(w, topicId)
      w.reads.delete(`topic:${topicId}`); w.topics.delete(topicId); pruneActivity(w); notify(channel)
    },
    async loadTopicLatest(channel: string, topicId: string) {
      const w = getWindow(channel)
      if (!current(channel, w)) return
      return this.loadTopic(channel, topicId, true, true)
    },
    setMainPinned(channel: string, pinned: boolean) { const w = windows.get(channel); if (w) w.main.following = pinned },
    setTopicPinned(channel: string, topicId: string, pinned: boolean) {
      const t = windows.get(channel)?.topics.get(topicId); if (t) t.following = pinned
    },
    async bootstrap(channel: string): Promise<Result<MessagePage>> {
      const request = sync.get().channels[channel]?.latest
      let result: Result<TimelinePage>
      for (;;) {
        const w = getWindow(channel), generation = w.generation
        result = await loadMainPage(channel, true)
        if (sync.get().channels[channel]?.latest !== request) return { ok: false, kind: 'network' }
        // An invalidated nonempty snapshot still needs a fresh bootstrap.
        if (!result.ok && current(channel, w) && w.generation !== generation) continue
        break
      }
      if (!result.ok) return result
      // Bootstrap carries the trusted event watermark independently of visible Messages.
      if (sync.get().channels[channel]?.latest !== request) return { ok: false, kind: 'network' }
      const last = result.data.items.at(-1)
      const message = last?.kind === 'message' ? last.message : last?.topic.latest_message
      return { ok: true, data: { history_generation: result.data.history_generation, as_of_seq: result.data.as_of_seq, messages: message ? [message] : [], has_more: false } }
    },
    async loadList(channel: string, restarted = false): Promise<void> {
      const w = getWindow(channel), p = w.list
      if (!current(channel, w) || p.loading || !p.hasMore) return
      const page = Symbol('list-page')
      w.listPage = page
      p.loading = true; p.error = false; notify(channel)
      const { result, isCurrent, startedAt } = await readList(channel, w, () => options.api.listTopics(channel,
        p.asOfSeq === undefined ? { history_generation: sync.get().historyGeneration } : { history_generation: sync.get().historyGeneration, as_of_seq: p.asOfSeq, before_position: p.before }))
      if (w.listPage !== page || w.list !== p) return
      w.listPage = undefined; p.loading = false
      if (!isCurrent()) { notify(channel); return }
      p.error = !result.ok
      if (!result.ok && result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
        for (const id of w.listTopics) if (!w.mainTopics.has(id) && !w.topics.has(id)) w.baselines.delete(id)
        w.listTopics.clear(); w.list = paging()
        return this.loadList(channel, true)
      }
      if (result.ok) {
        mergeBaselines(w, result.data, startedAt, true)
        trimMain(w, 'older')
        p.asOfSeq = result.data.as_of_seq; p.before = result.data.topics[0]?.last_seq; p.hasMore = result.data.has_more
        withSync(channel, () => { void sync.settleHistory(channel, result.data.topics.map(t => t.latest_message)) })
      }
      notify(channel)
    },
    loadSummary,
    ensureSummary,
    retrySummary,
    async loadTopic(channel: string, topicId: string, latest = false, restarted = false): Promise<void> {
      const w = getWindow(channel)
      if (!current(channel, w)) return
      for (const [id, other] of windows) if (other !== w && other.topics.size) {
        for (const [topic, value] of other.topics) { value.messages.clear(); other.reads.delete(`topic:${topic}`) }
        other.topics.clear(); other.activeTopic = undefined; pruneActivity(other); notify(id)
      }
      if (w.activeTopic !== topicId) {
        const previousTopic = w.activeTopic
        w.activeTopic = topicId
        if (previousTopic !== undefined) controller.releaseTopic(channel, previousTopic)
      }
      let t = w.topics.get(topicId)
      if (!t) {
        for (const [id, old] of w.topics) { old.messages.clear(); w.reads.delete(`topic:${id}`); w.topics.delete(id) }
        pruneActivity(w)
        w.topics.set(topicId, t = topicWindow())
        for (const m of sync.get().channels[channel]?.messages ?? []) if (m.topic_id === topicId) { const state = canonical(channel, t.messages.get(m.created_seq), m); if (state) t.messages.set(m.created_seq, state) }
        trimMessages(t.messages, topicLimit)
      }
      if (!current(channel, w) || (!latest && (t.loading || !t.hasMore))) return
      const older = t.initialized && !latest
      t.loading = true; t.error = false; t.notFound = false; notify(channel)
      const { result, isCurrent } = await read(channel, w, `topic:${topicId}`, () => options.api.listTopicMessages(channel, topicId,
        latest || t.before === undefined ? { history_generation: sync.get().historyGeneration } : { history_generation: sync.get().historyGeneration, as_of_seq: t.asOfSeq, before_seq: t.before }))
      if (!isCurrent() || w.topics.get(topicId) !== t) return
      t.loading = false
      if (!result.ok && result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
        t.messages.clear(); t.asOfSeq = undefined; t.before = undefined; t.initialized = false; t.hasMore = true
        const state = sync.get().channels[channel]
        for (const m of state?.messages ?? []) if (m.topic_id === topicId && m.version >= state!.mutationSeq) t.messages.set(m.created_seq, m)
        return this.loadTopic(channel, topicId, true, true)
      }
      const missing = !result.ok && result.kind === 'http' && result.status === 404 && result.error === 'topic_not_found'
      t.notFound = missing
      t.error = !result.ok && !missing
      if (result.ok) {
        t.asOfSeq = result.data.as_of_seq
        if (latest) t.messages.clear()
        if (!older) { t.hasNewer = false; t.following = true; t.newerCount = 0; t.through = undefined }
        t.initialized = true
        t.through = Math.max(t.through ?? 0, result.data.messages.at(-1)?.created_seq ?? 0)
        for (const m of result.data.messages) { const state = canonical(channel, t.messages.get(m.created_seq), m); if (state) t.messages.set(m.created_seq, state) }
        if (!older) {
          const suffix = (sync.get().channels[channel]?.messages ?? []).filter(m => m.topic_id === topicId && m.created_seq > (t!.through ?? 0))
          if (w.evidence.floor > (t.through ?? 0) || countSequencesAfter(w.evidence.sequences.get(topicId) ?? [], t.through ?? 0) > suffix.length) t.hasNewer = true
          else for (const m of suffix) { const state = canonical(channel, t.messages.get(m.created_seq), m); if (state) t.messages.set(m.created_seq, state) }
        }
        t.before = result.data.messages[0]?.created_seq; t.hasMore = result.data.has_more
        trimTopic(t, older ? 'older' : 'newer')
        if (t.hasNewer) t.through = Math.max(0, ...t.messages.keys())
        withSync(channel, () => { void sync.settleHistory(channel, result.data.messages) })
      }
      notify(channel)
    },
    replaceSession() { clearActivity(); sessionToken++; cancelReads(); windows.clear(); notify() },
    close() {
      closed = true; clearActivity(); unsubscribe(); cancelReads(); windows.clear()
      notify(); listeners.clear(); channelListeners.clear(); summaryListeners.clear()
    },
  }
  return controller
}
export type Topics = ReturnType<typeof createTopics>
