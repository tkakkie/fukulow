import type { ListMessagesQuery, ListTimelineQuery, Message, MessagePage, ReplyChainPage, ReplyChainQuery, Result, TimelineItem, TimelinePage, TopicSummary } from './api'
import { knownMessageState } from './identity-order'
import type { SearchResultTarget } from './navigation'
import type { createSync } from './sync'
import { MAIN_MESSAGE_LIMIT, type MoveVersion } from './protocol-types'
import { linePosition, selectMainTimeline, type MainTimelineLine, type TopicBaseline } from './topic-selectors'

export const PAGE_SIZE = 25
export const SEARCH_WINDOW_LIMIT = 100

export type PageRead = 'older' | 'newer' | 'refresh'
export type OpMode = 'initial' | PageRead
export type Reads = {
  messages(target: SearchResultTarget, query: ListMessagesQuery, signal?: AbortSignal): Promise<Result<MessagePage>>
  timeline(target: SearchResultTarget, query: ListTimelineQuery, signal?: AbortSignal): Promise<Result<TimelinePage>>
  reply(target: SearchResultTarget, query: ReplyChainQuery, signal?: AbortSignal): Promise<Result<ReplyChainPage>>
}
export type ChannelState = ReturnType<ReturnType<typeof createSync>['get']>['channels'][string] | undefined

export const initialView = (target: SearchResultTarget) => ({
  target, visit: Symbol(), status: 'loading' as 'loading' | 'ready' | 'missing' | 'error',
  messages: [] as Message[], lines: [] as MainTimelineLine[], reply: undefined as Message | undefined,
  hasOlder: false, hasNewer: false, detached: false, paging: false, pageError: undefined as PageRead | undefined,
  asOfSeq: undefined as number | undefined,
})
export type SearchAnchorView = ReturnType<typeof initialView>

export const isMainChannel = (target: SearchResultTarget) => !target.replyRootId && !target.topicId
export const itemPosition = (item: TimelineItem) => item.kind === 'message' ? item.message.created_seq : item.topic.last_seq
export const itemMessage = (item: TimelineItem) => item.kind === 'message' ? item.message : item.topic.latest_message
export const messagesFromLines = (lines: MainTimelineLine[]) => lines.flatMap(l => l.kind === 'message' ? [l.message] : [])

export const containsHit = (target: SearchResultTarget, message: Message) =>
  message.id === target.messageId && message.created_seq === target.createdSeq &&
  message.channel_id === target.channelId && message.topic_id === (target.topicId ?? null) &&
  (!target.replyRootId || (message.reply_root_id ?? message.id) === target.replyRootId) && !message.deleted

export function mergeMessages(channel: ChannelState, target: SearchResultTarget, incoming: Message[], starting: Message[]) {
  const records = new Map(starting.map(message => [message.id, message]))
  const expectedTopic = target.topicId ?? null
  for (const message of incoming) {
    if (message.channel_id !== target.channelId) continue
    const current = knownMessageState(channel, records.get(message.id), message)
    if (current && !current.deleted && current.topic_id === expectedTopic) records.set(message.id, current)
    else records.delete(message.id)
  }
  return [...records.values()].sort((a, b) => a.created_seq - b.created_seq)
}

export function mergeBaseline(channel: ChannelState, target: Map<string, TopicBaseline>, asOfSeq: number, summary: TopicSummary) {
  const existing = target.get(summary.id)
  if (existing && existing.asOfSeq > asOfSeq) return
  const held = existing?.summary.latest_message.id === summary.latest_message.id ? existing.summary.latest_message : undefined
  const latest = knownMessageState(channel, held, summary.latest_message) ?? summary.latest_message
  target.set(summary.id, { asOfSeq, summary: { ...summary, latest_message: latest } })
}

export function applyTimelineItems(
  channel: ChannelState,
  target: SearchResultTarget,
  items: TimelineItem[],
  asOfSeq: number,
  startingMessages: Message[],
  startingBaselines: Map<string, TopicBaseline>,
) {
  const nextBaselines = new Map(startingBaselines)
  const incomingMessages: Message[] = []
  for (const item of items) {
    if (item.kind === 'message') {
      if (item.message.topic_id === null) incomingMessages.push(item.message)
    } else {
      mergeBaseline(channel, nextBaselines, asOfSeq, item.topic)
    }
  }
  return { messages: mergeMessages(channel, target, incomingMessages, startingMessages), baselines: nextBaselines }
}

export function isContinuityDetached(channel: ChannelState, forwardWatermark: number) {
  return (channel?.streamBase ?? 0) > forwardWatermark || Boolean(
    channel && channel.messages.length >= MAIN_MESSAGE_LIMIT && channel.messages[0].created_seq > forwardWatermark + 1,
  )
}

export function upperBoundForMain(view: SearchAnchorView, after: number) {
  return view.hasNewer || view.detached
    ? Math.max(after, view.lines.length ? linePosition(view.lines.at(-1)!) : 0)
    : Infinity
}

export function upperBoundForTopic(view: SearchAnchorView, after: number) {
  return view.hasNewer || view.detached
    ? Math.max(after, view.messages.at(-1)?.created_seq ?? 0)
    : Infinity
}

