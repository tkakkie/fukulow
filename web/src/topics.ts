import * as api from './api'
import type { ListTimelineQuery, ListTopicsQuery, Message, MessagePage, Result, TimelinePage,
  TopicHistoryQuery, TopicPage, TopicSummaryResponse } from './api'
import type { createSync } from './sync'
import { selectMainTimeline, selectTopicMessages, type TopicBaseline } from './topic-selectors'

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
type Paging = { asOfSeq?: number; before?: number; hasMore: boolean; loading: boolean; error: boolean }
type TopicWindow = { messages: Map<number, Message>; before?: number; hasMore: boolean; loading: boolean; error: boolean }
const paging = (): Paging => ({ hasMore: true, loading: false, error: false })
const window = () => ({ main: paging(), list: paging(), messages: new Map<number, Message>(),
  mainTopics: new Set<string>(), baselines: new Map<string, TopicBaseline>(), topics: new Map<string, TopicWindow>(),
  summaries: new Set<string>(), reads: new Map<ReadSlot, symbol>(), unavailable: false })
type Window = ReturnType<typeof window>
type ReadSlot = 'main' | 'list' | `summary:${string}` | `topic:${string}`

/** Session-owned projection windows around the existing unfiltered sync controller. No protocol state is copied. */
export function createTopics(sync: Sync, options: { api: TopicsApi; onSessionEnded?: () => void; requestTimeoutMs?: number }) {
  const windows = new Map<string, Window>()
  const listeners = new Set<() => void>()
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  let closed = false
  let sessionToken = 0
  const cancelReads = () => {
    deadlines.forEach((resolve, timer) => { clearTimeout(timer); resolve() })
    deadlines.clear()
  }
  let previous = sync.get()
  const notify = () => { snapshots.clear(); listeners.forEach(l => l()) }
  const getWindow = (channel: string) => {
    let w = windows.get(channel)
    if (!w) windows.set(channel, w = window())
    return w
  }
  const unsubscribe = sync.subscribe(() => {
    const next = sync.get()
    for (const [id] of windows) {
      const before = previous.channels[id], after = next.channels[id]
      if (!next.running || !after || after.state === 'unavailable' ||
        before?.state === 'unavailable' ||
        (before?.watched && !after.watched) || (!before?.watched && after.watched && windows.get(id)?.unavailable) ||
        (before?.cursor != null && after.cursor === null)) windows.delete(id)
    }
    if (!next.running) cancelReads()
    previous = next
    notify()
  })
  const current = (channel: string, w: Window) => !closed && sync.get().running &&
    sync.get().organization === 'available' && windows.get(channel) === w && !w.unavailable &&
    sync.get().channels[channel]?.watched === true

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
        void sync.channelUnavailable(channel)
        w.unavailable = true
        windows.set(channel, w)
        w.main.loading = w.list.loading = false
        notify()
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
  function applyMain(w: Window, page: TimelinePage) {
    for (const item of page.items) {
      if (item.kind === 'message') w.messages.set(item.message.seq, item.message)
      else {
        w.mainTopics.add(item.topic.id)
        mergeBaselines(w, { as_of_seq: page.as_of_seq, topics: [item.topic] })
      }
    }
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
    p.loading = true; p.error = false; notify()
    const query: ListTimelineQuery = p.asOfSeq === undefined ? {} : { as_of_seq: p.asOfSeq, before_position: p.before }
    const { result, isCurrent } = await read(channel, w, 'main', () => options.api.listTimeline(channel, query), bootstrap)
    if (isCurrent() && w.main === p) {
      p.loading = false; p.error = !result.ok
      if (result.ok) {
        applyMain(w, result.data)
        void sync.settleHistory(channel, result.data.items.map(i => i.kind === 'message' ? i.message : i.topic.latest_message))
      }
      notify()
    }
    return isCurrent() ? result : { ok: false, kind: 'network' }
  }
  function snapshot(channel: string) {
    const w = closed ? window() : getWindow(channel)
    const c = closed ? undefined : sync.get().channels[channel]
    const messages = c?.messages ?? []
    const merged = selectMainTimeline(messages, w.messages.values(), w.baselines.values())
    // List/summary baselines supply counts, while main pages and sync records supply main membership.
    const visibleTopics = new Set([...w.mainTopics, ...messages.flatMap(m => m.topic_id ? [m.topic_id] : [])])
    const lines = merged.filter(l => l.kind === 'message' || visibleTopics.has(l.topicId))
    const topicSnapshots = new Map<string, ReturnType<typeof topic>>()
    function topic(topicId: string) {
      const t = w.topics.get(topicId)
      return { messages: selectTopicMessages(topicId, messages, t?.messages.values() ?? []),
        loading: t?.loading ?? false, hasMore: t?.hasMore ?? true, error: t?.error ?? false }
    }
    return { lines, topics: merged.filter(l => l.kind === 'topic'),
      main: { ...w.main }, list: { ...w.list }, unavailable: w.unavailable || c?.state === 'unavailable',
      topic(topicId: string) {
        let value = topicSnapshots.get(topicId)
        if (!value) topicSnapshots.set(topicId, value = topic(topicId))
        return value
      } }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    get(channel: string) {
      let value = snapshots.get(channel)
      if (!value) snapshots.set(channel, value = snapshot(channel))
      return value
    },
    async loadMain(channel: string) {
      if (sync.get().channels[channel]?.cursor === null) await sync.getTimeline(channel).loadLatest()
      else await loadMainPage(channel)
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
      p.loading = true; p.error = false; notify()
      const { result, isCurrent } = await read(channel, w, 'list', () => options.api.listTopics(channel,
        p.asOfSeq === undefined ? {} : { as_of_seq: p.asOfSeq, before_position: p.before }))
      if (!isCurrent()) return
      p.loading = false; p.error = !result.ok
      if (result.ok) {
        mergeBaselines(w, result.data)
        void sync.settleHistory(channel, result.data.topics.map(t => t.latest_message))
        p.asOfSeq = result.data.as_of_seq; p.before = result.data.topics[0]?.last_seq; p.hasMore = result.data.has_more
      }
      notify()
    },
    async loadSummary(channel: string, topicId: string) {
      const w = getWindow(channel)
      if (!current(channel, w) || w.summaries.has(topicId)) return
      w.summaries.add(topicId)
      const { result, isCurrent } = await read(channel, w, `summary:${topicId}`, () => options.api.getTopicSummary(channel, topicId))
      if (!isCurrent()) return
      w.summaries.delete(topicId)
      if (result.ok) {
        mergeBaselines(w, { as_of_seq: result.data.as_of_seq, topics: [result.data.topic] })
        void sync.settleHistory(channel, [result.data.topic.latest_message])
      }
      notify()
      return result
    },
    async loadTopic(channel: string, topicId: string) {
      const w = getWindow(channel)
      let t = w.topics.get(topicId)
      if (!t) w.topics.set(topicId, t = { messages: new Map(), hasMore: true, loading: false, error: false })
      if (!current(channel, w) || t.loading || !t.hasMore) return
      t.loading = true; t.error = false; notify()
      const { result, isCurrent } = await read(channel, w, `topic:${topicId}`, () => options.api.listTopicMessages(channel, topicId,
        t.before === undefined ? {} : { before_seq: t.before }))
      if (!isCurrent()) return
      t.loading = false; t.error = !result.ok
      if (result.ok) {
        for (const m of result.data.messages) t.messages.set(m.seq, m)
        void sync.settleHistory(channel, result.data.messages)
        t.before = result.data.messages[0]?.seq; t.hasMore = result.data.has_more
      }
      notify()
    },
    replaceSession() { sessionToken++; windows.clear(); cancelReads(); notify() },
    close() {
      closed = true; unsubscribe(); windows.clear()
      cancelReads(); notify(); listeners.clear()
    },
  }
}
export type Topics = ReturnType<typeof createTopics>
