import * as api from './api'
import type { ChannelList, MarkReadRequest, Message, ReadPosition, Result, TopicSummaryResponse, UnreadChannel } from './api'
import type { createSync } from './sync'
import type { Topics } from './topics'
import type { TopicBaseline } from './topic-selectors'
import { MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT } from './protocol'
import { backoffCap } from './reconnect'
import { chooseBaseline, chooseChannelBaseline, coveredThrough, inScope, mainBaseline, recordCoverage,
  needsUnreadRecord, scopeCount, sequenceToSubmit, topicBaseline, type Coverage, type ScopeBaseline, type UnreadScope, type UnreadRecord } from './unread-counts'
export type { UnreadScope } from './unread-counts'

type Sync = ReturnType<typeof createSync>
export type UnreadApi = {
  listChannels(signal?: AbortSignal): Promise<Result<ChannelList>>
  markRead(scope: UnreadScope, body: MarkReadRequest): Promise<Result<ReadPosition>>
  getTopicSummary(channel: string, topic: string): Promise<Result<TopicSummaryResponse>>
}
export const unreadApi = (org: string): UnreadApi => ({
  listChannels: signal => api.listChannels(org, undefined, signal),
  markRead: (s, body) => s.topicId === null ? api.markChannelRead(org, s.channel, body) : api.markTopicRead(org, s.channel, s.topicId, body),
  getTopicSummary: (c, t) => api.getTopicSummary(org, c, t),
})
// At most the union of sync, main and the active Topic bodies, plus one visit marker.
export const UNREAD_RECORD_LIMIT = MAIN_MESSAGE_LIMIT * 2 + TOPIC_MESSAGE_LIMIT
type Scope = { baseline?: ScopeBaseline; position: number; requiredPosition: number; stopped: boolean; error: boolean;
  operation?: symbol; intent?: MarkReadRequest; queued?: MarkReadRequest; timer?: ReturnType<typeof setTimeout>; attempt: number }
const scopeState = (): Scope => ({ position: 0, requiredPosition: 0, stopped: false, error: false, attempt: 0 })
const channelState = () => ({ token: Symbol(), main: scopeState(), topics: new Map<string, Scope>(),
  records: new Map<number, UnreadRecord>(), lostThrough: 0, aggregate: undefined as UnreadChannel | undefined, accepted: 0, requiredAfter: 0, requiredAggregateAfter: 0, requiredBase: 0,
  heldPositions: new Map<string, number>(), stopped: false, error: false,
  summaryReads: new Map<string, symbol>(), queuedSummaries: new Set<string>(), ignoredBaselines: new WeakSet<TopicBaseline>(), observedBaselines: new WeakSet<TopicBaseline>(),
  summaryTimers: new Map<string, ReturnType<typeof setTimeout>>(), summaryAttempts: new Map<string, number>() })
type Channel = ReturnType<typeof channelState>
type Visit = { id: symbol; scope: UnreadScope; boundary: number | null; unreadAtEntry: number | null; presented: Set<number>; firstUnread?: UnreadRecord }
type Deadline = { channel?: string; cancel(): void }

