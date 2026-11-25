import type { ListTimelineQuery, Result, TimelinePage } from './api'
import type { SearchResultTarget } from './navigation'
import { extendMainSearch, itemPosition, mainSearchWindow, SEARCH_PAGE_SIZE, SEARCH_WINDOW_LIMIT,
  type MainSearchBounds, type MainSearchWindow } from './search-main-window'

type ReadPage = (query: ListTimelineQuery) => Promise<Result<TimelinePage>>
export type MainSearchDirection = 'older' | 'newer' | 'refresh'

async function readSide(read: ReadPage, fixed: ListTimelineQuery, direction: 'older' | 'newer',
  position: number, desired: number, capacity: number): Promise<Result<TimelinePage>> {
  const older = direction === 'older'
  const at = (boundary: number) => older ? { before_position: boundary } : { after_position: boundary }
  const first = await read({ ...fixed, ...at(position), limit: desired })
  if (!first.ok || !first.data.has_more || first.data.items.length !== desired) return first
  const channels = first.data.items.filter(item => item.kind === 'message').length
  if (channels === desired) return first
  // Allow extra rows for Topics, keeping half the window free for the other side of the hit.
  const edge = older ? first.data.items[0] : first.data.items.at(-1)!
  const extra = await read({ ...fixed, ...at(itemPosition(edge)), limit: capacity - desired })
  if (!extra.ok) return extra
  const candidates = older ? [...extra.data.items].reverse() : extra.data.items
  let count = channels
  const stop = candidates.findIndex(item => item.kind === 'message' && ++count === desired)
  const used = stop === -1 ? candidates : candidates.slice(0, stop + 1)
  return { ok: true, data: { ...first.data, has_more: extra.data.has_more || used.length < candidates.length,
    items: older ? [...used.reverse(), ...first.data.items] : [...first.data.items, ...used] } }
}

export async function readMainSearch(read: ReadPage, target: SearchResultTarget, historyGeneration: string | undefined,
  direction?: MainSearchDirection, current?: MainSearchWindow, bounds?: MainSearchBounds): Promise<Result<MainSearchWindow>> {
  if (current?.items.length && direction && direction !== 'refresh') {
    const position = direction === 'older' ? itemPosition(current.items[0]) : itemPosition(current.items.at(-1)!)
    const page = await readSide(read, { history_generation: current.generation, as_of_seq: current.watermark },
      direction, position, SEARCH_PAGE_SIZE, SEARCH_WINDOW_LIMIT / 2)
    return page.ok ? { ok: true, data: extendMainSearch(current, page.data, direction) } : page
  }

  // The timeline API selects W on a latest page. The probe is never part of the displayed window.
  const probe = await read({ history_generation: historyGeneration, limit: 1 })
  if (!probe.ok) return probe
  const fixed = { history_generation: probe.data.history_generation, as_of_seq: probe.data.as_of_seq }
  if (!bounds) {
    const newer = await readSide(read, fixed, 'newer', target.createdSeq - 1, SEARCH_PAGE_SIZE + 1, SEARCH_WINDOW_LIMIT / 2)
    if (!newer.ok) return newer
    const hit = newer.data.items[0]
    if (hit?.kind !== 'message' || hit.message.id !== target.messageId || hit.message.created_seq !== target.createdSeq) {
      return { ok: true, data: mainSearchWindow(newer.data, [], false, false, 'newer') }
    }
    const older = await readSide(read, fixed, 'older', target.createdSeq, SEARCH_PAGE_SIZE, SEARCH_WINDOW_LIMIT / 2)
    if (!older.ok) return older
    return { ok: true, data: mainSearchWindow(newer.data, [...older.data.items, ...newer.data.items],
      older.data.has_more, newer.data.has_more, 'newer') }
  }

  // Bounds survive expiry as positions only. Re-read the held range at the new W before
  // displaying any rows, including rows on the side the user did not page.
  const lower = bounds.hasOlder && bounds.first > 1 ? bounds.first - 1 : 0
  const range = await read({ ...fixed, after_position: lower, limit: SEARCH_WINDOW_LIMIT + 1 })
  if (!range.ok) return range
  const bounded = bounds.hasNewer || bounds.detached
  const items = bounded ? range.data.items.filter(item => itemPosition(item) <= bounds.last) : range.data.items
  const hasNewer = range.data.has_more || items.length < range.data.items.length
  if (direction === 'older' && lower > 0) {
    const older = await readSide(read, fixed, 'older', bounds.first, SEARCH_PAGE_SIZE, SEARCH_WINDOW_LIMIT / 2)
    if (!older.ok) return older
    return { ok: true, data: mainSearchWindow(range.data, [...older.data.items, ...items], older.data.has_more,
      hasNewer, 'older', bounds.detached) }
  }
  if (direction === 'newer' && hasNewer) {
    const last = items.at(-1)
    const boundary = range.data.has_more && last ? itemPosition(last) : bounds.last
    const newer = await readSide(read, fixed, 'newer', boundary, SEARCH_PAGE_SIZE, SEARCH_WINDOW_LIMIT / 2)
    if (!newer.ok) return newer
    return { ok: true, data: mainSearchWindow(range.data, [...items, ...newer.data.items], bounds.hasOlder,
      newer.data.has_more, 'newer', bounds.detached) }
  }
  // A refresh at the live edge freezes the currently held range if newer arrivals would overflow it.
  if (direction === 'refresh' && !bounded && items.length > SEARCH_WINDOW_LIMIT) {
    return { ok: true, data: mainSearchWindow(range.data, items.filter(item => itemPosition(item) <= bounds.last),
      bounds.hasOlder, true, 'older', true) }
  }
  return { ok: true, data: mainSearchWindow(range.data, items, bounds.hasOlder, hasNewer,
    'older', bounds.detached) }
}
