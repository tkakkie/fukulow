import { createReplyCountCore } from '#sync-core'
import * as api from './api'
import type { Message, ReplyCountPage, ReplyCountRequest, Result } from './api'
import type { CountCore, CountInput, CountTicket, CountView } from './reply-count-core'
import { backoffCap } from './reconnect'
import type { createSync } from './sync'
import type { Replies } from './replies'
import type { Topics } from './topics'

type Sync = ReturnType<typeof createSync>
export type ReplyCountsApi = (channel: string, body: ReplyCountRequest, signal: AbortSignal) => Promise<Result<ReplyCountPage>>
type Batch = { tickets: CountTicket[]; abort: AbortController; timeout: ReturnType<typeof setTimeout> }
type Channel = { core: CountCore; view: CountView; roots: Set<string>; tickets: Map<string, number>; batch?: Batch; retry?: ReturnType<typeof setTimeout>; attempt: number; stopped: boolean; expired: Set<string>; blocked: Set<string>; omissions: Map<string, number> }
const empty: Readonly<Record<string, number | null>> = Object.freeze({})

/** I/O only: Rust owns authority, deduplication, floors and per-root generations. */
export function createReplyCounts(sync: Sync, sources: { replies: Replies; topics?: Pick<Topics, 'countMessages' | 'subscribe'> }, options: {
  api: ReplyCountsApi; onSessionEnded?: () => void; requestTimeoutMs?: number; random?: () => number
}) {
  const channels = new Map<string, Channel>()
  const listeners = new Set<() => void>()
  let closed = false, session = 0, queued = false, dirty = false
  const notify = () => { if (dirty) { dirty = false; listeners.forEach(l => l()) } }
  const usable = (id: string) => {
    const s = sync.get(), c = s.channels[id]
    return !closed && s.running && s.organization === 'available' && c?.watched && c.state !== 'unavailable'
  }
  const update = (c: Channel, input: CountInput) => {
    const view = c.core.step(input), previous = c.view.counts
    if (Object.keys(previous).length === Object.keys(view.counts).length && Object.entries(view.counts).every(([id, count]) => previous[id] === count)) view.counts = previous
    else dirty = true
    c.view = view; c.tickets = new Map(view.tickets.map(t => [t.root, t.generation]))
  }
  const valid = (c: Channel, t: CountTicket) => c.tickets.get(t.root) === t.generation
  const cancel = (c: Channel) => {
    if (c.batch) { clearTimeout(c.batch.timeout); c.batch.abort.abort(); update(c, { type: 'failed', tickets: c.batch.tickets }); c.batch = undefined }
  }
  const drop = (id: string, c: Channel) => {
    cancel(c); if (c.retry !== undefined) clearTimeout(c.retry)
    c.core.free(); channels.delete(id); dirty = true
  }
  const recover = (c: Channel, fresh = true) => {
    cancel(c)
    // Authority changes immediately; retry deadlines and attempts survive recoverable transitions.
    c.stopped = false
    if (fresh) { c.expired.clear(); c.blocked.clear(); c.omissions.clear() }
    update(c, { type: 'reset' })
  }
  const defer = () => {
    if (queued || closed) return
    queued = true
    queueMicrotask(() => { queued = false; if (!closed) for (const [id, c] of channels) pump(id, c) })
  }
  const backoff = (c: Channel, delay = 0) => {
    if (c.retry !== undefined) return
    const ms = Math.max(delay, 1 + Math.floor((options.random ?? Math.random)() * backoffCap(c.attempt++)))
    // Browser timers clamp larger values to 1 ms; preserve long Retry-After without an early retry.
    const wait = (remaining: number) => {
      const part = Math.min(remaining, 2_147_483_647)
      c.retry = setTimeout(() => {
        if (remaining > part) wait(remaining - part)
        else { c.retry = undefined; defer() }
      }, part)
    }
    wait(ms)
  }
  function reconcile(changed?: ReadonlySet<string>) {
    const s = sync.get()
    for (const [id, c] of channels) if (!usable(id)) drop(id, c)
    for (const id of changed ?? Object.keys(s.channels)) {
      if (!usable(id)) continue
      const state = s.channels[id]
      const panel = sources.replies.get(id)
      const members: Iterable<Message>[] = [state.messages, ...sources.topics?.countMessages(id) ?? [], panel.messages, panel.anchor ? [panel.anchor] : []]
      const roots = new Set<string>(panel.rootId ? [panel.rootId] : [])
      for (const source of members) for (const m of source) roots.add(m.reply_root_id ?? m.id)
      let c = channels.get(id)
      if (!c) {
        const core = createReplyCountCore()
        channels.set(id, c = { core, view: core.step({ type: 'track', roots: [] }), roots: new Set(), tickets: new Map(), attempt: 0, stopped: false, expired: new Set(), blocked: new Set(), omissions: new Map() })
      }
      if (roots.size !== c.roots.size || [...roots].some(root => !c.roots.has(root))) {
        update(c, { type: 'track', roots: [...roots] })
        for (const root of c.roots) if (!roots.has(root)) { c.expired.delete(root); c.blocked.delete(root); c.omissions.delete(root) }
      }
      c.roots = roots
    }
    notify(); defer()
  }
  function pump(id: string, c: Channel) {
    const state = sync.get().channels[id]
    if (!usable(id) || channels.get(id) !== c || !sync.get().connected || state.cursor === null || !state.subscription?.confirmed || c.batch || c.retry !== undefined || c.stopped) return
    const needed = new Map(c.view.needed.map(t => [t.root, t]))
    const tickets = [...c.roots].flatMap(root => { const t = needed.get(root); return t && !c.blocked.has(root) ? [t] : [] }).slice(0, 100)
    if (!tickets.length) return
    update(c, { type: 'begin', tickets })
    const abort = new AbortController(), account = session, { historyGeneration } = sync.get()
    const batch: Batch = { tickets, abort, timeout: setTimeout(() => {
      if (c.batch !== batch) return
      cancel(c); backoff(c); notify()
    }, options.requestTimeoutMs ?? 30_000) }
    c.batch = batch
    const current = () => !closed && channels.get(id) === c && c.batch === batch && usable(id)
    void Promise.resolve().then(() => current() ? options.api(id, { ids: tickets.map(t => t.root), history_generation: historyGeneration }, abort.signal) : { ok: false, kind: 'network' } as const)
      .catch((): Result<ReplyCountPage> => ({ ok: false, kind: 'network' }))
      .then(result => {
        // C6: cancellation/timeout/unwatch does not hide a same-Account-Session late 401.
        if (account !== session) return
        if (!result.ok && result.kind === 'http' && result.status === 401) { void sync.close(); options.onSessionEnded?.(); return }
        if (!closed && api.isOrganizationUnavailable(result)) { void sync.unavailable(); return }
        if (!current()) return
        if (result.ok && !sync.observeHistoryGeneration(result.data.history_generation)) return
        if (!result.ok && result.kind === 'http' && result.status === 409 && result.error === 'history_generation_changed') { sync.observeHistoryGeneration(); return }
        clearTimeout(batch.timeout); c.batch = undefined
        update(c, { type: 'failed', tickets })
        if (result.ok) {
          const rows = new Map(result.data.counts.filter(row => row.root_id === row.message_id).map(row => [row.message_id, row]))
          for (const t of tickets) {
            if (!valid(c, t)) continue
            const row = rows.get(t.root)
            if (row) {
              update(c, { type: 'install', ticket: t, watermark: result.data.as_of_seq, count: row.reply_count })
              if (c.view.counts[t.root] !== null) c.expired.delete(t.root)
              c.omissions.delete(t.root)
            } else {
              const misses = (c.omissions.get(t.root) ?? 0) + 1
              c.omissions.set(t.root, misses)
              if (misses >= 2) c.blocked.add(t.root)
            }
          }
          // Omitted anchors remain unresolved; an insufficient W never gains authority.
          if (tickets.some(t => !c.blocked.has(t.root) && valid(c, t) && c.view.counts[t.root] === null)) backoff(c)
          else c.attempt = 0
        } else if (result.kind === 'http' && result.status === 409 && result.error === 'snapshot_expired') {
          for (const t of tickets) {
            if (!valid(c, t)) continue
            if (c.expired.has(t.root)) c.blocked.add(t.root)
            c.expired.add(t.root)
          }
          recover(c, false)
        } else if (result.kind === 'http' && [403, 404].includes(result.status)) {
          void sync.channelUnavailable(id)
        } else if (result.kind === 'network' || (result.kind === 'http' && (result.status >= 500 || result.status === 429))) backoff(c, result.retryAfterMs)
        else c.stopped = true
        notify(); defer()
      })
  }
  const stopSync = sync.onInput((input, result, before) => {
    if (input.type === 'session_replaced' || input.type === 'session_start') {
      session++; for (const [id, c] of channels) drop(id, c)
    }
    reconcile(result.changedChannels)
    const after = sync.get()
    for (const [id, c] of channels) {
      const old = before.channels[id], now = after.channels[id]
      const expired = input.type === 'history_failed' && input.status === 409 && input.error === 'snapshot_expired' &&
        old && [old.latest, old.older, old.fill].includes(input.request)
      const reset = before.historyEpoch !== after.historyEpoch || expired || (before.connected && !after.connected) || (old && now && (
        old.versionEpoch !== now.versionEpoch || (old.cursor !== null && now.cursor === null) ||
        (old.fill === undefined && now.fill !== undefined) || (old.wait === undefined && now.wait !== undefined)))
      if (reset) recover(c)
    }
    // An ACK can install a body before its stream echo. Count raw current-stream envelopes,
    // not only changed bodies; Rust deduplicates the evidence independently of body retention.
    const fillChannel = input.type === 'events_result' ? Object.keys(before.channels).find(id => before.channels[id].fill === input.request) : undefined
    const events = input.type === 'event' && input.connection === before.connection && before.connected && input.event.type === 'message' &&
      before.channels[input.event.message.channel_id]?.subscription ? [input.event]
      : input.type === 'events_result' && fillChannel ? input.page.events.filter(e => e.type === 'message' && e.message.channel_id === fillChannel)
      : input.type === 'ack' && result.records.get(input.message.channel_id)?.some(m => m.id === input.message.id)
        ? [{ type: 'message' as const, kind: 'create' as const, seq: input.message.created_seq, message: input.message }] : []
    for (const event of before.historyEpoch === after.historyEpoch ? events : []) {
      if (event.type !== 'message') continue
      const m = event.message, c = channels.get(m.channel_id)
      if (!c || (event.kind === 'create' && event.seq !== m.created_seq)) continue
      const root = m.reply_root_id ?? m.id, cursor = before.channels[m.channel_id]?.cursor
      if (event.kind !== 'create' || m.deleted || m.version !== m.created_seq) update(c, { type: 'invalidate', root, seq: Math.max(event.seq, m.version) })
      else if (m.reply_root_id) update(c, { type: 'create', root, id: m.id, seq: event.seq })
      else if (cursor != null && event.seq > cursor) update(c, { type: 'seed', root, seq: event.seq })
    }
    notify(); defer()
  })
  const stopReplies = sources.replies.subscribe(reconcile)
  const stopTopics = sources.topics?.subscribe(reconcile)
  reconcile()
  return {
    get: (id: string): Readonly<Record<string, number | null>> => channels.get(id)?.view.counts ?? empty,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close() {
      closed = true; stopSync(); stopReplies(); stopTopics?.()
      for (const [id, c] of channels) drop(id, c)
      notify(); listeners.clear()
    },
  }
}
export type ReplyCounts = ReturnType<typeof createReplyCounts>
