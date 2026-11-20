import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeNetwork, flush, record } from './adapter-test-helpers.svelte'
import type { Channel, ChannelList, Result } from './api'
import type { ChannelsApi } from './channels'
import { dm } from './dm-test-helpers'
import { createSession } from './session'
import { deferred, http, main, ok, row } from './unread-test-helpers'

const history_generation = record(1).history_generation
const mentioned = (seq: number) => ({ ...record(seq), mentions: [{ member_id: 'me', name: '自分' }] })
const a = row({ as_of_seq: 1, unread_count: 1, main_unread_count: 1, mention_unread_count: 1, main_mention_unread_count: 1 })
const b = row({ id: 'B', name: 'B' })
const archived = (channel = a) => ({ ...channel, archived: true })
const list = (channels: ChannelList['channels']) => ok({ history_generation, channels })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function client(initial = [a, b]) {
  const rows = new Map(initial.map(channel => [channel.id, channel]))
  const net = fakeNetwork()
  net.pages.A = ok({ history_generation, as_of_seq: 1, messages: [mentioned(1)], has_more: false })
  const options = net.options()
  const activeRows = async () => list([...rows.values()].filter(channel => !channel.archived))
  const listChannels = vi.fn(activeRows)
  const listArchivedChannels = vi.fn<NonNullable<ChannelsApi['listArchivedChannels']>>(async () => list([...rows.values()].filter(channel => channel.archived)))
  const getChannel = vi.fn<NonNullable<ChannelsApi['getChannel']>>(async id => rows.has(id) ? ok(rows.get(id)!) : http(404, 'channel not found'))
  const updateChannel = vi.fn<NonNullable<ChannelsApi['updateChannel']>>(async (id, body) => {
    const channel = rows.get(id)
    if (!channel) return http(404, 'channel not found')
    rows.set(id, { ...channel, ...body })
    return ok(undefined)
  })
  const listTopics = vi.fn<NonNullable<typeof options.topicsApi>['listTopics']>(async (id, query, signal) => id === 'D'
    ? http(400, 'dm_topics_not_allowed')
    : options.topicsApi!.listTopics(id, query, signal))
  const changes = vi.fn(async () => ok({ dms: [dm('D')], next_cursor: '', caught_up: true }))
  const listDms = vi.fn(async () => ok({ history_generation, dms: [dm('D')], next_cursor: null }))
  const session = createSession({ selfId: 'me', organizationId: 'org', onEnded: vi.fn(), ...options,
    channelsApi: { listChannels, listArchivedChannels, getChannel, updateChannel, createChannel: vi.fn() },
    topicsApi: { ...options.topicsApi!, listTopics },
    unreadApi: { ...options.unreadApi!, listChannels: activeRows },
    dmsApi: { changes, list: listDms, open: vi.fn() },
    sync: { ...options.sync, random: () => 0.5 },
  })
  net.socket.onReady()
  return { net, session, channels: session.channels, rows, listChannels, listArchivedChannels, getChannel, updateChannel, listTopics, changes, listDms }
}

it('resolves a linked archived Channel by id with its name, Capabilities and read-only flag', async () => {
  const channel = archived({ ...a, name: 'Archive', capabilities: { ...a.capabilities, can_archive: { allowed: true } } })
  const c = client([channel, b])
  try {
    c.channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(200)
    expect(c.channels.get()).toMatchObject({ selectedId: 'A', channels: [b], openChannel: channel })
    expect(c.channels.isArchived('A')).toBe(true)
    expect(c.getChannel).toHaveBeenCalledExactlyOnceWith('A', expect.any(AbortSignal))
    expect(c.listTopics).toHaveBeenCalledWith('A', { limit: 1 }, expect.any(AbortSignal))
    expect(c.listArchivedChannels).toHaveBeenCalled()
    expect(c.session.sync.getTimeline('A').get().messages).toEqual([mentioned(1)])
  } finally { c.session.close() }
})

