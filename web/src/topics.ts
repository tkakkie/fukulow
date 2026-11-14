import { createActivityTarget, type Activity } from './activity'
import * as api from './api'
import type { ListTimelineQuery, ListTopicsQuery, Message, MessagePage, Result, TimelinePage,
  TopicHistoryQuery, TopicPage, TopicSummaryResponse } from './api'
import { backoffCap } from './reconnect'
import type { createSync } from './sync'
import { selectMainTimeline, selectTopicMessages, type TopicBaseline, type TopicSummaryError } from './topic-selectors'

type Sync = ReturnType<typeof createSync>
export type TopicsApi = {
  listTimeline(channel: string, query?: ListTimelineQuery): Promise<Result<TimelinePage>>
  listTopics(channel: string, query?: ListTopicsQuery): Promise<Result<TopicPage>>
  getTopicSummary(channel: string, topic: string): Promise<Result<TopicSummaryResponse>>
  listTopicMessages(channel: string, topic: string, query?: TopicHistoryQuery): Promise<Result<MessagePage>>
}
export const topicsApi = (organizationId: string): TopicsApi => ({
  listTimeline: (c, q) => api.listTimeline(organizationId, c, q),
  listTopics: (c, q) => api.listTopics(organizationId, c, q),
  getTopicSummary: (c, t) => api.getTopicSummary(organizationId, c, t),
  listTopicMessages: (c, t, q) => api.listTopicMessages(organizationId, c, t, q),
})
const MAX_SUMMARY_RETRIES = 4
type Paging = { asOfSeq?: number; before?: number; hasMore: boolean; loading: boolean; error: boolean }
type TopicWindow = { messages: Map<number, Message>; before?: number; through?: number; initialized: boolean; hasMore: boolean; loading: boolean; error: boolean; notFound: boolean }
type SummaryRetry = { attempt: number; timer?: ReturnType<typeof setTimeout>; terminal?: TopicSummaryError }
const isRetryableSummaryFailure = <T>(r: Exclude<Result<T>, { ok: true }>) =>
  r.kind === 'network' || (r.kind === 'http' && r.status >= 500)
const paging = (): Paging => ({ hasMore: true, loading: false, error: false })
const topicWindow = (): TopicWindow => ({ messages: new Map(), initialized: false, hasMore: true, loading: false, error: false, notFound: false })
const window = (generation: number) => ({ generation, main: paging(), list: paging(), messages: new Map<number, Message>(),
  mainTopics: new Set<string>(), baselines: new Map<string, TopicBaseline>(), topics: new Map<string, TopicWindow>(),
  summaries: new Set<string>(), summaryRetries: new Map<string, SummaryRetry>(), reads: new Map<ReadSlot, symbol>(), unavailable: false })
type Window = ReturnType<typeof window>
type ReadSlot = 'main' | 'list' | `summary:${string}` | `topic:${string}`

