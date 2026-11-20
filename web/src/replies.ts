import * as api from './api'
import { createRequestDeadlines } from './request-deadlines'
import { knownMessageState } from './identity-order'
import type { Message, ReplyChainPage, ReplyChainQuery, Result } from './api'
import type { createSync } from './sync'
import { REPLY_MESSAGE_LIMIT, type ChannelState } from './protocol-types'
import { countSequencesAfter, rememberSequence, trimMessages, EVIDENCE_LIMIT } from './message-window'

type Sync = ReturnType<typeof createSync>
export type RepliesApi = {
  listReplyChain(channel: string, anchor: string, query?: ReplyChainQuery, signal?: AbortSignal): Promise<Result<ReplyChainPage>>
}
export const repliesApi = (organizationId: string): RepliesApi => ({
  listReplyChain: (channel, anchor, query, signal) => api.listReplyChain(organizationId, channel, anchor, query, undefined, signal),
})
// Half a default page leaves context on both sides of a descendant in one read.
const ANCHOR_CONTEXT = 25
const beforeAnchor = (anchor: Message) => anchor.reply_root_id ? Math.max(0, anchor.created_seq - ANCHOR_CONTEXT) : 0
const observedThrough = (c: ChannelState | undefined) => Math.max(c?.cursor ?? 0, c?.heldThrough ?? 0)
const chain = (anchor: Message, channel: ChannelState | undefined) => ({ anchor, anchorCurrent: true, openedThrough: channel?.cursor ?? 0, rootId: anchor.reply_root_id ?? anchor.id,
  messages: new Map<string, Message>([[anchor.id, anchor]]),
  asOfSeq: undefined as number | undefined,
  moveBaseline: undefined as Pick<ReplyChainPage, 'chain_version' | 'history_generation'> | undefined,
  after: beforeAnchor(anchor),
  hasMore: true, hasOlder: Boolean(anchor.reply_root_id && anchor.created_seq > ANCHOR_CONTEXT),
  following: true, hasNewer: false, newerCount: 0,
  restart: false, moveInvalidated: false,
  restartAfter: 0,
  moveLiveFrom: observedThrough(channel),
  liveFloor: 0,
  liveSequences: [] as Parameters<typeof rememberSequence>[0],
  loading: false, error: false, read: Symbol() })
type Chain = ReturnType<typeof chain>