it('refreshes held Channel reads on notices and reconciliations without reading a DM by id', async () => {
  const c = client([archived(), b])
  const release = c.channels.holdArchived()
  try {
    c.channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(200)
    for (const type of ['channel_list_changed', 'activity_ready', 'activity_reset', 'channel_access_gained', 'channel_access_revoked'] as const) {
      const before = [c.listChannels, c.listArchivedChannels, c.getChannel].map(mock => mock.mock.calls.length)
      if (type === 'channel_access_gained' || type === 'channel_access_revoked') c.net.event({ type, channel_id: 'B' })
      else c.net.event({ type })
      await vi.advanceTimersByTimeAsync(1000)
      expect([c.listChannels, c.listArchivedChannels, c.getChannel].map(mock => mock.mock.calls.length), type).toEqual(before.map(n => n + 1))
    }
    expect(c.session.dms.get().rows.map(row => row.identity.id)).toEqual(['D'])
    c.session.dms.select('D')
    c.getChannel.mockClear()
    c.net.event({ type: 'channel_list_changed' })
    c.net.event({ type: 'activity_reset' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.getChannel).not.toHaveBeenCalled()
    expect(c.channels.isArchived('D')).toBe(false)

    release()
    c.listArchivedChannels.mockClear()
    c.net.event({ type: 'channel_list_changed' })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.listArchivedChannels).not.toHaveBeenCalled()
    expect(c.channels.get().archivedList).toBeUndefined()
  } finally { release(); c.session.close() }
})

it('does not use Channel by-id reads for an undiscovered DM link', async () => {
  const c = client()
  try {
    c.channels.selectHint('D')
    await vi.advanceTimersByTimeAsync(200)
    expect(c.session.dms.get().rows).toEqual([])
    expect(c.listTopics).toHaveBeenCalledWith('D', { limit: 1 }, expect.any(AbortSignal))
    expect(c.getChannel).not.toHaveBeenCalled()
    c.net.event({ type: 'channel_list_changed' })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.listTopics).toHaveBeenCalledTimes(1)

    c.net.event({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.listDms).toHaveBeenCalledWith(expect.objectContaining({ channel_id: ['D'] }), expect.any(AbortSignal))
    expect(c.getChannel).not.toHaveBeenCalled()
  } finally { c.session.close() }
})

