import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReadReason } from './activity'
import { fakeNetwork } from './adapter-test-helpers.svelte'
import { CHANNEL_READ_ID_HEADER, type DmListQuery, type ReadPosition, type Result } from './api'
import { CHANNEL_READ_MARK } from './channels'
import { dm } from './dm-test-helpers'
import { moveEvent } from './protocol-test-helpers'
import { createSession } from './session'
import { UNREAD_RECORD_LIMIT, unreadApi } from './unread'
import { deferred, http, msg, ok, row } from './unread-test-helpers'

const id = 'A'
const message = { ...msg(1), mentions: [{ member_id: 'me', name: 'Reader' }] }
const generation = message.history_generation
const nextGeneration = '00000000-0000-4000-8000-000000000516'
const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
type Target = 'channels' | 'dms'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  performance.clearMarks(CHANNEL_READ_MARK)
})
afterEach(() => {
  performance.clearMarks(CHANNEL_READ_MARK)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function client(target: Target, { complete = true, organization = 'org', historyGeneration = generation } = {}) {
  const isDm = target === 'dms'
  const net = fakeNetwork()
  const mark = deferred<Result<ReadPosition>>()
  const reads: ReadReason[][] = []
  const first = { ...message, history_generation: historyGeneration }
  let currentGeneration = historyGeneration, readSeq = 0, watermark = 1, count = 1, completeFields = complete
  const counts = () => ({
    history_generation: currentGeneration, as_of_seq: watermark, read_seq: readSeq,
    unread_count: count, main_unread_count: count, mention_unread_count: count,
  })
  function listRow<T extends object>(value: T) {
    if (!completeFields) Reflect.deleteProperty(value, 'mention_unread_count')
    return value
  }
  net.pages[id] = ok({ history_generation: currentGeneration, as_of_seq: 1, has_more: false, messages: [first] })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const { pathname } = new URL(input, 'http://localhost')
    const listPath = `/api/v1/orgs/${organization}/channels`
    if (pathname === listPath) {
      const readId = new Headers(init?.headers).get(CHANNEL_READ_ID_HEADER)
      const detail = performance.getEntriesByName(CHANNEL_READ_MARK, 'mark')
        .map(entry => (entry as PerformanceMark).detail as { id: string; reasons: ReadReason[] })
        .find(entry => entry.id === readId)
      if (detail) reads.push(detail.reasons)
      return Response.json({ history_generation: currentGeneration, channels: isDm ? [] : [listRow(row({ ...counts(), main_mention_unread_count: count }))] })
    }
    if (pathname === `${listPath}/${id}` && !isDm) return Response.json(row())
    return new Response(null, { status: 404 })
  })
  const listDms = vi.fn(async (_query: DmListQuery) => ok({
    history_generation: currentGeneration, dms: isDm ? [listRow(dm(id, counts()))] : [], next_cursor: null,
  }))
  const { kind, peer } = dm(id)
  const changes = async () => ok({ dms: isDm ? [{ id, kind, peer }] : [], next_cursor: 'done', caught_up: true })
  const onEnded = vi.fn()
  const { topicsApi, repliesApi, sectionsApi, replyCountsApi, sync } = net.options()
  const source = unreadApi(organization, () => currentGeneration)
  const markRead = vi.fn<typeof source.markRead>(() => mark.promise)
  const session = createSession({ repliesApi, sectionsApi,
    selfId: 'me', organizationId: organization, onEnded,
    topicsApi: { ...topicsApi!, listTopics: async () => isDm ? http(400, 'dm_topics_not_allowed') :
      ok({ history_generation: currentGeneration, as_of_seq: 1, has_more: false, topics: [] }) },
    replyCountsApi: async (channel, body, signal) => {
      const r = await replyCountsApi!(channel, body, signal)
      return r.ok ? ok({ ...r.data, history_generation: currentGeneration }) : r
    },
    unreadApi: { ...source, markRead },
    dmsApi: { changes, list: listDms, open: vi.fn() },
    sync: {
      ...sync, random: () => 0.5,
      api: {
        ...sync!.api!,
        listChannelEvents: async () => ok({ history_generation: currentGeneration, events: [], has_more: false }),
      },
    },
  })
  const invalidate = vi.spyOn((isDm ? session.dms.activityTarget : session.channels.activityTarget)!, 'invalidate')
  const confirm = () => net.event({ type: 'subscribed', channel_id: id, history_generation: currentGeneration, caught_up_seq: 1 })
  const notice = (seq = 1, topicId: string | null = null) =>
    net.event({ type: 'read_position_changed', channel_id: id, topic_id: topicId, read_seq: seq })
  return {
    target, net, session, mark, markRead, first, confirm, notice, invalidate, listDms, reads, onEnded,
    coverage: () => session.unread.activityMainCoverage(id),
    async boot(confirmed = true) {
      net.socket.onReady()
      net.event({ type: 'activity_ready' })
      await advance(650)
      if (isDm) session.dms.select(id)
      else if (!completeFields) await session.sync.watch(id)
      await advance()
      if (confirmed) confirm()
      expect(session.sync.get().channels[id]?.subscription?.confirmed).toBe(confirmed)
      if (complete) expect(session.unread.get(id)).toMatchObject({ unreadCount: 1, mentionUnreadCount: 1 })
    },
    async present() {
      session.unread.visibility(true)
      const visit = await session.unread.enter({ channel: id, topicId: null })
      expect(visit).toBeDefined()
      session.unread.presented(visit!, [1])
      await advance()
      expect(markRead).toHaveBeenCalledExactlyOnceWith({ channel: id, topicId: null }, { history_generation: currentGeneration, read_seq: 1 })
    },
    async ack(seq = 1) {
      mark.resolve(ok({ history_generation: currentGeneration, read_seq: seq }))
      await advance()
    },
    snapshot(seq: number, w = Math.max(1, seq)) {
      readSeq = seq; watermark = w; count = seq === 0 ? 1 : 0; completeFields = true
    },
    rotateHistory() {
      currentGeneration = nextGeneration
      const m = { ...first, history_generation: currentGeneration }
      net.pages[id] = ok({ history_generation: currentGeneration, as_of_seq: 1, has_more: false, messages: [m] })
      net.timelines[id] = ok({ history_generation: currentGeneration, as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m }] })
      session.sync.observeHistoryGeneration(currentGeneration)
    },
  }
}

