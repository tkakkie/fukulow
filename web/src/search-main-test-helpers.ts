import { vi } from 'vitest'
import { channel, fakeNetwork, flush, ok, record } from './adapter-test-helpers.svelte'
import type { ListTimelineQuery, Message, Result, TimelineItem, TimelinePage, TopicSummary } from './api'
import { createSession } from './session'
import { itemPosition } from './search-main-window'

export const generation = record(1).history_generation
export const target = { channelId: 'A', messageId: 'id40', createdSeq: 40 }
export async function flushSearch() { await flush(); await flush(); await flush() }
export const expired = { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' } as const
export const networkError = { ok: false, kind: 'network' } as const
export const isProbe = (query: ListTimelineQuery) => query.limit === 1 && query.as_of_seq === undefined
export const records = (first: number, last: number, topic_id: string | null = null) =>
  Array.from({ length: last - first + 1 }, (_, offset) => ({ ...record(first + offset), topic_id }))

export function messageTimeline(items: Message[], as_of_seq: number, query: ListTimelineQuery): TimelinePage {
  const topics = new Map<string, TopicSummary>()
  const lines: TimelineItem[] = []
  for (const m of [...items].sort((a, b) => a.created_seq - b.created_seq)) {
    if (m.deleted || m.created_seq > as_of_seq) continue
    if (!m.topic_id) { lines.push({ kind: 'message', message: m }); continue }
    const prior = topics.get(m.topic_id)
    topics.set(m.topic_id, {
      id: m.topic_id, name: m.topic_id, first_seq: prior?.first_seq ?? m.created_seq,
      last_seq: m.created_seq, latest_message: m, message_count: (prior?.message_count ?? 0) + 1,
      read_seq: 0, unread_count: 0, mention_unread_count: 0,
    })
  }
  for (const topic of topics.values()) lines.push({ kind: 'topic', topic })
  const matches = lines.sort((a, b) => itemPosition(a) - itemPosition(b)).filter(item =>
    itemPosition(item) > (query.after_position ?? 0) && itemPosition(item) < (query.before_position ?? Infinity))
  const limit = query.limit ?? 50
  return { history_generation: generation, as_of_seq,
    items: query.after_position === undefined ? matches.slice(-limit) : matches.slice(0, limit), has_more: matches.length > limit }
}

export function searchTimelineFixture(initial: Message[], base = 100) {
  const net = fakeNetwork()
  const options = net.options()
  const store = new Map(initial.map(m => [m.id, m]))
  let watermark = base
  let floor = 0
  const serve = (query: ListTimelineQuery): Result<TimelinePage> => query.as_of_seq !== undefined && query.as_of_seq < floor
    ? expired : ok(messageTimeline([...store.values()], query.as_of_seq ?? watermark, query))
  const read = vi.fn(async (query: ListTimelineQuery, _signal?: AbortSignal) => serve(query))
  const normal = options.topicsApi!.listTimeline
  net.pages.A = ok({ history_generation: generation, as_of_seq: base, messages: [record(base)], has_more: false })
  const rawRead = vi.fn(options.sync!.api!.listMessages)
  options.sync!.api!.listMessages = rawRead
  options.topicsApi!.listTimeline = (id, query, signal) => signal && query ? read(query, signal) : normal(id, query, signal)
  const session = createSession({ ...options, selfId: 'me', onEnded: vi.fn() })
  const anchor = session.searchAnchor
  async function ready() {
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: generation, channels: [channel('A')] }))
    await flush()
    net.subscribed('A', base)
    await flush()
  }
  return {
    anchor, net, read, rawRead, serve, close: session.close, session, ready,
    cursor: () => session.sync.get().channels.A.cursor,
    lines: () => anchor.get()?.lines.map(line => line.kind === 'message'
      ? `m:${line.message.created_seq}` : `t:${line.topicId}@${line.position}:${line.messageCount}`),
    put(message: Message) {
      store.set(message.id, message)
      watermark = Math.max(watermark, message.version)
      if (message.version > message.created_seq || message.deleted) floor = Math.max(floor, message.version)
    },
    async open(hit = target) {
      await ready()
      anchor.open(hit)
      await flushSearch()
    },
  }
}
