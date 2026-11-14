import type { Message, MessagePage, Result, TimelinePage } from './api'
import type { TopicsApi } from './topics'
import { createTopicSync } from './topic-sync'
import { createReplies } from './replies'
import type { RealtimeHandlers } from './realtime'
import { record } from './protocol-test-helpers'
import { ok, summary } from './topic-test-helpers'
import { flush } from './sync-test-helpers'

export function windowClient(size = 1000) {
  const records = Array.from({ length: size }, (_, i) => record(i + 1))
  let socket: RealtimeHandlers
  const mainQueries: Parameters<TopicsApi['listTimeline']>[1][] = []
  const topicQueries: Parameters<TopicsApi['listTopicMessages']>[2][] = []
  const replyQueries: number[] = []
  const options: TopicsApi = {
    async listTimeline(channel, query = {}): Promise<Result<TimelinePage>> {
      mainQueries.push(query)
      const w = query.as_of_seq ?? records.at(-1)!.seq
      const rows = records.filter(m => m.seq <= w && m.seq < (query.before_position ?? Infinity))
      return ok({ as_of_seq: w, has_more: rows.length > 50, items: rows.slice(-50).map(m => ({ kind: 'message', message: { ...m, channel_id: channel } })) })
    },
    async listTopics() { return ok({ as_of_seq: size, topics: [], has_more: false }) },
    async getTopicSummary(_channel, topic) { return ok({ as_of_seq: size, topic: summary(topic, size, size) }) },
    async listTopicMessages(channel, topic, query = {}): Promise<Result<MessagePage>> {
      topicQueries.push(query)
      const rows = records.filter(m => m.seq < (query.before_seq ?? Infinity)).map(m => ({ ...m, channel_id: channel, topic_id: topic }))
      return ok({ messages: rows.slice(-50), has_more: rows.length > 50 })
    },
  }
  const { sync, topics } = createTopicSync({ selfId: 'me', topicsApi: options,
    api: { listMessages: async () => ok({ messages: [], has_more: false }), sendMessage: async () => ({ ok: false, kind: 'network' }) },
    connect(h) { socket = h; return { send() {}, close() {} } },
  })
  const replies = createReplies(sync, { api: { async listReplyChain(_channel, _anchor, query = {}) {
    replyQueries.push(query.after_seq ?? 0)
    const rows = records.filter(m => m.seq > (query.after_seq ?? 0))
    return ok({ root_id: 'id1', has_more: rows.length > 50,
      messages: rows.slice(0, 50).map(m => m.seq === 1 ? m : { ...m, reply_to: 'id1', reply_root_id: 'id1' }) })
  } } })
  return { sync, topics, replies, records, options, mainQueries, topicQueries, replyQueries,
    async boot() { await sync.start(); socket!.onReady(); await sync.watch('A')
      socket!.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: size }); await flush() },
    event(m: Message) { socket!.onEvent({ type: 'message', message: m }) },
    refuse() { socket!.onEvent({ type: 'error', channel_id: 'A', code: 'subscription_limit' }) },
    loseAccess() { socket!.onEvent({ type: 'channel_access_lost', channel_id: 'A' }) },
    end(code: number) { socket!.onClose(code) },
    async close() { replies.close(); await sync.close() },
  }
}
