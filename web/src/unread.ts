import * as api from './api'
import type { ChannelList, MarkReadRequest, Message, ReadPosition, Result, TopicSummaryResponse, UnreadChannel } from './api'
import type { createSync } from './sync'
import type { Topics } from './topics'
import type { TopicBaseline } from './topic-selectors'
import { backoffCap } from './reconnect'
import { chooseBaseline, chooseChannelBaseline, coveredThrough, inScope, mainBaseline, recordCoverage,
  scopeCount, sequenceToSubmit, topicBaseline, type Coverage, type ScopeBaseline, type UnreadScope } from './unread-counts'
export type { UnreadScope } from './unread-counts'

type Sync = ReturnType<typeof createSync>
export type UnreadApi = {
  listChannels(): Promise<Result<ChannelList>>
  markRead(scope: UnreadScope, body: MarkReadRequest): Promise<Result<ReadPosition>>
  getTopicSummary(channel: string, topic: string): Promise<Result<TopicSummaryResponse>>
}
export const unreadApi = (org: string): UnreadApi => ({
  listChannels: () => api.listChannels(org),
  markRead: (s, body) => s.topicId === null ? api.markChannelRead(org, s.channel, body) : api.markTopicRead(org, s.channel, s.topicId, body),
  getTopicSummary: (c, t) => api.getTopicSummary(org, c, t),
})
type Scope = { baseline?: ScopeBaseline; position: number; requiredPosition: number; stopped: boolean; error: boolean;
  operation?: symbol; intent?: MarkReadRequest; queued?: MarkReadRequest; timer?: ReturnType<typeof setTimeout>; attempt: number }
const scopeState = (): Scope => ({ position: 0, requiredPosition: 0, stopped: false, error: false, attempt: 0 })
const channelState = () => ({ token: Symbol(), main: scopeState(), topics: new Map<string, Scope>(),
  records: new Map<number, Message>(), aggregate: undefined as UnreadChannel | undefined, accepted: 0, requiredAfter: 0, requiredBase: 0,
  heldPositions: new Map<string, number>(), stopped: false, error: false,
  summaryReads: new Set<string>(), queuedSummaries: new Set<string>(), ignoredBaselines: new Set<TopicBaseline>(), observedBaselines: new Set<TopicBaseline>(),
  summaryTimers: new Map<string, ReturnType<typeof setTimeout>>(), summaryAttempts: new Map<string, number>() })
type Channel = ReturnType<typeof channelState>
type Visit = { id: symbol; scope: UnreadScope; boundary: number | null; unreadAtEntry: number | null; presented: Set<number> }
type Deadline = { channel?: string; cancel(): void }

