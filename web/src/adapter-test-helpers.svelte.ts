import { flushSync, tick } from 'svelte'
import type { Channel, ClientMessage, Message, MessagePage, Result, SendMessageRequest, ServerEvent } from './api'
import type { RealtimeHandlers } from './realtime'
import { record } from './protocol-test-helpers'
import type { SessionOptions } from './session'

export { record }
export const channel = (id: string, name = id): Channel => ({ id, name, visibility: 'public', capabilities: { can_add_members: { allowed: false } } })
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
  const sends: ({ channel: string; body: SendMessageRequest } & Deferred<Result<Message>>)[] = []
  const lists: Deferred<Result<{ channels: Channel[] }>>[] = []
  const creates: ({ name: string } & Deferred<Result<Channel>>)[] = []
  let ids = 0
  const options = (selfId = 'me'): Pick<SessionOptions, 'channelsApi' | 'sync'> => ({
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
    sockets, history, pages, sends, lists, creates, options,
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
