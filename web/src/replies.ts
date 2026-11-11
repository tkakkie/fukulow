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
  const notify = () => { snapshots.clear(); listeners.forEach(l => l()) }
  const cancelReads = () => {
    deadlines.forEach((resolve, timer) => { clearTimeout(timer); resolve() })
    deadlines.clear()
  }
  const belongs = (w: Chain, m: Message) => m.id === w.rootId || m.reply_root_id === w.rootId
  const mergeStream = (channel: string, w: Chain) => {
    for (const m of sync.get().channels[channel]?.messages ?? []) if (belongs(w, m)) w.messages.set(m.id, m)
  }
  const unsubscribe = sync.subscribe(() => {
    const next = sync.get()
    for (const [id, w] of chains) {
      const before = previous.channels[id], after = next.channels[id]
      if (!next.running || next.organization === 'unavailable' || !after?.watched || after.state === 'unavailable' ||
        (before?.cursor != null && after.cursor === null)) chains.delete(id)
      else mergeStream(id, w)
    }
    if (!next.running || next.organization === 'unavailable') cancelReads()
    previous = next
    notify()
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
    try {
      const result = await Promise.race([operation, new Promise<Result<ReplyChainPage>>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
        deadlines.set(timer, () => resolve({ ok: false, kind: 'network' }))
      })])
      if (!isCurrent()) return
      w.loading = false
      if (!result.ok) {
        w.error = true
        if (!api.isOrganizationUnavailable(result) && result.kind === 'http' && [403, 404].includes(result.status)) {
          void sync.channelUnavailable(channel)
        }
      } else if (result.data.root_id !== w.rootId) {
        w.error = true
      } else {
        for (const m of result.data.messages) if (m.channel_id === channel && belongs(w, m)) w.messages.set(m.id, m)
        // Only the returned page advances continuation: a live append may be far beyond an unpaged sibling.
        w.after = result.data.messages.at(-1)?.seq ?? w.after
        w.hasMore = result.data.has_more
        void sync.settleHistory(channel, result.data.messages)
        mergeStream(channel, w)
      }
      notify()
    } finally {
      if (timer !== undefined) { clearTimeout(timer); deadlines.delete(timer) }
    }
  }
  function snapshot(channel: string) {
    const w = closed ? undefined : chains.get(channel)
    const c = closed ? undefined : sync.get().channels[channel]
    return { anchor: w?.anchor ?? null, rootId: w?.rootId ?? null, topicId: w?.anchor.topic_id ?? null,
      messages: w ? [...w.messages.values()].sort((a, b) => a.seq - b.seq) : [],
      pending: w ? (c?.pending ?? []).filter(p => p.reply_to && (p.reply_to === w.rootId || w.messages.has(p.reply_to))) : [],
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
    async open(anchor: Message) {
      const channel = anchor.channel_id
      if (closed || !sync.get().running || sync.get().organization !== 'available' ||
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