export function applyMainLiveUpdate(params: {
  view: SearchAnchorView
  channel: NonNullable<ChannelState>
  incoming: Message[]
  moves: readonly MoveVersion[] | undefined
  before: number
  refreshWatermark: number
  forwardWatermark: number
  windowMessages: Message[]
  baselines: Map<string, TopicBaseline>
  liveMain: Message[]
  canonicalHit: Message | undefined
  heldHit: Message | undefined
  watermark: number
}) {
  const { view: w, channel, incoming, moves, before, refreshWatermark, forwardWatermark, windowMessages, baselines, liveMain, canonicalHit, heldHit, watermark } = params
  const id = w.target.channelId
  const lower = w.hasOlder ? before - 1 : 0
  const affectedByMove = (root: string, version: number) =>
    moves?.some(move => move.channel_id === id && move.root_id === root && move.version > version)

  const heldWindowIds = new Set(windowMessages.map(m => m.id))
  const heldLiveIds = new Set(liveMain.map(m => m.id))
  const windowUpdates = incoming.filter(m => heldWindowIds.has(m.id))
  const liveUpdates = incoming.filter(m => heldLiveIds.has(m.id))
  let nextWindow = windowUpdates.length ? mergeMessages(channel, w.target, windowUpdates, windowMessages) : windowMessages
  let nextLiveMain = liveUpdates.length ? mergeMessages(channel, w.target, liveUpdates, liveMain) : liveMain
  let nextBaselines = baselines
  let refreshSeq = 0
  let hitMoved = false
  let dirty = nextWindow.length !== windowMessages.length || nextWindow.some((m, i) => m !== windowMessages[i]) ||
    nextLiveMain.length !== liveMain.length || nextLiveMain.some((m, i) => m !== liveMain[i])

  for (const m of incoming) {
    if (m.channel_id !== id) continue
    let matchedBaseline = false
    for (const [topicId, b] of nextBaselines) {
      if (b.summary.latest_message.id === m.id) {
        matchedBaseline = true
        const canonical = knownMessageState(channel, b.summary.latest_message, m)
        if (!canonical || canonical.deleted || canonical.topic_id !== topicId) {
          if (nextBaselines === baselines) nextBaselines = new Map(baselines)
          nextBaselines.delete(topicId)
          refreshSeq = Math.max(refreshSeq, m.version)
          dirty = true
        } else if (canonical !== b.summary.latest_message) {
          if (nextBaselines === baselines) nextBaselines = new Map(baselines)
          nextBaselines.set(topicId, { ...b, summary: { ...b.summary, latest_message: canonical } })
          dirty = true
        }
      } else if (m.deleted && m.topic_id === topicId && m.created_seq <= b.asOfSeq) {
        matchedBaseline = true
        refreshSeq = Math.max(refreshSeq, m.version)
      }
    }
    // Deleting an off-window Topic Message above lower can drop that Topic's last_seq into the held range.
    if (!matchedBaseline && m.deleted && m.topic_id !== null && m.created_seq > lower && m.version > refreshWatermark) {
      refreshSeq = Math.max(refreshSeq, m.version)
    }
  }

  if (moves?.length) {
    const hit = canonicalHit ?? heldHit
    hitMoved = Boolean(affectedByMove(hit?.reply_root_id ?? w.target.messageId, hit?.version ?? watermark))
    const visibleWindow = nextWindow.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
    const visibleLiveMain = nextLiveMain.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
    let visibleBaselines = nextBaselines
    for (const [topicId, b] of nextBaselines) {
      if (affectedByMove(b.summary.latest_message.reply_root_id ?? b.summary.latest_message.id, b.summary.latest_message.version)) {
        if (visibleBaselines === nextBaselines) visibleBaselines = new Map(nextBaselines)
        visibleBaselines.delete(topicId)
      }
    }
    const moveVersion = moves.reduce((max, move) => (
      move.channel_id === id && move.version > refreshWatermark ? Math.max(max, move.version) : max
    ), 0)
    if (hitMoved || moveVersion > 0 || visibleBaselines.size !== nextBaselines.size ||
        visibleWindow.length !== nextWindow.length || visibleLiveMain.length !== nextLiveMain.length) {
      nextWindow = visibleWindow
      nextBaselines = visibleBaselines
      nextLiveMain = visibleLiveMain
      dirty = true
      refreshSeq = Math.max(refreshSeq, moveVersion || watermark + 1)
    }
  }

  let detached = w.detached || (channel.streamBase ?? 0) > forwardWatermark
  if (!hitMoved && !w.hasNewer && !detached) {
    const suffix = incoming.filter(m =>
      !heldWindowIds.has(m.id) && !heldLiveIds.has(m.id) && !m.deleted && m.created_seq > forwardWatermark)
    if (suffix.length) {
      const combined = selectMainTimeline([...nextLiveMain, ...suffix], nextWindow, nextBaselines.values())
      if (combined.length > SEARCH_WINDOW_LIMIT) {
        detached = true
      } else {
        const mainSuffix = suffix.filter(m => m.topic_id === null)
        const topicSuffix = suffix.filter(m => m.topic_id !== null)
        if (mainSuffix.length) {
          nextLiveMain = mergeMessages(channel, w.target, mainSuffix, nextLiveMain)
          dirty = true
        }
        if (topicSuffix.length) {
          refreshSeq = Math.max(refreshSeq, ...topicSuffix.map(m => m.created_seq))
        }
      }
    }
  }

  return { nextWindow, nextBaselines, nextLiveMain, dirty, detached, refreshSeq, hitMoved }
}

