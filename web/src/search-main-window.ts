import type { Message, TimelineItem, TimelinePage } from './api'
import type { ChannelState, MoveVersion } from './protocol-types'
import { MAIN_MESSAGE_LIMIT } from './protocol-types'
import { selectMainTimeline } from './topic-selectors'

export const SEARCH_WINDOW_LIMIT = 100
export const SEARCH_PAGE_SIZE = 25

export type MainSearchWindow = {
  generation: string
  watermark: number
  items: TimelineItem[]
  tail: Message[]
  hasOlder: boolean
  hasNewer: boolean
  detached: boolean
}

export const itemMessage = (item: TimelineItem) => item.kind === 'message' ? item.message : item.topic.latest_message
export const itemPosition = (item: TimelineItem) => item.kind === 'message' ? item.message.created_seq : item.topic.last_seq

export function mainSearchLines(window: MainSearchWindow, suffix = window.tail) {
  return selectMainTimeline(suffix,
    window.items.flatMap(item => item.kind === 'message' ? [item.message] : []),
    window.items.flatMap(item => item.kind === 'topic' ? [{ asOfSeq: window.watermark, summary: item.topic }] : []))
}

export function mainSearchBounds(window: MainSearchWindow, anchor: number) {
  const first = window.items[0], last = window.items.at(-1)
  return {
    first: first ? itemPosition(first) : anchor,
    last: window.tail.at(-1)?.created_seq ?? (last ? itemPosition(last) : anchor),
    hasOlder: window.hasOlder, hasNewer: window.hasNewer, detached: window.detached,
  }
}
export type MainSearchBounds = ReturnType<typeof mainSearchBounds>

export function mainSearchWindow(page: TimelinePage, items: TimelineItem[], hasOlder: boolean, hasNewer: boolean,
  keep: 'older' | 'newer', detached = false): MainSearchWindow {
  const trimmed = items.length > SEARCH_WINDOW_LIMIT
  return {
    generation: page.history_generation, watermark: page.as_of_seq,
    items: keep === 'older' ? items.slice(0, SEARCH_WINDOW_LIMIT) : items.slice(-SEARCH_WINDOW_LIMIT),
    tail: [], hasOlder: hasOlder || (trimmed && keep === 'newer'),
    hasNewer: hasNewer || (trimmed && keep === 'older'), detached,
  }
}

export function extendMainSearch(window: MainSearchWindow, page: TimelinePage, direction: 'older' | 'newer') {
  const older = direction === 'older'
  const next = mainSearchWindow(page, older ? [...page.items, ...window.items] : [...window.items, ...page.items],
    older ? page.has_more : window.hasOlder, older ? window.hasNewer : page.has_more, direction, window.detached)
  if (older && !next.hasNewer) {
    next.tail = window.tail.slice(0, SEARCH_WINDOW_LIMIT - next.items.length)
    next.detached ||= next.tail.length < window.tail.length
  }
  return next
}

export function reconcileMainSearch(window: MainSearchWindow, channel: ChannelState | undefined) {
  if (channel && channel.mutationSeq > window.watermark) return { window, refresh: true }
  if (window.detached || window.hasNewer || !channel) return { window, refresh: false }
  const { watermark } = window
  if ((channel.streamBase ?? 0) > watermark ||
    (channel.messages.length >= MAIN_MESSAGE_LIMIT && channel.messages[0].created_seq > watermark + 1)) {
    return { window: { ...window, detached: true }, refresh: false }
  }
  // The sync view has already deduplicated complete canonical Message states, including replay and ACKs.
  const suffix = channel.messages.filter(m => m.created_seq > watermark && !m.deleted)
  if (mainSearchLines(window, suffix).length > SEARCH_WINDOW_LIMIT) {
    return { window: { ...window, detached: true }, refresh: false }
  }
  const tail = suffix.filter(m => m.topic_id === null)
  return {
    window: tail.length === window.tail.length && tail.every((m, i) => m === window.tail[i]) ? window : { ...window, tail },
    refresh: tail.length < suffix.length,
  }
}

export function discardStaleMainRows(window: MainSearchWindow, channel: ChannelState,
  records: readonly Message[], moves: readonly MoveVersion[]) {
  const changes = new Map(records.map(message => [message.id, message.version]))
  const current = (message: Message) =>
    (channel.versions[message.id]?.[0] ?? 0) <= message.version &&
    (changes.get(message.id) ?? 0) <= message.version &&
    !moves.some(move => move.channel_id === message.channel_id &&
      move.root_id === (message.reply_root_id ?? message.id) && move.version > message.version)
  const items = window.items.filter(item => current(itemMessage(item)))
  const tail = window.tail.filter(current)
  return items.length === window.items.length && tail.length === window.tail.length ? window : { ...window, items, tail }
}

export function capMainSearch(window: MainSearchWindow, last: number): MainSearchWindow {
  const items = window.items.filter(item => itemPosition(item) <= last)
  return { ...window, items, detached: true, hasNewer: window.hasNewer || items.length < window.items.length }
}
