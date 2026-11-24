import { isOrganizationUnavailable, type ListMessagesQuery, type ListTimelineQuery, type Message, type MessagePage, type ReplyChainPage, type ReplyChainQuery, type Result, type TimelineItem, type TimelinePage, type TopicSummary } from './api'
import { knownMessageState } from './identity-order'
import type { SearchResultTarget } from './navigation'
import type { createSync } from './sync'
import { createRequestDeadlines } from './request-deadlines'
import { MAIN_MESSAGE_LIMIT } from './protocol-types'
import { boundTopicEvidence, rememberTopicMessages, topicEvidence, type TopicEvidence } from './message-window'
import { linePosition, selectMainTimeline, type MainTimelineLine, type TopicBaseline } from './topic-selectors'

const PAGE_SIZE = 25
export const SEARCH_WINDOW_LIMIT = 100
const MAX_RAW_SCAN = 200
type PageRead = 'older' | 'newer' | 'refresh'
type Reads = {
  messages(target: SearchResultTarget, query: ListMessagesQuery): Promise<Result<MessagePage>>
  timeline(target: SearchResultTarget, query: ListTimelineQuery): Promise<Result<TimelinePage>>
  reply(target: SearchResultTarget, query: ReplyChainQuery): Promise<Result<ReplyChainPage>>
}
const initial = (target: SearchResultTarget) => ({
  target, visit: Symbol(), status: 'loading' as 'loading' | 'ready' | 'missing' | 'error',
  messages: [] as Message[], lines: [] as MainTimelineLine[], reply: undefined as Message | undefined,
  hasOlder: false, hasNewer: false, detached: false, paging: false, pageError: undefined as PageRead | undefined,
  asOfSeq: undefined as number | undefined,
})
type View = ReturnType<typeof initial>
const isMainChannel = (target: SearchResultTarget) => !target.replyRootId && !target.topicId
const itemPosition = (item: TimelineItem) => item.kind === 'message' ? item.message.created_seq : item.topic.last_seq
const itemMessage = (item: TimelineItem) => item.kind === 'message' ? item.message : item.topic.latest_message
const messagesFromLines = (lines: MainTimelineLine[]) => lines.flatMap(l => l.kind === 'message' ? [l.message] : [])
const cloneEvidence = (evidence: TopicEvidence): TopicEvidence => ({
  floor: evidence.floor,
  sequences: new Map([...evidence.sequences].map(([id, ranges]) => [id, ranges.map(r => ({ ...r }))])),
})

