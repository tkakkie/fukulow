import type { ListTimelineQuery, Message, Result, TimelinePage } from './api'
import { knownMessageState } from './identity-order'
import type { SearchResultTarget } from './navigation'
import type { ChannelState, MoveVersion } from './protocol-types'
import { initialSearchView, isSearchSnapshotExpired, matchesSearchTarget, type SearchAnchorView } from './search-anchor-view'
import { readMainSearch, type MainSearchDirection } from './search-main-read'
import { capMainSearch, discardStaleMainRows, itemMessage, mainSearchBounds, mainSearchLines, reconcileMainSearch,
  SEARCH_WINDOW_LIMIT, type MainSearchBounds, type MainSearchWindow } from './search-main-window'
import type { SearchRequest } from './search-request-control'
import type { createSync } from './sync'

type ReadTimeline = (target: SearchResultTarget, query: ListTimelineQuery, signal?: AbortSignal) => Promise<Result<TimelinePage>>
type Presentation = {
  get(): SearchAnchorView | undefined
  publish(view: SearchAnchorView): void
  missing(view: SearchAnchorView): void
  fail(view: SearchAnchorView, result: Exclude<Result<unknown>, { ok: true }>, mode?: MainSearchDirection): void
}
const superseded = { ok: false, kind: 'network' } as const

export function createMainSearchAnchor(sync: ReturnType<typeof createSync>, readTimeline: ReadTimeline, presentation: Presentation) {
  let window: MainSearchWindow | undefined
  let recovery: MainSearchBounds | undefined
  let rebuilding: MainSearchDirection | undefined
  const channelFor = (target: SearchResultTarget) => sync.get().channels[target.channelId]
  const bounds = (target: SearchResultTarget) => recovery ?? (window && mainSearchBounds(window, target.createdSeq))
  const needsMutationRefresh = (channel: ChannelState | undefined) =>
    !!window && !!channel && channel.mutationSeq > window.watermark
  const needsRefresh = (target: SearchResultTarget) => !!window && reconcileMainSearch(window, channelFor(target)).refresh

  function discard(view: SearchAnchorView) {
    if (!window) return view
    recovery = bounds(view.target)
    window = undefined
    return { ...initialSearchView(view.target), visit: view.visit }
  }

  function install(view: SearchAnchorView, next: MainSearchWindow, readCompleted = false) {
    window = next
    const lines = mainSearchLines(next)
    const messages = lines.flatMap(line => line.kind === 'message' ? [line.message] : [])
    presentation.publish({ ...view, status: 'ready', lines, messages, asOfSeq: next.watermark,
      ...(readCompleted ? { paging: false, pageError: undefined } : {}),
      hasOlder: next.hasOlder, hasNewer: next.hasNewer, detached: next.detached })
  }

  function update(view: SearchAnchorView, channel: ChannelState, records: Message[], moves: readonly MoveVersion[]) {
    const update = records.find(message => message.id === view.target.messageId)
    const hit = update && knownMessageState(channel, view.messages.find(message => message.id === update.id), update)
    if (hit && !matchesSearchTarget(view.target, hit)) {
      presentation.missing(view)
      return false
    }
    if (!window) return false
    const mutation = needsMutationRefresh(channel)
    const current = mutation ? discardStaleMainRows(window, channel, records, moves) : window
    // Keep the original paging positions when one of the boundary bodies is discarded.
    if (current !== window) recovery = bounds(view.target)
    const { window: next, refresh } = reconcileMainSearch(current, channel)
    if (next !== window) install(view, next)
    return refresh && (!view.pageError || mutation)
  }

  async function execute(request: SearchRequest, view: SearchAnchorView, mode?: MainSearchDirection): Promise<boolean> {
    const { target } = view
    if (mode === 'refresh' && window && !needsRefresh(target) && !view.pageError) return false
    presentation.publish({ ...view, status: window ? view.status : 'loading', paging: true, pageError: undefined })
    let retriedExpiry = false
    let fresh = false
    try {
      while (request.isCurrent()) {
        const current = window
        const retained = bounds(target)
        const continuing = current?.items.length && mode && mode !== 'refresh' && !fresh && !recovery ? current : undefined
        rebuilding = continuing ? undefined : mode
        const versionEpoch = channelFor(target)?.versionEpoch
        const overtaken = (watermark: number) => {
          const state = channelFor(target)
          return state && (state.versionEpoch !== versionEpoch || state.mutationSeq > watermark)
        }
        let snapshot = continuing && { generation: continuing.generation, watermark: continuing.watermark }
        const result = await readMainSearch(async query => {
          const page = await request.run(signal => readTimeline(target, query, signal))
          if (!request.isCurrent()) return page
          if (!page.ok) {
            const latest = presentation.get()
            if (latest && isSearchSnapshotExpired(page)) {
              const empty = discard(latest)
              if (empty !== latest) presentation.publish({ ...empty, paging: true })
            }
            return page
          }
          const { history_generation: generation, as_of_seq: watermark, items } = page.data
          if (snapshot && (snapshot.generation !== generation || snapshot.watermark !== watermark)) return superseded
          snapshot = { generation, watermark }
          // Authorized reads may settle a pending send even if a later page invalidates the view.
          void sync.settleHistory(target.channelId, items.map(itemMessage))
          return overtaken(watermark) ? superseded : page
        }, target, sync.get().historyGeneration, mode, continuing, retained)
        const latest = presentation.get()
        if (!request.isCurrent() || !latest) return false
        const checked = result.ok && overtaken(result.data.watermark) ? superseded : result
        if (!checked.ok) {
          // A locally superseded response can never replace the view. Try a fresh read within
          // the same deadline while the unaffected rows remain visible.
          if (checked === superseded) {
            fresh = true
            continue
          }
          if (isSearchSnapshotExpired(checked) && !retriedExpiry) {
            retriedExpiry = true
            fresh = true
            continue
          }
          presentation.fail(rebuilding ? discard(latest) : latest, checked, mode)
          return false
        }
        let next = checked.data
        const { first, last } = mainSearchBounds(next, target.createdSeq)
        const coversHit = first <= target.createdSeq && target.createdSeq <= last
        if ((!mode || (rebuilding && coversHit)) && !next.items.some(item => matchesSearchTarget(target, itemMessage(item)))) {
          presentation.missing(latest)
          return false
        }
        const held = bounds(target)
        if (mode === 'refresh' && held?.detached && !current?.detached) {
          next = capMainSearch(next, held.last)
        } else if (mode === 'older' && window?.detached && window.watermark === next.watermark) {
          const tail = next.hasNewer ? [] : window.tail.slice(0, SEARCH_WINDOW_LIMIT - next.items.length)
          next = { ...next, detached: true, tail }
        }
        recovery = undefined
        install(latest, reconcileMainSearch(next, channelFor(target)).window, true)
        return true
      }
      return false
    } finally {
      rebuilding = undefined
    }
  }

  return {
    execute, update, needsRefresh,
    needsMutationRefresh: (target: SearchResultTarget) => needsMutationRefresh(channelFor(target)),
    canPage: (mode: 'older' | 'newer') => mode === 'older' ? recovery?.hasOlder : recovery?.hasNewer,
    afterTimeout: (view: SearchAnchorView, mode?: MainSearchDirection) =>
      mode && (mode === 'refresh' || mode === rebuilding) ? discard(view) : view,
    clear() { window = undefined; recovery = undefined },
  }
}
