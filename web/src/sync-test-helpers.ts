import type { Result, TimelinePage, TopicSummary } from './api'
import { createTopics, type TopicsApi } from './topics'
import { createTopicSync } from './topic-sync'
import { createReplySync } from './reply-sync'
import { createUnread } from './unread'
import type { UnreadChannel } from './api'
import { expandMessage } from '../scripts/realtime-fixtures'
import type { Effect as FixtureEffect, ResolvedInput } from '../scripts/realtime-fixtures'
import { createSync, type SyncOptions } from './sync'
import type { Connection, RealtimeHandlers } from './realtime'
import { message, observe, record } from './protocol-test-helpers'
export { scenarios, record } from './protocol-test-helpers'

export const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
export function controllerClient(overrides: Partial<SyncOptions> = {}, withTopicSync = false, withReplySync = false, withUnread = false) {
  let emitted: FixtureEffect[] = []
  let nextId = 'unused'
  const sockets: (RealtimeHandlers & { closed: boolean; connection: Connection })[] = []
  const allEffects: FixtureEffect[] = []
  const emit = (e: FixtureEffect) => { emitted.push(e); allEffects.push(e) }
  const request = <T>(effect: FixtureEffect): Promise<Result<T>> => {
    effect.completed = false
    return new Promise<Result<T>>(resolve => {
      effect.resolve = (result: Result<T>) => { effect.completed = true; resolve(result) }
      emit(effect)
    })
  }
  const topicsApi: TopicsApi = {
    listTimeline: (channel, query) => request({ type: 'fetch_main_timeline', channel, ...query }),
    listTopics: (channel, query) => request({ type: 'fetch_topics', channel, ...query }),
    getTopicSummary: (channel, topic) => request({ type: 'fetch_topic_summary', channel, topic }),
    listTopicMessages: (channel, topic, query) => request({ type: 'fetch_history', channel, topic,
      page: query?.before_seq === undefined ? 'latest' : 'before', seq: query?.before_seq }),
  }
  const options: SyncOptions = {
    selfId: 'me', newId: () => nextId,
    // As in production (session.ts): a pre-connect close asks REST; the fixture answers with membership_check_result.
    checkMembership: () => request({ type: 'membership_check' }),
    api: {
      listMessages(channel, query) {
        return request({ type: 'fetch_history', channel,
          page: query?.after_seq !== undefined ? 'after' : query?.before_seq !== undefined ? 'before' : 'latest',
          seq: query?.after_seq ?? query?.before_seq })
      },
      sendMessage(channel, body) {
        return request({ type: 'send', channel, ...body })
      },
    },
    connect(handlers) {
      const connection: Connection = {
        send(m) { emit({ ...m, channel: m.channel_id, socket: handlers }) },
        close() { s.closed = true },
      }
      const s = { ...handlers, closed: false, connection }
      sockets.push(s)
      emit({ type: 'connect', socket: s })
      return connection
    },
    schedule(fn, ms, effect) {
      const handle = setTimeout(fn, ms)
      emit({ ...effect, fn, ms, handle })
      return handle
    },
    ...overrides,
  }
  const composition = withTopicSync ? createTopicSync({ ...options, topicsApi }) : undefined
  const replyComposition = withReplySync ? createReplySync({ ...options, repliesApi: {
    listReplyChain: (channel, anchor, query) => request({ type: 'fetch_reply_chain', channel, anchor, ...query }),
  } }, composition?.sync) : undefined
  const sync = replyComposition?.sync ?? composition?.sync ?? createSync(options)
  const replies = replyComposition?.replies
  const topics = composition?.topics ?? createTopics(sync, { api: topicsApi })
  let unreadSubject: string | undefined
  const unreadIds = new Set<string>()
  const unread = withUnread ? createUnread(sync, { api: {
    listChannels: () => {
      const channel = unreadSubject; unreadSubject = undefined
      return channel ? request({ type: 'fetch_unread', channel }) : Promise.resolve({ ok: true, data: { channels: [] } })
    },
    markRead: async () => ({ ok: false, kind: 'network' }),
    getTopicSummary: async () => ({ ok: false, kind: 'network' }),
  } }) : undefined
  const client = {
    sync: { ...sync,
      async close() { unread?.close(); await sync.close() },
      replaceSession(selfId: string) { unread?.replaceSession(); return sync.replaceSession(selfId) },
    }, topics, replies, unread, sockets, allEffects,
    observe: () => {
      const observation = observe(sync.get())
      for (const [channel, c] of Object.entries(observation.channels)) {
        if (replies) {
          const chain = replies.get(channel)
          c.reply_chain = { root_id: chain.rootId, topic: chain.topicId ?? undefined,
            visible: chain.messages.map(m => m.seq), has_more: chain.hasMore, error: chain.error }
        }
        const projection = topics.get(channel)
        c.main_timeline = projection.lines.map(l => l.kind === 'message' ? { seq: l.message.seq }
          : { topic: l.topicId, position: l.position, message_count: l.messageCount })
        const ids = new Set(sync.get().channels[channel].messages.flatMap(m => m.topic_id ? [m.topic_id] : []))
        for (const effect of allEffects) if (effect.channel === channel && typeof effect.topic === 'string') ids.add(effect.topic)
        c.topics = Object.fromEntries([...ids].map(id => [id, { visible: projection.topic(id).messages.map(m => m.seq) }]))
      }
      for (const id of unreadIds) {
        const u = unread!.get(id)
        const channel = observation.channels[id] ??= { cursor: null, messages: [], pending: [] }
        if (u.asOfSeq !== null && u.unreadCount !== null && u.main.position !== null && u.main.unreadCount !== null) channel.unread = {
          as_of_seq: u.asOfSeq, read_seq: u.main.position, main_unread_count: u.main.unreadCount, unread_count: u.unreadCount,
        }
      }
      return observation
    },
    async feed(i: ResolvedInput) {
      emitted = []
      const e = i.respond_to
      const channel = (i.channel ?? e?.channel ?? Object.entries(sync.get().channels)
        .find(([, c]) => c.pending.some(p => p.clientMessageId === i.client_message_id))?.[0] ?? 'A') as string
      const t = sync.getTimeline(channel)
      const socket = sockets.at(-1)!
      const resolve = (r: Result<unknown>) => (e!.resolve as (r: Result<unknown>) => void)(r)
      switch (i.type) {
        case 'organization_refused': void sync.unavailable(); break
        case 'session_start': void sync.start(); break
        case 'session_replaced': void client.sync.replaceSession('me'); break
        case 'connection_ready': socket.onReady(); break
        case 'socket_closed': socket.onClose(i.code as number); break
        case 'message': socket.onEvent({ type: 'message', message: message(i.message, channel) }); break
        case 'subscribed': (e?.socket as RealtimeHandlers ?? socket).onEvent({ type: 'subscribed', channel_id: channel,
          caught_up_seq: i.caught_up_seq as number }); break
        case 'channel_access_lost': socket.onEvent({ type: 'channel_access_lost', channel_id: channel }); break
        case 'error_event': socket.onEvent({ type: 'error', channel_id: channel, code: i.code as string }); break
        case 'history_result': resolve({ ok: true, data: { messages: i.messages!.map(m => message(m, channel)), has_more: i.has_more } }); break
        case 'ack': resolve({ ok: true, data: message(i.message, channel) }); break
        case 'membership_check_result': resolve(i.status === 200 ? { ok: true, data: {} } : typeof i.status === 'number'
          ? { ok: false, kind: 'http', status: i.status, ...(i.error === undefined ? {} : { error: i.error as string }) }
          : { ok: false, kind: 'network' }); break
        case 'history_failed': case 'send_failed': resolve(typeof i.status === 'number'
          ? { ok: false, kind: 'http', status: i.status,
            ...(i.retry_after_ms === undefined ? {} : { retryAfterMs: i.retry_after_ms as number }) } : { ok: false, kind: 'network' }); break
        case 'open_reply_chain': void replies!.open(channel, message(i.message, channel)); break
        case 'load_reply_chain': void replies!.loadMore(channel); break
        case 'reply_chain_result': resolve({ ok: true, data: { root_id: i.root_id,
          messages: i.messages!.map(m => message(m, channel)), has_more: i.has_more } }); break
        case 'reply_chain_failed': resolve(typeof i.status === 'number'
          ? { ok: false, kind: 'http', status: i.status, ...(i.error === undefined ? {} : { error: i.error as string }) }
          : { ok: false, kind: 'network' }); break
        case 'load_main_timeline': void topics.loadMain(channel); break
        case 'load_unread': unreadIds.add(channel); unreadSubject = channel; void unread!.refresh(); break
        case 'unread_result': resolve({ ok: true, data: { channels: [{ id: channel, name: channel, visibility: 'public',
          capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_leave: { allowed: false } },
          ...(i.baseline as Pick<UnreadChannel, 'as_of_seq' | 'read_seq' | 'main_unread_count' | 'unread_count'>),
        }] } }); break
        case 'open_topic': void topics.loadTopic(channel, i.topic as string); break
        case 'main_timeline_result': {
          const items = i.items as ({ kind: 'message'; message: Record<string, unknown> } | { kind: 'topic'; topic: { name: string; last_seq: number; message_count: number } })[]
          const page: TimelinePage = { as_of_seq: i.as_of_seq as number, has_more: i.has_more as boolean,
            items: items.map(item => {
              if (item.kind === 'message') return { kind: 'message', message: message(expandMessage(item.message, channel)[0], channel) }
              const t = item.topic
              const summary: TopicSummary = { ...t, id: t.name, first_seq: 1, read_seq: 0, unread_count: 0,
                latest_message: { ...record(t.last_seq, channel), topic_id: t.name } }
              return { kind: 'topic', topic: summary }
            }) }
          resolve({ ok: true, data: page }); break
        }
        case 'watch': void sync.watch(channel); break
        case 'unwatch': void sync.unwatch(channel); break
        case 'refresh': void t.loadLatest(); break
        case 'load_older': void t.loadOlder(); break
        case 'user_send': nextId = i.client_message_id as string;
          if (replies && typeof i.reply_to === 'string') void replies.send(channel, i.body as string ?? 'hello', i.reply_to)
          else void t.send(i.body as string ?? 'hello')
          break
        case 'user_retry': if (replies) void replies.retry(channel, i.client_message_id as string); else void t.retry(i.client_message_id as string); break
        case 'user_discard': t.discard(i.client_message_id as string); break
        case 'timer_elapsed': clearTimeout(e!.handle as ReturnType<typeof setTimeout>); (e!.fn as () => void)(); break
        default: throw new Error(`unhandled fixture input ${i.type}`)
      }
      await flush()
      return emitted
    },
  }
  return client
}
