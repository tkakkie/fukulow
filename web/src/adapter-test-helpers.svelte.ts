import { flushSync, tick } from 'svelte'
import type {
  Channel,
  ClientMessage,
  Message,
  MessagePage,
  ReplyChainPage,
  Result,
  SendMessageRequest,
  ServerEvent,
  TimelineItem,
  TimelinePage,
  TopicPage,
  TopicSummary,
  TopicSummaryResponse,
} from './api'
import type { RealtimeHandlers } from './realtime'
import { record } from './protocol-test-helpers'
import type { SessionOptions } from './session'

export { record }
export const channel = (id: string, name = id): Channel => ({ id, name, visibility: 'public', capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_leave: { allowed: true } } })
export const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

/** Lets pending promises finish, then applies Svelte's pending effects. */
export async function settle() {
  await flush()
  flushSync()
  await tick()
}

/**
 * Runs `read` inside an effect, like a mounted component would. `values` holds every result in order;
 * `unmount()` destroys the effect (the last observer), which releases the adapter's listener after a tick.
 */
export async function mount<T>(read: () => T) {
  const values: T[] = []
  const stop = $effect.root(() => {
    $effect(() => { values.push(read()) })
  })
  await tick() // the first run of a root's effects is a microtask
  return {
    values,
    get last() { return values.at(-1) as T },
    async unmount() {
      stop()
      await tick()
    },
  }
}

export type Deferred<T> = { resolve: (value: T) => void }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

export type FakeSocket = RealtimeHandlers & { sent: ClientMessage[]; closed: boolean }

