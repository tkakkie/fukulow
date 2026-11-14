import type { Message, TopicSummary } from './api'
import type { TopicEvidence } from './message-window'
import { row } from './unread-test-helpers'
import { createReplies } from './replies'
import { createUnread } from './unread'
import { windowClient } from './message-window-test-helpers'
import { ok } from './topic-test-helpers'
import { flush } from './sync-test-helpers'

/** Counts the actual production stores, including evidence which is absent from public display snapshots. */
export function observeBookkeeping() {
  const windows = new Set<{ evidence: TopicEvidence | Map<string, unknown[]> } & Record<string, unknown>>()
  const unread = new Set<{ records: Map<number, unknown> } & Record<string, unknown>>()
  const chains = new Set<{ liveSequences: unknown[] }>()
  const original = Map.prototype.set
  Map.prototype.set = function(key, value) {
    if (value && typeof value === 'object') {
      if ('evidence' in value && 'baselines' in value) windows.add(value)
      if ('records' in value && 'heldPositions' in value) unread.add(value)
      if ('liveSequences' in value && 'rootId' in value) chains.add(value)
    }
    return original.call(this, key, value)
  }
  const sizes = (values: Iterable<Record<string, unknown>>) => {
    const counts: Record<string, number> = {}
    for (const value of values) for (const [key, store] of Object.entries(value)) {
      if (store instanceof Map || store instanceof Set) counts[key] = (counts[key] ?? 0) + store.size
    }
    return counts
  }
  return {
    stop() { Map.prototype.set = original },
    counts() {
      return {
        topicRanges: [...windows].reduce((n, w) => n + [...(w.evidence instanceof Map ? w.evidence : w.evidence.sequences).values()].reduce((m, ranges) => m + ranges.length, 0), 0),
        topicEvidenceKeys: [...windows].reduce((n, w) => n + (w.evidence instanceof Map ? w.evidence : w.evidence.sequences).size, 0),
        replyRanges: [...chains].reduce((n, w) => n + w.liveSequences.length, 0),
        unreadRecords: [...unread].reduce((n, c) => n + c.records.size, 0),
        projectionStores: sizes(windows), unreadStores: sizes(unread),
      }
    },
  }
}

export async function evidenceClient() {
  const c = windowClient(2)
  c.records[0] = { ...c.records[0], topic_id: 'T' }
  c.records[1] = { ...c.records[1], topic_id: 'U' }
  let readSeq = 0
  const reads = { main: 0, history: 0, reply: 0, summary: 0, unread: 0, mark: 0 }
  const summary = (topic: string, w = c.records.at(-1)!.seq): TopicSummary => {
    const rows = c.records.filter(m => m.topic_id === topic && m.seq <= w)
    return { id: topic, name: topic, first_seq: rows[0].seq, last_seq: rows.at(-1)!.seq,
      latest_message: rows.at(-1)!, message_count: rows.length, read_seq: topic === 'T' ? readSeq : 0,
      unread_count: rows.filter(m => m.seq > (topic === 'T' ? readSeq : 0)).length }
  }
  c.options.listTimeline = async (_channel, query = {}) => {
    reads.main++
    const w = query.as_of_seq ?? c.records.at(-1)!.seq
    return ok({ as_of_seq: w, has_more: false, items: ['T', 'U'].map(t => summary(t, w))
      .filter(t => t.last_seq < (query.before_position ?? Infinity)).sort((a, b) => a.last_seq - b.last_seq)
      .map(topic => ({ kind: 'topic', topic })) })
  }
  c.options.getTopicSummary = async (_channel, topic) => {
    reads.summary++; return ok({ as_of_seq: c.records.at(-1)!.seq, topic: summary(topic) })
  }
  c.options.listTopicMessages = async (_channel, topic, query = {}) => {
    reads.history++
    const rows = c.records.filter(m => m.topic_id === topic && m.seq < (query.before_seq ?? Infinity))
    return ok({ messages: rows.slice(-50), has_more: rows.length > 50 })
  }
  const unread = createUnread(c.sync, { topics: c.topics, api: {
    async listChannels() {
      reads.unread++
      return ok({ channels: [row({ as_of_seq: c.records.at(-1)!.seq,
        read_seq: 0, main_unread_count: 0, unread_count: c.records.length - c.records.filter(m => m.topic_id === 'T' && m.seq <= readSeq).length })] })
    },
    getTopicSummary: c.options.getTopicSummary,
    async markRead(scope, body) { reads.mark++; if (scope.topicId === 'T') readSeq = Math.max(readSeq, body.read_seq); return ok(body) },
  } })
  const replies = createReplies(c.sync, { api: { async listReplyChain(_channel, _anchor, query = {}) {
    reads.reply++
    const rows = c.records.filter(m => (m.id === 'id1' || m.reply_root_id === 'id1') && m.seq > (query.after_seq ?? 0))
    return ok({ root_id: 'id1', messages: rows.slice(0, 50), has_more: rows.length > 50 })
  } } })
  await c.boot(); await c.topics.loadTopic('A', 'T'); await replies.open('A', c.records[0])
  unread.visibility(true); const visit = (await unread.enter({ channel: 'A', topicId: 'T' }))!
  await flush()
  return { ...c, replies, unread, visit, reads,
    append(m: Message) { c.records.push(m); c.event(m) },
    async close() { unread.close(); replies.close(); await c.close() },
  }
}