export function buildMainSearchView(params: {
  mode: OpMode
  restarted: boolean
  replaceState: boolean
  target: SearchResultTarget
  w: SearchAnchorView
  current: SearchAnchorView
  state: ChannelState
  applied: { messages: Message[]; baselines: Map<string, TopicBaseline> }
  olderTimeline: TimelinePage | undefined
  newerTimeline: TimelinePage | undefined
  watermark: number
  forwardWatermark: number
  before: number
  after: number
  hasOlderNext: boolean
  hasNewerNext: boolean
  liveMain: Message[]
  targetStaleSeq: number
}) {
  const { mode, restarted, replaceState, target, w, current, state, applied, olderTimeline, newerTimeline, watermark, forwardWatermark, hasOlderNext, hasNewerNext, targetStaleSeq } = params
  const refreshing = mode === 'refresh'
  const baseLines = selectMainTimeline([], applied.messages, applied.baselines.values())
  const trimmed = baseLines.length > SEARCH_WINDOW_LIMIT
  const keepStart = mode === 'older' || refreshing
  const keptLines = keepStart ? baseLines.slice(0, SEARCH_WINDOW_LIMIT) : baseLines.slice(-SEARCH_WINDOW_LIMIT)
  const keptMsgIds = new Set(keptLines.flatMap(l => l.kind === 'message' ? [l.message.id] : []))
  const keptTopicIds = new Set(keptLines.flatMap(l => l.kind === 'topic' ? [l.topicId] : []))
  const windowMessages = applied.messages.filter(m => keptMsgIds.has(m.id))
  const baselines = new Map([...applied.baselines].filter(([id]) => keptTopicIds.has(id)))

  let before = params.before
  let after = params.after
  if (mode === 'initial') {
    before = olderTimeline?.items[0] ? itemPosition(olderTimeline.items[0]) : target.createdSeq
    after = newerTimeline?.items.at(-1) ? itemPosition(newerTimeline.items.at(-1)!) : target.createdSeq
  } else {
    if (olderTimeline?.items[0]) before = itemPosition(olderTimeline.items[0])
    else if (replaceState && !w.hasOlder && keptLines[0]) before = linePosition(keptLines[0])
    if (newerTimeline?.items.at(-1)) after = itemPosition(newerTimeline.items.at(-1)!)
    else if (replaceState && keptLines.length) after = linePosition(keptLines.at(-1)!)
  }
  if (trimmed && keepStart && keptLines.length) after = linePosition(keptLines.at(-1)!)
  if (trimmed && !keepStart && keptLines.length) before = linePosition(keptLines[0])

  const preserveLive = mode === 'older' && !restarted
  let liveMain = preserveLive ? params.liveMain : []
  const stickyDetached = (refreshing || mode === 'older') && current.detached
  const next: SearchAnchorView = {
    ...current, status: 'ready',
    messages: messagesFromLines(keptLines),
    lines: keptLines,
    paging: false, asOfSeq: watermark,
    hasOlder: hasOlderNext || (trimmed && !keepStart),
    hasNewer: hasNewerNext || (trimmed && keepStart),
    detached: stickyDetached || (preserveLive
      ? (state?.streamBase ?? 0) > forwardWatermark
      : isContinuityDetached(state, forwardWatermark)),
  }
  let followupStaleSeq = 0
  if (!next.hasNewer && !next.detached) {
    const suffix = preserveLive
      ? liveMain
      : (state?.messages ?? []).filter(m => !m.deleted && m.created_seq > forwardWatermark)
    const capacityCheck = selectMainTimeline(suffix, windowMessages, baselines.values())
    if (capacityCheck.length > SEARCH_WINDOW_LIMIT) {
      next.detached = true
      liveMain = []
    } else {
      const topicSuffix = preserveLive ? [] : suffix.filter(m => m.topic_id !== null)
      const mainSuffix = preserveLive ? liveMain : mergeMessages(state, target, suffix, [])
      const combined = selectMainTimeline(mainSuffix, windowMessages, baselines.values())
      liveMain = mainSuffix
      next.lines = combined
      next.messages = messagesFromLines(combined)
      if (topicSuffix.length) {
        const maxTopicSeq = Math.max(...topicSuffix.map(m => m.created_seq))
        if (!refreshing || maxTopicSeq > targetStaleSeq) {
          followupStaleSeq = maxTopicSeq
        } else {
          next.detached = true
          liveMain = []
          next.lines = keptLines
          next.messages = messagesFromLines(keptLines)
        }
      }
    }
  } else {
    liveMain = []
  }

  return { next, windowMessages, baselines, liveMain, before, after, followupStaleSeq }
}