/** An authorized display projection. Only unfiltered sync can establish the Channel cursor. */
export function createSearchAnchor(sync: ReturnType<typeof createSync>, reads: Reads) {
  let view: View | undefined
  let before = 0, after = 0
  let refreshWatermark = 0, forwardWatermark = 0
  let windowMessages: Message[] = []
  let baselines = new Map<string, TopicBaseline>()
  let liveMain = new Map<string, Message>()
  let liveTopicLatest = new Map<string, Message>()
  let liveEvidence = topicEvidence()
  let request: symbol | undefined
  let previous = sync.get()
  const deadlines = createRequestDeadlines()
  const listeners = new Set<() => void>()
  const publish = (next: View | undefined) => { view = next; listeners.forEach(listener => listener()) }
  const liveMessages = (main: Map<string, Message>, topics: Map<string, Message>) => [...main.values(), ...topics.values()]
  function cancel() { request = undefined; deadlines.cancel() }
  function resetState() {
    before = 0; after = 0; refreshWatermark = 0; forwardWatermark = 0
    windowMessages = []; baselines = new Map()
    liveMain = new Map(); liveTopicLatest = new Map(); liveEvidence = topicEvidence()
  }
  function missing(w: View) {
    cancel()
    resetState()
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
    const expectedTopic = w.target.topicId ?? null
    for (const message of incoming) {
      if (message.channel_id !== w.target.channelId) continue
      const current = knownMessageState(channel, records.get(message.id), message)
      if (current && !current.deleted && current.topic_id === expectedTopic) records.set(message.id, current)
      else records.delete(message.id)
    }
    return [...records.values()].sort((a, b) => a.created_seq - b.created_seq)
  }

  function mergeLiveSuffix(
    channelId: string,
    startingMain: Map<string, Message>,
    startingTopics: Map<string, Message>,
    startingEvidence: TopicEvidence,
    incoming: Message[],
  ) {
    const channel = sync.get().channels[channelId]
    const nextMain = new Map(startingMain)
    const nextTopics = new Map(startingTopics)
    const nextEvidence = cloneEvidence(startingEvidence)
    const topicIncoming: Message[] = []
    for (const message of incoming) {
      if (message.channel_id !== channelId) continue
      const existing = message.topic_id === null
        ? nextMain.get(message.id)
        : (nextTopics.get(message.topic_id)?.id === message.id ? nextTopics.get(message.topic_id) : undefined)
      const current = knownMessageState(channel, existing, message)
      if (!current || current.deleted) {
        nextMain.delete(message.id)
        if (message.topic_id && nextTopics.get(message.topic_id)?.id === message.id) nextTopics.delete(message.topic_id)
        continue
      }
      if (current.topic_id === null) {
        nextMain.set(current.id, current)
      } else {
        topicIncoming.push(current)
        const prev = nextTopics.get(current.topic_id)
        if (!prev || current.created_seq > prev.created_seq || (current.created_seq === prev.created_seq && current.version >= prev.version)) {
          nextTopics.set(current.topic_id, current)
        }
      }
    }
    if (topicIncoming.length) {
      rememberTopicMessages(nextEvidence, topicIncoming)
      boundTopicEvidence(nextEvidence)
    }
    return { main: nextMain, topics: nextTopics, evidence: nextEvidence }
  }

  function mergeBaseline(channel: ReturnType<typeof channelFor>, target: Map<string, TopicBaseline>, asOfSeq: number, summary: TopicSummary) {
    const existing = target.get(summary.id)
    if (existing && existing.asOfSeq > asOfSeq) return
    const held = existing?.summary.latest_message.id === summary.latest_message.id ? existing.summary.latest_message : undefined
    const latest = knownMessageState(channel, held, summary.latest_message) ?? summary.latest_message
    target.set(summary.id, { asOfSeq, summary: { ...summary, latest_message: latest } })
  }

  function applyTimelineItems(w: View, items: TimelineItem[], asOfSeq: number, startingMessages: Message[], startingBaselines: Map<string, TopicBaseline>) {
    const channel = channelFor(w.target), nextBaselines = new Map(startingBaselines), incomingMessages: Message[] = []
    for (const item of items) {
      if (item.kind === 'message') { if (item.message.topic_id === null) incomingMessages.push(item.message) }
      else mergeBaseline(channel, nextBaselines, asOfSeq, item.topic)
    }
    return { messages: merge(w, incomingMessages, startingMessages), baselines: nextBaselines }
  }

  async function read(mode?: PageRead, restarted = false): Promise<void> {
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
    publish(w.status === 'ready' || mode
      ? { ...w, paging: true, pageError: undefined }
      : { ...w, status: 'loading' })
    const deadline = deadlines.start<Result<never>>({ ok: false, kind: 'network' }, { timeoutMs: 10_000 })
    const query = { history_generation: sync.get().historyGeneration }
    const run = <T>(operation: () => Promise<Result<T>>) =>
      Promise.race([Promise.resolve().then(operation).catch((): Result<T> => ({ ok: false, kind: 'network' })), deadline.until])
    const overtaken = (watermark: number) => {
      const state = channelFor(target)
      return state && (state.versionEpoch !== versionEpoch || state.mutationSeq > watermark)
    }
    const checked = <T extends { as_of_seq: number }>(result: Result<T>): Result<T> => {
      if (result.ok && overtaken(result.data.as_of_seq)) {
        return { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' }
      }
      return result
    }
    const fail = (result: Exclude<Result<unknown>, { ok: true }>) => {
      if (result.kind === 'http' && result.error === 'snapshot_expired' && !restarted && mode !== 'refresh') {
        cancel()
        return read(mode, true)
      }
      if (result.kind === 'http' && (result.status === 403 || result.status === 404)) {
        missing(w)
        if (!isOrganizationUnavailable(result) && result.error !== 'topic_not_found' && result.error !== 'reply_chain_not_found') {
          void sync.channelUnavailable(channel)
        }
      } else publish(mode
        ? { ...view!, paging: false, pageError: mode }
        : { ...view!, status: 'error', paging: false })
    }
    try {
      if (target.replyRootId) {
        const result = await run(() => reads.reply(target, { ...query, after_seq: target.createdSeq - 1, limit: 1 }))
        if (request !== token) return
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
      const fixed = Boolean(mode && !refreshing && !restarted)

      if (isMainChannel(target)) {
        const lower = w.hasOlder ? before - 1 : 0
        const upper = w.hasNewer || w.detached ? Math.max(after, w.lines.length ? linePosition(w.lines.at(-1)!) : 0) : Infinity
        let watermark = 0, olderTimeline: TimelinePage | undefined, pageItems: TimelineItem[] = [], settleMessages: Message[] = []
        let probeMessages: Message[] = []
        let forwardUpper: number | undefined, forwardHasMore = false, refreshTruncatedUpper = false
        let refreshedRetained = false, refreshedLower = lower, refreshedUpper = 0, refreshedLiveEdge = false
        const failWithProbe = (result: Exclude<Result<unknown>, { ok: true }>) => {
          const out = fail(result)
          if (probeMessages.length) void sync.settleHistory(channel, probeMessages)
          return out
        }

        if (mode === 'older') {
          let res: Result<TimelinePage>
          let retainedItems: TimelineItem[] = []
          if (fixed) {
            res = checked(await run(() => reads.timeline(target, { ...query, as_of_seq: w.asOfSeq, before_position: before, limit: PAGE_SIZE })))
            if (request !== token) return
            if (!res.ok) return fail(res)
          } else {
            const fresh = await run(() => reads.timeline(target, { ...query, limit: 1 }))
            if (request !== token) return
            if (!fresh.ok) return fail(fresh)
            probeMessages = fresh.data.items.map(itemMessage)
            if (overtaken(fresh.data.as_of_seq)) return failWithProbe({ ok: false, kind: 'network' })
            res = checked(await run(() => reads.timeline(target, {
              history_generation: fresh.data.history_generation, as_of_seq: fresh.data.as_of_seq, before_position: before, limit: PAGE_SIZE,
            })))
            if (request !== token) return
            if (!res.ok) return failWithProbe(res)
            const retainedUpper = w.hasNewer || w.detached ? upper : fresh.data.as_of_seq
            if (retainedUpper >= before) {
              const retainedRes = checked(await run(() => reads.timeline(target, {
                history_generation: fresh.data.history_generation, as_of_seq: fresh.data.as_of_seq,
                before_position: retainedUpper + 1, limit: SEARCH_WINDOW_LIMIT + 1,
              })))
              if (request !== token) return
              if (!retainedRes.ok) return failWithProbe(retainedRes)
              retainedItems = retainedRes.data.items.filter(item => {
                const pos = itemPosition(item)
                return pos >= before && pos <= retainedUpper
              })
              refreshedRetained = true
              refreshedLower = retainedRes.data.has_more && retainedRes.data.items[0]
                ? Math.max(before - 1, itemPosition(retainedRes.data.items[0]) - 1)
                : before - 1
              refreshedUpper = retainedUpper
              if (!w.hasNewer && !w.detached) refreshedLiveEdge = true
            }
          }
          olderTimeline = res.data; watermark = olderTimeline.as_of_seq
          pageItems = [...olderTimeline.items, ...retainedItems]
          settleMessages = [...probeMessages, ...pageItems.map(itemMessage)]
        } else if (refreshing) {
          if (upper === Infinity) {
            const res = await run(() => reads.timeline(target, { ...query, limit: SEARCH_WINDOW_LIMIT + 1 }))
            if (request !== token) return
            if (!res.ok) return fail(res)
            probeMessages = res.data.items.map(itemMessage)
            if (overtaken(res.data.as_of_seq)) return failWithProbe({ ok: false, kind: 'network' })
            watermark = res.data.as_of_seq
            if (res.data.has_more && res.data.items.length > 0 && itemPosition(res.data.items[0]) > lower + 1) {
              const anchorUpper = Math.max(after, w.lines.length ? linePosition(w.lines.at(-1)!) : 0, target.createdSeq)
              const tlRes = checked(await run(() => reads.timeline(target, {
                history_generation: res.data.history_generation, as_of_seq: watermark,
                before_position: anchorUpper + 1, limit: SEARCH_WINDOW_LIMIT + 1,
              })))
              if (request !== token) return
              if (!tlRes.ok) return failWithProbe(tlRes)
              pageItems = tlRes.data.items.filter(item => { const pos = itemPosition(item); return pos > lower && pos <= anchorUpper })
              refreshTruncatedUpper = true
              refreshedLower = tlRes.data.has_more && tlRes.data.items[0] ? Math.max(lower, itemPosition(tlRes.data.items[0]) - 1) : lower
              refreshedUpper = anchorUpper
              forwardUpper = Math.max(anchorUpper, pageItems.length ? itemPosition(pageItems.at(-1)!) : 0)
            } else {
              pageItems = res.data.items.filter(item => itemPosition(item) > lower)
              refreshedLower = lower
              refreshedUpper = watermark
              forwardUpper = pageItems.length ? itemPosition(pageItems.at(-1)!) : watermark
            }
          } else {
            const fresh = await run(() => reads.timeline(target, { ...query, limit: 1 }))
            if (request !== token) return
            if (!fresh.ok) return fail(fresh)
            probeMessages = fresh.data.items.map(itemMessage)
            if (overtaken(fresh.data.as_of_seq)) return failWithProbe({ ok: false, kind: 'network' })
            watermark = fresh.data.as_of_seq
            const tlRes = checked(await run(() => reads.timeline(target, {
              history_generation: fresh.data.history_generation, as_of_seq: watermark,
              before_position: upper + 1, limit: SEARCH_WINDOW_LIMIT + 1,
            })))
            if (request !== token) return
            if (!tlRes.ok) return failWithProbe(tlRes)
            pageItems = tlRes.data.items.filter(item => { const pos = itemPosition(item); return pos > lower && pos <= upper })
            const latestPos = fresh.data.items[0] ? itemPosition(fresh.data.items[0]) : 0
            forwardHasMore = latestPos > upper
            refreshedLower = tlRes.data.has_more && tlRes.data.items[0] ? Math.max(lower, itemPosition(tlRes.data.items[0]) - 1) : lower
            refreshedUpper = upper
            forwardUpper = Math.max(upper, pageItems.length ? itemPosition(pageItems.at(-1)!) : 0)
          }
          refreshedRetained = true
          settleMessages = [...probeMessages, ...pageItems.map(itemMessage)]
        } else {
          const needed = mode ? PAGE_SIZE : PAGE_SIZE + 1, startAfter = mode ? after : target.createdSeq - 1
          let scanAfter = startAfter, rawScanned = 0, mainCount = 0, scanGen: string | undefined, scanW: number | undefined
          const seenTopics = new Set<string>(), rawAccepted: Message[] = []
          let newerItems: TimelineItem[] = [], buffered: Message[] = [], lastPageHasMore = false
          const touchedTopics = new Set<string>()
          let addedMain = 0, addedMainMsgs: Message[] = []
          while (true) {
            if (buffered.length === 0 && rawScanned < MAX_RAW_SCAN) {
              const isFirst = scanW === undefined
              const limit = isFirst ? needed : Math.min(PAGE_SIZE, MAX_RAW_SCAN - rawScanned)
              const res = await run(() => reads.messages(target, {
                history_generation: scanGen ?? query.history_generation, limit, after_seq: scanAfter,
                ...(isFirst ? (fixed ? { as_of_seq: w.asOfSeq } : {}) : { as_of_seq: scanW }),
              }))
              if (request !== token) return
              const page = (!isFirst || fixed) ? checked(res) : res
              if (!page.ok) return fail(page)
              const data = page.data
              if (isFirst && mode && !fixed && overtaken(data.as_of_seq)) return fail({ ok: false, kind: 'network' })
              if (isFirst) {
                scanGen = data.history_generation; scanW = data.as_of_seq
                if (!mode && !data.messages.some(message => contains(target, message))) { missing(w); return }
              }
              rawScanned += data.messages.length
              lastPageHasMore = data.has_more && data.messages.length > 0
              buffered = [...data.messages]
              if (data.messages.length > 0) scanAfter = data.messages.at(-1)!.created_seq
            }
            let cut = false
            while (buffered.length > 0) {
              const m = buffered.shift()!
              if (m.topic_id === null) { mainCount += 1; addedMain += 1; addedMainMsgs.push(m) }
              else { seenTopics.add(m.topic_id); touchedTopics.add(m.topic_id) }
              rawAccepted.push(m)
              if (newerItems.length + addedMain + touchedTopics.size >= needed) { cut = true; break }
            }
            const hasMoreRaw = buffered.length > 0 || lastPageHasMore
            const exhausted = !hasMoreRaw || (buffered.length === 0 && (rawScanned >= MAX_RAW_SCAN || seenTopics.size === 0))
            if (cut || exhausted) {
              const upperSeq = rawAccepted.at(-1)?.created_seq
              if (touchedTopics.size > 0 && upperSeq !== undefined) {
                const tlRes = checked(await run(() => reads.timeline(target, {
                  history_generation: scanGen!, as_of_seq: scanW!, before_position: upperSeq + 1,
                  limit: Math.min(MAX_RAW_SCAN, mainCount + seenTopics.size),
                })))
                if (request !== token) return
                if (!tlRes.ok) return fail(tlRes)
                newerItems = tlRes.data.items.filter(item => itemPosition(item) > startAfter)
              } else if (addedMainMsgs.length > 0) {
                newerItems = [...newerItems, ...addedMainMsgs.map(message => ({ kind: 'message' as const, message }))]
              }
              addedMain = 0; addedMainMsgs = []; touchedTopics.clear()
              forwardHasMore = hasMoreRaw
              if (newerItems.length >= needed || exhausted) break
            }
          }
          watermark = scanW!; forwardUpper = rawAccepted.at(-1)?.created_seq
          let retainedItems: TimelineItem[] = []
          if (mode === 'newer' && !fixed && after >= 1) {
            const retainedRes = checked(await run(() => reads.timeline(target, {
              history_generation: scanGen!, as_of_seq: watermark, before_position: after + 1, limit: SEARCH_WINDOW_LIMIT + 1,
            })))
            if (request !== token) return
            if (!retainedRes.ok) return fail(retainedRes)
            retainedItems = retainedRes.data.items.filter(item => { const pos = itemPosition(item); return pos > lower && pos <= after })
            refreshedRetained = true
            refreshedLower = retainedRes.data.has_more && retainedRes.data.items[0] ? Math.max(lower, itemPosition(retainedRes.data.items[0]) - 1) : lower
            refreshedUpper = after
          }
          if (!mode) {
            const olderRes = checked(await run(() => reads.timeline(target, {
              history_generation: scanGen!, as_of_seq: watermark, before_position: target.createdSeq, limit: PAGE_SIZE,
            })))
            if (request !== token) return
            if (!olderRes.ok) return fail(olderRes)
            olderTimeline = olderRes.data
          }
          pageItems = [...(olderTimeline?.items ?? []), ...retainedItems, ...newerItems]
          settleMessages = [...rawAccepted, ...pageItems.map(itemMessage)]
        }

        const current = view!
        let retainedMessages = mode ? windowMessages : []
        let retainedBaselines = mode ? new Map(baselines) : new Map<string, TopicBaseline>()
        if (refreshedRetained) {
          const returnedMsgIds = new Set(pageItems.flatMap(item => item.kind === 'message' ? [item.message.id] : []))
          const returnedTopicIds = new Set(pageItems.flatMap(item => item.kind === 'topic' ? [item.topic.id] : []))
          retainedMessages = retainedMessages.filter(m =>
            m.created_seq <= refreshedLower || m.created_seq > refreshedUpper || m.version > watermark || returnedMsgIds.has(m.id))
          for (const [id, b] of retainedBaselines) {
            if (b.summary.last_seq > refreshedLower && b.summary.last_seq <= refreshedUpper && b.asOfSeq <= watermark && !returnedTopicIds.has(id)) {
              retainedBaselines.delete(id)
            }
          }
        }
        const applied = applyTimelineItems(current, pageItems, watermark, retainedMessages, retainedBaselines)
        if ((!mode || (refreshing && current.messages.some(message => contains(target, message)))) &&
            !applied.messages.some(message => contains(target, message))) {
          missing(w)
          return
        }
        if (!mode || refreshing || refreshedRetained) refreshWatermark = watermark
        if (forward || refreshedLiveEdge) forwardWatermark = watermark
        if (!mode) before = target.createdSeq
        if (olderTimeline?.items[0]) before = itemPosition(olderTimeline.items[0])
        const baseLines = selectMainTimeline([], applied.messages, applied.baselines.values())
        if (refreshing && !w.hasOlder && baseLines[0]) before = linePosition(baseLines[0])
        if (forward && forwardUpper !== undefined) after = forwardUpper
        const trimmed = baseLines.length > SEARCH_WINDOW_LIMIT
        const keepStart = mode === 'older' || refreshing
        const keptLines = keepStart ? baseLines.slice(0, SEARCH_WINDOW_LIMIT) : baseLines.slice(-SEARCH_WINDOW_LIMIT)
        const keptMsgIds = new Set(keptLines.flatMap(l => l.kind === 'message' ? [l.message.id] : []))
        const keptTopicIds = new Set(keptLines.flatMap(l => l.kind === 'topic' ? [l.topicId] : []))
        windowMessages = applied.messages.filter(m => keptMsgIds.has(m.id))
        baselines = new Map([...applied.baselines].filter(([id]) => keptTopicIds.has(id)))
        const preserveLive = mode === 'older' && !refreshedLiveEdge
        if (!preserveLive) {
          liveMain = new Map(); liveTopicLatest = new Map(); liveEvidence = topicEvidence()
        }
        if (trimmed && keepStart && keptLines.length) after = linePosition(keptLines.at(-1)!)
        if (trimmed && !keepStart && keptLines.length) before = linePosition(keptLines[0])
        const next = {
          ...current, status: 'ready' as const,
          messages: messagesFromLines(keptLines),
          lines: keptLines,
          paging: false, asOfSeq: watermark,
          hasOlder: (olderTimeline?.has_more ?? current.hasOlder) || (trimmed && !keepStart),
          hasNewer: (forward ? forwardHasMore : current.hasNewer) || (trimmed && keepStart) ||
            (refreshing && refreshTruncatedUpper),
        }
        const state = channelFor(target)
        // A fresh projection can cover ahead of the cursor. A later bootstrap cannot fill its old prefix.
        next.detached = (state?.streamBase ?? 0) > forwardWatermark || (preserveLive
          ? current.detached
          : Boolean(state && state.messages.length >= MAIN_MESSAGE_LIMIT && state.messages[0].created_seq > forwardWatermark + 1))
        if (!next.hasNewer && !next.detached) {
          const suffix = preserveLive
            ? { main: liveMain, topics: liveTopicLatest, evidence: liveEvidence }
            : mergeLiveSuffix(channel, new Map(), new Map(), topicEvidence(), (state?.messages ?? []).filter(m => m.created_seq > forwardWatermark))
          const combined = selectMainTimeline(liveMessages(suffix.main, suffix.topics), windowMessages, baselines.values(), suffix.evidence)
          if (combined.length > SEARCH_WINDOW_LIMIT) {
            next.detached = true
            liveMain = new Map(); liveTopicLatest = new Map(); liveEvidence = topicEvidence()
          } else {
            liveMain = suffix.main; liveTopicLatest = suffix.topics; liveEvidence = suffix.evidence
            next.lines = combined
            next.messages = messagesFromLines(combined)
          }
        } else {
          liveMain = new Map(); liveTopicLatest = new Map(); liveEvidence = topicEvidence()
        }
        publish(next)
        void sync.settleHistory(channel, settleMessages)
        return
      }

      const lower = w.hasOlder ? before - 1 : 0
      const upper = w.hasNewer || w.detached ? Math.max(after, w.messages.at(-1)?.created_seq ?? 0) : Infinity
      const response = await run(() => reads.messages(target, {
        ...query, limit: refreshing ? SEARCH_WINDOW_LIMIT + 1 : mode ? PAGE_SIZE : PAGE_SIZE + 1,
        ...(fixed ? { as_of_seq: w.asOfSeq } : {}),
        ...(forward ? { after_seq: refreshing ? lower : mode ? after : target.createdSeq - 1 } : { before_seq: before }),
      }))
      if (request !== token) return
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
        const result = checked(await run(() => reads.messages(target, {
          history_generation: data.history_generation, as_of_seq: data.as_of_seq, before_seq: target.createdSeq, limit: PAGE_SIZE,
        })))
        if (request !== token) return
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
        ...current, status: 'ready' as const, messages: kept, lines: [] as MainTimelineLine[], paging: false, asOfSeq: watermark,
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
      resetState()
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
    // A continuation's new W only covers that page, so it cannot supersede a Move elsewhere in the window.
    const topicMove = w.target.topicId && !w.target.replyRootId && moves?.some(move =>
      move.channel_id === id && move.destination_topic_id === w.target.topicId &&
      move.version > (watermark === undefined ? 0 : refreshWatermark))
    if (watermark === undefined) {
      if (topicMove || moves?.some(move => move.channel_id === id && move.root_id === w.target.replyRootId)) {
        cancel()
        void read()
      }
      return
    }
    const affectedByMove = (root: string, version: number) =>
      moves?.some(move => move.channel_id === id && move.root_id === root && move.version > version)

    if (isMainChannel(w.target)) {
      const heldWindowIds = new Set(windowMessages.map(m => m.id))
      const windowUpdates = incoming.filter(m => heldWindowIds.has(m.id))
      let nextWindow = windowUpdates.length ? merge(w, windowUpdates, windowMessages) : windowMessages
      let nextBaselines = baselines
      let nextLiveMain = liveMain
      let nextLiveTopics = liveTopicLatest
      let nextLiveEvidence = liveEvidence
      let needsRefresh = false
      let dirty = nextWindow.length !== windowMessages.length || nextWindow.some((m, i) => m !== windowMessages[i])
      for (const m of incoming) {
        if (m.channel_id !== id) continue
        for (const [topicId, b] of nextBaselines) {
          if (b.summary.latest_message.id === m.id) {
            const canonical = knownMessageState(channel, b.summary.latest_message, m)
            if (!canonical || canonical.deleted || canonical.topic_id !== topicId) {
              if (nextBaselines === baselines) nextBaselines = new Map(baselines)
              nextBaselines.delete(topicId)
              needsRefresh = true
              dirty = true
            } else if (canonical !== b.summary.latest_message) {
              if (nextBaselines === baselines) nextBaselines = new Map(baselines)
              nextBaselines.set(topicId, { ...b, summary: { ...b.summary, latest_message: canonical } })
              dirty = true
            }
          } else if (m.deleted && m.topic_id === topicId && m.created_seq <= b.asOfSeq) {
            needsRefresh = true
          }
        }
        if (nextLiveMain.has(m.id)) {
          const canonical = knownMessageState(channel, nextLiveMain.get(m.id), m)
          if (nextLiveMain === liveMain) nextLiveMain = new Map(liveMain)
          if (!canonical || canonical.deleted || canonical.topic_id !== null) nextLiveMain.delete(m.id)
          else nextLiveMain.set(m.id, canonical)
          dirty = true
        }
        for (const [topicId, latest] of nextLiveTopics) {
          if (latest.id === m.id) {
            const canonical = knownMessageState(channel, latest, m)
            if (!canonical || canonical.deleted || canonical.topic_id !== topicId) {
              if (nextLiveTopics === liveTopicLatest) nextLiveTopics = new Map(liveTopicLatest)
              nextLiveTopics.delete(topicId)
              needsRefresh = true
              dirty = true
            } else if (canonical !== latest) {
              if (nextLiveTopics === liveTopicLatest) nextLiveTopics = new Map(liveTopicLatest)
              nextLiveTopics.set(topicId, canonical)
              dirty = true
            }
          } else if (m.deleted && m.topic_id === topicId && m.created_seq > forwardWatermark) {
            needsRefresh = true
          }
        }
      }
      if (needsRefresh) {
        windowMessages = nextWindow
        baselines = nextBaselines
        liveMain = nextLiveMain
        liveTopicLatest = nextLiveTopics
        liveEvidence = nextLiveEvidence
        cancel()
        if (dirty) {
          const lines = selectMainTimeline(liveMessages(liveMain, liveTopicLatest), windowMessages, baselines.values(), liveEvidence)
          publish({ ...w, messages: messagesFromLines(lines), lines })
        }
        void read('refresh')
        return
      }
      if (moves?.length) {
        const hit = canonicalHit ?? heldHit
        const hitMoved = affectedByMove(hit?.reply_root_id ?? w.target.messageId, hit?.version ?? watermark)
        const visibleWindow = nextWindow.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
        const visibleLiveMain = new Map([...nextLiveMain].filter(([, m]) => !affectedByMove(m.reply_root_id ?? m.id, m.version)))
        const visibleLiveTopics = new Map([...nextLiveTopics].filter(([, m]) => !affectedByMove(m.reply_root_id ?? m.id, m.version)))
        const mainMove = moves.some(move => move.channel_id === id && move.version > refreshWatermark && (
          move.destination_topic_id === null ||
          nextBaselines.has(move.destination_topic_id) ||
          nextLiveTopics.has(move.destination_topic_id)
        ))
        const baselineMoved = [...nextBaselines.values()].some(b =>
          affectedByMove(b.summary.latest_message.reply_root_id ?? b.summary.latest_message.id, b.summary.latest_message.version))
        if (hitMoved || mainMove || baselineMoved || visibleWindow.length !== nextWindow.length ||
            visibleLiveMain.size !== nextLiveMain.size || visibleLiveTopics.size !== nextLiveTopics.size) {
          windowMessages = visibleWindow
          baselines = nextBaselines
          liveMain = visibleLiveMain
          liveTopicLatest = visibleLiveTopics
          liveEvidence = nextLiveEvidence
          const lines = selectMainTimeline(liveMessages(liveMain, liveTopicLatest), windowMessages, baselines.values(), liveEvidence)
          cancel()
          publish({ ...w, messages: messagesFromLines(lines), lines })
          void read(hitMoved ? undefined : 'refresh')
          return
        }
      }
      let detached = w.detached || (channel.streamBase ?? 0) > forwardWatermark
      if (!w.hasNewer && !detached) {
        const suffix = incoming.filter(m =>
          !heldWindowIds.has(m.id) && !nextLiveMain.has(m.id) && !m.deleted && m.created_seq > forwardWatermark)
        if (suffix.length) {
          const candidate = mergeLiveSuffix(id, nextLiveMain, nextLiveTopics, nextLiveEvidence, suffix)
          const combined = selectMainTimeline(liveMessages(candidate.main, candidate.topics), nextWindow, nextBaselines.values(), candidate.evidence)
          if (combined.length > SEARCH_WINDOW_LIMIT) detached = true
          else {
            nextLiveMain = candidate.main
            nextLiveTopics = candidate.topics
            nextLiveEvidence = candidate.evidence
            dirty = true
          }
        }
      }
      if (dirty || detached !== w.detached) {
        windowMessages = nextWindow
        baselines = nextBaselines
        liveMain = nextLiveMain
        liveTopicLatest = nextLiveTopics
        liveEvidence = nextLiveEvidence
        const lines = selectMainTimeline(liveMessages(liveMain, liveTopicLatest), windowMessages, baselines.values(), liveEvidence)
        publish({ ...w, messages: messagesFromLines(lines), lines, detached })
      }
      return
    }

    const heldIds = new Set(w.messages.map(m => m.id))
    const updates = incoming.filter(m => heldIds.has(m.id))
    let messages = updates.length ? merge(w, updates) : w.messages
    if (moves?.length) {
      const hit = canonicalHit ?? heldHit
      const hitMoved = affectedByMove(hit?.reply_root_id ?? w.target.replyRootId ?? w.target.messageId, hit?.version ?? watermark)
      const visible = messages.filter(m => !affectedByMove(m.reply_root_id ?? m.id, m.version))
      if (hitMoved || topicMove || visible.length !== messages.length) {
        cancel()
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
      cancel()
      resetState()
      publish(target ? initial(target) : undefined)
      const channel = target && channelFor(target)
      if (view && channel?.state === 'unavailable') missing(view)
      else if (target && channel?.watched) void read()
    },
    retry: () => read(view?.pageError),
    loadOlder: () => view?.hasOlder ? read('older') : undefined,
    loadNewer: () => view?.hasNewer ? read('newer') : undefined,
    close() { stop(); cancel(); resetState(); publish(undefined); listeners.clear() },
  }
}
