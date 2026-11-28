import { vi } from 'vitest'
import type { Activity } from './activity'
import type { ChannelEventPage, Message, ReplyChainPage, Result, SendMessageRequest, TimelinePage, TopicSummary, TopicSummaryResponse, ListChannelEventsQuery } from './api'
import type { RealtimeHandlers } from './realtime'
import { createTopicSync } from './topic-sync'
import { record } from './protocol-test-helpers'
import { flush, standaloneAccess } from './sync-test-helpers'

// These fixtures supply only the Messages represented in the mock page.
export const replyPage = (page: Omit<ReplyChainPage, 'chain_version'>): ReplyChainPage => ({
  ...page,
  chain_version: page.messages.reduce((version, message) => Math.max(version, message.version), 1),
})
export const ok = <T>(data: T): Result<T> => ({ ok: true, data })
export const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
export const msg = (seq: number, topic: string | null = null): Message => ({ ...record(seq), topic_id: topic })
export const summary = (id: string, last: number, count: number): TopicSummary => ({
  mention_unread_count: 0,
  read_seq: 0, unread_count: 0,
  id, name: `Topic ${id}`, first_seq: 1, last_seq: last, message_count: count, latest_message: msg(last, id),
})
export const page = (w = 10): TimelinePage => ({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: w, has_more: true,
  items: [{ kind: 'message', message: msg(8) }, { kind: 'topic', topic: summary('T', w, 3) }] })

export function topicClient(activity?: Activity, requestTimeoutMs?: number) {
  const handlers: RealtimeHandlers[] = []
  const controls: unknown[] = []
  const listMessages = vi.fn(async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([msg(11), msg(12, 'T')]).at(-1)?.created_seq ?? 0,  messages: [msg(11), msg(12, 'T')], has_more: false }))
  const sendMessage = vi.fn(async (_channel: string, body: SendMessageRequest) =>
    ok({ ...msg(11), sender: 'me', client_message_id: body.client_message_id, body: body.body }))
  const topicsApi = {
    listTimeline: vi.fn(async () => ok(page())),
    listTopics: vi.fn(async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 10, has_more: false, topics: [summary('T', 10, 3)] })),
    getTopicSummary: vi.fn(async (): Promise<Result<TopicSummaryResponse>> => ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 12, topic: summary('T', 12, 4) })),
    listTopicMessages: vi.fn(async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([msg(5, 'T'), msg(10, 'T')]).at(-1)?.created_seq ?? 0,  messages: [msg(5, 'T'), msg(10, 'T')], has_more: true })),
  }
  const listChannelEvents = vi.fn(async (_channel: string, _query: ListChannelEventsQuery): Promise<Result<ChannelEventPage>> => {
    const result = await listMessages()
    return result.ok ? ok({ history_generation: '00000000-0000-4000-8000-000000000515', events: result.data.messages.map(message => ({ type: 'message' as const, seq: message.created_seq, kind: 'create' as const, message })), has_more: result.data.has_more }) : result
  })
  const onSessionEnded = vi.fn()
  const client = createTopicSync({ selfId: 'me', activity, requestTimeoutMs, api: { listMessages, sendMessage, listChannelEvents }, topicsApi, onSessionEnded,
    ...standaloneAccess(onSessionEnded),
    connect(h) { handlers.push(h); return { send: m => { controls.push(m) }, close: vi.fn() } },
  })
  return { ...client, topicsApi, listMessages, listChannelEvents, sendMessage, handlers, controls, onSessionEnded,
    async boot() {
      await client.sync.start(); handlers[0].onReady(); await client.sync.watch('A')
      handlers[0].onEvent({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: 'A', caught_up_seq: 10 }); await flush()
    },
    event(seq: number, topic: string | null = null) { handlers.at(-1)!.onEvent({ type: 'message', kind: 'create', seq: (msg(seq, topic)).created_seq, message: msg(seq, topic) }) },
  }
}
