import { vi } from 'vitest'
import type { Message, MessagePage, ReplyChainPage, Result, SendMessageRequest } from './api'
import type { RealtimeHandlers } from './realtime'
import { createReplySync } from './reply-sync'
import { createSync, type SyncOptions } from './sync'
import { record } from './protocol-test-helpers'
import { flush } from './sync-test-helpers'
export { deferred, ok } from './topic-test-helpers'
export const root = (topic: string | null = null) => ({ ...record(1), topic_id: topic })
export const reply = (seq: number, parent = 'id1', topic: string | null = null): Message =>
  ({ ...record(seq), reply_to: parent, reply_root_id: 'id1', topic_id: topic })
export function replyClient(requestTimeoutMs = 30_000) {
  const handlers: RealtimeHandlers[] = []
  const controls: unknown[] = []
  const listMessages = vi.fn(async (channel: string): Promise<Result<MessagePage>> =>
    ({ ok: true, data: { messages: [{ ...root(), channel_id: channel }], has_more: false } }))
  const listReplyChain = vi.fn(async (): Promise<Result<ReplyChainPage>> =>
    ({ ok: true, data: { root_id: 'id1', messages: [root(), reply(3)], has_more: true } }))
  let id = 0
  const sendMessage = vi.fn(async (channel: string, body: SendMessageRequest): Promise<Result<Message>> =>
    ({ ok: true, data: { ...reply(4, body.reply_to ?? 'id1'), channel_id: channel, sender: 'me', client_message_id: body.client_message_id, body: body.body } }))
  const onSessionEnded = vi.fn()
  const options: SyncOptions = { selfId: 'me', api: { listMessages, sendMessage },
    newId: () => `send${++id}`, onSessionEnded, requestTimeoutMs,
    connect(h) { handlers.push(h); return { send: m => { controls.push(m) }, close: vi.fn() } },
  }
  const source = createSync(options)
  const client = createReplySync({ ...options, repliesApi: { listReplyChain } }, source)
  return { ...client, source, listMessages, sendMessage, listReplyChain, handlers, controls, onSessionEnded,
    async boot() {
      await client.sync.start(); handlers[0].onReady(); await client.sync.watch('A')
      handlers[0].onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 1 }); await flush()
    },
    event(message: Message) { handlers.at(-1)!.onEvent({ type: 'message', message }) },
  }
}