type Client = ReturnType<typeof client>

async function expectNotice(c: Client, shouldRead: boolean, seq = 1, topicId: string | null = null, ms = 400) {
  c.invalidate.mockClear()
  const reads = c.reads.length, dmReads = c.listDms.mock.calls.length
  c.notice(seq, topicId)
  if (shouldRead) expect(c.invalidate).toHaveBeenCalledWith('notice', 200, c.target === 'dms' ? false : undefined)
  else expect(c.invalidate).not.toHaveBeenCalled()
  await advance(ms)
  if (c.target === 'dms') {
    const followups = c.listDms.mock.calls.slice(dmReads)
    if (shouldRead) expect(followups.map(([query]) => query.channel_id)).toContainEqual([id])
    else expect(followups).toEqual([])
  } else {
    expect(c.reads.slice(reads).some(reasons => reasons.includes('notice'))).toBe(shouldRead)
  }
}

async function authorized(target: Target) {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    expect(c.coverage()).toBe(0)
    await c.ack()
    expect(c.session.unread.get(id)).toMatchObject({ unreadCount: 0, mentionUnreadCount: 0 })
    expect(c.coverage()).toBe(1)
    await expectNotice(c, false)
  } finally { c.session.close() }
}

function evictEvidence(c: Client) {
  for (let seq = 2; seq <= UNREAD_RECORD_LIMIT + 2; seq++) {
    c.net.event({ type: 'message', kind: 'create', seq, message: msg(seq) })
  }
}