/** Session-owned projection windows around the existing unfiltered sync controller. No protocol state is copied. */
// Compose only via createTopicSync, or call replaceSession/close on topics before sync with a test.
export function createTopics(sync: Sync, options: { api: TopicsApi; onSessionEnded?: () => void; requestTimeoutMs?: number; activity?: Activity }) {
  const windows = new Map<string, Window>()
  const activityTargets = new Map<string, { close(): void; release(): void; target: ReturnType<typeof createActivityTarget> }>()
  const listeners = new Set<(channels: ReadonlySet<string>) => void>()
  const channelListeners = new Map<string, Set<() => void>>()
  const pendingChannels = new Set<string>()
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>()
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
    w.summaries.clear()
    w.main.loading = false
    w.list.loading = false
    for (const t of w.topics.values()) t.loading = false
  }
  const cancelReads = () => {
    for (const w of windows.values()) clearWindowTimers(w)
    deadlines.forEach((resolve, timer) => { clearTimeout(timer); resolve() })
    deadlines.clear()
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
  const reconcileSync = (syncChanged?: ReadonlySet<string>) => {
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
        if (
          !after ||
          (before?.watched && !after.watched) ||
          (!before?.watched && after.watched && w.unavailable) ||
          (before?.cursor != null && after.cursor === null)
        ) {
          clearWindowTimers(w)
          clearActivity(id); windows.delete(id)
        } else if ((before?.state === 'unavailable' || w.unavailable) && after.state !== 'unavailable') {
          clearWindowTimers(w)
          w.unavailable = false
          w.generation = nextGeneration++
        } else if (!next.running || next.organization === 'unavailable' || after.state === 'unavailable') {
          freezeWindow(w)
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
    if (!w) windows.set(channel, w = window(nextGeneration++))
    return w
  }
  const unsubscribe = sync.subscribe(changedChannels => {
    reconcileSync(changedChannels)
    if (!batching) notify([])
  })
  const current = (channel: string, w: Window) => {
    if (!closed) reconcileSync()
    const s = sync.get()
    return !closed && s.running &&
      s.organization === 'available' && windows.get(channel) === w && !w.unavailable &&
      s.channels[channel]?.watched === true && s.channels[channel]?.state !== 'unavailable'
  }

  async function read<T>(channel: string, w: Window, slot: ReadSlot, run: () => Promise<Result<T>>, bootstrap = false) {
    const token = Symbol(slot)
    w.reads.set(slot, token)
    const isCurrent = () => current(channel, w) && w.reads.get(slot) === token
    let timer: ReturnType<typeof setTimeout> | undefined
    // Session replacement fences late authentication failures; same-session late 401 remains authoritative.
    const session = sessionToken
    const operation = Promise.resolve().then(run).catch((): Result<T> => ({ ok: false, kind: 'network' }))
    void operation.then(r => {
      if (!r.ok && r.kind === 'http' && r.status === 401 && session === sessionToken) {
        void sync.close(); options.onSessionEnded?.()
      } else if (api.isOrganizationUnavailable(r) && session === sessionToken) void sync.unavailable()
    })
    try {
      const result = await Promise.race([operation, new Promise<Result<T>>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
        deadlines.set(timer, () => resolve({ ok: false, kind: 'network' }))
      })])
      // Bootstrap denials belong to sync's history request; C10 must never become a C9 denial.
      if (!bootstrap && !api.isOrganizationUnavailable(result) && isCurrent() && !result.ok && result.kind === 'http' &&
        [403, 404].includes(result.status) && result.error !== 'topic_not_found') {
        // C9: refuse sends and resubscription until explicit user selection.
        w.unavailable = true
        freezeWindow(w)
        withSync(channel, () => { void sync.channelUnavailable(channel) })
        windows.set(channel, w)
        notify(channel)
      }
      return { result, isCurrent }
    } finally {
      if (timer !== undefined) { clearTimeout(timer); deadlines.delete(timer) }
    }
  }
  function mergeBaselines(w: Window, response: Pick<TopicPage, 'as_of_seq' | 'topics'>) {
    for (const summary of response.topics) {
      holdSummary(w, summary.id)
      clearSummaryRetry(w, summary.id)
      const old = w.baselines.get(summary.id)
      if (!old || response.as_of_seq > old.asOfSeq || (response.as_of_seq === old.asOfSeq && (summary.read_seq > old.summary.read_seq || (summary.read_seq === old.summary.read_seq && summary.unread_count < old.summary.unread_count)))) w.baselines.set(summary.id, { asOfSeq: response.as_of_seq, summary })
    }
  }
  function holdSummary(w: Window, topic: string) {
    const channel = [...windows].find(([, value]) => value === w)?.[0]
    if (!channel || !options.activity) return
    const key = `topic:${channel}:${topic}`
    const existing = activityTargets.get(key)
    if (existing) return existing.target
    const target = createActivityTarget({
      load: () => options.api.getTopicSummary(channel, topic),
      hide: () => { w.reads.delete(`summary:${topic}`) },
      accept: response => {
        if (!current(channel, w)) return
        mergeBaselines(w, { as_of_seq: response.as_of_seq, topics: [response.topic] })
        notify(channel)
      },
      error: r => {
        if (r.kind === 'http' && r.status === 401) options.onSessionEnded?.()
        else if (api.isOrganizationUnavailable(r)) void sync.unavailable()
        else if (r.kind === 'http' && (r.status === 403 || (r.status === 404 && r.error !== 'topic_not_found'))) void sync.channelUnavailable(channel)
        else { w.summaryRetries.set(topic, { attempt: 0, terminal: r.kind === 'network' || r.status === 429 || r.status >= 500 ? 'retryable' : 'non_retryable' }); notify(channel) }
      },
      terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || r.status === 403 || r.status === 404),
      timeoutMs: options.requestTimeoutMs,
    })
    activityTargets.set(key, { close: target.close, release: options.activity.hold(key, target), target })
    return target
  }
  function holdMain(w: Window) {
    const channel = [...windows].find(([, value]) => value === w)?.[0]
    if (!channel || !options.activity) return
    const key = `main:${channel}`
    const existing = activityTargets.get(key)
    if (existing) return existing.target
    const target = createActivityTarget({
      load: () => options.api.listTopics(channel),
      hide: () => { w.reads.delete('list') },
      accept: response => { if (current(channel, w)) { mergeBaselines(w, response); notify(channel) } },
      error: r => { if (r.kind === 'http' && r.status === 401) options.onSessionEnded?.(); else if (api.isOrganizationUnavailable(r)) void sync.unavailable(); else if (r.kind === 'http' && (r.status === 403 || (r.status === 404 && r.error !== 'topic_not_found'))) void sync.channelUnavailable(channel) },
      terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || r.status === 403 || r.status === 404),
      timeoutMs: options.requestTimeoutMs,
    })
    activityTargets.set(key, { close: target.close, release: options.activity.hold(key, target), target })
    return target
  }
  function clearActivity(channel?: string) {
    for (const [key, target] of activityTargets) if (channel === undefined || key.startsWith(`topic:${channel}:`) || key === `main:${channel}`) { target.close(); target.release(); activityTargets.delete(key) }
  }
  function applyMain(w: Window, page: TimelinePage) {
    for (const item of page.items) {
      if (item.kind === 'message') w.messages.set(item.message.seq, item.message)
      else {
        w.mainTopics.add(item.topic.id)
        mergeBaselines(w, { as_of_seq: page.as_of_seq, topics: [item.topic] })
      }
    }
    holdMain(w)
    w.main.asOfSeq = page.as_of_seq
    w.main.before = page.items[0] && (page.items[0].kind === 'message' ? page.items[0].message.seq : page.items[0].topic.last_seq)
    w.main.hasMore = page.has_more
  }

  async function loadMainPage(channel: string, bootstrap = false): Promise<Result<TimelinePage>> {
    if (bootstrap) {
      const w = getWindow(channel)
      w.main = paging(); w.messages.clear(); w.mainTopics.clear()
    }
    const w = getWindow(channel), p = w.main
    if (!current(channel, w) || p.loading || !p.hasMore) return { ok: false, kind: 'network' }
    p.loading = true; p.error = false; notify(channel)
    const query: ListTimelineQuery = p.asOfSeq === undefined ? {} : { as_of_seq: p.asOfSeq, before_position: p.before }
    const { result, isCurrent } = await read(channel, w, 'main', () => options.api.listTimeline(channel, query), bootstrap)
    if (isCurrent() && w.main === p) {
      p.loading = false; p.error = !result.ok
      if (result.ok) {
        applyMain(w, result.data)
        withSync(channel, () => { void sync.settleHistory(channel, result.data.items.map(i => i.kind === 'message' ? i.message : i.topic.latest_message)) })
      }
      notify(channel)
    }
    return isCurrent() ? result : { ok: false, kind: 'network' }
  }
  function snapshot(channel: string) {
    const w = closed ? window(0) : getWindow(channel)
    const syncState = closed ? undefined : sync.get()
    const c = syncState?.channels[channel]
    const messages = c?.messages ?? []
    const summaryErrorFor = (topicId: string): TopicSummaryError | null =>
      w.baselines.has(topicId) || w.topics.get(topicId)?.notFound
        ? null
        : (w.summaryRetries.get(topicId)?.terminal ?? null)
    const merged = selectMainTimeline(messages, w.messages.values(), w.baselines.values())
    for (const item of merged) {
      if (item.kind === 'topic' && item.baseline === null) item.summaryError = summaryErrorFor(item.topicId)
    }
    // List/summary baselines supply counts, while main pages and sync records supply main membership.
    const visibleTopics = new Set([...w.mainTopics, ...messages.flatMap(m => m.topic_id ? [m.topic_id] : [])])
    const lines = merged.filter(l => l.kind === 'message' || visibleTopics.has(l.topicId))
    const topicSnapshots = new Map<string, ReturnType<typeof topic>>()
    function topic(topicId: string) {
      const t = w.topics.get(topicId)
      return { messages: selectTopicMessages(topicId, messages, t?.messages.values() ?? []),
        before: t?.before, through: t?.through,
        initialized: t?.initialized ?? false,
        loading: t?.loading ?? false, hasMore: t?.hasMore ?? true, error: t?.error ?? false,
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
  async function fetchSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const pendingRetry = w.summaryRetries.get(topicId)
    if (pendingRetry?.timer !== undefined) {
      clearTimeout(pendingRetry.timer)
      pendingRetry.timer = undefined
    }
    w.summaries.add(topicId)
    const { result, isCurrent } = await read(channel, w, `summary:${topicId}`, () => options.api.getTopicSummary(channel, topicId))
    if (!isCurrent()) return
    w.summaries.delete(topicId)
    if (result.ok) {
      const existing = w.topics.get(topicId)
      if (existing) existing.notFound = false
      mergeBaselines(w, { as_of_seq: result.data.as_of_seq, topics: [result.data.topic] })
      withSync(channel, () => { void sync.settleHistory(channel, [result.data.topic.latest_message]) })
      notify(channel)
    } else if (result.kind === 'http' && result.status === 404 && result.error === 'topic_not_found') {
      clearSummaryRetry(w, topicId)
      let t = w.topics.get(topicId)
      if (!t) w.topics.set(topicId, t = topicWindow())
      if (!t.notFound) {
        t.notFound = true
        notify(channel)
      }
    }
    return result
  }
  async function loadSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w)) await holdSummary(w, topicId)?.refresh(); return }
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const hadTerminal = w.summaryRetries.get(topicId)?.terminal !== undefined
    clearSummaryRetry(w, topicId)
    const pending = fetchSummary(channel, topicId)
    if (hadTerminal) notify(channel)
    const result = await pending
    if (
      result &&
      !result.ok &&
      current(channel, w) &&
      !w.baselines.has(topicId) &&
      !w.topics.get(topicId)?.notFound &&
      !w.summaries.has(topicId)
    ) {
      w.summaryRetries.set(topicId, {
        attempt: MAX_SUMMARY_RETRIES,
        terminal: isRetryableSummaryFailure(result) ? 'retryable' : 'non_retryable',
      })
      notify(channel)
    }
    return result
  }
  async function ensureSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w) && !w.baselines.has(topicId)) await holdSummary(w, topicId)?.ensure(); return }
    const existingRetry = w.summaryRetries.get(topicId)
    if (
      !current(channel, w) ||
      w.baselines.has(topicId) ||
      w.topics.get(topicId)?.notFound ||
      w.summaries.has(topicId) ||
      existingRetry?.timer !== undefined ||
      existingRetry?.terminal !== undefined
    ) {
      return
    }
    const result = await fetchSummary(channel, topicId)
    if (!result) return
    const latestRetry = w.summaryRetries.get(topicId)
    if (
      !current(channel, w) ||
      w.baselines.has(topicId) ||
      w.topics.get(topicId)?.notFound ||
      w.summaries.has(topicId) ||
      latestRetry?.timer !== undefined ||
      latestRetry?.terminal !== undefined
    ) {
      return
    }
    const attempt = latestRetry?.attempt ?? 0
    if (result.ok || !isRetryableSummaryFailure(result)) {
      w.summaryRetries.set(topicId, { attempt, terminal: 'non_retryable' })
      notify(channel)
      return
    }
    if (attempt >= MAX_SUMMARY_RETRIES) {
      w.summaryRetries.set(topicId, { attempt, terminal: 'retryable' })
      notify(channel)
      return
    }
    const timer = setTimeout(() => {
      const entry = w.summaryRetries.get(topicId)
      if (entry) entry.timer = undefined
      void ensureSummary(channel, topicId)
    }, backoffCap(attempt))
    w.summaryRetries.set(topicId, { attempt: attempt + 1, timer })
  }
  async function retrySummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w)) await holdSummary(w, topicId)?.retryNow(); return }
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
  return {
    subscribe,
    activityAccess(channel: string) {
      const w = windows.get(channel)
      if (!w) return
      w.generation = nextGeneration++; w.reads.clear(); w.baselines.clear(); clearWindowTimers(w)
      for (const [key, entry] of activityTargets) if (key.startsWith(`topic:${channel}:`) || key === `main:${channel}`) entry.target.invalidate('access')
      notify(channel)
    },
    async activitySummary(channel: string, topic: string, minimumPosition = 0): Promise<Result<TopicSummaryResponse>> {
      const w = getWindow(channel)
      if (!current(channel, w)) return { ok: false, kind: 'network' }
      const target = holdSummary(w, topic)
      const cached = w.baselines.get(topic)
      if (cached && cached.summary.read_seq >= minimumPosition) return { ok: true, data: { as_of_seq: cached.asOfSeq, topic: cached.summary } }
      if (cached) { target?.invalidate(); await target?.refresh() } else await target?.ensure()
      const failed = target?.failure()
      if (failed) return failed
      const baseline = w.baselines.get(topic)
      return baseline && current(channel, w) ? { ok: true, data: { as_of_seq: baseline.asOfSeq, topic: baseline.summary } } : { ok: false, kind: 'network' }
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
      return (await loadMainPage(channel)).ok
    },
    async bootstrap(channel: string): Promise<Result<MessagePage>> {
      const request = sync.get().channels[channel]?.latest
      const result = await loadMainPage(channel, true)
      if (!result.ok) return result
      // Every Channel position is currently a Message creation (S1). The final line contains the real
      // Message at W, including when it is a Topic summary. Only bootstrap passes this trusted base
      // to sync; all later projection responses remain outside its window and contiguity evidence.
      if (sync.get().channels[channel]?.latest !== request) return { ok: false, kind: 'network' }
      const last = result.data.items.at(-1)
      const base = last?.kind === 'message' ? last.message : last?.topic.latest_message
      if ((base?.seq ?? 0) !== result.data.as_of_seq) return { ok: false, kind: 'network' }
      return { ok: true, data: { messages: base ? [base] : [], has_more: false } }
    },
    async loadList(channel: string) {
      const w = getWindow(channel), p = w.list
      if (!current(channel, w) || p.loading || !p.hasMore) return
      p.loading = true; p.error = false; notify(channel)
      const { result, isCurrent } = await read(channel, w, 'list', () => options.api.listTopics(channel,
        p.asOfSeq === undefined ? {} : { as_of_seq: p.asOfSeq, before_position: p.before }))
      if (!isCurrent()) return
      p.loading = false; p.error = !result.ok
      if (result.ok) {
        mergeBaselines(w, result.data)
        p.asOfSeq = result.data.as_of_seq; p.before = result.data.topics[0]?.last_seq; p.hasMore = result.data.has_more
        withSync(channel, () => { void sync.settleHistory(channel, result.data.topics.map(t => t.latest_message)) })
      }
      notify(channel)
    },
    loadSummary,
    ensureSummary,
    retrySummary,
    async loadTopic(channel: string, topicId: string) {
      const w = getWindow(channel)
      let t = w.topics.get(topicId)
      if (!t) w.topics.set(topicId, t = topicWindow())
      if (!current(channel, w) || t.loading || !t.hasMore) return
      t.loading = true; t.error = false; t.notFound = false; notify(channel)
      const { result, isCurrent } = await read(channel, w, `topic:${topicId}`, () => options.api.listTopicMessages(channel, topicId,
        t.before === undefined ? {} : { before_seq: t.before }))
      if (!isCurrent()) return
      t.loading = false
      const missing = !result.ok && result.kind === 'http' && result.status === 404 && result.error === 'topic_not_found'
      t.notFound = missing
      t.error = !result.ok && !missing
      if (result.ok) {
        t.initialized = true
        t.through = Math.max(t.through ?? 0, result.data.messages.at(-1)?.seq ?? 0)
        for (const m of result.data.messages) t.messages.set(m.seq, m)
        t.before = result.data.messages[0]?.seq; t.hasMore = result.data.has_more
        withSync(channel, () => { void sync.settleHistory(channel, result.data.messages) })
      }
      notify(channel)
    },
    replaceSession() { clearActivity(); sessionToken++; cancelReads(); windows.clear(); notify() },
    close() {
      closed = true; clearActivity(); unsubscribe(); cancelReads(); windows.clear()
      notify(); listeners.clear(); channelListeners.clear()
    },
  }
}
export type Topics = ReturnType<typeof createTopics>
