import { vi } from 'vitest'
import type { Message, Result, TopicSummary, UnreadChannel } from './api'
import type { UnreadApi, UnreadScope } from './unread'
import type { TopicsApi } from './topics'
import type { RealtimeHandlers } from './realtime'
import { createUnreadSync } from './unread-sync'
import { record } from './protocol-test-helpers'
export { deferred, ok } from './topic-test-helpers'
export { flush } from './sync-test-helpers'
import { ok } from './topic-test-helpers'
import { flush } from './sync-test-helpers'
export const msg = (seq: number, topic: string | null = null, sender = 'other', channel = 'A'): Message => ({ ...record(seq, channel), topic_id: topic, sender })
export const row = (extra: Partial<UnreadChannel> = {}): UnreadChannel => ({ id: 'A', kind: 'channel', name: 'A', visibility: 'public',
  capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_manage_managers: { allowed: false }, can_leave: { allowed: false } },
  as_of_seq: 3, read_seq: 0, main_unread_count: 1, unread_count: 3, ...extra })
export const summary = (id = 'T', w = 3, p = 0, count = 1): TopicSummary => ({ id, name: id, first_seq: 2,
  last_seq: w, latest_message: msg(w, id), message_count: count, read_seq: p, unread_count: count })
export function unreadClient() {
  const handlers: RealtimeHandlers[] = []
  const history = [msg(1), msg(2, 'T'), msg(3, 'U')]
  const rows = [row()]
  const summaries = new Map([['T', summary('T', 2)], ['U', summary('U', 3)]])
  const unreadApi = {
    listChannels: vi.fn(async () => ok({ channels: [...rows] })),
    markRead: vi.fn<UnreadApi['markRead']>(async (_scope, body) => ok({ ...body })),
    getTopicSummary: vi.fn<UnreadApi['getTopicSummary']>(async (_c, t) => ok({ as_of_seq: 3, topic: summaries.get(t)! })),
  }
  const topicsApi = {
    listTimeline: vi.fn<TopicsApi['listTimeline']>(async channel => {
      const items = history.filter(m => m.topic_id === null).map(message => ({ kind: 'message' as const, message: { ...message, channel_id: channel } }))
      return ok({ as_of_seq: 3, has_more: false, items: [...items,
        ...[...summaries.values()].map(topic => ({ kind: 'topic' as const, topic: { ...topic, latest_message: { ...topic.latest_message, channel_id: channel } } }))].sort((a, b) =>
        (a.kind === 'message' ? a.message.seq : a.topic.last_seq) - (b.kind === 'message' ? b.message.seq : b.topic.last_seq)) })
    }),
    listTopics: vi.fn<TopicsApi['listTopics']>(async () => ok({ as_of_seq: 3, has_more: false, topics: [...summaries.values()] })),
    getTopicSummary: unreadApi.getTopicSummary,
    listTopicMessages: vi.fn<TopicsApi['listTopicMessages']>(async (channel, topic) => ok({ messages: history.filter(m => m.topic_id === topic).map(m => ({ ...m, channel_id: channel })), has_more: false })),
  }
  const onSessionEnded = vi.fn()
  const c = createUnreadSync({ selfId: 'me', organizationId: 'org', unreadApi, topicsApi, requestTimeoutMs: 1000, onSessionEnded,
    random: () => 0.5,
    api: { listMessages: async () => ok({ messages: [], has_more: false }), sendMessage: async () => ({ ok: false, kind: 'network' }) },
    connect(h) { handlers.push(h); return { send() {}, close() {} } },
  })
  return { ...c, history, rows, summaries, unreadApi, topicsApi, handlers, onSessionEnded,
    async boot() { await c.sync.start(); handlers[0].onReady(); await c.sync.watch('A'); await flush()
      handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3 }); await flush() },
    event(m: Message) { handlers.at(-1)!.onEvent({ type: 'message', message: m }) },
    async enter(topicId: string | null = null) { if (topicId) await c.topics.loadTopic('A', topicId)
      c.unread.visibility(true); const id = await c.unread.enter({ channel: 'A', topicId }); await flush(); return id! },
    async present(seqs: number[], topicId: string | null = null) { const id = await this.enter(topicId); c.unread.presented(id, seqs); await flush(); return id },
  }
}
export const http = (status: number, error?: string): Result<never> => ({ ok: false, kind: 'http', status, error })
export const main: UnreadScope = { channel: 'A', topicId: null }
