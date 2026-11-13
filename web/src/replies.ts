import * as api from './api'
import type { Message, ReplyChainPage, ReplyChainQuery, Result } from './api'
import type { createSync } from './sync'
import { REPLY_MESSAGE_LIMIT } from './protocol'
import { countSequencesAfter, rememberSequence, trimMessages, EVIDENCE_LIMIT } from './message-window'

type Sync = ReturnType<typeof createSync>
export type RepliesApi = {
  listReplyChain(channel: string, anchor: string, query?: ReplyChainQuery): Promise<Result<ReplyChainPage>>
}
export const repliesApi = (organizationId: string): RepliesApi => ({
  listReplyChain: (channel, anchor, query) => api.listReplyChain(organizationId, channel, anchor, query),
})
const chain = (anchor: Message, openedThrough: number) => ({ anchor, openedThrough, rootId: anchor.reply_root_id ?? anchor.id,
  messages: new Map<string, Message>([[anchor.id, anchor]]), after: 0, hasMore: true, hasOlder: false,
  following: true, hasNewer: false, newerCount: 0,
  restart: false,
  liveFloor: 0,
  liveSequences: [] as Parameters<typeof rememberSequence>[0],
  loading: false, error: false, read: Symbol() })
type Chain = ReturnType<typeof chain>