/** Session/Organization-owned CRUD controller. The sync protocol supplies records and lifecycle only. */
export function createUnread(sync: Sync, options: { api: UnreadApi; topics?: Topics; onSessionEnded?: () => void; requestTimeoutMs?: number; refreshList?: () => Promise<void> }) {
  const channels = new Map<string, Channel>()
  const listeners = new Set<() => void>()
  const channelListeners = new Map<string, Set<() => void>>()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  const deadlines = new Map<ReturnType<typeof setTimeout>, Deadline>()
  let previous = sync.get(), closed = false, session = 0, epoch = 0, issue = 0
  let list: symbol | undefined, queuedList = false, listTimer: ReturnType<typeof setTimeout> | undefined, listAttempt = 0
  let visit: Visit | undefined, visible = false
  const notify = (changed?: string | Iterable<string>) => {
    if (changed === undefined) {
      snapshots.clear()
      for (const ls of channelListeners.values()) ls.forEach(l => l())
      listeners.forEach(l => l())
      return
    }
    const ids = typeof changed === 'string' ? new Set([changed]) : new Set(changed)
    if (ids.size === 0) return
    for (const id of ids) snapshots.delete(id)
    for (const id of ids) channelListeners.get(id)?.forEach(l => l())
    listeners.forEach(l => l())
  }
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
  function needed(c: Channel, m: UnreadRecord) {
    const s = m.topic_id === null ? c.main : c.topics.get(m.topic_id)
    // requiredBase/requiredAfter fence baseline authority, not record coverage.
    const aggregateAfter = m.topic_id === null ? Infinity : Math.max(c.aggregate?.as_of_seq ?? 0,
      c.heldPositions.get(m.topic_id) ?? s?.position ?? 0)
    const visitAfter = visit && inScope(m, visit.scope) ? visit.boundary ?? 0 : Infinity
    // Aggregate W/positions never retreat; a visit pins its boundary until it ends.
    // Only a replacement scope baseline can need rows below a previous pruning window.
    return needsUnreadRecord(m.seq, s?.baseline, aggregateAfter, visitAfter)
  }
  // Stream events only filter their input; rescan retained rows at baseline refreshes/visit changes.
  function prune(c: Channel) {
    for (const [seq, m] of c.records) if (!needed(c, m)) c.records.delete(seq)
  }
  function rememberFirstUnread(id: string, c: Channel) {
    if (!visit || visit.scope.channel !== id || visit.boundary === null || visit.firstUnread) return
    const through = coveredThrough(visit.boundary, coverage(visit.scope))
    for (const m of c.records.values()) if (inScope(m, visit.scope) && m.seq > visit.boundary && m.seq <= through &&
      (!visit.firstUnread || m.seq < visit.firstUnread.seq)) visit.firstUnread = m
  }
  function boundRecords(id: string, c: Channel) {
    rememberFirstUnread(id, c)
    if (c.records.size <= UNREAD_RECORD_LIMIT) return
    const p = options.topics?.get(id)
    const bodies = new Set((sync.get().channels[id]?.messages ?? []).map(m => m.seq))
    for (const line of p?.lines ?? []) if (line.kind === 'message') bodies.add(line.message.seq)
    for (const topic of c.topics.keys()) for (const m of p?.topic(topic).messages ?? []) bodies.add(m.seq)
    const target = Math.min(UNREAD_RECORD_LIMIT, Math.max(bodies.size, UNREAD_RECORD_LIMIT - MAIN_MESSAGE_LIMIT))
    // Keep current projection pages so a refetched older prefix can be presented safely.
    for (const [seq] of [...c.records].sort((a, b) => Number(bodies.has(a[0])) - Number(bodies.has(b[0])))) {
      if (c.records.size <= target) break
      c.records.delete(seq); c.lostThrough = Math.max(c.lostThrough, seq)
    }
    c.requiredBase = Math.max(c.requiredBase, c.lostThrough)
    if (visit?.scope.channel === id) for (const seq of visit.presented) if (!c.records.has(seq)) visit.presented.delete(seq)
    // A pending read (including its backoff) absorbs newer recovery requirements.
    // Its completion checks the latest requiredBase before scheduling another read.
    if (!list && listTimer === undefined && listNeedsRecovery(c)) void refresh()
    for (const [topic, s] of c.topics) if (needsRecovery(c, s) &&
      !c.summaryReads.has(topic) && !c.summaryTimers.has(topic)) void refreshTopic(id, topic)
  }
  function collectRecord(c: Channel, m: Message): boolean {
    if (m.sender === sync.get().selfId) return false
    const old = c.records.get(m.seq)
    if (!needed(c, m) || (old?.id === m.id && old.sender === m.sender && old.topic_id === m.topic_id)) return false
    const { id, seq, channel_id, topic_id, sender } = m
    c.records.set(m.seq, { id, seq, channel_id, topic_id, sender })
    return true
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
  const retryDelay = (attempt: number, r: Result<unknown>) => Math.max(backoffCap(attempt), !r.ok ? r.retryAfterMs ?? 0 : 0)
  const retryable = (r: Result<unknown>) => !r.ok && (r.kind === 'network' || r.status === 429 || r.status >= 500)
  function acceptScope(s: Scope, b: ScopeBaseline) {
    s.baseline = chooseBaseline(s.baseline, b)
    // Accepted baselines and successful mark-read responses supply persisted positions.
    s.position = Math.max(s.position, s.baseline.readSeq)
    // A newer W can carry an older readSeq, even when no Messages were observed.
    // Refetch through the persisted position rather than subtract a possibly missing prefix.
    if (s.position > s.baseline.readSeq) {
      s.requiredPosition = Math.max(s.requiredPosition, s.position)
    }
    s.error = s.baseline.readSeq < s.requiredPosition
  }
  async function refresh(retryTokens?: Map<string, symbol>) {
    if (!active()) return
    if (options.refreshList) return options.refreshList()
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
      const changed = new Set<string>()
      for (const row of r.data.channels) {
        if (retryTokens && !discovering && !tokens.has(row.id)) continue
        const existing = channels.get(row.id)
        if (existing && tokens.get(row.id) !== existing.token) continue
        const c = getChannel(row.id)
        if (c.stopped || sync.get().channels[row.id]?.state === 'unavailable') continue
        const prevError = c.error
        const prevMainBase = c.main.baseline, prevMainPos = c.main.position, prevMainErr = c.main.error
        const prevAgg = c.aggregate, prevHeld = c.heldPositions.size
        c.error = false
        acceptScope(c.main, mainBaseline(row))
        if (number > c.accepted && number >= c.requiredAfter && (!c.aggregate || row.as_of_seq >= c.aggregate.as_of_seq)) {
          c.aggregate = chooseChannelBaseline(c.aggregate, row); c.accepted = number
          c.requiredAfter = 0; c.heldPositions.clear()
        }
        prune(c)
        const aggChanged = prevAgg?.as_of_seq !== c.aggregate?.as_of_seq ||
          prevAgg?.read_seq !== c.aggregate?.read_seq ||
          prevAgg?.unread_count !== c.aggregate?.unread_count ||
          prevAgg?.main_unread_count !== c.aggregate?.main_unread_count
        if (
          !existing ||
          prevError !== c.error ||
          prevMainBase !== c.main.baseline ||
          prevMainPos !== c.main.position ||
          prevMainErr !== c.main.error ||
          aggChanged ||
          prevHeld !== c.heldPositions.size
        ) {
          changed.add(row.id)
        }
      }
      const unresolved = new Map([...channels].filter(([id, c]) => tokens.get(id) === c.token && !c.stopped &&
        listNeedsRecovery(c)))
      if (unresolved.size > 0) {
        const affected = new Map([...unresolved].map(([id, c]) => [id, c.token]))
        listTimer = setTimeout(() => { listTimer = undefined; void refresh(affected) }, retryDelay(listAttempt++, r))
      } else listAttempt = 0
      if (resolveBoundary() && visit) changed.add(visit.scope.channel)
      notify(changed)
    } else if (!api.isOrganizationUnavailable(r)) {
      const affected = new Map([...tokens].filter(([id, token]) => {
        const c = channels.get(id)
        return c && !c.stopped && c.token === token
      }))
      affected.forEach((_, id) => { getChannel(id).error = true })
      notify(affected.keys())
      if (retryable(r) && (discovering || affected.size > 0)) listTimer = setTimeout(() => { listTimer = undefined; void refresh(affected) }, retryDelay(listAttempt++, r))
    }
    if (queuedList) { queuedList = false; void refresh() }
  }
  const needsRecovery = (c: Channel, s: Scope) => s.error || (s.baseline !== undefined &&
    (s.baseline.asOfSeq < c.requiredBase || s.baseline.readSeq < s.requiredPosition))
  const listNeedsRecovery = (c: Channel) => needsRecovery(c, c.main) || (c.aggregate !== undefined && c.aggregate.as_of_seq < c.requiredBase)
  function count(id: string, c: Channel, topic: string | null, records: Iterable<UnreadRecord> = c.records.values()): number | null {
    const s = getScope(c, topic)
    if (!s.baseline || (s.position > s.baseline.readSeq && s.baseline.readSeq < c.lostThrough) || needsRecovery(c, s) || s.stopped || c.stopped || c.error) return null
    return scopeCount(s.baseline, s.position, records, { channel: id, topicId: topic }, sync.get().selfId)
  }
  function aggregateCount(id: string, c: Channel): number | null {
    const b = c.aggregate, main = count(id, c, null)
    if (!b || c.accepted < c.requiredAggregateAfter || b.as_of_seq < c.requiredBase || main === null) return null
    let topicPart = b.unread_count - b.main_unread_count
    for (const m of c.records.values()) if (m.topic_id !== null && m.sender !== sync.get().selfId && m.seq > b.as_of_seq &&
      m.seq > (c.heldPositions.get(m.topic_id) ?? c.topics.get(m.topic_id)?.position ?? 0)) topicPart++
    return main + topicPart
  }
  function coverage(scope: UnreadScope): Coverage[] {
    const state = sync.get().channels[scope.channel]
    const ranges = recordCoverage(state?.messages ?? [])
    if (state?.streamBase !== undefined && state.cursor !== null) ranges.push({ after: Math.max(state.streamBase, channels.get(scope.channel)?.lostThrough ?? 0), through: state.cursor })
    const p = options.topics?.get(scope.channel)
    if (!p || p.unavailable) return ranges
    if (scope.topicId === null && p.main.asOfSeq !== undefined) ranges.push({
      after: p.main.hasMore ? (p.main.before ?? Infinity) - 1 : 0, through: p.main.through ?? p.main.asOfSeq })
    if (scope.topicId !== null) {
      const t = p.topic(scope.topicId)
      if (t.initialized) ranges.push({ after: t.hasMore ? (t.before ?? Infinity) - 1 : 0, through: t.through ?? 0 })
    }
    return ranges
  }
  function resolveBoundary(): boolean {
    if (!visit || visit.boundary !== null) return false
    const c = getChannel(visit.scope.channel), s = getScope(c, visit.scope.topicId)
    const unread = count(visit.scope.channel, c, visit.scope.topicId)
    if (unread === null) return false
    visit.boundary = s.position; visit.unreadAtEntry = unread
    rememberFirstUnread(visit.scope.channel, c)
    prune(c)
    enqueue(visit)
    return true
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
      for (const seq of v.presented) if (seq <= s.position) v.presented.delete(seq)
      if (s.baseline && s.position > s.baseline.readSeq && s.baseline.readSeq < c.lostThrough) {
        s.requiredPosition = Math.max(s.requiredPosition, s.position); s.error = true
        if (v.scope.topicId === null) void refresh()
        else void refreshTopic(v.scope.channel, v.scope.topicId)
      }
      if (v.scope.topicId !== null) void refresh()
      notify(v.scope.channel)
      if (s.queued) void submit(v, c, s)
    } else if (retryable(r)) {
      s.timer = setTimeout(() => { s.timer = undefined; void submit(v, c, s) }, retryDelay(s.attempt++, r))
    } else {
      stopScope(s); s.error = true; s.stopped = true
      if (!api.isOrganizationUnavailable(r) && r.kind === 'http' && r.status === 404 && r.error !== 'topic_not_found') {
        fence(v.scope.channel, c); c.stopped = true
      }
      notify(v.scope.channel)
    }
  }
  async function refreshTopic(id: string, topic: string) {
    const c = getChannel(id), s = getScope(c, topic), token = c.token
    if (!watched(id) || s.stopped) return
    if (c.summaryReads.has(topic)) { c.queuedSummaries.add(topic); return }
    const retry = c.summaryTimers.get(topic)
    if (retry !== undefined) { clearTimeout(retry); c.summaryTimers.delete(topic) }
    const operation = Symbol()
    const recoveryPosition = s.error ? s.requiredPosition : undefined
    c.summaryReads.set(topic, operation)
    const r = await request(() => options.api.getTopicSummary(id, topic), id)
    if (!watched(id) || c.token !== token || c.summaryReads.get(topic) !== operation) return
    c.summaryReads.delete(topic)
    if (r.ok && r.data.topic.id === topic) {
      acceptScope(s, topicBaseline(r.data.as_of_seq, r.data.topic))
      if (s.baseline && s.baseline.asOfSeq < c.requiredBase) s.error = true
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
    // Pending recovery absorbs notifications; only a successful read made stale by
    // new requirements needs an immediate follow-up. Failures always use backoff.
    const queued = c.queuedSummaries.delete(topic)
    const rerun = queued && r.ok && (recoveryPosition === undefined || s.requiredPosition > recoveryPosition)
    if (s.error && !s.stopped && !rerun) {
      const attempt = c.summaryAttempts.get(topic) ?? 0
      c.summaryAttempts.set(topic, attempt + 1)
      c.summaryTimers.set(topic, setTimeout(() => { c.summaryTimers.delete(topic); void refreshTopic(id, topic) }, retryDelay(attempt, r)))
    }
    const changed = new Set([id])
    if (resolveBoundary() && visit) changed.add(visit.scope.channel)
    prune(c); notify(changed)
    if (rerun) void refreshTopic(id, topic)
  }
  function collect(id: string, c: Channel): boolean {
    if (!watched(id)) return false
    const p = options.topics?.get(id)
    let baselineChanged = false
    let recordAdded = false
    const observed: string[] = []
    // Merge first: filtering against the previous readSeq could discard rows the winner needs.
    for (const line of p && !p.unavailable ? p.topics : []) {
      if (line.baseline && !c.ignoredBaselines.has(line.baseline) && !c.observedBaselines.has(line.baseline)) {
        c.observedBaselines.add(line.baseline)
        const hadTopic = c.topics.has(line.topicId)
        const s = getScope(c, line.topicId)
        const previous = s.baseline, prevPos = s.position, prevErr = s.error, prevStop = s.stopped
        acceptScope(s, topicBaseline(line.baseline.asOfSeq, line.baseline.summary))
        baselineChanged ||= !hadTopic || s.baseline !== previous || s.position !== prevPos || s.error !== prevErr || s.stopped !== prevStop
        observed.push(line.topicId)
      }
    }
    for (const m of sync.get().channels[id]?.messages ?? []) if (collectRecord(c, m)) recordAdded = true
    if (p && !p.unavailable) {
      for (const line of p.lines) if (line.kind === 'message' && collectRecord(c, line.message)) recordAdded = true
      for (const topic of c.topics.keys()) for (const m of p.topic(topic).messages) if (collectRecord(c, m)) recordAdded = true
    }
    for (const topic of observed) {
      const s = getScope(c, topic)
      if (s.baseline && (s.baseline.asOfSeq < c.requiredBase || s.error)) {
        if (!c.summaryTimers.has(topic)) void refreshTopic(id, topic)
      } else if (!s.error && !s.stopped) {
        // A current projection supersedes summary work, including a completion still in flight.
        const retry = c.summaryTimers.get(topic)
        if (retry !== undefined) clearTimeout(retry)
        c.summaryTimers.delete(topic); c.summaryAttempts.delete(topic)
        c.summaryReads.delete(topic); c.queuedSummaries.delete(topic)
      }
    }
    if (baselineChanged) prune(c)
    boundRecords(id, c)
    if (c.topics.size > MAIN_MESSAGE_LIMIT) {
      const retained = new Set(p?.topics.map(t => t.topicId) ?? [])
      for (const [topic, scope] of [...c.topics].sort((a, b) => Number(retained.has(a[0])) - Number(retained.has(b[0])))) {
        if (c.topics.size <= MAIN_MESSAGE_LIMIT) break
        if (visit?.scope.channel === id && visit.scope.topicId === topic) continue
        stopScope(scope); c.topics.delete(topic); c.heldPositions.delete(topic)
        c.summaryReads.delete(topic); c.queuedSummaries.delete(topic)
        const timer = c.summaryTimers.get(topic)
        if (timer !== undefined) clearTimeout(timer)
        c.summaryTimers.delete(topic); c.summaryAttempts.delete(topic)
      }
      c.error = true; c.requiredAfter = issue + 1; c.requiredAggregateAfter = c.requiredAfter; void refresh()
    }
    return baselineChanged || recordAdded
  }
  function reconcile(syncChanged?: ReadonlySet<string>, records?: ReadonlyMap<string, Message[]>) {
    if (closed) return
    const next = sync.get(), before = previous
    previous = next
    if (!next.running || next.organization !== 'available') { if (before.running) reset(); return }
    let rebootstrap = false
    const changed = new Set<string>()
    const selfChanged = before.selfId !== next.selfId
    if (selfChanged) {
      for (const id of [...channels.keys(), ...snapshots.keys(), ...channelListeners.keys()]) changed.add(id)
    }
    const candidates = !selfChanged && before.running === next.running && syncChanged
      ? syncChanged
      : new Set([...channels.keys(), ...Object.keys(next.channels)])
    for (const id of candidates) {
      const existed = channels.has(id)
      const old = before.channels[id], now = next.channels[id]
      if (!selfChanged && old === now && existed) continue
      let c = getChannel(id)
      let channelChanged = !existed
      if (now?.state === 'unavailable') {
        if (!c.stopped) {
          fence(id, c); c.stopped = true; c.records.clear(); c.aggregate = undefined; c.main = scopeState(); c.topics.clear()
          channelChanged = true
        }
        if (channelChanged) changed.add(id)
        continue
      }
      if (old?.watched && !now?.watched) {
        fence(id, c); c.records.clear(); c.heldPositions.clear()
        channelChanged = true
      }
      const resetHistory = old?.cursor != null && now?.cursor === null
      const selected = now?.watched && (!old?.watched || old.state === 'unavailable')
      if (resetHistory || selected) {
        const oldBaselines = options.topics?.get(id).topics.flatMap(t => t.baseline ? [t.baseline] : []) ?? []
        const oldVisit = resetHistory && visit?.scope.channel === id ? visit : undefined
        fence(id, c); channels.set(id, c = channelState()); rebootstrap = true
        for (const b of oldBaselines) { c.ignoredBaselines.add(b); getScope(c, b.summary.id) }
        if (oldVisit) visit = { id: Symbol(), scope: oldVisit.scope, boundary: null, unreadAtEntry: null, presented: new Set() }
        channelChanged = true
      }
      // Bootstrap omits history <= B from replay. A REST snapshot older than B cannot cover that prefix.
      if (now?.watched && old?.cursor == null && now.cursor !== null) {
        c.requiredBase = now.cursor; rebootstrap = true
        channelChanged = true
      }
      for (const m of records?.get(id) ?? []) if (collectRecord(c, m)) channelChanged = true
      if (collect(id, c)) channelChanged = true
      if (visit?.scope.channel === id && old?.messages !== now?.messages) channelChanged = true
      if (channelChanged) changed.add(id)
    }
    if (resolveBoundary() && visit) changed.add(visit.scope.channel)
    notify(changed)
    if (channels.size > 0 && [...channels.values()].every(c => c.stopped)) { cancelList(); cancelDeadlines() }
    if ((!before.running && next.running) || (!before.connected && next.connected) || rebootstrap) {
      if (channels.size === 0 || [...channels.keys()].some(watched)) void refresh()
      for (const [id, c] of channels) if (watched(id)) for (const topic of c.topics.keys()) void refreshTopic(id, topic)
    }
  }
  const unsubscribe = sync.subscribe(reconcile)
  const unsubscribeTopics = options.topics?.subscribe(topicChannels => {
    if (!active()) return
    const changed = new Set<string>()
    const targets = topicChannels && topicChannels.size > 0 ? topicChannels : channels.keys()
    for (const id of targets) {
      const c = channels.get(id)
      if (!c) continue
      if (collect(id, c) || visit?.scope.channel === id) changed.add(id)
    }
    if (resolveBoundary() && visit) changed.add(visit.scope.channel)
    notify(changed)
  })
  function snapshot(id: string) {
    const c = channels.get(id)
    const topicRecords = new Map<string, UnreadRecord[]>()
    for (const m of c?.records.values() ?? []) if (m.topic_id !== null && c?.topics.has(m.topic_id)) {
      let records = topicRecords.get(m.topic_id)
      if (!records) topicRecords.set(m.topic_id, records = [])
      records.push(m)
    }
    const v = visit?.scope.channel === id ? visit : undefined
    let entry = null
    if (v) {
      const boundary = v.boundary
      const rows = [...(c?.records.values() ?? [])].filter(m => inScope(m, v.scope) && m.sender !== sync.get().selfId && boundary !== null && m.seq > boundary).sort((a, b) => a.seq - b.seq)
      const through = boundary === null ? 0 : coveredThrough(boundary, coverage(v.scope))
      entry = { id: v.id, scope: v.scope, boundary, unreadAtEntry: v.unreadAtEntry,
        firstUnread: v.firstUnread ?? rows.find(m => m.seq <= through) ?? null,
        needsOlder: !v.firstUnread && v.unreadAtEntry !== null && v.unreadAtEntry > 0 && (rows.length === 0 || through < rows[0].seq) }
    }
    return { generation: c?.token ?? null, asOfSeq: c?.aggregate?.as_of_seq ?? null, unreadCount: c ? aggregateCount(id, c) : null, main: c ? scopeSnapshot(id, c, null) : { position: null, unreadCount: null, stopped: false, error: false },
      topics: Object.fromEntries(c ? [...c.topics.keys()].map(t => [t, scopeSnapshot(id, c, t, topicRecords.get(t) ?? [])]) : []),
      entry, stopped: c?.stopped ?? false, error: c?.error ?? false }
  }
  function scopeSnapshot(id: string, c: Channel, topic: string | null, records?: Iterable<UnreadRecord>) {
    const s = getScope(c, topic)
    return { position: s.baseline ? s.position : null, unreadCount: count(id, c, topic, records), stopped: s.stopped, error: s.error }
  }
  function leave(id?: symbol) {
    if (!visit || (id !== undefined && visit.id !== id)) return
    const channel = visit.scope.channel, c = getChannel(channel)
    fence(channel, c); prune(c); notify(channel)
    if (!c.stopped) {
      // fence() drops in-flight and scheduled list retries for this Channel; restart any recovery they owned.
      if (c.error || c.requiredAfter > 0 || !c.main.baseline || listNeedsRecovery(c)) void refresh()
      for (const [topic, s] of c.topics) if (!s.stopped && needsRecovery(c, s) &&
        !c.summaryReads.has(topic) && !c.summaryTimers.has(topic)) void refreshTopic(channel, topic)
    }
  }
  function subscribe(listener: () => void, channel?: string): () => void {
    if (channel !== undefined) {
      let set = channelListeners.get(channel)
      if (!set) channelListeners.set(channel, set = new Set())
      set.add(listener)
      return () => {
        set?.delete(listener)
        if (set?.size === 0) channelListeners.delete(channel)
      }
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  if (active()) { reconcile(); void refresh() }
  return {
    subscribe,
    activityMainCoverage(id: string) { return channels.get(id)?.aggregate?.read_seq ?? -1 },
    activitySnapshot(rows: UnreadChannel[]) {
      if (!active()) return
      const ids = new Set(rows.map(r => r.id))
      for (const [id, c] of channels) if (!ids.has(id) && !watched(id)) { fence(id, c); channels.delete(id) }
      for (const row of rows) {
        const c = getChannel(row.id)
        if (c.stopped) continue
        acceptScope(c.main, mainBaseline(row))
        c.aggregate = chooseChannelBaseline(c.aggregate, row); c.error = false; c.heldPositions.clear(); prune(c)
      }
      resolveBoundary(); notify()
    },
    activityReconcile() {
      for (const [id, c] of channels) if (!watched(id)) { fence(id, c); channels.set(id, channelState()) }
      notify()
    },
    activityAccess(id: string) {
      const c = channels.get(id)
      if (c) fence(id, c)
      channels.set(id, channelState()); notify(id)
    },
    activityRevoke(id: string) {
      const c = channels.get(id)
      if (c) fence(id, c)
      channels.delete(id); notify(id)
    },
    activityRead(id: string, topic: string | null) {
      if (!watched(id)) return
      if (topic !== null && (channels.get(id)?.topics.has(topic))) void refreshTopic(id, topic)
    },
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
      collect(scope.channel, c); resolveBoundary(); notify(scope.channel)
      if (!s.baseline || s.baseline.asOfSeq < c.requiredBase || wasStopped) {
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
        if (!value) {
          stopScope(s); cancelDeadlines(visit.scope.channel)
          if (visit.boundary === null) visit.presented.clear()
        }
        // Returning to a visible document needs a fresh row presentation intent.
        notify(visit.scope.channel)
      }
    },
    presented(id: symbol, seqs: number[]) {
      if (!visit || visit.id !== id || !isVisit(visit)) return
      const c = getChannel(visit.scope.channel)
      for (const seq of seqs) { const m = c.records.get(seq); if (m && inScope(m, visit.scope)) visit.presented.add(seq) }
      while (visit.presented.size > UNREAD_RECORD_LIMIT) visit.presented.delete(visit.presented.values().next().value!)
      enqueue(visit)
    },
    replaceSession() { session++; reset() },
    close() { closed = true; unsubscribe(); unsubscribeTopics?.(); reset(); listeners.clear(); channelListeners.clear() },
  }
}
export type Unread = ReturnType<typeof createUnread>
