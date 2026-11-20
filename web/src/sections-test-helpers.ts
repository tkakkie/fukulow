import { vi } from 'vitest'
import { channel } from './adapter-test-helpers.svelte'
import type { ClientMessage, Dm, Result, SectionLayout, ServerEvent, UnreadChannel } from './api'
import { connectRealtime, type SocketLike } from './realtime'
import { createSession, type SessionOptions } from './session'
import type { SectionsApi } from './sections'

export const ok = <T>(data: T) => ({ ok: true as const, data })
export const http = (status: number, error: string): Extract<Result<never>, { kind: 'http' }> => ({ ok: false, kind: 'http', status, error })
export const network = { ok: false, kind: 'network' } as const
export const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
export const advance = (ms = 200) => vi.advanceTimersByTimeAsync(ms)
export const history = '00000000-0000-4000-8000-000000000515'
export const row = (id: string, patch: Partial<UnreadChannel> = {}): UnreadChannel => ({
  ...channel(id), history_generation: history, as_of_seq: 5, read_seq: 2, unread_count: 3,
  main_unread_count: 3, mention_unread_count: 0, main_mention_unread_count: 0, ...patch,
})
export const layout = (generation: string, channel_ids: string[] = ['A'], name = 'Saved'): SectionLayout => ({
  generation, sections: [{ id: 'S', name, channel_ids }], other_channel_ids: [],
})
export const database = () => ({ layout: layout('1'), rows: [row('A')] })
type Db = ReturnType<typeof database>

export function client(db: Db = database(), options: {
  initialList?: Promise<Result<{ channels: UnreadChannel[] }>>
  organizationId?: string
  accountSignal?: AbortSignal
  timeoutMs?: number
  dms?: Dm[]
} = {}) {
  const sockets: SocketLike[] = [], controls: ClientMessage[] = []
  const getLayout = vi.fn(async (_signal: AbortSignal): Promise<Result<SectionLayout>> => ok(db.layout))
  const list = vi.fn(async (_signal?: AbortSignal): Promise<Result<{ channels: UnreadChannel[] }>> => ok({ channels: db.rows }))
  if (options.initialList) list.mockReturnValueOnce(options.initialList)
  const sectionsApi = {
    layout: getLayout,
    placement: vi.fn<SectionsApi['placement']>(async () => ok({ generation: db.layout.generation, section_id: 'S' })),
    create: vi.fn<SectionsApi['create']>(async body => ok({ id: body.id, generation: db.layout.generation })),
    rename: vi.fn<SectionsApi['rename']>(async () => ok(undefined)),
    reorder: vi.fn<SectionsApi['reorder']>(async () => ok(undefined)),
    moveChannel: vi.fn<SectionsApi['moveChannel']>(async () => ok(undefined)),
    reorderChannels: vi.fn<SectionsApi['reorderChannels']>(async () => ok(undefined)),
    delete: vi.fn<SectionsApi['delete']>(async () => ok(undefined)),
  }
  const channelsApi = { listChannels: list, createChannel: vi.fn(async () => ok(row('new'))) }
  const onEnded = vi.fn()
  const session = createSession({
    selfId: 'member', organizationId: options.organizationId ?? 'org', accountSignal: options.accountSignal,
    onEnded, channelsApi, sectionsApi,
    dmsApi: {
      list: async () => ok({ history_generation: history, dms: options.dms ?? [], next_cursor: null }),
      changes: async () => ok({ dms: options.dms ?? [], caught_up: true, next_cursor: 'cursor' }),
      open: async () => network,
    },
    topicsApi: {
      listTimeline: async () => ok({ history_generation: history, as_of_seq: 5, has_more: false, items: [] }),
      listTopics: async () => ok({ history_generation: history, as_of_seq: 5, topics: [], has_more: false }),
      getTopicSummary: async () => network,
      listTopicMessages: async () => network,
    },
    unreadApi: {
      listChannels: async () => ok({ history_generation: history, channels: db.rows }),
      markRead: async (_scope, body) => ok({ history_generation: history, read_seq: body.read_seq }),
      getTopicSummary: async () => network,
    },
    sync: {
      connect: handlers => connectRealtime(handlers, () => {
        const socket: SocketLike = {
          send: data => controls.push(JSON.parse(data) as ClientMessage),
          close() {}, onopen: null, onmessage: null, onclose: null,
        }
        sockets.push(socket)
        return socket
      }),
      checkMembership: async () => network,
      random: () => 0.5, requestTimeoutMs: options.timeoutMs,
      api: {
        listMessages: async () => ok({ history_generation: history, as_of_seq: 5, has_more: false, messages: [] }),
        listChannelEvents: async () => network, sendMessage: async () => network,
      },
    },
  } satisfies SessionOptions)
  const sections = session.sections
  const socket = () => sockets.at(-1)!
  const event = (value: ServerEvent) => socket().onmessage?.({ data: JSON.stringify(value) })
  return {
    db, session, sections, onEnded, getLayout, list, sectionsApi, channelsApi, sockets, socket, controls, event,
    async ready() { socket().onopen?.(); event({ type: 'activity_ready' }); await advance() },
    groups: () => sections.get().groups.map(g => [g.id, g.channels.map(c => c.id)]),
    generation: () => sections.get().generation,
  }
}
