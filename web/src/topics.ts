import * as api from './api'
import type { ListTimelineQuery, ListTopicsQuery, Message, MessagePage, Result, TimelinePage,
  TopicHistoryQuery, TopicPage, TopicSummaryResponse } from './api'
import { backoffCap } from './reconnect'
import type { createSync } from './sync'
import { selectMainTimeline, selectTopicMessages, type TopicBaseline, type TopicSummaryError } from './topic-selectors'
import { countSequencesAfter, rememberTopicMessages, trimMessages, topicEvidence, boundTopicEvidence } from './message-window'
import { MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT } from './protocol'

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
type Paging = { asOfSeq?: number; before?: number; through?: number; hasMore: boolean; hasNewer: boolean; following: boolean; newerCount: number; loading: boolean; error: boolean }
type TopicWindow = { messages: Map<number, Message>; before?: number; through?: number; initialized: boolean; hasMore: boolean; hasNewer: boolean; following: boolean; newerCount: number; loading: boolean; error: boolean; notFound: boolean }
type SummaryRetry = { attempt: number; timer?: ReturnType<typeof setTimeout>; terminal?: TopicSummaryError }
const isRetryableSummaryFailure = <T>(r: Exclude<Result<T>, { ok: true }>) =>
  r.kind === 'network' || (r.kind === 'http' && r.status >= 500)
const paging = (): Paging => ({ hasMore: true, hasNewer: false, following: true, newerCount: 0, loading: false, error: false })
const topicWindow = (): TopicWindow => ({ messages: new Map(), initialized: false, hasMore: true, hasNewer: false, following: true, newerCount: 0, loading: false, error: false, notFound: false })
const window = (generation: number) => ({ generation, main: paging(), list: paging(), messages: new Map<number, Message>(),
  mainTopics: new Set<string>(), mainPositions: new Map<string, number>(), baselines: new Map<string, TopicBaseline>(), topics: new Map<string, TopicWindow>(),
  evidence: topicEvidence(), evidenceRefresh: new Set<string>(),
  summaryThrough: new Map<string, number>(),
  summaries: new Set<string>(), summaryRetries: new Map<string, SummaryRetry>(), reads: new Map<ReadSlot, symbol>(), unavailable: false })
type Window = ReturnType<typeof window>
type ReadSlot = 'main' | 'list' | `summary:${string}` | `topic:${string}`