/** One open chain per Channel; projection records settle sends but never enter sync's confirmed window. */
export function createReplies(sync: Sync, options: { api: RepliesApi; onSessionEnded?: () => void; requestTimeoutMs?: number }) {
  const chains = new Map<string, Chain>()
  const listeners = new Set<() => void>()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>()
  const inFlight = new WeakMap<Chain, Promise<void>>()
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
    (c?.pending ?? []).filter(p => p.reply_to && (p.replyRootId === w.rootId || p.reply_to === w.rootId || w.messages.has(p.reply_to)))
  const mergeStream = (channel: string, w: Chain, incoming?: Message[]) => {
    let changed = false
    for (const m of incoming ?? sync.get().channels[channel]?.messages ?? []) if (belongs(w, m) && (!w.hasOlder || m.seq > w.after) && w.messages.get(m.id) !== m) {
      const isNew = m.seq > w.liveFloor && countSequencesAfter(w.liveSequences, m.seq - 1) === countSequencesAfter(w.liveSequences, m.seq)
      if (m.seq > w.liveFloor) rememberSequence(w.liveSequences, m.seq)
      while (w.liveSequences.length > EVIDENCE_LIMIT) w.liveFloor = Math.max(w.liveFloor, w.liveSequences.shift()!.end)
      if ((incoming === undefined && w.hasMore && m.seq > w.after && !w.messages.has(m.id)) || (!w.following && w.messages.size >= REPLY_MESSAGE_LIMIT && !w.messages.has(m.id))) {
        if (isNew) { w.hasNewer = w.hasMore = true; w.newerCount++; changed = true }
        continue
      }
      w.messages.set(m.id, m); changed = true
    }
    if (trimMessages(w.messages, REPLY_MESSAGE_LIMIT, w.hasMore ? 'older' : 'newer')) {
      if (!w.hasMore) w.hasOlder = true
      else w.hasNewer = true
    }
    return changed
  }
  const unsubscribe = sync.subscribe((_changed, records) => {
    const next = sync.get()
    const changed = new Set<string>()
    for (const id of new Set([...chains.keys(), ...snapshots.keys()])) {
      const before = previous.channels[id], after = next.channels[id]
      const w = chains.get(id)
      if (w) {
        if (!next.running || next.organization === 'unavailable' || !after?.watched || after.state === 'unavailable' ||
          (before?.cursor != null && after.cursor === null)) { release(w); chains.delete(id); changed.add(id) }
        else {
          const oldPending = pending(w, before)
          if ((before?.messages !== after.messages || records?.has(id)) && mergeStream(id, w, records?.get(id))) changed.add(id)
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
  const release = (w: Chain) => { w.messages.clear(); w.anchor = { ...w.anchor, body: '' } }

  async function readMore(channel: string) {
    const w = chains.get(channel)
    if (!w || !current(channel, w) || w.loading || (!w.hasMore && !w.restart)) return
    const requestedAfter = w.restart ? 0 : w.after
    const token = Symbol(), session = sessionToken
    w.read = token; w.loading = true; w.error = false; notify()
    const isCurrent = () => current(channel, w) && w.read === token
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = Promise.resolve().then(() => options.api.listReplyChain(channel, w.anchor.id, { after_seq: requestedAfter }))
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
        if (w.restart) {
          w.messages.clear(); w.after = 0; w.hasOlder = w.hasNewer = false; w.newerCount = 0
          w.liveSequences = []; w.liveFloor = 0; w.following = true; w.restart = false
        }
        for (const m of messages) w.messages.set(m.id, m)
        // Only the returned page advances continuation: a live append may be far beyond an unpaged sibling.
        const after = messages.at(-1)?.seq ?? requestedAfter
        // An empty or non-advancing filtered page cannot safely continue, even if has_more is set.
        w.hasMore = result.data.has_more && after > requestedAfter
        w.after = Math.max(w.after, after)
        if (requestedAfter === 0) for (const [id, m] of w.messages) {
          if (m.seq > after && m.seq <= w.openedThrough) w.messages.delete(id)
        }
        // Requested history wins over a disconnected live suffix once the combined window is full.
        if (w.hasMore && w.messages.size > REPLY_MESSAGE_LIMIT) {
          for (const [id, m] of w.messages) if (m.seq > after) w.messages.delete(id)
          w.hasNewer = true
        }
        if (trimMessages(w.messages, REPLY_MESSAGE_LIMIT)) w.hasOlder = true
        void sync.settleHistory(channel, messages)
        mergeStream(channel, w)
        if (!w.hasMore) { w.hasNewer = false; w.newerCount = 0 }
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
  function loadMore(channel: string): Promise<void> {
    const w = chains.get(channel)
    if (!w) return Promise.resolve()
    const active = inFlight.get(w)
    if (active) return active
    const promise = readMore(channel)
    inFlight.set(w, promise)
    const releaseRead = () => { if (inFlight.get(w) === promise) inFlight.delete(w) }
    void promise.then(releaseRead, releaseRead)
    return promise
  }
  function snapshot(channel: string) {
    const w = closed ? undefined : chains.get(channel)
    const c = closed ? undefined : sync.get().channels[channel]
    return { anchor: w?.anchor ?? null, rootId: w?.rootId ?? null, topicId: w?.anchor.topic_id ?? null,
      messages: w ? [...w.messages.values()].sort((a, b) => a.seq - b.seq) : [],
      pending: w ? pending(w, c) : [],
      loading: w?.loading ?? false, error: w?.error ?? false, hasMore: w?.hasMore ?? false,
      hasOlder: w?.hasOlder ?? false,
      hasNewer: w?.hasNewer ?? false, newerCount: w?.newerCount ?? 0,
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
      const old = chains.get(channel)
      const seekAnchor = old?.rootId === (anchor.reply_root_id ?? anchor.id) && old.anchor.id !== anchor.id
      const w = chain(anchor, sync.get().channels[channel]?.cursor ?? 0)
      for (const old of chains.values()) release(old)
      chains.clear(); snapshots.clear()
      chains.set(channel, w); mergeStream(channel, w); notify()
      await loadMore(channel)
      // A same-chain anchor change is an explicit navigation intent. Read the
      // intervening pages rather than retaining a disconnected cached suffix.
      while (seekAnchor && current(channel, w) && !w.error && w.hasMore && w.after < anchor.seq) {
        await loadMore(channel)
      }
    },
    loadMore,
    setPinned(channel: string, pinned: boolean) { const w = chains.get(channel); if (w) w.following = pinned },
    async loadLatest(channel: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w)) return
      w.following = true
      while (current(channel, w) && w.hasMore) {
        await loadMore(channel)
        if (w.error) break
      }
      if (current(channel, w) && !w.error) { w.hasNewer = false; w.newerCount = 0; notify() }
    },
    async loadOlder(channel: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w)) return
      w.restart = true; w.read = Symbol(); w.loading = false; w.following = false
      inFlight.delete(w)
      await loadMore(channel)
    },
    dismiss(channel: string) { const w = chains.get(channel); if (w) release(w); chains.delete(channel); notify() },
    async send(channel: string, body: string, parentId?: string) {
      const w = chains.get(channel)
      const parent = parentId ?? w?.anchor.id
      if (!w || !current(channel, w) || !parent || (!w.messages.has(parent) && parent !== w.anchor.id && parent !== w.rootId)) return false
      return sync.getTimeline(channel).send(body, { reply_to: parent, replyRootId: w.rootId })
    },
    retry(channel: string, clientMessageId: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w)) return
      const p = sync.get().channels[channel]?.pending.find(p => p.clientMessageId === clientMessageId)
      if (p?.reply_to && (p.replyRootId === w.rootId || p.reply_to === w.rootId || w.messages.has(p.reply_to))) return sync.getTimeline(channel).retry(clientMessageId)
    },
    replaceSession() { sessionToken++; chains.forEach(release); chains.clear(); cancelReads(); notify() },
    close() { closed = true; unsubscribe(); chains.forEach(release); chains.clear(); cancelReads(); notify(); listeners.clear() },
  }
}
export type Replies = ReturnType<typeof createReplies>