/** Session/Organization-owned CRUD controller. The sync protocol supplies records and lifecycle only. */
export function createUnread(sync: Sync, options: { api: UnreadApi; topics?: Topics; onSessionEnded?: () => void; requestTimeoutMs?: number }) {
  const channels = new Map<string, Channel>()
  const listeners = new Set<() => void>()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  const deadlines = new Map<ReturnType<typeof setTimeout>, Deadline>()
  let previous = sync.get(), closed = false, session = 0, epoch = 0, issue = 0
  let list: symbol | undefined, queuedList = false, listTimer: ReturnType<typeof setTimeout> | undefined, listAttempt = 0
  let visit: Visit | undefined, visible = false
  const notify = () => { snapshots.clear(); listeners.forEach(l => l()) }
  const getChannel = (id: string) => {
    let c = channels.get(id)
    if (!c) channels.set(id, c = channelState())
    return c
  }
  const getScope = (c: Channel, topic: string | null) => {
    if (topic === null) return c.main
    let s = c.topics.get(topic)
    if (!s) c.topics.set(topic, s = scopeState())
    return s
  }
  const active = () => !closed && sync.get().running && sync.get().organization === 'available'
  const watched = (id: string) => active() && sync.get().channels[id]?.watched === true && sync.get().channels[id]?.state !== 'unavailable' && !getChannel(id).stopped
  const stopScope = (s: Scope) => {
    if (s.timer !== undefined) clearTimeout(s.timer)
    s.timer = undefined; s.operation = undefined; s.intent = undefined; s.queued = undefined
  }
  const cancelDeadlines = (channel?: string) => {
    for (const [timer, d] of deadlines) if (channel === undefined || d.channel === channel) {
      clearTimeout(timer); deadlines.delete(timer); d.cancel()
    }
  }
  const fence = (id: string, c: Channel) => {
    c.token = Symbol(); stopScope(c.main); c.topics.forEach(stopScope); c.summaryReads.clear(); c.queuedSummaries.clear(); cancelDeadlines(id)
    c.summaryTimers.forEach(clearTimeout); c.summaryTimers.clear()
    if (visit?.scope.channel === id) visit = undefined
  }
  const cancelList = () => {
    list = undefined; queuedList = false
    if (listTimer !== undefined) clearTimeout(listTimer)
    listTimer = undefined
  }
  function reset() {
    epoch++; cancelList(); channels.forEach((c, id) => fence(id, c)); channels.clear(); cancelDeadlines(); visit = undefined; notify()
  }
  async function request<T>(run: () => Promise<Result<T>>, channel?: string): Promise<Result<T>> {
    const account = session
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = Promise.resolve().then(run).catch((): Result<T> => ({ ok: false, kind: 'network' }))
    // Authentication failures outlive data authority; the old Organization's sync alone receives C10.
    void operation.then(r => {
      if (account !== session) return
      if (!r.ok && r.kind === 'http' && r.status === 401) { void sync.close(); options.onSessionEnded?.() }
      else if (api.isOrganizationUnavailable(r)) void sync.unavailable()
    })
    try {
      return await Promise.race([operation, new Promise<Result<T>>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
        deadlines.set(timer, { channel, cancel: () => resolve({ ok: false, kind: 'network' }) })
      })])
    } finally { if (timer !== undefined) { clearTimeout(timer); deadlines.delete(timer) } }
  }
  const retryDelay = (attempt: number, r: Result<unknown>) => Math.max(backoffCap(attempt), !r.ok && r.kind === 'network' ? r.retryAfterMs ?? 0 : 0)
  const retryable = (r: Result<unknown>) => !r.ok && (r.kind === 'network' || r.status >= 500)
  function acceptScope(s: Scope, b: ScopeBaseline) {
    s.baseline = chooseBaseline(s.baseline, b)
    // Positions learned remotely are used only together with their winning fresh count baseline.
    s.position = Math.max(s.position, s.baseline.readSeq)
    s.error = s.baseline.readSeq < s.requiredPosition
  }
  async function refresh(retryTokens?: Map<string, symbol>) {
    if (!active()) return
    // Before discovery there are no Channel generations to scope a list retry to.
    const discovering = channels.size === 0
    const eligible = (id: string, c: Channel) => !c.stopped && (!retryTokens || retryTokens.get(id) === c.token)
    if (retryTokens && !discovering && ![...channels].some(([id, c]) => eligible(id, c))) return
    if (list) { queuedList = true; return }
    if (listTimer !== undefined) { clearTimeout(listTimer); listTimer = undefined }
    const token = Symbol(), generation = epoch, number = ++issue
    list = token
    const tokens = new Map([...channels].filter(([id, c]) => eligible(id, c)).map(([id, c]) => [id, c.token]))
    const r = await request(() => options.api.listChannels())
    if (!active() || generation !== epoch || list !== token) return
    list = undefined
    if (r.ok) {
      listAttempt = 0
      for (const row of r.data.channels) {
        if (retryTokens && !discovering && !tokens.has(row.id)) continue
        const existing = channels.get(row.id)
        if (existing && tokens.get(row.id) !== existing.token) continue
        const c = getChannel(row.id)
        if (c.stopped || sync.get().channels[row.id]?.state === 'unavailable') continue
        c.error = false
        acceptScope(c.main, mainBaseline(row))
        if (number > c.accepted && number >= c.requiredAfter && (!c.aggregate || row.as_of_seq >= c.aggregate.as_of_seq)) {
          c.aggregate = chooseChannelBaseline(c.aggregate, row); c.accepted = number
          c.requiredAfter = 0; c.heldPositions.clear()
        }
      }
      resolveBoundary(); notify()
    } else if (!api.isOrganizationUnavailable(r)) {
      const affected = new Map([...tokens].filter(([id, token]) => {
        const c = channels.get(id)
        return c && !c.stopped && c.token === token
      }))
      affected.forEach((_, id) => { getChannel(id).error = true })
      notify()
      if (retryable(r) && (discovering || affected.size > 0)) listTimer = setTimeout(() => { listTimer = undefined; void refresh(affected) }, retryDelay(listAttempt++, r))
    }
    if (queuedList) { queuedList = false; void refresh() }
  }
  function count(id: string, c: Channel, topic: string | null): number | null {
    const s = getScope(c, topic)
    if (!s.baseline || s.baseline.asOfSeq < c.requiredBase || s.baseline.readSeq < s.requiredPosition || s.error || s.stopped || c.stopped || c.error) return null
    return scopeCount(s.baseline, s.position, c.records.values(), { channel: id, topicId: topic }, sync.get().selfId)
  }
  function aggregateCount(id: string, c: Channel): number | null {
    const b = c.aggregate, main = count(id, c, null)
    if (!b || b.as_of_seq < c.requiredBase || main === null) return null
    let topicPart = b.unread_count - b.main_unread_count
    for (const m of c.records.values()) if (m.topic_id !== null && m.sender !== sync.get().selfId && m.seq > b.as_of_seq &&
      m.seq > (c.heldPositions.get(m.topic_id) ?? c.topics.get(m.topic_id)?.position ?? 0)) topicPart++
    return main + topicPart
  }
  function coverage(scope: UnreadScope): Coverage[] {
    const state = sync.get().channels[scope.channel]
    const ranges = recordCoverage(state?.messages ?? [])
    const p = options.topics?.get(scope.channel)
    if (!p || p.unavailable) return ranges
    if (scope.topicId === null && p.main.asOfSeq !== undefined) ranges.push({
      after: p.main.hasMore ? (p.main.before ?? Infinity) - 1 : 0, through: p.main.asOfSeq })
    if (scope.topicId !== null) {
      const t = p.topic(scope.topicId)
      if (t.initialized) ranges.push({ after: t.hasMore ? (t.before ?? Infinity) - 1 : 0, through: t.through ?? 0 })
    }
    return ranges
  }
  function resolveBoundary() {
    if (!visit || visit.boundary !== null) return
    const c = getChannel(visit.scope.channel), s = getScope(c, visit.scope.topicId)
    const unread = count(visit.scope.channel, c, visit.scope.topicId)
    if (unread === null) return
    visit.boundary = s.position; visit.unreadAtEntry = unread
  }
  const isVisit = (v: Visit) => visit === v && visible && watched(v.scope.channel)
  function enqueue(v: Visit) {
    if (!isVisit(v)) return
    const c = getChannel(v.scope.channel), s = getScope(c, v.scope.topicId)
    if (count(v.scope.channel, c, v.scope.topicId) === null) return
    const seq = sequenceToSubmit(s.position, c.records.values(), coverage(v.scope), v.presented, v.scope, sync.get().selfId)
    if (seq <= s.position || seq <= (s.intent?.read_seq ?? 0) || seq <= (s.queued?.read_seq ?? 0)) return
    s.queued = { read_seq: seq }
    if (!s.intent) void submit(v, c, s)
  }
  async function submit(v: Visit, c: Channel, s: Scope) {
    if (!isVisit(v) || s.stopped) return
    if (!s.intent) { s.intent = s.queued; s.queued = undefined }
    const intent = s.intent
    if (!intent) return
    const token = Symbol(), generation = c.token
    s.operation = token
    const r = await request(() => options.api.markRead(v.scope, intent), v.scope.channel)
    if (!isVisit(v) || c.token !== generation || s.operation !== token) return
    s.operation = undefined
    if (r.ok) {
      if (v.scope.topicId !== null) {
        if (!c.heldPositions.has(v.scope.topicId)) c.heldPositions.set(v.scope.topicId, s.position)
        c.requiredAfter = issue + 1
      }
      s.position = Math.max(s.position, r.data.read_seq); s.error = false; s.intent = undefined; s.attempt = 0
      if (r.data.read_seq > intent.read_seq) {
        s.requiredPosition = Math.max(s.requiredPosition, r.data.read_seq)
        s.error = true
        if (v.scope.topicId === null) void refresh()
        else void refreshTopic(v.scope.channel, v.scope.topicId)
      }
      if (s.queued && s.queued.read_seq <= s.position) s.queued = undefined
      if (v.scope.topicId !== null) void refresh()
      notify()
      if (s.queued) void submit(v, c, s)
    } else if (retryable(r)) {
      s.timer = setTimeout(() => { s.timer = undefined; void submit(v, c, s) }, retryDelay(s.attempt++, r))
    } else {
      stopScope(s); s.error = true; s.stopped = true
      if (!api.isOrganizationUnavailable(r) && r.kind === 'http' && r.status === 404 && r.error !== 'topic_not_found') {
        fence(v.scope.channel, c); c.stopped = true
      }
      notify()
    }
  }
  async function refreshTopic(id: string, topic: string) {
    const c = getChannel(id), s = getScope(c, topic), token = c.token
    if (!watched(id) || s.stopped) return
    if (c.summaryReads.has(topic)) { c.queuedSummaries.add(topic); return }
    const retry = c.summaryTimers.get(topic)
    if (retry !== undefined) { clearTimeout(retry); c.summaryTimers.delete(topic) }
    c.summaryReads.add(topic)
    const r = await request(() => options.api.getTopicSummary(id, topic), id)
    if (!watched(id) || c.token !== token) return
    c.summaryReads.delete(topic)
    if (r.ok && r.data.topic.id === topic) {
      acceptScope(s, topicBaseline(r.data.as_of_seq, r.data.topic))
      if (!s.error) c.summaryAttempts.delete(topic)
    } else {
      s.error = true
      if (!retryable(r)) {
        s.stopped = true
        if (!r.ok && !api.isOrganizationUnavailable(r) && r.kind === 'http' && r.status === 404 && r.error !== 'topic_not_found') {
          fence(id, c); c.stopped = true
        }
      }
    }
    if (s.error && !s.stopped && !c.queuedSummaries.has(topic)) {
      const attempt = c.summaryAttempts.get(topic) ?? 0
      c.summaryAttempts.set(topic, attempt + 1)
      c.summaryTimers.set(topic, setTimeout(() => { c.summaryTimers.delete(topic); void refreshTopic(id, topic) }, retryDelay(attempt, r)))
    }
    resolveBoundary(); notify()
    if (c.queuedSummaries.delete(topic)) void refreshTopic(id, topic)
  }
  function collect(id: string, c: Channel) {
    if (!watched(id)) return
    for (const m of sync.get().channels[id]?.messages ?? []) c.records.set(m.seq, m)
    const p = options.topics?.get(id)
    if (!p || p.unavailable) return
    for (const line of p.lines) {
      if (line.kind === 'message') c.records.set(line.message.seq, line.message)
    }
    for (const line of p.topics) {
      if (line.baseline && !c.ignoredBaselines.has(line.baseline) && !c.observedBaselines.has(line.baseline)) {
        c.observedBaselines.add(line.baseline)
        acceptScope(getScope(c, line.topicId), topicBaseline(line.baseline.asOfSeq, line.baseline.summary))
      }
    }
    for (const topic of c.topics.keys()) for (const m of p.topic(topic).messages) c.records.set(m.seq, m)
  }
  function reconcile() {
    if (closed) return
    const next = sync.get(), before = previous
    previous = next
    if (!next.running || next.organization !== 'available') { if (before.running) reset(); return }
    let rebootstrap = false
    for (const id of new Set([...channels.keys(), ...Object.keys(next.channels)])) {
      let c = getChannel(id)
      const old = before.channels[id], now = next.channels[id]
      if (now?.state === 'unavailable') {
        if (!c.stopped) { fence(id, c); c.stopped = true; c.records.clear(); c.aggregate = undefined; c.main = scopeState(); c.topics.clear() }
        continue
      }
      if (old?.watched && !now?.watched) { fence(id, c); c.records.clear(); c.heldPositions.clear() }
      const resetHistory = old?.cursor != null && now?.cursor === null
      const selected = now?.watched && (!old?.watched || old.state === 'unavailable')
      if (resetHistory || selected) {
        const oldBaselines = options.topics?.get(id).topics.flatMap(t => t.baseline ? [t.baseline] : []) ?? []
        const oldVisit = resetHistory && visit?.scope.channel === id ? visit : undefined
        fence(id, c); channels.set(id, c = channelState()); rebootstrap = true
        for (const b of oldBaselines) { c.ignoredBaselines.add(b); getScope(c, b.summary.id) }
        if (oldVisit) visit = { id: Symbol(), scope: oldVisit.scope, boundary: null, unreadAtEntry: null, presented: new Set() }
      }
      // Bootstrap omits history <= B from replay. A REST snapshot older than B cannot cover that prefix.
      if (now?.watched && old?.cursor == null && now.cursor !== null) {
        c.requiredBase = now.cursor; rebootstrap = true
      }
      collect(id, c)
    }
    resolveBoundary(); notify()
    if (channels.size > 0 && [...channels.values()].every(c => c.stopped)) { cancelList(); cancelDeadlines() }
    if ((!before.running && next.running) || (!before.connected && next.connected) || rebootstrap) {
      void refresh()
      for (const [id, c] of channels) if (watched(id)) for (const topic of c.topics.keys()) void refreshTopic(id, topic)
    }
  }
  const unsubscribe = sync.subscribe(reconcile)
  const unsubscribeTopics = options.topics?.subscribe(() => {
    if (!active()) return
    for (const [id, c] of channels) collect(id, c)
    resolveBoundary(); notify()
  })
  function snapshot(id: string) {
    const c = channels.get(id)
    const v = visit?.scope.channel === id ? visit : undefined
    let entry = null
    if (v) {
      const boundary = v.boundary
      const rows = [...(c?.records.values() ?? [])].filter(m => inScope(m, v.scope) && m.sender !== sync.get().selfId && boundary !== null && m.seq > boundary).sort((a, b) => a.seq - b.seq)
      const through = boundary === null ? 0 : coveredThrough(boundary, coverage(v.scope))
      entry = { id: v.id, scope: v.scope, boundary, unreadAtEntry: v.unreadAtEntry,
        firstUnread: rows.find(m => m.seq <= through) ?? null,
        needsOlder: v.unreadAtEntry !== null && v.unreadAtEntry > 0 && (rows.length === 0 || through < rows[0].seq) }
    }
    return { generation: c?.token ?? null, asOfSeq: c?.aggregate?.as_of_seq ?? null, unreadCount: c ? aggregateCount(id, c) : null, main: c ? scopeSnapshot(id, c, null) : { position: null, unreadCount: null, stopped: false, error: false },
      topics: Object.fromEntries(c ? [...c.topics.keys()].map(t => [t, scopeSnapshot(id, c, t)]) : []),
      entry, stopped: c?.stopped ?? false, error: c?.error ?? false }
  }
  function scopeSnapshot(id: string, c: Channel, topic: string | null) {
    const s = getScope(c, topic)
    return { position: s.baseline ? s.position : null, unreadCount: count(id, c, topic), stopped: s.stopped, error: s.error }
  }
  function leave(id?: symbol) {
    if (!visit || (id !== undefined && visit.id !== id)) return
    const c = getChannel(visit.scope.channel)
    fence(visit.scope.channel, c); notify()
    if (c.requiredAfter > 0 && !c.stopped) void refresh()
  }
  if (active()) { reconcile(); void refresh() }
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
    get(id: string) { let s = snapshots.get(id); if (!s) snapshots.set(id, s = snapshot(id)); return s },
    refresh: () => refresh(),
    async enter(scope: UnreadScope) {
      leave()
      if (!active() || !sync.get().channels[scope.channel]?.watched || sync.get().channels[scope.channel]?.state === 'unavailable') return
      let c = getChannel(scope.channel)
      if (c.stopped) { fence(scope.channel, c); channels.set(scope.channel, c = channelState()); void refresh() }
      const s = getScope(c, scope.topicId), wasStopped = s.stopped || s.error
      s.stopped = false; s.error = wasStopped
      visit = { id: Symbol(), scope: { ...scope }, boundary: null, unreadAtEntry: null, presented: new Set() }
      const id = visit.id
      collect(scope.channel, c); resolveBoundary(); notify()
      if (!s.baseline || wasStopped) {
        if (scope.topicId === null) void refresh()
        else void refreshTopic(scope.channel, scope.topicId)
      }
      return id
    },
    leave,
    visibility(value: boolean) {
      visible = value
      if (visit) {
        const c = getChannel(visit.scope.channel), s = getScope(c, visit.scope.topicId)
        if (!value) { stopScope(s); cancelDeadlines(visit.scope.channel) }
        // Returning to a visible document needs a fresh row presentation intent.
      }
      notify()
    },
    presented(id: symbol, seqs: number[]) {
      if (!visit || visit.id !== id || !isVisit(visit) || visit.boundary === null) return
      const c = getChannel(visit.scope.channel)
      for (const seq of seqs) { const m = c.records.get(seq); if (m && inScope(m, visit.scope)) visit.presented.add(seq) }
      enqueue(visit)
    },
    replaceSession() { session++; reset() },
    close() { closed = true; unsubscribe(); unsubscribeTopics?.(); reset(); listeners.clear() },
  }
}
export type Unread = ReturnType<typeof createUnread>
