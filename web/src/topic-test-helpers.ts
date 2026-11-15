import { vi } from 'vitest'
import type { Activity } from './activity'
import type { Message, Result, SendMessageRequest, TimelinePage, TopicSummary, TopicSummaryResponse } from './api'
import type { RealtimeHandlers } from './realtime'
import { createTopicSync } from './topic-sync'
import { record } from './protocol-test-helpers'
import { flush } from './sync-test-helpers'

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
export const page = (w = 10): TimelinePage => ({ as_of_seq: w, has_more: true,
  items: [{ kind: 'message', message: msg(8) }, { kind: 'topic', topic: summary('T', w, 3) }] })

export function topicClient(activity?: Activity, requestTimeoutMs?: number) {
  const handlers: RealtimeHandlers[] = []
  const controls: unknown[] = []
  const listMessages = vi.fn(async () => ok({ messages: [msg(11), msg(12, 'T')], has_more: false }))
  const sendMessage = vi.fn(async (_channel: string, body: SendMessageRequest) =>
    ok({ ...msg(11), sender: 'me', client_message_id: body.client_message_id, body: body.body }))
  const topicsApi = {
    listTimeline: vi.fn(async () => ok(page())),
    listTopics: vi.fn(async () => ok({ as_of_seq: 10, has_more: false, topics: [summary('T', 10, 3)] })),
    getTopicSummary: vi.fn(async (): Promise<Result<TopicSummaryResponse>> => ok({ as_of_seq: 12, topic: summary('T', 12, 4) })),
    listTopicMessages: vi.fn(async () => ok({ messages: [msg(5, 'T'), msg(10, 'T')], has_more: true })),
  }
  const onSessionEnded = vi.fn()
  const client = createTopicSync({ selfId: 'me', activity, requestTimeoutMs, api: { listMessages, sendMessage }, topicsApi, onSessionEnded,
    connect(h) { handlers.push(h); return { send: m => { controls.push(m) }, close: vi.fn() } },
  })
  return { ...client, topicsApi, listMessages, sendMessage, handlers, controls, onSessionEnded,
    async boot() {
      await client.sync.start(); handlers[0].onReady(); await client.sync.watch('A')
      handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 10 }); await flush()
    },
    event(seq: number, topic: string | null = null) { handlers.at(-1)!.onEvent({ type: 'message', message: msg(seq, topic) }) },
  }
}