/** One open chain per Channel; projection records settle sends but never enter sync's confirmed window. */
export function createReplies(sync: Sync, options: { api: RepliesApi; onSessionEnded?: () => void; requestTimeoutMs?: number }) {
  const canonical = (channel: string, held: Message | undefined, incoming: Message) =>
    knownMessageState(sync.get().channels[channel], held, incoming)
  const chains = new Map<string, Chain>()
  const listeners = new Set<(channels?: ReadonlySet<string>) => void>()
  const snapshots = new Map<string, ReturnType<typeof snapshot>>()
  const deadlines = createRequestDeadlines()
  const inFlight = new WeakMap<Chain, Promise<void>>()
  let closed = false
  let sessionToken = 0
  let previous = sync.get()
  const notify = (channels?: Set<string>) => {
    if (channels) channels.forEach(id => snapshots.delete(id))
    else snapshots.clear()
    listeners.forEach(l => l(channels))
  }
  const cancelReads = deadlines.cancel
  const belongs = (w: Chain, m: Message) => m.id === w.rootId || m.reply_root_id === w.rootId
  const pending = (w: Chain, c: ChannelState | undefined) =>
    (c?.pending ?? []).filter(p => p.reply_to && (p.replyRootId === w.rootId || p.reply_to === w.rootId || w.messages.has(p.reply_to)))
  const advanceMoveBaseline = (w: Chain, c: ChannelState | undefined) => {
    const baseline = w.moveBaseline
    if (!baseline || w.restart || w.hasNewer || w.asOfSeq === undefined || !c || c.mutationSeq > w.asOfSeq) return false
    // Neither bootstrap history nor a discarded Reply window proves coverage after W.
    if (c.streamBase === undefined || c.streamBase > w.asOfSeq || w.moveLiveFrom > w.asOfSeq) return false
    const covered = Math.max(w.asOfSeq, c.cursor ?? 0)
    const through = c.advancing.find(range => range.start <= covered + 1 && range.end > covered)?.end ?? covered
    const floor = Math.max(baseline.chain_version, w.asOfSeq)
    if (through <= floor || w.liveFloor > floor) return false
    // The newer badge can clear even if some observed Replies were evicted.
    const countAfter = (seq: number) => countSequencesAfter(w.liveSequences, seq)
    let missing = countAfter(floor) - countAfter(through)
    if (missing === 0) return false
    let version = floor
    for (const m of w.messages.values()) {
      if (m.created_seq <= floor || m.created_seq > through || countAfter(m.created_seq - 1) === countAfter(m.created_seq)) continue
      missing--
      // A hydrated mutation version on one Reply cannot stand for the whole chain.
      if (m.reply_root_id === w.rootId && !m.deleted && m.version === m.created_seq &&
        m.history_generation === baseline.history_generation && m.version > version && m.version <= through) version = m.version
    }
    if (missing !== 0 || version === floor) return false
    w.moveBaseline = { ...baseline, chain_version: version }
    return true
  }
  const mergeStream = (channel: string, w: Chain, incoming?: Message[]) => {
    if (w.restart && !w.anchorCurrent) return false
    let changed = false
    for (const m of incoming ?? sync.get().channels[channel]?.messages ?? []) {
      if (w.anchor.id === m.id) {
        const anchor = canonical(channel, w.anchorCurrent ? w.anchor : undefined, m)
        if (anchor) { w.anchor = anchor; w.anchorCurrent = true }
      }
      if (belongs(w, m) && (!w.hasOlder || m.created_seq > w.after) && w.messages.get(m.id) !== m) {
        const isNew = m.created_seq > w.liveFloor && countSequencesAfter(w.liveSequences, m.created_seq - 1) === countSequencesAfter(w.liveSequences, m.created_seq)
        if (m.created_seq > w.liveFloor) rememberSequence(w.liveSequences, m.created_seq)
        while (w.liveSequences.length > EVIDENCE_LIMIT) w.liveFloor = Math.max(w.liveFloor, w.liveSequences.shift()!.end)
        if ((incoming === undefined && w.hasMore && m.created_seq > w.after && !w.messages.has(m.id)) || (!w.following && w.messages.size >= REPLY_MESSAGE_LIMIT && !w.messages.has(m.id))) {
          if (isNew) { w.hasNewer = w.hasMore = true; w.newerCount++; changed = true }
          continue
        }
        const state = canonical(channel, w.messages.get(m.id), m)
        if (state) w.messages.set(m.id, state)
        changed = true
      }
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
      if (w && before && after && before.versionEpoch !== after.versionEpoch) { w.read = Symbol(); w.loading = false }
      if (w) {
        if (!next.running || next.organization === 'unavailable' || !after?.watched || after.state === 'unavailable' ||
          (before?.cursor != null && after.cursor === null) || previous.historyEpoch !== next.historyEpoch) { release(w); chains.delete(id); changed.add(id) }
        else if (after.moveEpoch !== undefined && before?.moveEpoch !== after.moveEpoch) {
          const epoch = after.moveEpoch
          invalidateForMove(w)
          changed.add(id)
          queueMicrotask(() => {
            if (current(id, w) && w.restart && sync.get().channels[id]?.moveEpoch === epoch) void loadMore(id)
          })
        }
        else {
          const oldPending = pending(w, before)
          if ((before?.messages !== after.messages || records?.has(id)) && mergeStream(id, w, records?.get(id))) changed.add(id)
          if ((changed.has(id) || before?.cursor !== after.cursor || before?.advancing !== after.advancing) && advanceMoveBaseline(w, after)) changed.add(id)
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
  function invalidate(w: Chain, after: number) {
    w.read = Symbol(); w.loading = false; w.restart = true; w.restartAfter = after
    w.messages.clear(); w.asOfSeq = undefined; w.moveBaseline = undefined; w.hasMore = true
    w.anchorCurrent = false; w.hasOlder = after > 0; w.hasNewer = false; w.newerCount = 0
    inFlight.delete(w)
  }
  function invalidateForMove(w: Chain) {
    invalidate(w, beforeAnchor(w.anchor))
    w.moveInvalidated = true
  }

  async function readMore(channel: string, restarted = false) {
    const w = chains.get(channel)
    if (!w || !current(channel, w) || w.loading || (!w.hasMore && !w.restart)) return
    const requestedAfter = w.restart ? w.restartAfter : w.after
    const requestedW = w.restart ? undefined : w.asOfSeq
    const mutationFloor = sync.get().channels[channel]?.mutationSeq ?? 0
    const versionEpoch = sync.get().channels[channel]?.versionEpoch
    const token = Symbol(), session = sessionToken
    w.read = token; w.loading = true; w.error = false; notify(new Set([channel]))
    const isCurrent = () => current(channel, w) && w.read === token && sync.get().channels[channel]?.versionEpoch === versionEpoch
    const anchor = w.anchor.id, generation = sync.get().historyGeneration
    const operation = Promise.resolve().then(() => options.api.listReplyChain(channel, anchor, { history_generation: generation, as_of_seq: requestedW, after_seq: requestedAfter }))
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
      const generation = result.ok ? result.data.history_generation : undefined
      if (generation !== undefined && !sync.observeHistoryGeneration(generation)) return
      if (!result.ok && result.kind === 'http' && result.status === 409 && result.error === 'history_generation_changed') { sync.observeHistoryGeneration(); return }
      const state = sync.get().channels[channel]
      const mutationSeq = state?.mutationSeq ?? 0
      const floor = mutationFloor < mutationSeq ? mutationSeq : state?.moveSeq ?? 0
      if (result.ok && result.data.as_of_seq < floor) result = { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
      if (!result.ok && result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
        w.messages.clear(); w.asOfSeq = undefined; w.moveBaseline = undefined; w.after = 0; w.hasMore = true
        if (!w.restart) { w.restart = true; w.restartAfter = 0 }
        // Edit/Delete can leave complete current stream records. A Move restart keeps the chain hidden until its page arrives.
        if (w.anchorCurrent) for (const m of state?.messages ?? []) {
          if (belongs(w, m) && (m.version >= mutationSeq || m.id === w.rootId)) w.messages.set(m.id, m)
        }
        return readMore(channel, true)
      }
      if (!result.ok) {
        w.error = true
        if (!api.isOrganizationUnavailable(result) && result.kind === 'http' && [403, 404].includes(result.status) &&
          result.error !== 'reply_chain_not_found') {
          void sync.channelUnavailable(channel)
        }
      } else if (result.data.root_id !== w.rootId) {
        w.error = true
      } else {
        // Continuations use the same W and cannot supersede a live advance.
        if (requestedW === undefined) {
          w.asOfSeq = result.data.as_of_seq
          const { chain_version, history_generation } = result.data
          w.moveBaseline = Number.isSafeInteger(chain_version) && chain_version > 0 ? { chain_version, history_generation } : undefined
        }
        const messages = result.data.messages.filter(m => m.channel_id === channel && belongs(w, m))
        if (w.restart) {
          w.moveLiveFrom = observedThrough(state)
          w.messages.clear(); w.after = requestedAfter; w.hasOlder = requestedAfter > 0; w.hasNewer = false; w.newerCount = 0
          w.liveSequences = []; w.liveFloor = 0; w.following = true; w.restart = false; w.moveInvalidated = false
        }
        for (const m of messages) {
          const current = canonical(channel, w.messages.get(m.id), m)
          if (current) {
            w.messages.set(m.id, current)
            if (w.anchor.id === current.id) { w.anchor = current; w.anchorCurrent = true }
          }
        }
        // Only the returned page advances continuation: a live append may be far beyond an unpaged sibling.
        const after = messages.at(-1)?.created_seq ?? requestedAfter
        // An empty or non-advancing filtered page cannot safely continue, even if has_more is set.
        w.hasMore = result.data.has_more && after > requestedAfter
        w.after = Math.max(w.after, after)
        if (requestedAfter === 0) for (const [id, m] of w.messages) {
          if (m.created_seq > after && m.created_seq <= w.openedThrough) w.messages.delete(id)
        }
        // Requested history wins over a disconnected live suffix once the combined window is full.
        if (w.hasMore && w.messages.size > REPLY_MESSAGE_LIMIT) {
          for (const [id, m] of w.messages) if (m.created_seq > after) w.messages.delete(id)
          w.hasNewer = true
        }
        if (trimMessages(w.messages, REPLY_MESSAGE_LIMIT)) w.hasOlder = true
        void sync.settleHistory(channel, messages)
        mergeStream(channel, w)
        if (!w.hasMore) { w.hasNewer = false; w.newerCount = 0 }
        advanceMoveBaseline(w, sync.get().channels[channel])
      }
      notify(new Set([channel]))
    })
    const deadline = deadlines.start<void>(undefined, {
      timeoutMs: options.requestTimeoutMs ?? 30_000,
      onTimeout() {
        if (isCurrent()) { w.read = Symbol(); w.loading = false; w.error = true; notify(new Set([channel])) }
      },
    })
    try { await Promise.race([apply, deadline.until]) }
    finally { deadline.clear() }
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
    const topicMessage = w?.messages.values().next().value ?? (w?.anchorCurrent ? w.anchor : undefined)
    const topicId = topicMessage?.topic_id ?? null
    return { anchor: w?.anchorCurrent ? w.anchor : null, anchorId: w?.anchor.id ?? null, rootId: w?.rootId ?? null, topicId,
      moveInvalidated: w?.moveInvalidated ?? false,
      chainVersion: w?.restart ? undefined : w?.moveBaseline?.chain_version,
      messages: w ? [...w.messages.values()].sort((a, b) => a.created_seq - b.created_seq) : [],
      pending: w ? pending(w, c) : [],
      loading: w?.loading ?? false, error: w?.error ?? false, hasMore: w?.hasMore ?? false,
      hasOlder: w?.hasOlder ?? false,
      hasNewer: w?.hasNewer ?? false, newerCount: w?.newerCount ?? 0,
      unavailable: c?.state === 'unavailable' || sync.get().organization === 'unavailable' }
  }
  return {
    subscribe(listener: (channels?: ReadonlySet<string>) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    get(channel: string) {
      let value = snapshots.get(channel)
      if (!value) snapshots.set(channel, value = snapshot(channel))
      return value
    },
    async open(channel: string, anchor: Message) {
      if (anchor.channel_id !== channel || closed || !sync.get().running || sync.get().organization !== 'available' ||
        !sync.get().channels[channel]?.watched || sync.get().channels[channel]?.state === 'unavailable') return
      const old = chains.get(channel)
      if (old?.rootId === (anchor.reply_root_id ?? anchor.id) &&
        (old.messages.has(anchor.id) || old.anchor.id === anchor.id || old.rootId === anchor.id)) {
        if (old.restart) return
        const current = canonical(channel, old.anchorCurrent && old.anchor.id === anchor.id ? old.anchor : undefined, old.messages.get(anchor.id) ?? anchor)
        if (current) { old.anchor = current; old.anchorCurrent = true }
        notify(new Set([channel]))
        return
      }
      const w = chain(anchor, sync.get().channels[channel])
      if (anchor.version < (sync.get().channels[channel]?.moveSeq ?? 0)) invalidateForMove(w)
      const changed = new Set([...chains.keys(), channel])
      for (const old of chains.values()) release(old)
      chains.clear(); snapshots.clear()
      chains.set(channel, w); mergeStream(channel, w); notify(changed)
      await loadMore(channel)
    },
    loadMore,
    moveTarget(channel: string, anchor: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w) ||
        (anchor !== w.anchor.id && anchor !== w.rootId && !w.messages.has(anchor))) return undefined
      return { rootId: w.rootId, baseline: w.restart ? undefined : w.moveBaseline, isCurrent: () => current(channel, w), refresh: async () => {
        if (!current(channel, w)) return false
        invalidate(w, beforeAnchor(w.anchor))
        await loadMore(channel)
        return current(channel, w) && !w.restart && !w.error && w.moveBaseline !== undefined
      } }
    },
    setPinned(channel: string, pinned: boolean) { const w = chains.get(channel); if (w) w.following = pinned },
    async loadLatest(channel: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w)) return
      w.following = true
      while (current(channel, w) && w.hasMore) {
        await loadMore(channel)
        if (w.error) break
      }
      if (current(channel, w) && !w.error) { w.hasNewer = false; w.newerCount = 0; notify(new Set([channel])) }
    },
    async loadOlder(channel: string) {
      const w = chains.get(channel)
      if (!w || !current(channel, w)) return
      w.restart = true; w.restartAfter = 0; w.read = Symbol(); w.loading = false; w.following = false
      inFlight.delete(w)
      await loadMore(channel)
    },
    dismiss(channel: string) { const w = chains.get(channel); if (w) release(w); chains.delete(channel); notify(new Set([channel])) },
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
