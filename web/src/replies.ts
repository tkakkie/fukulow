import * as api from './api'
import type { Message, ReplyChainPage, ReplyChainQuery, Result } from './api'
import type { createSync } from './sync'

type Sync = ReturnType<typeof createSync>
export type RepliesApi = {
  listReplyChain(channel: string, anchor: string, query?: ReplyChainQuery): Promise<Result<ReplyChainPage>>
}
export const repliesApi = (organizationId: string): RepliesApi => ({
  listReplyChain: (channel, anchor, query) => api.listReplyChain(organizationId, channel, anchor, query),
})
const chain = (anchor: Message) => ({ anchor, rootId: anchor.reply_root_id ?? anchor.id,
  messages: new Map<string, Message>([[anchor.id, anchor]]), after: 0, hasMore: true,
  loading: false, error: false, read: Symbol() })
type Chain = ReturnType<typeof chain>

/** One open chain per Channel; projection records settle sends but never enter sync's confirmed window. */
export function createReplies(sync: Sync, options: { api: RepliesApi; onSessionEnded?: () => void; requestTimeoutMs?: number }) {
  const chains = new Map<string, Chain>()
  const listeners = new Set<() => void>()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>()
  let closed = false
  let sessionToken = 0
  let previous = sync.get()
  const notify = (channels?: Set<string>) => {
    if (channels) channels.forEach(id => snapshots.delete(id))
    else snapshots.clear()
    listeners.forEach(l => l())
  }
  const cancelReads = () => {
    deadlines.forEach((resolve, timer) => { clearTimeout(timer); resolve() })
    deadlines.clear()
  }
  const belongs = (w: Chain, m: Message) => m.id === w.rootId || m.reply_root_id === w.rootId
  const pending = (w: Chain, c: ReturnType<Sync['get']>['channels'][string] | undefined) =>
    (c?.pending ?? []).filter(p => p.reply_to && (p.reply_to === w.rootId || w.messages.has(p.reply_to)))
  const mergeStream = (channel: string, w: Chain) => {
    let changed = false
    for (const m of sync.get().channels[channel]?.messages ?? []) if (belongs(w, m) && w.messages.get(m.id) !== m) {
      w.messages.set(m.id, m); changed = true
    }
    return changed
  }
  const unsubscribe = sync.subscribe(() => {
    const next = sync.get()
    const changed = new Set<string>()
    for (const id of new Set([...chains.keys(), ...snapshots.keys()])) {
      const before = previous.channels[id], after = next.channels[id]
      const w = chains.get(id)
      if (w) {
        if (!next.running || next.organization === 'unavailable' || !after?.watched || after.state === 'unavailable' ||
          (before?.cursor != null && after.cursor === null)) { chains.delete(id); changed.add(id) }
        else {
          const oldPending = pending(w, before)
          if (before?.messages !== after.messages && mergeStream(id, w)) changed.add(id)
          if (before?.pending !== after.pending || changed.has(id)) {
            const newPending = pending(w, after)
            if (oldPending.length !== newPending.length || oldPending.some((p, i) => p !== newPending[i])) changed.add(id)
          }
        }
      }
      if ((before?.state === 'unavailable') !== (after?.state === 'unavailable') || previous.organization !== next.organization) changed.add(id)
    }
    if (!next.running || next.organization === 'unavailable') cancelReads()
    previous = next
    if (changed.size) notify(changed)
  })
  const current = (channel: string, w: Chain) => !closed && sync.get().running &&
    sync.get().organization === 'available' && chains.get(channel) === w &&
    sync.get().channels[channel]?.watched === true && sync.get().channels[channel]?.state !== 'unavailable'

  async function loadMore(channel: string) {
    const w = chains.get(channel)
    if (!w || !current(channel, w) || w.loading || !w.hasMore) return
    const token = Symbol(), session = sessionToken
    w.read = token; w.loading = true; w.error = false; notify()
    const isCurrent = () => current(channel, w) && w.read === token
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = Promise.resolve().then(() => options.api.listReplyChain(channel, w.anchor.id, { after_seq: w.after }))
      .catch((): Result<ReplyChainPage> => ({ ok: false, kind: 'network' }))
    // C6 late 401 and C10 remain authoritative for this Account Session, even after timeout or unwatch.
    void operation.then(r => {
      if (session !== sessionToken) return
      if (!r.ok && r.kind === 'http' && r.status === 401) { void sync.close(); options.onSessionEnded?.() }
      else if (api.isOrganizationUnavailable(r)) void sync.unavailable()
    })
    const apply = operation.then(result => {
      if (!isCurrent()) return
      w.loading = false
      if (!result.ok) {
        w.error = true
        if (!api.isOrganizationUnavailable(result) && result.kind === 'http' && [403, 404].includes(result.status) &&
          result.error !== 'reply_chain_not_found') {
          void sync.channelUnavailable(channel)
        }
      } else if (result.data.root_id !== w.rootId) {
        w.error = true
      } else {
        const messages = result.data.messages.filter(m => m.channel_id === channel && belongs(w, m))
        for (const m of messages) w.messages.set(m.id, m)
        // Only the returned page advances continuation: a live append may be far beyond an unpaged sibling.
        const after = messages.at(-1)?.seq ?? w.after
        // An empty or non-advancing filtered page cannot safely continue, even if has_more is set.
        w.hasMore = result.data.has_more && after > w.after
        w.after = Math.max(w.after, after)
        void sync.settleHistory(channel, messages)
        mergeStream(channel, w)
      }
      notify()
    })
    try {
      await Promise.race([apply, new Promise<void>(resolve => {
        timer = setTimeout(() => {
          // Expiry ends this read's authority, not the underlying HTTP operation.
          if (isCurrent()) { w.read = Symbol(); w.loading = false; w.error = true; notify() }
          resolve()
        }, options.requestTimeoutMs ?? 30_000)
        deadlines.set(timer, resolve)
      })])
    } finally {
      if (timer !== undefined) { clearTimeout(timer); deadlines.delete(timer) }
    }
  }
  function snapshot(channel: string) {
    const w = closed ? undefined : chains.get(channel)
    const c = closed ? undefined : sync.get().channels[channel]
    return { anchor: w?.anchor ?? null, rootId: w?.rootId ?? null, topicId: w?.anchor.topic_id ?? null,
      messages: w ? [...w.messages.values()].sort((a, b) => a.seq - b.seq) : [],
      pending: w ? pending(w, c) : [],
      loading: w?.loading ?? false, error: w?.error ?? false, hasMore: w?.hasMore ?? false,
      unavailable: c?.state === 'unavailable' || sync.get().organization === 'unavailable' }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    get(channel: string) {
      let value = snapshots.get(channel)
      if (!value) snapshots.set(channel, value = snapshot(channel))
      return value
    },
    async open(channel: string, anchor: Message) {
      if (anchor.channel_id !== channel || closed || !sync.get().running || sync.get().organization !== 'available' ||
        !sync.get().channels[channel]?.watched || sync.get().channels[channel]?.state === 'unavailable') return
      const w = chain(anchor)
      chains.set(channel, w); mergeStream(channel, w); notify()
      await loadMore(channel)
    },
    loadMore,
    dismiss(channel: string) { chains.delete(channel); notify() },
    async send(channel: string, body: string, parentId?: string) {
      const w = chains.get(channel)
      const parent = parentId ?? w?.anchor.id
      if (!w || !current(channel, w) || !parent || !w.messages.has(parent)) return false
      return sync.getTimeline(channel).send(body, { reply_to: parent })
    },
    retry(channel: string, clientMessageId: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w)) return
      const p = sync.get().channels[channel]?.pending.find(p => p.clientMessageId === clientMessageId)
      if (p?.reply_to && (p.reply_to === w.rootId || w.messages.has(p.reply_to))) return sync.getTimeline(channel).retry(clientMessageId)
    },
    replaceSession() { sessionToken++; chains.clear(); cancelReads(); notify() },
    close() { closed = true; unsubscribe(); chains.clear(); cancelReads(); notify(); listeners.clear() },
  }
}
export type Replies = ReturnType<typeof createReplies>