it.each([
  { scenario: 'echo before ACK', prepare(c: Client) {
    c.snapshot(1)
  } },
  { scenario: 'failed PUT', async prepare(c: Client) {
    c.mark.resolve(http(400))
    await advance()
    expect(c.session.unread.get(id).main.stopped).toBe(true)
  } },
  { scenario: 'retryable PUT pending', async prepare(c: Client) {
    c.mark.resolve(http(503))
    await advance()
    expect(c.session.unread.get(id).main.position).toBe(0)
  } },
  { scenario: 'ACK above intent', seq: 2, async prepare(c: Client) {
    await c.ack(2)
    expect(c.session.unread.get(id).main).toMatchObject({ position: 2, error: true })
    c.snapshot(2)
  } },
  { scenario: 'evidence lost before ACK', async prepare(c: Client) {
    evictEvidence(c)
    await c.ack()
    expect(c.session.unread.get(id).main).toMatchObject({ position: 1, error: true })
    c.snapshot(1, UNREAD_RECORD_LIMIT + 2)
  } },
  { scenario: 'newer notice from another device', seq: 2, async prepare(c: Client) {
    await c.ack()
    expect(c.coverage()).toBe(1)
    c.snapshot(2)
  } },
  { scenario: 'Topic-scope notice', topicId: 'T', channelsOnly: true, async prepare(c: Client) {
    await c.ack()
    expect(c.coverage()).toBe(1)
    c.snapshot(1)
  } },
  { scenario: 'concurrent Move', channelsOnly: true, async prepare(c: Client) {
    await c.ack()
    c.net.event(moveEvent(2, message.id))
    expect(c.session.sync.get().channels[id]?.moveSeq).toBe(2)
    expect(c.session.unread.get(id).mentionUnreadCount).toBeNull()
    c.snapshot(1, 2)
  } },
  { scenario: 'edit at or below the baseline watermark', async prepare(c: Client) {
    await c.ack()
    c.net.event({ type: 'message', kind: 'edit', seq: 2, message: { ...message, version: 2, body: 'Edited' } })
    expect(c.session.unread.get(id).unreadCount).toBeNull()
    c.snapshot(1, 2)
  } },
  { scenario: 'delete at or below the baseline watermark', async prepare(c: Client) {
    await c.ack()
    c.net.event({ type: 'message', kind: 'delete', seq: 2, message: { ...message, version: 2, deleted: true, body: undefined, mentions: [] } })
    expect(c.session.unread.get(id).mentionUnreadCount).toBeNull()
    c.snapshot(1, 2)
  } },
  { scenario: 'evidence evicted after ACK', async prepare(c: Client) {
    await c.ack()
    evictEvidence(c)
    expect(c.session.unread.get(id).unreadCount).toBeNull()
    c.snapshot(1, UNREAD_RECORD_LIMIT + 2)
  } },
])('retains the notice read after $scenario (#1084)', async ({ prepare, seq, topicId, channelsOnly }) => {
  const targets: Target[] = channelsOnly ? ['channels'] : ['channels', 'dms']
  for (const target of targets) {
    const c = client(target)
    try {
      await c.boot()
      await c.present()
      await prepare(c)
      await expectNotice(c, true, seq, topicId)
    } finally { c.session.close() }
    await authorized(target)
  }
})

it.each(['channels', 'dms'] as const)('reads %s on notice with incomplete count fields (#1084)', async target => {
  const c = client(target, { complete: false })
  try {
    await c.boot()
    expect(c.coverage()).toBe(-1)
    expect(c.session.unread.get(id).mentionUnreadCount).toBeNull()
    c.snapshot(1)
    await expectNotice(c, true, 1, null, 3000)
  } finally { c.session.close() }
  await authorized(target)
})

it.each(['channels', 'dms'] as const)('reads %s on notice before subscription confirmation (#1084)', async target => {
  const c = client(target)
  try {
    await c.boot(false)
    await c.present()
    await c.ack()
    expect(c.session.unread.get(id).mentionUnreadCount).toBe(0)
    expect(c.coverage()).toBe(0)
    c.snapshot(1)
    await expectNotice(c, true)
  } finally { c.session.close() }
  await authorized(target)
})