/** Fake transports for one test: sockets that record controls, history pages, and sends/lists held until resolved. */
export function fakeNetwork() {
  const sockets: FakeSocket[] = []
  const history: { channel: string; query?: { after_seq?: number; before_seq?: number } }[] = []
  const pages: Record<string, Result<MessagePage>> = {}
  const timelines: Record<string, Result<TimelinePage>> = {}
  const topicLists: Record<string, Result<TopicPage>> = {}
  const topicSummaries: Record<string, Result<TopicSummaryResponse>> = {}
  const topicMessages: Record<string, Result<MessagePage>> = {}
  const replyChains: Record<string, Result<ReplyChainPage>> = {}
  const replyHistory: { channel: string; anchor: string; query?: { after_seq?: number; limit?: number } }[] = []
  const sends: ({ channel: string; body: SendMessageRequest } & Deferred<Result<Message>>)[] = []
  const lists: Deferred<Result<{ channels: Channel[] }>>[] = []
  const creates: ({ name: string } & Deferred<Result<Channel>>)[] = []
  let ids = 0
  function toTimelinePage(page: MessagePage): TimelinePage {
    const byTopic = new Map<string, TopicSummary>()
    const items: TimelineItem[] = []
    for (const m of page.messages) {
      if (m.topic_id === null) {
        items.push({ kind: 'message', message: m })
      } else {
        const prev = byTopic.get(m.topic_id)
        byTopic.set(m.topic_id, {
          id: m.topic_id,
          name: prev?.name ?? m.topic_id,
          first_seq: prev?.first_seq ?? m.seq,
          last_seq: m.seq,
          message_count: (prev?.message_count ?? 0) + 1,
          latest_message: m,
          read_seq: 0,
          unread_count: 0,
        })
      }
    }
    for (const topic of byTopic.values()) items.push({ kind: 'topic', topic })
    items.sort((a, b) => (a.kind === 'message' ? a.message.seq : a.topic.last_seq) - (b.kind === 'message' ? b.message.seq : b.topic.last_seq))
    return {
      as_of_seq: page.messages.at(-1)?.seq ?? 0,
      has_more: page.has_more,
      items,
    }
  }
  const options = (selfId = 'me'): Pick<SessionOptions, 'channelsApi' | 'topicsApi' | 'repliesApi' | 'sync'> => ({
    channelsApi: {
      listChannels() {
        const d = deferred<Result<{ channels: Channel[] }>>()
        lists.push(d)
        return d.promise
      },
      createChannel(body) {
        const d = deferred<Result<Channel>>()
        creates.push({ name: body.name, resolve: d.resolve })
        return d.promise
      },
    },
    topicsApi: {
      async listTimeline(channel, query) {
        history.push({ channel, query: query?.before_position !== undefined ? { before_seq: query.before_position } : undefined })
        if (timelines[channel]) return timelines[channel]
        const page = pages[channel] ?? { ok: true, data: { messages: [], has_more: false } }
        return page.ok ? { ok: true, data: toTimelinePage(page.data) } : page
      },
      async listTopics(channel) {
        if (topicLists[channel]) return topicLists[channel]
        const page = pages[channel]
        if (page && !page.ok) return page
        const tl = toTimelinePage(page?.data ?? { messages: [], has_more: false })
        return {
          ok: true,
          data: {
            as_of_seq: tl.as_of_seq,
            has_more: false,
            topics: tl.items.flatMap(i => (i.kind === 'topic' ? [i.topic] : [])),
          },
        }
      },
      async getTopicSummary(channel, topic) {
        const custom = topicSummaries[`${channel}:${topic}`]
        if (custom) return custom
        const page = pages[channel]
        if (page && !page.ok) return page
        const tl = toTimelinePage(page?.data ?? { messages: [], has_more: false })
        const found = tl.items.find(i => i.kind === 'topic' && i.topic.id === topic)
        if (found?.kind === 'topic') return { ok: true, data: { as_of_seq: tl.as_of_seq, topic: found.topic } }
        return { ok: false, kind: 'http', status: 404, error: 'topic_not_found' }
      },
      async listTopicMessages(channel, topic) {
        const custom = topicMessages[`${channel}:${topic}`]
        if (custom) return custom
        const page = pages[channel]
        if (page && !page.ok) return page
        return {
          ok: true,
          data: {
            messages: (page?.data.messages ?? []).filter(m => m.topic_id === topic),
            has_more: false,
          },
        }
      },
    },
    repliesApi: {
      async listReplyChain(channel, anchor, query) {
        replyHistory.push({ channel, anchor, query })
        const custom =
          replyChains[`${channel}:${anchor}:${query?.after_seq ?? 'initial'}`] ?? replyChains[`${channel}:${anchor}`]
        if (custom) return custom
        const page = pages[channel]
        if (page && !page.ok) return page
        const all = page?.data.messages ?? []
        const byId = new Map(all.map(m => [m.id, m]))
        let root = byId.get(anchor)
        if (!root) return { ok: false, kind: 'http', status: 404, error: 'reply_chain_not_found' }
        while (root.reply_to && byId.has(root.reply_to)) root = byId.get(root.reply_to)!
        const chainIds = new Set<string>([root.id])
        const messages: Message[] = []
        for (const m of all) {
          if (m.id === root.id || m.reply_root_id === root.id || (m.reply_to !== null && chainIds.has(m.reply_to))) {
            chainIds.add(m.id)
            if (query?.after_seq === undefined || m.seq > query.after_seq) messages.push(m)
          }
        }
        return { ok: true, data: { root_id: root.id, messages, has_more: false } }
      },
    },
    sync: {
      newId: () => `${selfId}-c${++ids}`,
      api: {
        async listMessages(channel, query) {
          history.push({ channel, query })
          return pages[channel] ?? { ok: true, data: { messages: [], has_more: false } }
        },
        sendMessage(channel, body) {
          const d = deferred<Result<Message>>()
          sends.push({ channel, body, resolve: d.resolve })
          return d.promise
        },
      },
      connect(handlers) {
        const socket: FakeSocket = { ...handlers, sent: [], closed: false }
        sockets.push(socket)
        return { send: m => { socket.sent.push(m) }, close: () => { socket.closed = true } }
      },
    },
  })
  return {
    sockets, history, pages, timelines, topicLists, topicSummaries, topicMessages, replyChains, replyHistory, sends, lists, creates, options,
    get socket() { return sockets.at(-1)! },
    event: (e: ServerEvent) => sockets.at(-1)!.onEvent(e),
    subscribed: (channel: string, caught_up_seq: number) =>
      sockets.at(-1)!.onEvent({ type: 'subscribed', channel_id: channel, caught_up_seq }),
    subscribeCount: (channel: string) =>
      sockets.flatMap(s => s.sent).filter(m => m.type === 'subscribe' && m.channel_id === channel).length,
  }
}
export type FakeNetwork = ReturnType<typeof fakeNetwork>

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })
export const sentBy = (selfId: string, seq: number, clientMessageId: string, body: string, channelId = 'A'): Message =>
  ({ ...record(seq, channelId), sender: selfId, client_message_id: clientMessageId, body })