/** Session-owned projection windows around the existing unfiltered sync controller. No protocol state is copied. */
// Compose only via createTopicSync, or call replaceSession/close on topics before sync with a test.
export function createTopics(sync: Sync, options: { api: TopicsApi; onSessionEnded?: () => void; requestTimeoutMs?: number }) {
  const windows = new Map<string, Window>()
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
        if (
          !after ||
          (before?.watched && !after.watched) ||
          (!before?.watched && after.watched && w.unavailable) ||
          (before?.cursor != null && after.cursor === null)
        ) {
          clearWindowTimers(w)
          w.messages.clear(); w.baselines.clear(); w.reads.clear()
          for (const t of w.topics.values()) t.messages.clear()
          w.topics.clear()
          windows.delete(id)
        } else if ((before?.state === 'unavailable' || w.unavailable) && after.state !== 'unavailable') {
          clearWindowTimers(w)
          w.unavailable = false
          w.generation = nextGeneration++
        } else if (!next.running || next.organization === 'unavailable' || after.state === 'unavailable') {
          freezeWindow(w)
        } else if (before?.messages !== after.messages || records?.has(id)) {
          const incoming = records?.get(id) ?? after.messages
          rememberTopicMessages(w.evidence, incoming)
          if (!w.main.following && w.messages.size + w.baselines.size >= MAIN_MESSAGE_LIMIT) w.main.hasNewer = true
          for (const m of incoming) {
            const arrived = m.seq > (before?.cursor ?? Infinity) && !before?.messages.some(old => old.seq === m.seq)
            if (arrived && w.main.hasNewer) w.main.newerCount++
            if (m.seq > (w.main.asOfSeq ?? 0) && (!w.main.hasNewer || (m.topic_id && w.baselines.has(m.topic_id)))) w.messages.set(m.seq, m)
            for (const [topicId, t] of w.topics) if (m.topic_id === topicId) {
              if (!t.following && t.messages.size >= TOPIC_MESSAGE_LIMIT) t.hasNewer = true
              if (arrived && t.hasNewer) t.newerCount++
              if (!t.hasNewer) t.messages.set(m.seq, m)
            }
          }
          trimMain(w, w.main.hasNewer ? 'older' : 'newer')
          for (const t of w.topics.values()) {
            if (trimMessages(t.messages, TOPIC_MESSAGE_LIMIT)) {
              t.before = Math.min(...t.messages.keys()); t.hasMore = true
            }
          }
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
      windows.set(channel, w = window(nextGeneration++))
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
    return known > baseline.summary.latest_message.seq && w.messages.get(known)?.topic_id !== topicId &&
      known > (w.summaryThrough.get(topicId) ?? 0)
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
      const old = w.baselines.get(summary.id)
      if (!old || response.as_of_seq > old.asOfSeq) w.baselines.set(summary.id, { asOfSeq: response.as_of_seq, summary })
    }
  }
  async function ensureSummaryForWindow(w: Window, topicId: string) {
    if (w.evidenceRefresh.has(topicId)) return
    w.evidenceRefresh.add(topicId)
    try {
      await Promise.resolve()
      for (const [channel, value] of windows) if (value === w && current(channel, w)) await ensureSummary(channel, topicId)
    } finally { w.evidenceRefresh.delete(topicId) }
  }
  function trimMain(w: Window, edge: 'older' | 'newer') {
    const lines = selectMainTimeline([], w.messages.values(), w.baselines.values(), w.evidence)
    const liveTopics = new Set([...w.messages.values()].flatMap(m => m.topic_id ? [m.topic_id] : []))
    const kept = [...lines]
    const cost = (line: typeof lines[number]) => line.kind === 'message' ? 1 :
      Number(w.baselines.has(line.topicId)) + Number(liveTopics.has(line.topicId))
    let size = kept.reduce((sum, l) => sum + cost(l), 0)
    const trimmed = size > MAIN_MESSAGE_LIMIT
    while (size > MAIN_MESSAGE_LIMIT) size -= cost(edge === 'older' ? kept.pop()! : kept.shift()!)
    const ids = new Set(kept.filter(l => l.kind === 'topic').map(l => l.topicId))
    const seqs = new Set(kept.filter(l => l.kind === 'message').map(l => l.message.seq))
    for (const [seq, m] of w.messages) if (m.topic_id ? !ids.has(m.topic_id) : !seqs.has(seq)) w.messages.delete(seq)
    for (const id of w.baselines.keys()) if (!ids.has(id)) {
      w.baselines.delete(id); w.mainTopics.delete(id); w.mainPositions.delete(id); w.summaryThrough.delete(id)
      if (!w.topics.has(id)) { w.reads.delete(`summary:${id}`); w.summaries.delete(id); clearSummaryRetry(w, id) }
    }
    // Only the latest body of each Topic is needed; its count evidence has a separate lifetime.
    const latest = new Map<string, number>()
    for (const m of w.messages.values()) if (m.topic_id) latest.set(m.topic_id, Math.max(latest.get(m.topic_id) ?? 0, m.seq))
    for (const [seq, m] of w.messages) if (m.topic_id && seq !== latest.get(m.topic_id)) w.messages.delete(seq)
    if (trimmed) {
      // Auxiliary summaries do not prove that any main-page history was fetched.
      const covered = kept.filter(l => l.kind === 'message' || w.mainTopics.has(l.topicId) || liveTopics.has(l.topicId))
      const positions = covered.map(l => l.kind === 'message' ? l.message.seq : w.mainPositions.get(l.topicId) ?? l.position)
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
      if (total <= MAIN_MESSAGE_LIMIT) break
      if (other === w) continue
      total -= other.messages.size + other.baselines.size
      other.messages.clear(); other.baselines.clear(); other.mainTopics.clear(); other.mainPositions.clear()
      other.main = paging(); other.list = paging()
      other.summaryThrough.clear(); other.summaries.clear(); other.evidence = topicEvidence()
      for (const slot of other.reads.keys()) if (!slot.startsWith('topic:')) other.reads.delete(slot)
      clearWindowTimers(other)
      snapshots.delete(id); pendingChannels.add(id)
    }
  }
  function applyMain(w: Window, page: TimelinePage) {
    const older = w.main.asOfSeq !== undefined
    for (const item of page.items) {
      if (item.kind === 'message') w.messages.set(item.message.seq, item.message)
      else {
        w.mainTopics.add(item.topic.id)
        w.mainPositions.set(item.topic.id, item.topic.last_seq)
        mergeBaselines(w, { as_of_seq: page.as_of_seq, topics: [item.topic] })
      }
    }
    w.main.asOfSeq = page.as_of_seq
    w.main.through ??= page.as_of_seq
    w.main.before = page.items[0] && (page.items[0].kind === 'message' ? page.items[0].message.seq : page.items[0].topic.last_seq)
    w.main.hasMore = page.has_more
    trimMain(w, older ? 'older' : 'newer')
  }

  async function loadMainPage(channel: string, bootstrap = false, latest = false): Promise<Result<TimelinePage>> {
    if (bootstrap) {
      const w = getWindow(channel)
      w.main = paging(); w.messages.clear(); w.mainTopics.clear()
      for (const m of sync.get().channels[channel]?.messages ?? []) w.messages.set(m.seq, m)
      trimMain(w, 'newer')
    }
    const w = getWindow(channel), p = w.main
    if (!current(channel, w) || p.loading || !p.hasMore) return { ok: false, kind: 'network' }
    p.loading = true; p.error = false; notify(channel)
    const query: ListTimelineQuery = p.asOfSeq === undefined ? {} : { as_of_seq: p.asOfSeq, before_position: p.before }
    const { result, isCurrent } = await read(channel, w, 'main', () => options.api.listTimeline(channel, query), bootstrap)
    if (isCurrent() && w.main === p) {
      p.loading = false; p.error = !result.ok
      if (result.ok) {
        if (latest) {
          w.messages.clear(); w.mainTopics.clear(); w.baselines.clear(); w.mainPositions.clear(); w.list = paging()
          w.summaryThrough.clear()
        }
        applyMain(w, result.data)
        if (query.as_of_seq === undefined) {
          const messages = sync.get().channels[channel]?.messages ?? []
          rememberTopicMessages(w.evidence, messages)
          const cursor = sync.get().channels[channel]?.cursor ?? 0
          const suffix = messages.filter(m => m.seq > result.data.as_of_seq)
          const missing = cursor > result.data.as_of_seq && (suffix[0]?.seq ?? Infinity) > result.data.as_of_seq + 1
          if (missing) w.main.hasNewer = true
          else for (const m of suffix) w.messages.set(m.seq, m)
          trimMain(w, 'newer')
        }
        withSync(channel, () => { void sync.settleHistory(channel, result.data.items.map(i => i.kind === 'message' ? i.message : i.topic.latest_message)) })
      }
      notify(channel)
    }
    return isCurrent() ? result : { ok: false, kind: 'network' }
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
      p.before = Math.min(...lines.map(l => l.kind === 'message' ? l.message.seq : w.mainPositions.get(l.topicId) ?? l.position))
      p.hasMore = true
      withSync(channel, () => { void sync.settleHistory(channel, result.data.items.map(i => i.kind === 'message' ? i.message : i.topic.latest_message)) })
    }
    notify(channel)
    return result.ok
  }
  function snapshot(channel: string) {
    const w = closed ? window(0) : getWindow(channel)
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
  async function fetchSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const pendingRetry = w.summaryRetries.get(topicId)
    if (pendingRetry?.timer !== undefined) {
      clearTimeout(pendingRetry.timer)
      pendingRetry.timer = undefined
    }
    w.summaries.add(topicId)
    const through = w.evidence.sequences.get(topicId)?.at(-1)?.end ?? 0
    const { result, isCurrent } = await read(channel, w, `summary:${topicId}`, () => options.api.getTopicSummary(channel, topicId))
    if (!isCurrent()) return
    if (result.ok) {
      w.summaryThrough.set(topicId, through)
      const existing = w.topics.get(topicId)
      if (existing) existing.notFound = false
      mergeBaselines(w, { as_of_seq: result.data.as_of_seq, topics: [result.data.topic] })
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
        (first.kind === 'message' ? first.message.seq : first.position) > p.asOfSeq &&
        !(await reanchorMain(channel, w))) return false
      return (await loadMainPage(channel)).ok
    },
    async loadMainLatest(channel: string) {
      const w = getWindow(channel)
      if (!current(channel, w)) return
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
      w.topics.get(topicId)?.messages.clear()
      if (!w.baselines.has(topicId)) clearSummaryRetry(w, topicId)
      w.reads.delete(`topic:${topicId}`); w.topics.delete(topicId); notify(channel)
    },
    async loadTopicLatest(channel: string, topicId: string) {
      const w = getWindow(channel)
      if (!current(channel, w)) return
      return this.loadTopic(channel, topicId, true)
    },
    setMainPinned(channel: string, pinned: boolean) { const w = windows.get(channel); if (w) w.main.following = pinned },
    setTopicPinned(channel: string, topicId: string, pinned: boolean) {
      const t = windows.get(channel)?.topics.get(topicId); if (t) t.following = pinned
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
        trimMain(w, 'older')
        p.asOfSeq = result.data.as_of_seq; p.before = result.data.topics[0]?.last_seq; p.hasMore = result.data.has_more
        withSync(channel, () => { void sync.settleHistory(channel, result.data.topics.map(t => t.latest_message)) })
      }
      notify(channel)
    },
    loadSummary,
    ensureSummary,
    retrySummary,
    async loadTopic(channel: string, topicId: string, latest = false) {
      const w = getWindow(channel)
      if (!current(channel, w)) return
      for (const [id, other] of windows) if (other !== w && other.topics.size) {
        for (const [topic, value] of other.topics) { value.messages.clear(); other.reads.delete(`topic:${topic}`) }
        other.topics.clear(); notify(id)
      }
      let t = w.topics.get(topicId)
      if (!t) {
        for (const [id, old] of w.topics) { old.messages.clear(); w.reads.delete(`topic:${id}`); w.topics.delete(id) }
        w.topics.set(topicId, t = topicWindow())
        for (const m of sync.get().channels[channel]?.messages ?? []) if (m.topic_id === topicId) t.messages.set(m.seq, m)
        trimMessages(t.messages, TOPIC_MESSAGE_LIMIT)
      }
      if (!current(channel, w) || (!latest && (t.loading || !t.hasMore))) return
      const older = t.initialized && !latest
      t.loading = true; t.error = false; t.notFound = false; notify(channel)
      const { result, isCurrent } = await read(channel, w, `topic:${topicId}`, () => options.api.listTopicMessages(channel, topicId,
        latest || t.before === undefined ? {} : { before_seq: t.before }))
      if (!isCurrent() || w.topics.get(topicId) !== t) return
      t.loading = false
      const missing = !result.ok && result.kind === 'http' && result.status === 404 && result.error === 'topic_not_found'
      t.notFound = missing
      t.error = !result.ok && !missing
      if (result.ok) {
        if (latest) t.messages.clear()
        if (!older) { t.hasNewer = false; t.following = true; t.newerCount = 0; t.through = undefined }
        t.initialized = true
        t.through = Math.max(t.through ?? 0, result.data.messages.at(-1)?.seq ?? 0)
        for (const m of result.data.messages) t.messages.set(m.seq, m)
        if (!older) {
          const suffix = (sync.get().channels[channel]?.messages ?? []).filter(m => m.topic_id === topicId && m.seq > (t!.through ?? 0))
          if (w.evidence.floor > (t.through ?? 0) || countSequencesAfter(w.evidence.sequences.get(topicId) ?? [], t.through ?? 0) > suffix.length) t.hasNewer = true
          else for (const m of suffix) t.messages.set(m.seq, m)
        }
        t.before = result.data.messages[0]?.seq; t.hasMore = result.data.has_more
        if (trimMessages(t.messages, TOPIC_MESSAGE_LIMIT, older ? 'older' : 'newer')) {
          if (older) t.hasNewer = true
          else { t.hasMore = true; t.before = Math.min(...t.messages.keys()) }
        }
        if (t.hasNewer) t.through = Math.max(0, ...t.messages.keys())
        withSync(channel, () => { void sync.settleHistory(channel, result.data.messages) })
      }
      notify(channel)
    },
    replaceSession() { sessionToken++; cancelReads(); windows.clear(); notify() },
    close() {
      closed = true; unsubscribe(); cancelReads(); windows.clear()
      notify(); listeners.clear(); channelListeners.clear()
    },
  }
}
export type Topics = ReturnType<typeof createTopics>
