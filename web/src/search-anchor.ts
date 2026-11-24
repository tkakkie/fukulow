import { isOrganizationUnavailable, type ListTimelineQuery, type Message, type MessagePage, type Result, type TimelineItem, type TimelinePage } from './api'
import { knownMessageState } from './identity-order'
import type { SearchResultTarget } from './navigation'
import type { createSync } from './sync'
import { createRequestDeadlines } from './request-deadlines'
import { selectMainTimeline, type MainTimelineLine, type TopicBaseline } from './topic-selectors'
import {
  applyMainLiveUpdate, applyTimelineItems, buildMainSearchView, containsHit, initialView, isContinuityDetached, isMainChannel,
  itemMessage, itemPosition, mergeMessages, messagesFromLines, PAGE_SIZE, SEARCH_WINDOW_LIMIT,
  upperBoundForMain, upperBoundForTopic, type OpMode, type PageRead, type Reads, type SearchAnchorView,
} from './search-anchor-state'

export { SEARCH_WINDOW_LIMIT }

type QueuedOp = { mode: OpMode; resolve: () => void }

/** An authorized display projection. Only unfiltered sync can establish the Channel cursor. */
export function createSearchAnchor(sync: ReturnType<typeof createSync>, reads: Reads) {
  let view: SearchAnchorView | undefined
  let before = 0, after = 0
  let refreshWatermark = 0, forwardWatermark = 0
  let windowMessages: Message[] = []
  let baselines = new Map<string, TopicBaseline>()
  let liveMain: Message[] = []
  let activeToken: symbol | undefined
  let activeMode: OpMode | undefined
  let inFlightTransport: Promise<unknown> | undefined
  const queue: QueuedOp[] = []
  let staleSeq = 0
  let staleHitMoved = false
  let settling = false
  let previous = sync.get()
  const deadlines = createRequestDeadlines()
  const listeners = new Set<() => void>()

  const publish = (next: SearchAnchorView | undefined) => { view = next; listeners.forEach(listener => listener()) }
  const channelFor = (target: SearchResultTarget) => sync.get().channels[target.channelId]

  function resetState() {
    before = 0; after = 0; refreshWatermark = 0; forwardWatermark = 0
    windowMessages = []; baselines = new Map(); liveMain = []
  }

  function cancelAll() {
    activeToken = undefined
    activeMode = undefined
    staleSeq = 0
    staleHitMoved = false
    deadlines.cancel()
    for (const item of queue.splice(0)) item.resolve()
  }

  function missing(w: SearchAnchorView) {
    cancelAll()
    resetState()
    publish({ ...initialView(w.target), visit: w.visit, status: 'missing' })
  }

  function enqueue(mode: OpMode): Promise<void> {
    if (!view || sync.get().organization === 'unavailable' || !channelFor(view.target)?.watched) {
      return Promise.resolve()
    }
    if (activeMode === mode && mode !== 'initial') return Promise.resolve()
    const existing = queue.find(item => item.mode === mode)
    if (existing) {
      return new Promise<void>(resolve => {
        const prev = existing.resolve
        existing.resolve = () => { prev(); resolve() }
      })
    }
    return new Promise<void>(resolve => {
      queue.push({ mode, resolve })
      if (!activeToken && !inFlightTransport) void drain()
    })
  }

  function markStale(triggerSeq: number, hitMoved = false) {
    if (hitMoved) staleHitMoved = true
    staleSeq = Math.max(staleSeq, triggerSeq)
    if (!activeToken && !inFlightTransport) void drain()
  }

  async function drain(): Promise<void> {
    if (activeToken || inFlightTransport) return
    while (true) {
      if (inFlightTransport) return
      const w = view
      if (!w || sync.get().organization === 'unavailable' || !channelFor(w.target)?.watched) {
        for (const item of queue.splice(0)) item.resolve()
        staleSeq = 0
        staleHitMoved = false
        return
      }
      let next: QueuedOp | undefined
      let targetStaleSeq = 0
      if (staleHitMoved) {
        staleHitMoved = false
        staleSeq = 0
        for (const item of queue.splice(0)) item.resolve()
        next = { mode: 'initial', resolve: () => {} }
      } else if (queue.length > 0) {
        next = queue.shift()!
      } else if (staleSeq > 0 && w.status === 'ready' && !w.pageError) {
        targetStaleSeq = staleSeq
        staleSeq = 0
        next = { mode: 'refresh', resolve: () => {} }
      } else {
        return
      }
      if (next.mode === 'older' && (w.status !== 'ready' || !w.hasOlder)) {
        next.resolve()
        continue
      }
      if (next.mode === 'newer' && (w.status !== 'ready' || !w.hasNewer)) {
        next.resolve()
        continue
      }
      const token = Symbol()
      activeToken = token
      activeMode = next.mode
      let cancelled = false
      try {
        await executeOperation(token, next.mode, targetStaleSeq)
      } finally {
        cancelled = activeToken !== token
        if (!cancelled) {
          activeToken = undefined
          activeMode = undefined
        }
        next.resolve()
      }
      if (cancelled) return
    }
  }

  async function executeOperation(token: symbol, mode: OpMode, targetStaleSeq: number): Promise<void> {
    const startView = view
    if (!startView || sync.get().organization === 'unavailable' || !channelFor(startView.target)?.watched) return
    const { target } = startView
    const channel = target.channelId
    if (!Number.isSafeInteger(target.createdSeq) || target.createdSeq < 1) {
      missing(startView)
      return
    }
    publish(startView.status === 'ready' || mode !== 'initial'
      ? { ...startView, paging: true, pageError: undefined }
      : { ...startView, status: 'loading' })
    const deadline = deadlines.start<Result<never>>({ ok: false, kind: 'network' }, { timeoutMs: 10_000 })
    const safe = <T>(operation: () => Promise<Result<T>>): Promise<Result<T>> => {
      try { return operation().catch((): Result<T> => ({ ok: false, kind: 'network' })) }
      catch { return Promise.resolve({ ok: false, kind: 'network' }) }
    }
    const run = <T>(operation: () => Promise<Result<T>>): Promise<Result<T>> => {
      const request = safe(operation)
      inFlightTransport = request
      void request.finally(() => {
        if (inFlightTransport === request) {
          inFlightTransport = undefined
          if (!activeToken) void drain()
        }
      })
      return Promise.race([request, deadline.until])
    }

    const settlePage = (historyGeneration: string | undefined, messages: Message[]) => {
      if (!messages.length) return
      const state = sync.get()
      const ch = state.channels[channel]
      if (activeToken !== token || !state.running || state.organization === 'unavailable' || !ch?.watched || ch.state === 'unavailable') return
      if (historyGeneration !== undefined && state.historyGeneration !== undefined && historyGeneration !== state.historyGeneration) return
      settling = true
      try {
        void sync.settleHistory(channel, messages)
      } finally {
        settling = false
      }
    }

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (activeToken !== token || !view) return
        const w = view
        const restarted = attempt === 1
        const versionEpoch = channelFor(target)?.versionEpoch
        const query = { history_generation: sync.get().historyGeneration }
        const overtaken = (watermark: number) => {
          const state = channelFor(target)
          return Boolean(state && (state.versionEpoch !== versionEpoch || state.mutationSeq > watermark))
        }
        const checked = <T extends { as_of_seq: number }>(result: Result<T>): Result<T> => (
          result.ok && overtaken(result.data.as_of_seq)
            ? { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
            : result
        )
        const handleFailure = (result: Exclude<Result<unknown>, { ok: true }>, invalidated = false): 'retry' | 'done' => {
          if (result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) return 'retry'
          if (result.kind === 'http' && (result.status === 403 || result.status === 404)) {
            missing(w)
            if (!isOrganizationUnavailable(result) && result.error !== 'topic_not_found' && result.error !== 'reply_chain_not_found') {
              void sync.channelUnavailable(channel)
            }
            return 'done'
          }
          const rangeInvalidated = invalidated || restarted || mode === 'initial' ||
            (result.kind === 'http' && (result.error === 'snapshot_expired' || result.error === 'history_generation_changed'))
          if (rangeInvalidated) {
            resetState()
            staleSeq = 0
            staleHitMoved = false
            publish({ ...initialView(w.target), visit: w.visit, status: 'error' })
          } else {
            if (mode === 'refresh') staleSeq = 0
            publish({ ...view!, paging: false, pageError: mode as PageRead })
          }
          return 'done'
        }

        if (target.replyRootId) {
          const result = await run(() => reads.reply(target, { ...query, after_seq: target.createdSeq - 1, limit: 1 }))
          if (activeToken !== token) return
          if (!result.ok) {
            if (handleFailure(result) === 'retry') continue
            return
          }
          const message = result.data.messages.find(m => containsHit(target, m))
          const reply = message && knownMessageState(channelFor(target), view?.reply, message)
          if (result.data.root_id === target.replyRootId && reply && containsHit(target, reply)) {
            publish({ ...view!, reply, asOfSeq: result.data.as_of_seq, status: 'ready', paging: false })
          } else missing(w)
          return
        }

        const refreshing = mode === 'refresh'
        const forward = mode !== 'older'
        const fixed = mode !== 'initial' && !refreshing && !restarted

        if (isMainChannel(target)) {
          const lower = w.hasOlder ? before - 1 : 0
          let watermark = 0
          let olderTimeline: TimelinePage | undefined
          let newerTimeline: TimelinePage | undefined
          let pageItems: TimelineItem[] = []
          const replaceState = mode === 'initial' || refreshing || restarted
          let hasOlderNext = w.hasOlder
          let hasNewerNext = w.hasNewer
          let failed: Exclude<Result<unknown>, { ok: true }> | undefined

          const readTimelinePage = async (q: ListTimelineQuery, checkFreshness = true): Promise<Result<TimelinePage> | undefined> => {
            const res = await run(() => reads.timeline(target, q))
            if (activeToken !== token) return undefined
            if (res.ok) settlePage(res.data.history_generation, res.data.items.map(itemMessage))
            if (activeToken !== token) return undefined
            return checkFreshness ? checked(res) : res
          }
          const probeFresh = async (): Promise<TimelinePage | undefined> => {
            const fresh = await readTimelinePage({ ...query, limit: 1 }, false)
            if (activeToken !== token || !fresh) return undefined
            if (!fresh.ok) { failed = fresh; return undefined }
            if (overtaken(fresh.data.as_of_seq)) {
              failed = !restarted
                ? { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
                : { ok: false, kind: 'network' }
              return undefined
            }
            return fresh.data
          }

          if (mode === 'initial') {
            const fresh = await probeFresh()
            if (activeToken !== token) return
            if (!fresh) { if (failed && handleFailure(failed) === 'retry') continue; return }
            watermark = fresh.as_of_seq
            const gen = fresh.history_generation
            const newerRes = await readTimelinePage({
              history_generation: gen, as_of_seq: watermark, after_position: target.createdSeq - 1, limit: PAGE_SIZE + 1,
            })
            if (activeToken !== token || !newerRes) return
            if (!newerRes.ok) { if (handleFailure(newerRes) === 'retry') continue; return }
            if (!newerRes.data.items.some(item => item.kind === 'message' && containsHit(target, item.message))) {
              missing(w)
              return
            }
            const olderRes = await readTimelinePage({
              history_generation: gen, as_of_seq: watermark, before_position: target.createdSeq, limit: PAGE_SIZE,
            })
            if (activeToken !== token || !olderRes) return
            if (!olderRes.ok) { if (handleFailure(olderRes) === 'retry') continue; return }
            olderTimeline = olderRes.data
            newerTimeline = newerRes.data
            pageItems = [...olderTimeline.items, ...newerTimeline.items]
            hasOlderNext = olderTimeline.has_more
            hasNewerNext = newerTimeline.has_more
          } else if (mode === 'older') {
            if (fixed) {
              const res = await readTimelinePage({ ...query, as_of_seq: w.asOfSeq, before_position: before, limit: PAGE_SIZE })
              if (activeToken !== token || !res) return
              if (!res.ok) { if (handleFailure(res) === 'retry') continue; return }
              olderTimeline = res.data
              watermark = olderTimeline.as_of_seq
              pageItems = olderTimeline.items
              hasOlderNext = olderTimeline.has_more
            } else {
              const fresh = await probeFresh()
              if (activeToken !== token) return
              if (!fresh) { if (failed && handleFailure(failed) === 'retry') continue; return }
              watermark = fresh.as_of_seq
              const gen = fresh.history_generation
              const olderRes = await readTimelinePage({
                history_generation: gen, as_of_seq: watermark, before_position: before, limit: PAGE_SIZE,
              })
              if (activeToken !== token || !olderRes) return
              if (!olderRes.ok) { if (handleFailure(olderRes) === 'retry') continue; return }
              const retainedRes = await readTimelinePage({
                history_generation: gen, as_of_seq: watermark, after_position: before - 1, limit: SEARCH_WINDOW_LIMIT,
              })
              if (activeToken !== token || !retainedRes) return
              if (!retainedRes.ok) { if (handleFailure(retainedRes) === 'retry') continue; return }
              const effectiveUpper = upperBoundForMain(view!, after)
              const retainedItems = effectiveUpper < Infinity
                ? retainedRes.data.items.filter(item => itemPosition(item) <= effectiveUpper)
                : retainedRes.data.items
              olderTimeline = olderRes.data
              pageItems = [...olderTimeline.items, ...retainedItems]
              hasOlderNext = olderTimeline.has_more
              hasNewerNext = retainedRes.data.has_more || retainedItems.length < retainedRes.data.items.length
            }
          } else if (mode === 'newer') {
            if (fixed) {
              const res = await readTimelinePage({ ...query, as_of_seq: w.asOfSeq, after_position: after, limit: PAGE_SIZE })
              if (activeToken !== token || !res) return
              if (!res.ok) { if (handleFailure(res) === 'retry') continue; return }
              newerTimeline = res.data
              watermark = newerTimeline.as_of_seq
              pageItems = newerTimeline.items
              hasNewerNext = newerTimeline.has_more
            } else {
              const fresh = await probeFresh()
              if (activeToken !== token) return
              if (!fresh) { if (failed && handleFailure(failed) === 'retry') continue; return }
              watermark = fresh.as_of_seq
              const gen = fresh.history_generation
              const newerRes = await readTimelinePage({
                history_generation: gen, as_of_seq: watermark, after_position: after, limit: PAGE_SIZE,
              })
              if (activeToken !== token || !newerRes) return
              if (!newerRes.ok) { if (handleFailure(newerRes) === 'retry') continue; return }
              const retainedRes = await readTimelinePage({
                history_generation: gen, as_of_seq: watermark, before_position: after + 1, limit: SEARCH_WINDOW_LIMIT,
              })
              if (activeToken !== token || !retainedRes) return
              if (!retainedRes.ok) { if (handleFailure(retainedRes) === 'retry') continue; return }
              const retainedItems = w.hasOlder
                ? retainedRes.data.items.filter(item => itemPosition(item) >= before)
                : retainedRes.data.items
              const retainedTruncatedOlder = retainedRes.data.has_more &&
                (!w.hasOlder || (retainedRes.data.items[0] !== undefined && itemPosition(retainedRes.data.items[0]) > before))
              newerTimeline = newerRes.data
              pageItems = [...retainedItems, ...newerTimeline.items]
              hasOlderNext = w.hasOlder || retainedTruncatedOlder
              hasNewerNext = newerTimeline.has_more
            }
          } else {
            const fresh = await probeFresh()
            if (activeToken !== token) return
            if (!fresh) { if (failed && handleFailure(failed) === 'retry') continue; return }
            watermark = fresh.as_of_seq
            const gen = fresh.history_generation
            const res = await readTimelinePage({
              history_generation: gen, as_of_seq: watermark, after_position: lower, limit: SEARCH_WINDOW_LIMIT + 1,
            })
            if (activeToken !== token || !res) return
            if (!res.ok) { if (handleFailure(res, true) === 'retry') continue; return }
            const effectiveUpper = upperBoundForMain(view!, after)
            pageItems = effectiveUpper < Infinity
              ? res.data.items.filter(item => itemPosition(item) <= effectiveUpper)
              : res.data.items
            hasOlderNext = w.hasOlder
            hasNewerNext = res.data.has_more || pageItems.length < res.data.items.length
          }

          if (activeToken !== token || !view) return
          if (overtaken(watermark)) {
            if (handleFailure({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }) === 'retry') continue
            return
          }
          const current = view
          const state = channelFor(target)
          const applied = applyTimelineItems(
            state,
            target,
            pageItems,
            watermark,
            replaceState ? [] : windowMessages,
            replaceState ? new Map<string, TopicBaseline>() : new Map(baselines),
          )
          if ((mode === 'initial' || (refreshing && current.messages.some(message => containsHit(target, message)))) &&
              !applied.messages.some(message => containsHit(target, message))) {
            missing(w)
            return
          }
          if (replaceState) refreshWatermark = watermark
          if (forward || (mode === 'older' && restarted && !hasNewerNext)) forwardWatermark = watermark
          if (replaceState && watermark >= staleSeq && !staleHitMoved) staleSeq = 0

          const built = buildMainSearchView({
            mode, restarted, replaceState, target, w, current, state, applied,
            olderTimeline, newerTimeline, watermark, forwardWatermark, before, after,
            hasOlderNext, hasNewerNext, liveMain, targetStaleSeq,
          })
          windowMessages = built.windowMessages
          baselines = built.baselines
          liveMain = built.liveMain
          before = built.before
          after = built.after
          if (built.followupStaleSeq > 0) staleSeq = Math.max(staleSeq, built.followupStaleSeq)
          publish(built.next)
          return
        }

        // Topic-channel search
        const lower = w.hasOlder ? before - 1 : 0
        const response = await run(() => reads.messages(target, {
          ...query, limit: refreshing ? SEARCH_WINDOW_LIMIT + 1 : mode !== 'initial' ? PAGE_SIZE : PAGE_SIZE + 1,
          ...(fixed ? { as_of_seq: w.asOfSeq } : {}),
          ...(forward ? { after_seq: refreshing ? lower : mode !== 'initial' ? after : target.createdSeq - 1 } : { before_seq: before }),
        }))
        if (activeToken !== token) return
        if (response.ok) settlePage(response.data.history_generation, response.data.messages)
        const page = fixed ? checked(response) : response
        if (!page.ok) { if (handleFailure(page) === 'retry') continue; return }
        const data = page.data
        if (mode !== 'initial' && !fixed && overtaken(data.as_of_seq)) {
          if (handleFailure({ ok: false, kind: 'network' }) === 'retry') continue
          return
        }
        let older: MessagePage | undefined
        if (mode === 'initial') {
          if (!data.messages.some(message => containsHit(target, message))) {
            missing(w)
            return
          }
          const olderRes = await run(() => reads.messages(target, {
            history_generation: data.history_generation, as_of_seq: data.as_of_seq, before_seq: target.createdSeq, limit: PAGE_SIZE,
          }))
          if (activeToken !== token) return
          if (olderRes.ok) settlePage(olderRes.data.history_generation, olderRes.data.messages)
          const result = checked(olderRes)
          if (!result.ok) { if (handleFailure(result) === 'retry') continue; return }
          older = result.data
        }
        const current = view!
        const state = channelFor(target)
        const effectiveUpper = upperBoundForTopic(current, after)
        const pageMessages = refreshing ? data.messages.filter(message => message.created_seq <= effectiveUpper)
          : [...(older?.messages ?? []), ...data.messages]
        let retained = mode !== 'initial' ? current.messages : []
        if (refreshing) {
          const covered = data.has_more ? Math.min(data.messages.at(-1)?.created_seq ?? lower, effectiveUpper) : effectiveUpper
          const returned = new Set(pageMessages.map(message => message.id))
          retained = retained.filter(message => message.created_seq > covered || message.version > data.as_of_seq || returned.has(message.id))
        }
        const messages = mergeMessages(state, target, pageMessages, retained)
        if ((mode === 'initial' || (refreshing && current.messages.some(message => containsHit(target, message)))) &&
            !messages.some(message => containsHit(target, message))) {
          missing(w)
          return
        }
        const watermark = data.as_of_seq
        if (mode === 'initial' || refreshing) {
          refreshWatermark = watermark
          if (watermark >= staleSeq && !staleHitMoved) staleSeq = 0
        }
        if (forward) forwardWatermark = watermark
        const olderPage = older ?? (forward ? undefined : data)
        if (mode === 'initial') before = target.createdSeq
        if (olderPage) before = olderPage.messages[0]?.created_seq ?? before
        if (refreshing && !w.hasOlder) before = messages[0]?.created_seq ?? before
        if (forward) after = pageMessages.at(-1)?.created_seq ?? after
        const trimmed = messages.length > SEARCH_WINDOW_LIMIT
        const keepStart = mode === 'older' || refreshing
        const kept = keepStart ? messages.slice(0, SEARCH_WINDOW_LIMIT) : messages.slice(-SEARCH_WINDOW_LIMIT)
        if (trimmed && keepStart) after = kept.at(-1)!.created_seq
        if (trimmed && !keepStart) before = kept[0].created_seq
        const stickyDetached = (refreshing || mode === 'older') && current.detached
        const next: SearchAnchorView = {
          ...current, status: 'ready', messages: kept, lines: [] as MainTimelineLine[], paging: false, asOfSeq: watermark,
          hasOlder: (olderPage?.has_more ?? current.hasOlder) || (trimmed && !keepStart),
          hasNewer: (forward ? data.has_more : current.hasNewer) || (trimmed && keepStart) ||
            (refreshing && pageMessages.length < data.messages.length),
          detached: stickyDetached || isContinuityDetached(state, forwardWatermark),
        }
        if (!next.hasNewer && !next.detached) {
          const combined = mergeMessages(state, target, (state?.messages ?? []).filter(message => message.created_seq > forwardWatermark), next.messages)
          if (combined.length > SEARCH_WINDOW_LIMIT) next.detached = true
          else next.messages = combined
        }
        publish(next)
        return
      }
    } finally {
      deadline.clear()
    }
  }

  const stop = sync.subscribe((changed, records, moves) => {
    const state = sync.get(), old = previous
    previous = state
    if (settling) return
    const w = view
    if (!w) return
    const id = w.target.channelId, channel = state.channels[id], prior = old.channels[id]
    if (state.organization === 'unavailable') {
      if (w.status !== 'missing' && old.organization !== state.organization) {
        cancelAll()
        publish({ ...w, status: w.status === 'ready' ? 'ready' : 'missing', paging: false, hasOlder: false, hasNewer: false })
      }
      return
    }
    if (!state.running || channel?.state === 'unavailable' || (prior?.watched && !channel?.watched)) {
      if (w.status !== 'missing') missing(w)
      return
    }
    if (state.historyEpoch !== old.historyEpoch || (prior?.cursor != null && channel?.cursor === null)) {
      cancelAll()
      resetState()
      publish(initialView(w.target))
      void enqueue('initial')
      return
    }
    if (w.status === 'missing' || !changed.has(id) || !channel?.watched) return
    if (!prior?.watched && w.status === 'loading') { void enqueue('initial'); return }
    const incoming = records?.get(id) ?? []
    const heldHit = w.reply ?? w.messages.find(m => m.id === w.target.messageId)
    const hitUpdate = incoming.find(m => m.id === w.target.messageId)
    const canonicalHit = hitUpdate && knownMessageState(channel, heldHit, hitUpdate)
    if (canonicalHit && !containsHit(w.target, canonicalHit)) { missing(w); return }
    const watermark = w.asOfSeq
    const topicMove = w.target.topicId && !w.target.replyRootId && moves?.some(move =>
      move.channel_id === id && move.destination_topic_id === w.target.topicId &&
      move.version > (watermark === undefined ? 0 : refreshWatermark))
    if (watermark === undefined) {
      if (topicMove || moves?.some(move => move.channel_id === id && move.root_id === w.target.replyRootId)) {
        markStale(1, true)
      }
      return
    }

    if (isMainChannel(w.target)) {
      const update = applyMainLiveUpdate({
        view: w, channel, incoming, moves, before, refreshWatermark, forwardWatermark,
        windowMessages, baselines, liveMain, canonicalHit, heldHit, watermark,
      })
      if (update.dirty || update.detached !== w.detached) {
        windowMessages = update.nextWindow
        baselines = update.nextBaselines
        liveMain = update.nextLiveMain
        const lines = selectMainTimeline(liveMain, windowMessages, baselines.values())
        publish({ ...w, messages: messagesFromLines(lines), lines, detached: update.detached })
      }
      if (update.hitMoved || update.refreshSeq > 0) markStale(update.refreshSeq, update.hitMoved)
      return
    }

    const affectedByMove = (root: string, version: number) =>
      moves?.some(move => move.channel_id === id && move.root_id === root && move.version > version)
    const heldIds = new Set(w.messages.map(m => m.id))
    const updates = incoming.filter(m => heldIds.has(m.id))
    let messages = updates.length ? mergeMessages(channel, w.target, updates, w.messages) : w.messages
    if (moves?.length) {
      const hit = canonicalHit ?? heldHit
      const hitMoved = Boolean(affectedByMove(hit?.reply_root_id ?? w.target.replyRootId ?? w.target.messageId, hit?.version ?? watermark))
      const visible = messages.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
      if (hitMoved || topicMove || visible.length !== messages.length) {
        const moveVersion = moves.reduce((max, move) => (move.channel_id === id ? Math.max(max, move.version) : max), watermark + 1)
        publish({ ...w, messages: visible, reply: hitMoved ? undefined : w.reply })
        markStale(moveVersion, hitMoved)
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
        const combined = mergeMessages(channel, w.target, suffix, messages)
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
      cancelAll()
      resetState()
      publish(target ? initialView(target) : undefined)
      const channel = target && channelFor(target)
      if (view && channel?.state === 'unavailable') missing(view)
      else if (target && channel?.watched) void enqueue('initial')
    },
    retry: () => {
      if (!view) return undefined
      if (view.status === 'error') return enqueue('initial')
      if (view.pageError) return enqueue(view.pageError)
      return undefined
    },
    loadOlder: () => view?.status === 'ready' && view.hasOlder ? enqueue('older') : undefined,
    loadNewer: () => view?.status === 'ready' && view.hasNewer ? enqueue('newer') : undefined,
    close() { stop(); cancelAll(); resetState(); publish(undefined); listeners.clear() },
  }
}