it.each(['channels', 'dms'] as const)('reads %s on a replacement socket after disconnect (#1084)', async target => {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    await c.ack()
    const lifetime = c.session.unread.get(id).generation
    const connection = c.session.sync.get().connection
    expect(c.coverage()).toBe(1)
    c.net.socket.onClose(1001)
    expect(c.session.sync.get().connection).toBeNull()
    expect(c.coverage()).toBe(0)
    const oldSocket = c.net.socket
    await advance(250)
    expect(c.net.socket).not.toBe(oldSocket)

    c.net.socket.onReady()
    c.confirm()
    expect(c.session.sync.get().connection).not.toBe(connection)
    expect(c.session.sync.get().channels[id]?.subscription?.confirmed).toBe(true)
    expect(c.session.unread.get(id).generation).toBe(lifetime)
    expect(c.coverage()).toBe(0)
    c.net.event({ type: 'activity_ready' })
    c.snapshot(1)
    await expectNotice(c, true)
  } finally { c.session.close() }
  await authorized(target)
})

it.each(['channels', 'dms'] as const)('reads %s when a PUT ACK arrives on a later socket (#1084)', async target => {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    c.net.socket.onClose(1001)
    await advance(250)
    c.net.socket.onReady()
    c.confirm()
    c.net.event({ type: 'activity_ready' })
    await c.ack()
    expect(c.session.unread.get(id).main.position).toBe(1)
    expect(c.coverage()).toBe(0)
    c.snapshot(1)
    await expectNotice(c, true)
  } finally { c.session.close() }
  await authorized(target)
})

it.each(['channels', 'dms'] as const)('reads %s on notice after revoke and re-grant (#1084)', async target => {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    await c.ack()
    expect(c.coverage()).toBe(1)
    c.net.event({ type: 'channel_access_revoked', channel_id: id })
    expect(c.coverage()).toBe(-1)
    c.net.event({ type: 'channel_access_gained', channel_id: id })
    await advance(650)
    expect(c.coverage()).toBe(0)
    c.snapshot(1)
    await expectNotice(c, true)
  } finally { c.session.close() }
  await authorized(target)
})

it.each(['channels', 'dms'] as const)('reads %s on notice after a Channel lifetime change (#1084)', async target => {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    await c.ack()
    const lifetime = c.session.unread.get(id).generation
    expect(c.coverage()).toBe(1)
    c.session.unread.leave()
    expect(c.session.unread.get(id).generation).not.toBe(lifetime)
    expect(c.session.unread.get(id).mentionUnreadCount).toBe(0)
    expect(c.coverage()).toBe(0)
    c.snapshot(1)
    await expectNotice(c, true)
  } finally { c.session.close() }
  await authorized(target)
})

it.each(['channels', 'dms'] as const)('reads %s on notice after a history generation change (#1084)', async target => {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    await c.ack()
    const epoch = c.session.sync.get().historyEpoch
    expect(c.coverage()).toBe(1)
    c.rotateHistory()
    expect(c.session.sync.get().historyEpoch).toBe(epoch + 1)
    await advance()
    await c.boot()
    expect(c.session.sync.get().historyEpoch).toBe(epoch + 1)
    expect(c.coverage()).toBe(0)
    c.snapshot(1)
    await expectNotice(c, true)
  } finally { c.session.close() }
  await authorized(target)
})

it.each([
  { target: 'channels', reason: 'Organization retirement' },
  { target: 'dms', reason: 'Organization retirement' },
  { target: 'channels', reason: 'Session end' },
  { target: 'dms', reason: 'Session end' },
] as const)('reads $target on notice after $reason (#1084)', async ({ target, reason }) => {
  const c = client(target)
  try {
    await c.boot()
    await c.present()
    await c.ack()
    expect(c.coverage()).toBe(1)
    c.net.socket.onClose(reason === 'Session end' ? 4001 : 4003)
    await advance()
    expect(c.coverage()).toBe(-1)
    expect(c.onEnded).toHaveBeenCalledTimes(reason === 'Session end' ? 1 : 0)
    c.invalidate.mockClear()
    c.notice()
    expect(c.invalidate).not.toHaveBeenCalled()
  } finally { c.session.close() }

  // A retired socket cannot deliver notices. The replacement owner reads the same position.
  const replacement = client(target, { organization: reason === 'Organization retirement' ? 'other-org' : 'org' })
  try {
    await replacement.boot()
    expect(replacement.coverage()).toBe(0)
    replacement.snapshot(1)
    await expectNotice(replacement, true)
  } finally { replacement.session.close() }
  await authorized(target)
})
