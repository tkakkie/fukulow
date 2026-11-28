import { isChannelDenial, isOrganizationUnavailable, type ListMessagesQuery, type ListTimelineQuery, type Message, type MessagePage, type ReplyChainPage, type ReplyChainQuery, type Result, type TimelinePage } from './api'
import { knownMessageState } from './identity-order'
import type { SearchResultTarget } from './navigation'
import type { createSync } from './sync'
import { createSearchRequestControl, type SearchRequest } from './search-request-control'
import { MAIN_MESSAGE_LIMIT } from './protocol-types'
import { initialSearchView as initial, isSearchSnapshotExpired as isExpired,
  matchesSearchTarget as contains, type SearchAnchorView as View } from './search-anchor-view'
import { createMainSearchAnchor } from './search-main-anchor'
import type { MainSearchDirection as PageRead } from './search-main-read'
import { SEARCH_PAGE_SIZE as PAGE_SIZE, SEARCH_WINDOW_LIMIT } from './search-main-window'

export { SEARCH_WINDOW_LIMIT }
const expired = { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' } as const
const isMain = (target: SearchResultTarget) => !target.topicId && !target.replyRootId
type Reads = {
  timeline(target: SearchResultTarget, query: ListTimelineQuery, signal?: AbortSignal): Promise<Result<TimelinePage>>
  messages(target: SearchResultTarget, query: ListMessagesQuery, signal?: AbortSignal): Promise<Result<MessagePage>>
  reply(target: SearchResultTarget, query: ReplyChainQuery, signal?: AbortSignal): Promise<Result<ReplyChainPage>>
}
type TopicRecovery = Pick<View, 'hasOlder' | 'hasNewer' | 'detached'> & { before: number; after: number }

/** An authorized display projection. Only unfiltered sync can establish the Channel cursor. */
export function createSearchAnchor(sync: ReturnType<typeof createSync>, reads: Reads) {
  let view: View | undefined
  let topicRecovery: TopicRecovery | undefined
  let before = 0, after = 0
  let refreshWatermark = 0, forwardWatermark = 0
  let previous = sync.get()
  const requests = createSearchRequestControl()
  const listeners = new Set<() => void>()
  const publish = (next: View | undefined) => { view = next; listeners.forEach(listener => listener()) }
  const main = createMainSearchAnchor(sync, reads.timeline, { get: () => view, publish, missing, fail: handleFailure })
  function clearWindow() { main.clear(); topicRecovery = undefined }
  function missing(w: View) {
    requests.cancel()
    clearWindow()
    publish({ ...initial(w.target), visit: w.visit, status: 'missing' })
  }
  const channelFor = (target: SearchResultTarget) => sync.get().channels[target.channelId]
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

  function canRead(w: View | undefined, mode?: PageRead): w is View {
    return Boolean(w && sync.get().organization !== 'unavailable' && channelFor(w.target)?.watched &&
      (mode !== 'older' || w.hasOlder || main.canPage('older') || topicRecovery?.hasOlder) &&
      (mode !== 'newer' || w.hasNewer || main.canPage('newer') || topicRecovery?.hasNewer))
  }

  function showError(w: View, mode?: PageRead) {
    publish({ ...w, paging: false, pageError: mode, status: w.status === 'loading' ? 'error' : w.status })
  }

  function read(mode?: PageRead, automatic = false) {
    if (!canRead(view, mode)) return Promise.resolve()
    const visit = view.visit
    let installed = false
    return requests.enqueue(mode ?? 'initial', async request => {
      if (automatic && view?.pageError && !main.needsMutationRefresh(view.target)) return
      installed = await executeRead(request, mode)
    }, () => {
      if (canRead(view, mode)) showError(isMain(view.target) ? main.afterTimeout(view, mode) : view, mode)
    }).then(() => {
      if (installed && view?.visit === visit && !view.pageError && main.needsRefresh(view.target)) void read('refresh', true)
    })
  }

  function handleFailure(w: View, failure: Exclude<Result<unknown>, { ok: true }>, mode?: PageRead) {
    if (failure.kind === 'http' && (failure.status === 403 || failure.status === 404)) {
      missing(w)
      if (!isOrganizationUnavailable(failure) &&
        isChannelDenial(failure, { statuses: [403, 404], localNotFound: 'topic_not_found' }) &&
        failure.error !== 'reply_chain_not_found') {
        void sync.channelUnavailable(w.target.channelId)
      }
    } else showError(w, mode)
  }

  async function executeRead(request: SearchRequest, mode?: PageRead) {
    const w = view
    if (!canRead(w, mode)) return false
    if (!Number.isSafeInteger(w.target.createdSeq) || w.target.createdSeq < 1) {
      missing(w)
      return false
    }
    if (isMain(w.target)) return main.execute(request, w, mode)
    await executeMessageRead(request, mode)
    return false
  }

  async function executeMessageRead(request: SearchRequest, mode?: PageRead, restarted = false): Promise<void> {
    const w = view
    if (!canRead(w, mode)) return
    const { target } = w
    const channel = target.channelId
    const versionEpoch = channelFor(target)?.versionEpoch
    publish(w.status === 'ready' || mode
      ? { ...w, paging: true, pageError: undefined }
      : { ...w, status: 'loading' })
    const query = { history_generation: sync.get().historyGeneration }
    const overtaken = (watermark: number) => {
      const state = channelFor(target)
      return state && (state.versionEpoch !== versionEpoch || state.mutationSeq > watermark)
    }
    const checked = (result: Result<MessagePage>): Result<MessagePage> => {
      if (result.ok && overtaken(result.data.as_of_seq)) {
        return { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
      }
      return result
    }
    const fail = (result: Exclude<Result<unknown>, { ok: true }>) => {
      if (isExpired(result)) {
        if (view?.asOfSeq !== undefined) {
          topicRecovery = { before, after: Math.max(after, view.messages.at(-1)?.created_seq ?? 0),
            hasOlder: view.hasOlder, hasNewer: view.hasNewer, detached: view.detached }
          publish({ ...initial(w.target), visit: w.visit })
        }
        if (!restarted) return executeMessageRead(request, mode, true)
      }
      handleFailure(view ?? w, result, mode)
    }
    if (topicRecovery) {
      const bounds = topicRecovery
      const lower = bounds.hasOlder ? bounds.before - 1 : 0
      const range = await request.run(signal => reads.messages(target, {
        ...query, after_seq: lower, limit: SEARCH_WINDOW_LIMIT + 1,
      }, signal))
      if (!request.isCurrent()) return
      if (!range.ok) return fail(range)
      const { as_of_seq: watermark, history_generation } = range.data
      if (overtaken(watermark)) return fail(expired)
      const held = range.data.messages.filter(message =>
        (!bounds.hasNewer && !bounds.detached) || message.created_seq <= bounds.after)
      const fixed = { history_generation, as_of_seq: watermark }
      const more = mode === 'older' && lower > 0 ? { before_seq: bounds.before }
        : mode === 'newer' ? { after_seq: bounds.after } : undefined
      const page = more ? checked(await request.run(signal => reads.messages(target, { ...fixed, ...more, limit: PAGE_SIZE }, signal))) : undefined
      if (!request.isCurrent()) return
      if (page && !page.ok) return fail(page)
      if (overtaken(watermark)) return fail(expired)
      const ordered = merge(w, [...held, ...(page?.data.messages ?? [])], [])
      const keepStart = mode !== 'newer'
      const messages = keepStart ? ordered.slice(0, SEARCH_WINDOW_LIMIT) : ordered.slice(-SEARCH_WINDOW_LIMIT)
      const trimmed = messages.length < ordered.length
      before = messages[0]?.created_seq ?? bounds.before
      after = messages.at(-1)?.created_seq ?? bounds.after
      refreshWatermark = forwardWatermark = watermark
      topicRecovery = undefined
      publish({ ...w, status: 'ready', paging: false, pageError: undefined, asOfSeq: watermark, messages,
        detached: bounds.detached, hasOlder: (mode === 'older' ? page?.data.has_more ?? false : bounds.hasOlder) || (trimmed && !keepStart),
        hasNewer: (mode === 'newer' ? page?.data.has_more ?? false : bounds.hasNewer || range.data.has_more) || (trimmed && keepStart) })
      void sync.settleHistory(channel, [...held, ...(page?.data.messages ?? [])])
      return
    }
    if (target.replyRootId) {
      const result = await request.run(signal => reads.reply(target, { ...query, after_seq: target.createdSeq - 1, limit: 1 }, signal))
      if (!request.isCurrent()) return
      if (!result.ok) return fail(result)
      const message = result.data.messages.find(m => contains(target, m))
      const reply = message && knownMessageState(channelFor(target), view?.reply, message)
      if (result.data.root_id === target.replyRootId && reply && contains(target, reply)) {
        publish({ ...w, reply, asOfSeq: result.data.as_of_seq, status: 'ready', paging: false })
      } else missing(w)
      return
    }
    const refreshing = mode === 'refresh'
    const forward = mode !== 'older'
    const fixed = mode && !refreshing && !restarted
    const lower = w.hasOlder ? before - 1 : 0
    const upper = w.hasNewer || w.detached ? Math.max(after, w.messages.at(-1)?.created_seq ?? 0) : Infinity
    const response = await request.run(signal => reads.messages(target, {
      ...query, limit: refreshing ? SEARCH_WINDOW_LIMIT + 1 : mode ? PAGE_SIZE : PAGE_SIZE + 1,
      ...(fixed ? { as_of_seq: w.asOfSeq } : {}),
      ...(forward ? { after_seq: refreshing ? lower : mode ? after : target.createdSeq - 1 } : { before_seq: before }),
    }, signal))
    if (!request.isCurrent()) return
    const page = fixed ? checked(response) : response
    if (!page.ok) return fail(page)
    const data = page.data
    // A fresh continuation or refresh may still be overtaken while in flight.
    if (mode && !fixed && overtaken(data.as_of_seq)) return fail({ ok: false, kind: 'network' })
    let older: MessagePage | undefined
    if (!mode) {
      if (!data.messages.some(message => contains(target, message))) {
        missing(w)
        return
      }
      const result = checked(await request.run(signal => reads.messages(target, {
        history_generation: data.history_generation, as_of_seq: data.as_of_seq, before_seq: target.createdSeq, limit: PAGE_SIZE,
      }, signal)))
      if (!request.isCurrent()) return
      if (!result.ok) return fail(result)
      older = result.data
    }
    const pageMessages = refreshing ? data.messages.filter(message => message.created_seq <= upper)
      : [...(older?.messages ?? []), ...data.messages]
    const current = view!
    let retained = mode ? current.messages : []
    if (refreshing) {
      const covered = data.has_more ? Math.min(data.messages.at(-1)?.created_seq ?? lower, upper) : upper
      const returned = new Set(pageMessages.map(message => message.id))
      retained = retained.filter(message => message.created_seq > covered || message.version > data.as_of_seq || returned.has(message.id))
    }
    const messages = merge(current, pageMessages, retained)
    if ((!mode || (refreshing && current.messages.some(message => contains(target, message)))) &&
        !messages.some(message => contains(target, message))) {
      missing(w)
      return
    }
    const watermark = data.as_of_seq
    if (!mode || refreshing) refreshWatermark = watermark
    if (forward) forwardWatermark = watermark
    const olderPage = older ?? (forward ? undefined : data)
    if (!mode) before = target.createdSeq
    if (olderPage) before = olderPage.messages[0]?.created_seq ?? before
    if (refreshing && !w.hasOlder) before = messages[0]?.created_seq ?? before
    if (forward) after = pageMessages.at(-1)?.created_seq ?? after
    const trimmed = messages.length > SEARCH_WINDOW_LIMIT
    const keepStart = mode === 'older' || refreshing
    const kept = keepStart ? messages.slice(0, SEARCH_WINDOW_LIMIT) : messages.slice(-SEARCH_WINDOW_LIMIT)
    if (trimmed && keepStart) after = kept.at(-1)!.created_seq
    if (trimmed && !keepStart) before = kept[0].created_seq
    const next = {
      ...current, status: 'ready' as const, messages: kept, paging: false, asOfSeq: watermark,
      hasOlder: (olderPage?.has_more ?? current.hasOlder) || (trimmed && !keepStart),
      hasNewer: (forward ? data.has_more : current.hasNewer) || (trimmed && keepStart) ||
        (refreshing && pageMessages.length < data.messages.length),
    }
    const state = channelFor(target)
    // A fresh projection can cover ahead of the cursor. A later bootstrap cannot fill its old prefix.
    next.detached = (state?.streamBase ?? 0) > forwardWatermark || Boolean(state &&
      state.messages.length >= MAIN_MESSAGE_LIMIT && state.messages[0].created_seq > forwardWatermark + 1)
    if (!next.hasNewer && !next.detached) {
      const combined = merge(next, (state?.messages ?? []).filter(message => message.created_seq > forwardWatermark))
      if (combined.length > SEARCH_WINDOW_LIMIT) next.detached = true
      else next.messages = combined
    }
    publish(next)
    void sync.settleHistory(channel, pageMessages)
  }

  const stop = sync.subscribe((changed, records, moves) => {
    const state = sync.get(), old = previous
    previous = state
    const w = view
    if (!w) return
    const id = w.target.channelId, channel = state.channels[id], prior = old.channels[id]
    if (state.organization === 'unavailable') {
      if (w.status !== 'missing' && old.organization !== state.organization) {
        requests.cancel()
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
      requests.cancel()
      clearWindow()
      publish(initial(w.target))
      void read()
      return
    }
    if (w.status === 'missing' || !changed.has(id) || !channel?.watched) return
    if (!prior?.watched && w.status === 'loading') { void read(); return }
    const incoming = records?.get(id) ?? []
    if (isMain(w.target)) {
      if (main.update(w, channel, incoming, moves ?? [])) void read('refresh', true)
      return
    }
    const heldHit = w.reply ?? w.messages.find(m => m.id === w.target.messageId)
    const hitUpdate = incoming.find(m => m.id === w.target.messageId)
    const canonicalHit = hitUpdate && knownMessageState(channel, heldHit, hitUpdate)
    if (canonicalHit && !contains(w.target, canonicalHit)) { missing(w); return }
    const watermark = w.asOfSeq
    // A continuation's new W only covers that page, so it cannot supersede a Move elsewhere in the window.
    const topicMove = w.target.topicId && !w.target.replyRootId && moves?.some(move =>
      move.channel_id === id && move.destination_topic_id === w.target.topicId &&
      move.version > (watermark === undefined ? 0 : refreshWatermark))
    if (watermark === undefined) {
      if (topicRecovery) return
      if (topicMove || moves?.some(move => move.channel_id === id && move.root_id === w.target.replyRootId)) {
        requests.cancel()
        void read()
      }
      return
    }
    const heldIds = new Set(w.messages.map(m => m.id))
    const updates = incoming.filter(m => heldIds.has(m.id))
    let messages = updates.length ? merge(w, updates) : w.messages
    const affectedByMove = (root: string, version: number) =>
      moves?.some(move => move.channel_id === id && move.root_id === root && move.version > version)
    if (moves?.length) {
      const hit = canonicalHit ?? heldHit
      const hitMoved = affectedByMove(hit?.reply_root_id ?? w.target.replyRootId ?? w.target.messageId, hit?.version ?? watermark)
      const visible = messages.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
      if (hitMoved || topicMove || visible.length !== messages.length) {
        requests.cancel()
        publish({ ...w, messages: visible, reply: hitMoved ? undefined : w.reply })
        void read(hitMoved ? undefined : 'refresh')
        return
      }
    }
    if (w.target.replyRootId) {
      if (canonicalHit && canonicalHit !== w.reply) publish({ ...w, reply: canonicalHit })
      return
    }
    let detached = w.detached || (channel.streamBase ?? 0) > forwardWatermark
    if (!w.hasNewer && !detached) {
      const suffix = incoming.filter(m => !heldIds.has(m.id) && m.created_seq > forwardWatermark)
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
      requests.cancel()
      clearWindow()
      publish(target ? initial(target) : undefined)
      const channel = target && channelFor(target)
      if (view && channel?.state === 'unavailable') missing(view)
      else if (target && channel?.watched) void read()
    },
    retry: () => read(view?.pageError),
    loadOlder: () => view?.hasOlder ? read('older') : undefined,
    loadNewer: () => view?.hasNewer ? read('newer') : undefined,
    close() { stop(); requests.cancel(); clearWindow(); publish(undefined); listeners.clear() },
  }
}