it('refreshes both Channel lists after successful rename, archive and restore', async () => {
  const c = client()
  const release = c.channels.holdArchived()
  try {
    await flush()
    const renamed = { ...a, name: 'Renamed' }
    await expect(c.channels.rename('A', renamed.name)).resolves.toBeNull()
    expect(c.channels.get().channels).toEqual([a, b])
    await vi.advanceTimersByTimeAsync(201)
    expect(c.channels.get().channels).toEqual([renamed, b])

    await expect(c.channels.archive('A')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(201)
    expect(c.channels.get().channels).toEqual([b])
    expect(c.channels.get().archivedList?.channels).toEqual([archived(renamed)])

    await expect(c.channels.restore('A')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(201)
    expect(c.channels.get().channels).toEqual([renamed, b])
    expect(c.channels.get().archivedList?.channels).toEqual([])
    expect(c.listChannels).toHaveBeenCalledTimes(4)
    expect(c.listArchivedChannels).toHaveBeenCalledTimes(4)
  } finally { release(); c.session.close() }
})

it('fences stale ordinary, archived and open Channel responses after list-change and release', async () => {
  const c = client([archived(), b])
  const staleOrdinary = deferred<Result<ChannelList>>()
  const staleArchive = deferred<Result<ChannelList>>()
  const staleOpen = deferred<Result<Channel>>()
  try {
    c.channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(200)
    c.listChannels.mockReturnValueOnce(staleOrdinary.promise)
    c.listArchivedChannels.mockReturnValueOnce(staleArchive.promise)
    c.getChannel.mockReturnValueOnce(staleOpen.promise)
    const release = c.channels.holdArchived()
    c.net.event({ type: 'channel_list_changed' })
    await vi.advanceTimersByTimeAsync(200)
    c.rows.set('A', archived({ ...a, name: 'Current' }))
    c.net.event({ type: 'channel_list_changed' })
    staleOrdinary.resolve(list([a, b]))
    staleOpen.resolve(http(404, 'channel not found'))
    staleArchive.resolve(list([archived({ ...a, name: 'Stale' })]))
    await flush()
    expect(c.channels.get()).toMatchObject({ channels: [b], openChannel: archived(), archivedList: { channels: [archived()] } })
    expect(c.session.sync.get().channels.A.state).not.toBe('unavailable')
    await vi.advanceTimersByTimeAsync(200)
    expect(c.channels.get().openChannel?.name).toBe('Current')
    expect(c.channels.get().archivedList?.channels.map(channel => channel.name)).toEqual(['Current'])

    const lateArchive = deferred<Result<ChannelList>>()
    const lateOpen = deferred<Result<Channel>>()
    c.listArchivedChannels.mockReturnValueOnce(lateArchive.promise)
    c.getChannel.mockReturnValueOnce(lateOpen.promise)
    c.net.event({ type: 'channel_list_changed' })
    await vi.advanceTimersByTimeAsync(200)
    const archiveSignal = c.listArchivedChannels.mock.lastCall![0]
    const openSignal = c.getChannel.mock.lastCall![1]
    release()
    c.channels.select('B')
    expect(archiveSignal.aborted).toBe(true)
    expect(openSignal.aborted).toBe(true)
    lateArchive.resolve(list([archived()]))
    lateOpen.resolve(ok(archived()))
    await flush()
    expect(c.channels.get()).toMatchObject({ selectedId: 'B', archivedList: undefined, openChannel: undefined })
  } finally { c.session.close() }
})

it('routes a current by-id 404 through C9 and stops automatic reads for that Channel', async () => {
  const c = client([archived(), b])
  try {
    c.channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(200)
    c.rows.delete('A')
    c.net.event({ type: 'channel_access_revoked', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.channels.get().openChannel).toBeUndefined()
    expect(c.session.sync.get()).toMatchObject({ organization: 'available', channels: { A: { state: 'unavailable' } } })
    expect(c.getChannel).toHaveBeenCalledTimes(2)
    c.net.event({ type: 'channel_list_changed' })
    c.net.event({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.getChannel).toHaveBeenCalledTimes(2)
    c.channels.select('B')
    await flush()
    expect(c.session.sync.get().channels.B.state).not.toBe('unavailable')
  } finally { c.session.close() }
})

it('archive and restore suppress badges without replacing Unread generations, records or a pending mark', async () => {
  const c = client()
  const { net, channels, session, rows } = c
  const { unread, sync } = session
  try {
    await flush()
    net.subscribed('A', 1)
    unread.visibility(true)
    const visit = await unread.enter({ channel: 'A', topicId: null })
    net.holdMarkReads = true
    unread.presented(visit!, [1])
    await flush()
    expect(net.pendingMarkReads).toHaveLength(1)
    const old = unread.get('A'), unwatched = unread.get('B')
    expect(old).toMatchObject({ unreadCount: 1, mentionUnreadCount: 1, asOfSeq: 1, main: { position: 0 } })
    const subscription = sync.get().channels.A.subscription

    rows.set('B', archived(b))
    await expect(channels.archive('A')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(201)
    expect(channels.get().channels).toEqual([])
    expect(channels.get().openChannel).toMatchObject({ id: 'A', archived: true })
    expect(unread.get('A')).toMatchObject({ generation: old.generation, unreadCount: null, mentionUnreadCount: null, asOfSeq: 1, main: { position: 0, unreadCount: null } })
    expect(unread.get('B')).toMatchObject({ generation: unwatched.generation, asOfSeq: unwatched.asOfSeq, unreadCount: null })

    net.event({ type: 'message', seq: 2, kind: 'create', message: mentioned(2) })
    rows.set('B', b)
    await expect(channels.restore('A')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(channels.get().channels.map(channel => channel.id)).toEqual(['A', 'B'])
    expect(channels.isArchived('A')).toBe(false)
    expect(unread.get('A')).toMatchObject({ generation: old.generation, unreadCount: 2, mentionUnreadCount: 2, asOfSeq: 1, main: { position: 0 } })
    net.pendingMarkReads[0].resolve(ok({ history_generation, read_seq: 1 }))
    await flush()
    expect(unread.get('A')).toMatchObject({ generation: old.generation, unreadCount: 1, mentionUnreadCount: 1, asOfSeq: 1, main: { position: 1 } })
    expect(unread.get('B')).toMatchObject({ generation: unwatched.generation, unreadCount: unwatched.unreadCount })
    expect(sync.get().channels.A).toMatchObject({ cursor: 2, subscription })
    expect(c.updateChannel.mock.calls).toEqual([['A', { archived: true }], ['A', { archived: false }]])
    expect(c.channels.get().archivedList).toBeUndefined()
  } finally { session.close() }
})

it('marks presented Messages on an archived deep link with the archived section collapsed', async () => {
  const c = client([archived(), b])
  const { channels, net, session: { unread } } = c
  try {
    channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(400)
    net.subscribed('A', 1)
    unread.visibility(true)
    const visit = await unread.enter(main)
    expect(unread.get('A')).toMatchObject({ unreadCount: null, main: { position: 0 }, entry: { boundary: 0 } })
    unread.presented(visit!, [1])
    await flush()
    expect(net.markReads).toEqual([{ scope: main, body: { history_generation, read_seq: 1 } }])
    expect(unread.get('A').main.position).toBe(1)
    channels.select('B')
    expect(channels.get().archivedList).toBeUndefined()
  } finally { c.session.close() }
})

it('refreshes the selected archived Channel read baseline after C8 cursor reset', async () => {
  const c = client([archived(row({ as_of_seq: 1, read_seq: 1, unread_count: 0, main_unread_count: 0 })), b])
  const { channels, net, session: { unread } } = c
  try {
    channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(400)
    net.subscribed('A', 1)
    expect(unread.get('A').main.position).toBe(1)
    c.listArchivedChannels.mockClear()

    c.rows.set('A', archived(row({ as_of_seq: 0, unread_count: 0, main_unread_count: 0 })))
    net.pages.A = ok({ history_generation, as_of_seq: 0, messages: [], has_more: false })
    net.timelines.A = ok({ history_generation, as_of_seq: 0, items: [], has_more: false })
    net.socket.onClose(1006)
    await vi.advanceTimersByTimeAsync(1000)
    net.socket.onReady()
    await flush()
    net.subscribed('A', 0)
    await vi.advanceTimersByTimeAsync(400)
    expect(c.listArchivedChannels).toHaveBeenCalled()
    expect(unread.get('A')).toMatchObject({ asOfSeq: 0, unreadCount: null, main: { position: 0 } })

    net.subscribed('A', 0)
    net.event({ type: 'message', seq: 1, kind: 'create', message: mentioned(1) })
    unread.visibility(true)
    const visit = await unread.enter(main)
    unread.presented(visit!, [1])
    await flush()
    expect(c.session.sync.get().channels.A).toMatchObject({ cursor: 1 })
    expect(unread.get('A').entry).toMatchObject({ boundary: 0 })
    expect(net.markReads).toEqual([{ scope: main, body: { history_generation, read_seq: 1 } }])
  } finally { c.session.close() }
})

it('refreshes the held archived list when a mark-read response leaves the main position unresolved', async () => {
  const c = client([archived(row({ main_unread_count: 3 })), b])
  const { channels, net, session: { unread } } = c
  try {
    net.pages.A = ok({ history_generation, as_of_seq: 3, messages: [mentioned(1), mentioned(2), mentioned(3)], has_more: false })
    channels.selectHint('A')
    await vi.advanceTimersByTimeAsync(400)
    net.subscribed('A', 3)
    unread.visibility(true)
    const visit = await unread.enter(main)
    await vi.advanceTimersByTimeAsync(400)
    c.listArchivedChannels.mockClear()
    net.holdMarkReads = true
    unread.presented(visit!, [1])
    await flush()
    expect(net.pendingMarkReads[0]?.body.read_seq).toBe(1)
    c.rows.set('A', archived(row({ read_seq: 2, unread_count: 1, main_unread_count: 1 })))
    net.pendingMarkReads[0].resolve(ok({ history_generation, read_seq: 2 }))
    await flush()
    expect(unread.get('A').main).toMatchObject({ error: true, position: 2 })
    await vi.advanceTimersByTimeAsync(200)
    expect(c.listArchivedChannels).toHaveBeenCalledTimes(1)
    expect(unread.get('A').main).toMatchObject({ error: false, position: 2 })
    unread.presented(visit!, [3])
    await flush()
    expect(net.pendingMarkReads[1]?.body.read_seq).toBe(3)
  } finally { c.session.close() }
})

it.each(['main', 'first Topic Message', 'Reply'] as const)('settles a 409 archived %s send in WASM without retrying', async scope => {
  const c = client()
  try {
    await flush()
    c.net.subscribed('A', 1)
    const timeline = c.session.sync.getTimeline('A')
    const composer = scope === 'Reply' ? timeline.reply('id1') : timeline
    composer.setDraft('body')
    if (scope === 'first Topic Message') timeline.setTopicDraft('First')
    const submission = composer.submit()
    await flush()
    expect(c.net.sends).toHaveLength(1)
    const send = c.net.sends[0]
    expect(send.body.topic_name).toBe(scope === 'first Topic Message' ? 'First' : undefined)
    expect(send.body.reply_to).toBe(scope === 'Reply' ? 'id1' : undefined)
    send.resolve(http(409, 'channel_archived'))
    await submission
    expect(timeline.get().pending).toMatchObject([{
      clientMessageId: send.body.client_message_id, body: 'body', status: 'failed', retryable: false,
      failureCode: 'channel_archived',
    }])
    await composer.retry(send.body.client_message_id)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.net.sends).toHaveLength(1)
  } finally { c.session.close() }
})
