import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReadReason } from './activity'
import { fakeNetwork } from './adapter-test-helpers.svelte'
import { CHANNEL_READ_ID_HEADER } from './api'
import { CHANNEL_READ_MARK } from './channels'
import { createSession, startInitialChannels } from './session'
import { deferred, msg, ok, row } from './unread-test-helpers'

const organizationId = 'org'
const channelId = 'A'
const message = msg(1)
const history_generation = message.history_generation
const listPath = `/api/v1/orgs/${organizationId}/channels`
const json = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  performance.clearMarks(CHANNEL_READ_MARK)
})

afterEach(() => {
  performance.clearMarks(CHANNEL_READ_MARK)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function startupClient() {
  const initial = deferred<Response>()
  const replacement = deferred<Response>()
  const listIds: (string | null)[] = []
  const puts: unknown[] = []
  let readSeq = 0
  const snapshot = () => json({ history_generation, channels: [row({
    as_of_seq: 1, read_seq: readSeq,
    main_unread_count: 1 - readSeq, unread_count: 1 - readSeq,
    main_mention_unread_count: 1 - readSeq, mention_unread_count: 1 - readSeq,
  })] })
  const net = fakeNetwork()
  net.pages[channelId] = ok({ history_generation, as_of_seq: 1, has_more: false, messages: [
    { ...message, mentions: [{ member_id: 'me', name: 'Reader' }] },
  ] })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(input, 'http://localhost')
    if (pathname === listPath && !searchParams.has('archived')) {
      listIds.push(new Headers(init?.headers).get(CHANNEL_READ_ID_HEADER))
      if (listIds.length === 1) return initial.promise
      if (listIds.length === 2) return replacement.promise
      return snapshot()
    }
    if (pathname === `${listPath}/${channelId}/read` && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      readSeq = Math.max(readSeq, body.read_seq)
      return json({ history_generation, read_seq: readSeq })
    }
    return new Response(null, { status: 404 })
  })
  const { topicsApi, repliesApi, replyCountsApi, sectionsApi, sync } = net.options()
  const account = new AbortController()
  const session = createSession({
    selfId: 'me', organizationId, onEnded: vi.fn(), accountSignal: account.signal,
    initialChannels: startInitialChannels(organizationId, account.signal),
    topicsApi, repliesApi, replyCountsApi, sectionsApi,
    dmsApi: { changes: async () => ok({ dms: [], next_cursor: 'done', caught_up: true }),
      list: async () => ok({ history_generation, dms: [], next_cursor: null }), open: vi.fn() },
    sync: { ...sync, random: () => 0.5 },
  })
  const deliverReadNotice = () => net.event({ type: 'read_position_changed', channel_id: channelId, topic_id: null, read_seq: readSeq })
  function reasons() {
    const marks = performance.getEntriesByName(CHANNEL_READ_MARK, 'mark')
      .map(mark => (mark as PerformanceMark).detail as { id: string; reasons: ReadReason[] })
    expect(marks.map(mark => mark.id)).toEqual(listIds)
    return marks.map(mark => mark.reasons)
  }
  return { session, net, puts, reasons, deliverReadNotice,
    resolveInitial: () => initial.resolve(snapshot()),
    resolveReplacement: () => replacement.resolve(snapshot()),
    markOnAnotherSocket() { readSeq = 1; deliverReadNotice() },
    close() { account.abort(); session.close() },
  }
}

it('keeps two startup Channel list reads when the local ACK precedes its notice (#1084)', async () => {
  const c = startupClient()
  try {
    await vi.advanceTimersByTimeAsync(0)
    c.net.socket.onReady()
    c.net.event({ type: 'activity_ready' })
    expect(c.reasons()).toEqual([['initial']])

    c.resolveInitial()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.reasons()).toEqual([['initial'], ['reconcile', 'initial']])
    expect(c.session.channels.get().selectedId).toBeNull()
    c.resolveReplacement()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.session.channels.get().selectedId).toBe(channelId)
    expect(c.net.subscribeCount(channelId)).toBe(1)
    c.net.subscribed(channelId, 1)
    expect(c.session.unread.get(channelId)).toMatchObject({ unreadCount: 1, mentionUnreadCount: 1 })

    c.session.unread.visibility(true)
    const visit = await c.session.unread.enter({ channel: channelId, topicId: null })
    expect(visit).toBeDefined()
    c.session.unread.presented(visit!, [1])
    await vi.advanceTimersByTimeAsync(0)
    expect(c.puts).toEqual([{ history_generation, read_seq: 1 }])
    expect(c.session.unread.get(channelId)).toMatchObject({ main: { position: 1 }, unreadCount: 0, mentionUnreadCount: 0 })
    expect(c.reasons()).toEqual([['initial'], ['reconcile', 'initial']])

    c.deliverReadNotice()
    await vi.advanceTimersByTimeAsync(400)
    expect(c.reasons()).toEqual([['initial'], ['reconcile', 'initial']])
  } finally { c.close() }
})

it('folds a read notice received before the Ready replacement into two startup Channel list reads (#1084)', async () => {
  const c = startupClient()
  try {
    await vi.advanceTimersByTimeAsync(0)
    c.net.socket.onReady()
    c.net.event({ type: 'activity_ready' })
    expect(c.reasons()).toEqual([['initial']])

    // The cold default Channel is still unselected, so the earlier mark comes from another socket.
    c.markOnAnotherSocket()
    c.resolveInitial()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.reasons()).toEqual([['initial'], ['reconcile', 'notice', 'initial']])
    c.resolveReplacement()
    await vi.advanceTimersByTimeAsync(400)
    expect(c.session.unread.get(channelId)).toMatchObject({ main: { position: 1 }, unreadCount: 0, mentionUnreadCount: 0 })
    expect(c.puts).toEqual([])
    expect(c.reasons()).toHaveLength(2)
  } finally { c.close() }
})
