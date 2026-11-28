import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivity, createActivityTarget, type ReadReason } from './activity'
import { CHANNEL_READ_ID_HEADER, type ChannelList, type Result, type ServerEvent, type UnreadChannel } from './api'
import { CHANNEL_READ_MARK, createChannels } from './channels'
import { createSession } from './session'
import { createSync } from './sync'
import { createUnread } from './unread'
import { CHANNELS_API_PATH, classifyChannelReads } from '../scripts/read-reasons.ts'

const ORG = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000010'
const ARCHIVED = '00000000-0000-4000-8000-000000000011'
const GEN = '00000000-0000-4000-8000-000000000515'
const SELF = '00000000-0000-4000-8000-000000000099'

type MarkDetail = { id: string; reasons: ReadReason[] }

const readMarks = (): MarkDetail[] =>
  performance
    .getEntriesByName(CHANNEL_READ_MARK, 'mark')
    .map((entry) => (entry as PerformanceMark).detail as MarkDetail)

const channelRow = (id: string, archived = false): UnreadChannel => ({
  id,
  kind: 'channel',
  name: archived ? 'old' : 'general',
  visibility: 'public',
  archived,
  capabilities: {
    can_add_members: { allowed: true },
    can_remove_members: { allowed: true },
    can_manage_managers: { allowed: true },
    can_leave: { allowed: false },
    can_rename: { allowed: true },
    can_archive: { allowed: true },
  },
  history_generation: GEN,
  as_of_seq: 1,
  read_seq: 1,
  unread_count: 0,
  main_unread_count: 0,
  mention_unread_count: 0,
  main_mention_unread_count: 0,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('Channel read-reason instrumentation regressions (#983)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    performance.clearMarks(CHANNEL_READ_MARK)
  })

  afterEach(() => {
    performance.clearMarks(CHANNEL_READ_MARK)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('labels archived Channel list requests with paired read ids and marks (finding 3)', async () => {
    const captured: Array<{ search: string; readId: string | null }> = []
    class FakeSocket {
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: ((e: { code: number }) => void) | null = null
      send() {}
      close() {}
      emit(event: ServerEvent) { this.onmessage?.({ data: JSON.stringify(event) }) }
    }
    const sockets: FakeSocket[] = []
    vi.stubGlobal('WebSocket', class extends FakeSocket {
      constructor() { super(); sockets.push(this) }
    })
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', origin: 'http://localhost', pathname: '/', href: 'http://localhost/' })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, 'http://localhost')
      if (url.pathname === `/api/v1/orgs/${ORG}/channels`) {
        const readId = init?.headers ? new Headers(init.headers).get(CHANNEL_READ_ID_HEADER) : null
        captured.push({ search: url.search, readId })
        const archived = url.searchParams.get('archived') === 'true'
        return json({ history_generation: GEN, channels: [channelRow(archived ? ARCHIVED : CHANNEL, archived)] })
      }
      return json({ history_generation: GEN, channels: [], dms: [], next_cursor: null, sections: [], other_channel_ids: [], generation: '1', caught_up: true })
    }))

    const session = createSession({ selfId: SELF, organizationId: ORG, onEnded: () => {} })
    try {
      await flush()
      const releaseArchived = session.channels.holdArchived()
      await flush()
      releaseArchived()

      const archivedCalls = captured.filter((c) => c.search.includes('archived=true'))
      expect(archivedCalls.length).toBeGreaterThanOrEqual(1)
      expect(archivedCalls.every((c) => typeof c.readId === 'string' && c.readId.length > 0)).toBe(true)

      const marks = readMarks()
      const summary = classifyChannelReads(
        captured.map((c, idx) => ({ seq: idx + 1, method: 'GET', path: CHANNELS_API_PATH, search: c.search, readId: c.readId })),
        marks,
      )
      expect(summary.valid).toBe(true)
      expect(summary.countsByClass.startup).toBe(captured.length)
      expect(summary.countedReads).toBe(captured.length)
    } finally {
      session.close()
    }
  })

  it('labels standalone createChannels.load() fallback reads with a paired read id and mark (finding 3)', async () => {
    const readIds: Array<string | undefined> = []
    const channels = createChannels({
      listChannels: async (_signal, readId) => {
        readIds.push(readId)
        return { ok: true, data: { channels: [channelRow(CHANNEL)] } }
      },
      createChannel: async () => ({ ok: false, kind: 'network' }),
    })
    try {
      await channels.load()
      await channels.load()
      const marks = readMarks()
      expect(readIds).toHaveLength(2)
      expect(readIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
      expect(marks.map((m) => m.id)).toEqual(readIds)
      expect(marks.map((m) => m.reasons)).toEqual([['initial'], ['reconcile']])
    } finally {
      channels.close()
    }
  })

  it('labels standalone createUnread.refresh() fallback reads with a paired read id and mark (finding 3)', async () => {
    const readIds: Array<string | undefined> = []
    class FakeSocket {
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: ((e: { code: number }) => void) | null = null
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', origin: 'http://localhost', pathname: '/', href: 'http://localhost/' })
    const sync = createSync({
      selfId: SELF,
      organizationId: ORG,
      api: {
        listChannelEvents: async () => ({ ok: true, data: { history_generation: GEN, events: [], has_more: false } }),
        listMessages: async () => ({ ok: true, data: { history_generation: GEN, as_of_seq: 1, messages: [], has_more: false } }),
        sendMessage: async () => ({ ok: false, kind: 'network' }),
      },
    })
    const unread = createUnread(sync, {
      api: {
        listChannels: async (_signal, readId) => {
          readIds.push(readId)
          return { ok: true, data: { history_generation: GEN, channels: [channelRow(CHANNEL)] } as ChannelList }
        },
        markRead: async () => ({ ok: false, kind: 'network' }),
        getTopicSummary: async () => ({ ok: false, kind: 'network' }),
      },
    })
    try {
      await sync.start()
      await flush()
      expect(readIds.length).toBeGreaterThanOrEqual(1)
      expect(readIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
      const marks = readMarks()
      expect(marks.map((m) => m.id)).toEqual(readIds)
      expect(marks[0]!.reasons).toEqual(['initial'])
    } finally {
      unread.close()
      await sync.close()
    }
  })

  it('restores reasons by union with pendingReasons on generation mismatch, below-floor, and retry (finding 4)', async () => {
    // 1. Generation mismatch: O5 (periodic) arrives while a notice read is in flight.
    {
      const seenReasons: ReadReason[][] = []
      let releaseFirst!: (r: Result<number>) => void
      const first = new Promise<Result<number>>((resolve) => { releaseFirst = resolve })
      const target = createActivityTarget<number>({
        load: (_signal, reasons) => {
          seenReasons.push([...reasons])
          return seenReasons.length === 1 ? first : Promise.resolve({ ok: true, data: 2 })
        },
        accept: () => {},
        random: () => 0.5,
      })
      try {
        target.invalidate('notice', 0)
        await vi.advanceTimersByTimeAsync(0)
        expect(seenReasons).toEqual([['notice']])

        // O5 arrives while the notice read is in flight -> bumps generation and adds 'periodic' to pendingReasons.
        target.invalidate('periodic', 200)
        releaseFirst({ ok: true, data: 1 })
        await vi.advanceTimersByTimeAsync(250)
        await flush()

        expect(seenReasons).toHaveLength(2)
        expect(new Set(seenReasons[1])).toEqual(new Set(['notice', 'periodic']))
      } finally {
        target.close()
      }
    }

    // 2. Below-floor response while another reason is queued in pendingReasons.
    {
      const seenReasons: ReadReason[][] = []
      let releaseFirst!: (r: Result<number>) => void
      const first = new Promise<Result<number>>((resolve) => { releaseFirst = resolve })
      const target = createActivityTarget<number>({
        load: (_signal, reasons) => {
          seenReasons.push([...reasons])
          return seenReasons.length === 1 ? first : Promise.resolve({ ok: true, data: 2 })
        },
        covers: (n) => n >= 2,
        accept: () => {},
        random: () => 0.5,
      })
      try {
        target.invalidate('reconcile', 0)
        await vi.advanceTimersByTimeAsync(0)
        expect(seenReasons).toEqual([['reconcile']])

        // Queue a notice while the reconcile read is in flight (does not bump generation), then return below-floor.
        target.invalidate('notice', 200)
        releaseFirst({ ok: true, data: 1 })
        await vi.advanceTimersByTimeAsync(250)
        await flush()

        expect(seenReasons).toHaveLength(2)
        expect(new Set(seenReasons[1])).toEqual(new Set(['reconcile', 'notice']))
      } finally {
        target.close()
      }
    }

    // 3. Retryable failure (503) while O5 (periodic) arrived during the in-flight notice read.
    {
      const seenReasons: ReadReason[][] = []
      let releaseFirst!: (r: Result<number>) => void
      const first = new Promise<Result<number>>((resolve) => { releaseFirst = resolve })
      const target = createActivityTarget<number>({
        load: (_signal, reasons) => {
          seenReasons.push([...reasons])
          return seenReasons.length === 1 ? first : Promise.resolve({ ok: true, data: 2 })
        },
        accept: () => {},
        random: () => 0.5,
      })
      try {
        target.invalidate('notice', 0)
        await vi.advanceTimersByTimeAsync(0)
        expect(seenReasons).toEqual([['notice']])

        target.invalidate('periodic', 200)
        releaseFirst({ ok: false, kind: 'http', status: 503 })
        await vi.advanceTimersByTimeAsync(2_000)
        await flush()

        expect(seenReasons).toHaveLength(2)
        expect(new Set(seenReasons[1])).toEqual(new Set(['notice', 'periodic']))
      } finally {
        target.close()
      }
    }
  })

  it('still issues requests with read ids and preserves retry/fence when performance.mark throws, while classification catches the missing mark as invalid (finding 5)', async () => {
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('performance.mark failed')
    })

    const receivedIds: Array<string | undefined> = []
    let failOnce = true
    const activity = createActivity({ watched: () => false, random: () => 0.5 })
    const channels = createChannels(
      {
        listChannels: async (_signal, readId) => {
          receivedIds.push(readId)
          if (failOnce) {
            failOnce = false
            return { ok: false, kind: 'network' }
          }
          return { ok: true, data: { channels: [channelRow(CHANNEL)] } }
        },
        createChannel: async () => ({ ok: false, kind: 'network' }),
      },
      undefined,
      activity,
    )
    try {
      void channels.load()
      await flush()
      expect(receivedIds).toHaveLength(1)
      expect(typeof receivedIds[0]).toBe('string')
      expect(channels.get().status).toBe('error')

      // Retry behaviour remains intact despite performance.mark throwing.
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      expect(receivedIds).toHaveLength(2)
      expect(typeof receivedIds[1]).toBe('string')
      expect(receivedIds[1]).not.toBe(receivedIds[0])
      expect(channels.get().status).toBe('ready')
      expect(channels.get().channels.map((c) => c.id)).toEqual([CHANNEL])

      // The missing marks cause classification to mark the run invalid and count the reads as unknown.
      const summary = classifyChannelReads(
        receivedIds.map((readId, idx) => ({ seq: idx + 1, method: 'GET', path: CHANNELS_API_PATH, readId })),
        readMarks(),
      )
      expect(summary.valid).toBe(false)
      expect(summary.invalidReasons).toEqual(['unmatched_request'])
      expect(summary.countsByClass.unknown).toBe(2)
      expect(summary.countedReads).toBe(2)
    } finally {
      channels.close()
      activity.close()
    }
  })
})
