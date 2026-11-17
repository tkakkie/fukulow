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
type Channel = { core: CountCore; view: CountView; batch?: Batch; retry?: ReturnType<typeof setTimeout>; attempt: number; stopped: boolean }
const empty: Readonly<Record<string, number | null>> = Object.freeze({})

/** I/O only: Rust owns authority, deduplication, floors and per-root generations. */
export function createReplyCounts(sync: Sync, sources: { replies: Replies; topics?: Pick<Topics, 'countMessages' | 'subscribe'> }, options: {
  api: ReplyCountsApi; onSessionEnded?: () => void; requestTimeoutMs?: number; random?: () => number
}) {
  const channels = new Map<string, Channel>()
  const listeners = new Set<() => void>()
  let closed = false, session = 0, queued = false
  const notify = () => listeners.forEach(l => l())
  const usable = (id: string) => {
    const s = sync.get(), c = s.channels[id]
    return !closed && s.running && s.organization === 'available' && c?.watched && c.state !== 'unavailable'
  }
  const update = (c: Channel, input: CountInput) => { c.view = c.core.step(input) }
  const valid = (c: Channel, t: CountTicket) => c.view.tickets.some(now => now.root === t.root && now.generation === t.generation)
  const cancel = (c: Channel) => {
    if (c.batch) { clearTimeout(c.batch.timeout); c.batch.abort.abort(); update(c, { type: 'failed', tickets: c.batch.tickets }); c.batch = undefined }
  }
  const drop = (id: string, c: Channel) => {
    cancel(c); if (c.retry !== undefined) clearTimeout(c.retry)
    c.core.free(); channels.delete(id)
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
  function reconcile() {
    const s = sync.get()
    for (const [id, c] of channels) if (!usable(id)) drop(id, c)
    for (const [id, state] of Object.entries(s.channels)) {
      if (!usable(id)) continue
      const panel = sources.replies.get(id)
      const members: Iterable<Message>[] = [state.messages, ...sources.topics?.countMessages(id) ?? [], panel.messages, panel.anchor ? [panel.anchor] : []]
      const roots = new Set<string>()
      for (const source of members) for (const m of source) roots.add(m.reply_root_id ?? m.id)
      if (panel.rootId) roots.add(panel.rootId)
      let c = channels.get(id)
      if (!c) {
        const core = createReplyCountCore()
        channels.set(id, c = { core, view: core.step({ type: 'track', roots: [] }), attempt: 0, stopped: false })
      }
      update(c, { type: 'track', roots: [...roots] })
      if (c.batch?.tickets.some(t => !valid(c, t))) cancel(c)
    }
    notify(); defer()
  }
  function pump(id: string, c: Channel) {
    if (!usable(id) || channels.get(id) !== c || !sync.get().connected || c.batch || c.retry !== undefined || c.stopped) return
    const tickets = c.view.needed.slice(0, 100)
    if (!tickets.length) return
    update(c, { type: 'begin', tickets })
    const abort = new AbortController(), account = session
    const batch: Batch = { tickets, abort, timeout: setTimeout(() => {
      if (c.batch !== batch) return
      cancel(c); backoff(c); notify()
    }, options.requestTimeoutMs ?? 30_000) }
    c.batch = batch
    const current = () => !closed && channels.get(id) === c && c.batch === batch && usable(id)
    void Promise.resolve().then(() => current() ? options.api(id, { ids: tickets.map(t => t.root) }, abort.signal) : { ok: false, kind: 'network' } as const)
      .catch((): Result<ReplyCountPage> => ({ ok: false, kind: 'network' }))
      .then(result => {
        // C6: cancellation/timeout/unwatch does not hide a same-Account-Session late 401.
        if (account !== session) return
        if (!result.ok && result.kind === 'http' && result.status === 401) { void sync.close(); options.onSessionEnded?.(); return }
        if (!closed && api.isOrganizationUnavailable(result)) { void sync.unavailable(); return }
        if (!current()) return
        clearTimeout(batch.timeout); c.batch = undefined
        update(c, { type: 'failed', tickets })
        if (result.ok) {
          for (const t of tickets) {
            const row = result.data.counts.find(row => row.message_id === t.root && row.root_id === t.root)
            if (row) update(c, { type: 'install', ticket: t, watermark: result.data.as_of_seq, count: row.reply_count })
          }
          // Omitted anchors remain unresolved; an insufficient W never gains authority.
          if (tickets.some(t => valid(c, t) && c.view.counts[t.root] === null)) backoff(c)
          else c.attempt = 0
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
    reconcile()
    const after = sync.get()
    for (const [id, c] of channels) {
      const old = before.channels[id], now = after.channels[id]
      const reset = (before.connected && !after.connected) || (old && now && (
        old.versionEpoch !== now.versionEpoch || (old.cursor !== null && now.cursor === null) ||
        (old.fill === undefined && now.fill !== undefined) || (old.wait === undefined && now.wait !== undefined)))
      if (reset) { cancel(c); update(c, { type: 'reset' }); c.stopped = false }
    }
    // An ACK can install a body before its stream echo. Count raw current-stream envelopes,
    // not only changed bodies; Rust deduplicates the evidence independently of body retention.
    const fillChannel = input.type === 'events_result' ? Object.keys(before.channels).find(id => before.channels[id].fill === input.request) : undefined
    const events = input.type === 'event' && input.connection === before.connection && before.connected && input.event.type === 'message' &&
      before.channels[input.event.message.channel_id]?.subscription ? [input.event]
      : input.type === 'events_result' && fillChannel ? input.page.events.filter(e => e.type === 'message' && e.message.channel_id === fillChannel)
      : input.type === 'ack' && result.records.get(input.message.channel_id)?.some(m => m.id === input.message.id)
        ? [{ type: 'message' as const, kind: 'create' as const, seq: input.message.created_seq, message: input.message }] : []
    for (const event of events) {
      if (event.type !== 'message') continue
      const m = event.message, c = channels.get(m.channel_id)
      if (!c || (event.kind === 'create' && event.seq !== m.created_seq)) continue
      const root = m.reply_root_id ?? m.id
      if (event.kind !== 'create' || m.deleted || m.version !== m.created_seq) update(c, { type: 'invalidate', root, seq: Math.max(event.seq, m.version) })
      else if (m.reply_root_id) update(c, { type: 'create', root, id: m.id, seq: event.seq })
      if (c.batch?.tickets.some(t => !valid(c, t))) { cancel(c); backoff(c) }
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
