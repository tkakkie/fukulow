import { isOrganizationUnavailable, type ListMessagesQuery, type Message, type MessagePage, type ReplyChainPage, type ReplyChainQuery, type Result } from './api'
import { knownMessageState } from './identity-order'
import type { SearchResultTarget } from './navigation'
import type { createSync } from './sync'
import { createRequestDeadlines } from './request-deadlines'
import { MAIN_MESSAGE_LIMIT } from './protocol-types'

const PAGE_SIZE = 25
export const SEARCH_WINDOW_LIMIT = 100
type Direction = 'older' | 'newer'
type Reads = {
  messages(target: SearchResultTarget, query: ListMessagesQuery): Promise<Result<MessagePage>>
  reply(target: SearchResultTarget, query: ReplyChainQuery): Promise<Result<ReplyChainPage>>
}
const initial = (target: SearchResultTarget) => ({
  target, visit: Symbol(), status: 'loading' as 'loading' | 'ready' | 'missing' | 'error',
  messages: [] as Message[], reply: undefined as Message | undefined,
  hasOlder: false, hasNewer: false, detached: false, paging: false, pageError: undefined as Direction | undefined,
  asOfSeq: undefined as number | undefined,
})
type View = ReturnType<typeof initial>

/** An authorized display projection. Only unfiltered sync can establish the Channel cursor. */
export function createSearchAnchor(sync: ReturnType<typeof createSync>, reads: Reads) {
  let view: View | undefined
  let before = 0, after = 0
  let request: symbol | undefined
  let previous = sync.get()
  const deadlines = createRequestDeadlines()
  const listeners = new Set<() => void>()
  const publish = (next: View | undefined) => { view = next; listeners.forEach(listener => listener()) }
  function cancel() { request = undefined; deadlines.cancel() }
  function missing(w: View) {
    cancel()
    publish({ ...initial(w.target), visit: w.visit, status: 'missing' })
  }
  const channelFor = (target: SearchResultTarget) => sync.get().channels[target.channelId]
  const contains = (target: SearchResultTarget, message: Message) =>
    message.id === target.messageId && message.created_seq === target.createdSeq &&
    message.channel_id === target.channelId && message.topic_id === (target.topicId ?? null) &&
    (!target.replyRootId || (message.reply_root_id ?? message.id) === target.replyRootId) && !message.deleted

  function merge(w: View, incoming: Message[], starting: Message[] = w.messages) {
    const records = new Map(starting.map(message => [message.id, message]))
    const channel = channelFor(w.target)
    for (const message of incoming) {
      if (message.channel_id !== w.target.channelId) continue
      const current = knownMessageState(channel, records.get(message.id), message)
      if (current && !current.deleted && (!w.target.topicId || current.topic_id === w.target.topicId)) records.set(message.id, current)
      else records.delete(message.id)
    }
    return [...records.values()].sort((a, b) => a.created_seq - b.created_seq)
  }

  async function read(direction?: Direction, restarted = false): Promise<void> {
    const w = view
    if (!w || request || sync.get().organization === 'unavailable' || !channelFor(w.target)?.watched) return
    const { target } = w
    const channel = target.channelId
    if (!Number.isSafeInteger(target.createdSeq) || target.createdSeq < 1) {
      missing(w)
      return
    }
    const token = request = Symbol()
    const versionEpoch = channelFor(target)?.versionEpoch
    publish(w.status === 'ready' || direction
      ? { ...w, paging: true, pageError: undefined }
      : { ...w, status: 'loading' })
    const deadline = deadlines.start<Result<never>>({ ok: false, kind: 'network' }, { timeoutMs: 10_000 })
    const query = { history_generation: sync.get().historyGeneration }
    const run = <T>(operation: () => Promise<Result<T>>) =>
      Promise.race([Promise.resolve().then(operation).catch((): Result<T> => ({ ok: false, kind: 'network' })), deadline.until])
    const checked = <T extends { as_of_seq: number }>(result: Result<T>): Result<T> => {
      const state = channelFor(target)
      if (result.ok && state && (state.versionEpoch !== versionEpoch || state.mutationSeq > result.data.as_of_seq)) {
        return { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
      }
      return result
    }
    const fail = (result: Exclude<Result<unknown>, { ok: true }>) => {
      if (result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
        cancel()
        return read(undefined, true)
      }
      if (result.kind === 'http' && (result.status === 403 || result.status === 404)) {
        missing(w)
        if (!isOrganizationUnavailable(result) && result.error !== 'topic_not_found' && result.error !== 'reply_chain_not_found') {
          void sync.channelUnavailable(channel)
        }
      } else publish(direction
        ? { ...view!, paging: false, pageError: direction }
        : { ...view!, status: 'error', paging: false })
    }
    try {
      if (target.replyRootId) {
        const result = checked(await run(() => reads.reply(target, { ...query, after_seq: target.createdSeq - 1, limit: 1 })))
        if (request !== token) return
        if (!result.ok) return fail(result)
        const message = result.data.messages.find(m => contains(target, m))
        const reply = message && knownMessageState(channelFor(target), view?.reply, message)
        if (result.data.root_id === target.replyRootId && reply && contains(target, reply)) {
          publish({ ...w, reply, asOfSeq: result.data.as_of_seq, status: 'ready', paging: false })
        } else missing(w)
        return
      }
      const forward = direction !== 'older'
      const page = checked(await run(() => reads.messages(target, {
        ...query, limit: forward && !direction ? PAGE_SIZE + 1 : PAGE_SIZE,
        ...(direction ? { as_of_seq: w.asOfSeq } : {}),
        ...(forward ? { after_seq: direction ? after : target.createdSeq - 1 } : { before_seq: before }),
      })))
      if (request !== token) return
      if (!page.ok) return fail(page)
      const data = page.data
      let older: MessagePage | undefined
      if (!direction) {
        if (!data.messages.some(message => contains(target, message))) {
          missing(w)
          return
        }
        const result = checked(await run(() => reads.messages(target, {
          history_generation: data.history_generation, as_of_seq: data.as_of_seq, before_seq: target.createdSeq, limit: PAGE_SIZE,
        })))
        if (request !== token) return
        if (!result.ok) return fail(result)
        older = result.data
      }
      const pageMessages = [...(older?.messages ?? []), ...data.messages]
      const current = view!
      const messages = merge(current, pageMessages, direction ? current.messages : [])
      if (!direction && !messages.some(message => contains(target, message))) {
        missing(w)
        return
      }
      const watermark = data.as_of_seq
      const olderPage = older ?? (forward ? undefined : data)
      if (!direction) before = target.createdSeq
      if (olderPage) before = olderPage.messages[0]?.created_seq ?? before
      if (forward) after = data.messages.at(-1)?.created_seq ?? after
      const trimmed = messages.length > SEARCH_WINDOW_LIMIT
      const kept = direction === 'older' ? messages.slice(0, SEARCH_WINDOW_LIMIT) : messages.slice(-SEARCH_WINDOW_LIMIT)
      if (trimmed && direction === 'older') after = kept.at(-1)!.created_seq
      if (trimmed && direction !== 'older') before = kept[0].created_seq
      const next = {
        ...current, status: 'ready' as const, messages: kept, paging: false, asOfSeq: watermark,
        hasOlder: (olderPage?.has_more ?? current.hasOlder) || (trimmed && direction !== 'older'),
        hasNewer: (forward ? data.has_more : current.hasNewer) || (trimmed && direction === 'older'),
      }
      const state = channelFor(target)
      // A fresh projection can cover ahead of the cursor. A later bootstrap cannot fill its old prefix.
      next.detached = (state?.streamBase ?? 0) > watermark || Boolean(state &&
        state.messages.length >= MAIN_MESSAGE_LIMIT && state.messages[0].created_seq > watermark + 1)
      if (!next.hasNewer && !next.detached) {
        const combined = merge(next, (state?.messages ?? []).filter(message => message.created_seq > watermark))
        if (combined.length > SEARCH_WINDOW_LIMIT) next.detached = true
        else next.messages = combined
      }
      publish(next)
      void sync.settleHistory(channel, pageMessages)
    } finally {
      deadline.clear()
      if (request === token) request = undefined
    }
  }

  const stop = sync.subscribe((changed, records, moves) => {
    const state = sync.get(), old = previous
    previous = state
    const w = view
    if (!w) return
    const id = w.target.channelId, channel = state.channels[id], prior = old.channels[id]
    if (state.organization === 'unavailable') {
      if (w.status !== 'missing' && old.organization !== state.organization) {
        cancel()
        publish({ ...w, status: w.status === 'ready' ? 'ready' : 'missing', paging: false, hasOlder: false, hasNewer: false })
      }
      return
    }
    if (!state.running || channel?.state === 'unavailable' ||
      (prior?.watched && !channel?.watched)) {
      if (w.status !== 'missing') missing(w)
      return
    }
    if (state.historyEpoch !== old.historyEpoch || (prior?.cursor != null && channel?.cursor === null)) {
      cancel()
      publish(initial(w.target))
      void read()
      return
    }
    if (w.status === 'missing' || !changed.has(id) || !channel?.watched) return
    if (!prior?.watched && w.status === 'loading') { void read(); return }
    const incoming = records?.get(id) ?? []
    const heldHit = w.reply ?? w.messages.find(m => m.id === w.target.messageId)
    const hitUpdate = incoming.find(m => m.id === w.target.messageId)
    const canonicalHit = hitUpdate && knownMessageState(channel, heldHit, hitUpdate)
    if (canonicalHit && !contains(w.target, canonicalHit)) { missing(w); return }
    const watermark = w.asOfSeq
    if (watermark === undefined) return
    const heldIds = new Set(w.messages.map(m => m.id))
    const updates = incoming.filter(m => heldIds.has(m.id))
    let messages = updates.length ? merge(w, updates) : w.messages
    const affectedByMove = (root: string, version: number) =>
      moves?.some(move => move.channel_id === id && move.root_id === root && move.version > version)
    if (moves?.length) {
      const hit = canonicalHit ?? heldHit
      const hitMoved = affectedByMove(hit?.reply_root_id ?? w.target.replyRootId ?? w.target.messageId, hit?.version ?? watermark)
      const visible = messages.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
      if (hitMoved || visible.length !== messages.length) {
        cancel()
        publish({ ...w, messages: visible, reply: hitMoved ? undefined : w.reply })
        void read()
        return
      }
    }
    if (w.target.replyRootId) {
      if (canonicalHit && canonicalHit !== w.reply) publish({ ...w, reply: canonicalHit })
      return
    }
    let detached = w.detached || (channel.streamBase ?? 0) > watermark
    if (!w.hasNewer && !detached) {
      const suffix = incoming.filter(m => !heldIds.has(m.id) && m.created_seq > watermark)
      if (suffix.length) {
        const combined = merge(w, suffix, messages)
        if (combined.length > SEARCH_WINDOW_LIMIT) detached = true
        else messages = combined
      }
    }
    if (detached !== w.detached || messages.length !== w.messages.length || messages.some((m, i) => m !== w.messages[i])) {
      publish({ ...w, messages, detached })
    }
  })
  return {
    get: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open(target: SearchResultTarget | undefined) {
      if (view?.target === target) return
      cancel()
      publish(target ? initial(target) : undefined)
      const channel = target && channelFor(target)
      if (view && channel?.state === 'unavailable') missing(view)
      else if (target && channel?.watched) void read()
    },
    retry: () => read(view?.pageError),
    loadOlder: () => view?.hasOlder ? read('older') : undefined,
    loadNewer: () => view?.hasNewer ? read('newer') : undefined,
    close() { stop(); cancel(); publish(undefined); listeners.clear() },
  }
}
