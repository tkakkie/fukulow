import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChannelPlacement, Result, SectionLayout } from './api'
import { dm } from './dm-test-helpers'
import { advance, client, database, deferred, history, http, layout, network, ok, row } from './sections-test-helpers'

const clients: ReturnType<typeof client>[] = []
function open(...args: Parameters<typeof client>) {
  const c = client(...args); clients.push(c); return c
}
async function boot(...args: Parameters<typeof client>) {
  const c = open(...args)
  c.sections.hold()
  await advance(0)
  await c.ready()
  return c
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clients.splice(0).forEach(c => c.session.close())
  vi.useRealTimers()
})

it('intersects complete snapshots by id and preserves section and Other Channels order', async () => {
  const db = database()
  db.layout = { generation: '0', sections: [], other_channel_ids: ['A', 'z', 'Á', 'á'] }
  db.rows = [row('A'), row('z'), row('Á'), row('á')]
  const c = await boot(db)
  expect(c.groups()).toEqual([[null, ['A', 'z', 'Á', 'á']]])
  db.layout = {
    generation: '1',
    sections: [
      { id: 'second', name: 'Duplicate', channel_ids: ['hidden', 'z', 'A'] },
      { id: 'first', name: 'Duplicate', channel_ids: [] },
    ],
    other_channel_ids: ['archived', 'á', 'Á'],
  }
  db.rows = [row('A', { name: 'Current name' }), row('list-only'), row('z'), row('Á'), row('á'), row('archived', { archived: true })]
  c.event({ type: 'channel_list_changed' })
  await advance()
  expect(c.groups()).toEqual([['second', ['z', 'A']], ['first', []], [null, ['á', 'Á']]])
  expect(c.sections.get().groups[0]).toMatchObject({ name: 'Duplicate', channels: [{ id: 'z' }, { id: 'A', name: 'Current name' }] })
  expect(JSON.stringify(c.sections.get())).not.toMatch(/"id":"(hidden|archived|list-only)"/)
  db.layout = { generation: '2', sections: [], other_channel_ids: ['z', 'A', 'Á', 'á'] }
  c.event({ type: 'sections_changed', generation: '2' })
  await advance()
  expect(c.groups()).toEqual([[null, ['z', 'A', 'Á', 'á']]])
})

it('coalesces generation gaps and duplicates and rejects reads below either numeric floor', async () => {
  const c = await boot()
  c.getLayout.mockClear()
  const first = deferred<Result<SectionLayout>>()
  c.getLayout.mockReturnValueOnce(first.promise)
  c.event({ type: 'sections_changed', generation: '9007199254740992' })
  await advance()
  c.event({ type: 'sections_changed', generation: '9007199254740993' })
  c.event({ type: 'sections_changed', generation: '12' })
  c.db.layout = layout('9007199254740993', ['A'], 'Latest')
  first.resolve(ok(c.db.layout))
  await advance(200)
  expect(c.getLayout).toHaveBeenCalledOnce()
  expect(c.generation()).toBe('9007199254740993')
  c.event({ type: 'sections_changed', generation: c.db.layout.generation })
  await advance()
  expect(c.getLayout).toHaveBeenCalledOnce()

  c.event({ type: 'sections_changed', generation: '9223372036854775806' })
  await advance()
  expect(c.generation()).toBe('9007199254740993')
  c.db.layout = layout('9223372036854775807', [], 'Complete')
  await advance()
  expect(c.generation()).toBe('9223372036854775807')
  expect(c.groups()).toEqual([['S', []], [null, []]])

  c.db.layout = layout('9223372036854775806', ['A'], 'Stale')
  c.event({ type: 'activity_reset' })
  await advance(1000)
  expect(c.generation()).toBe('9223372036854775807')
  expect(c.groups()).toEqual([['S', []], [null, []]])
  c.db.layout = layout('9223372036854775807', ['A'], 'Current access')
  await advance()
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
})

it('repeated notices during layout reads keep the 200 ms follow-up without setting an error', async () => {
  const c = await boot()
  const reads = Array.from({ length: 3 }, () => deferred<Result<SectionLayout>>())
  c.getLayout.mockClear()
  for (const read of reads) c.getLayout.mockReturnValueOnce(read.promise)
  c.getLayout.mockResolvedValueOnce(network)
  const errors = vi.fn()
  c.sections.subscribe(() => {
    const { error } = c.sections.get()
    if (error) errors(error)
  })
  c.event({ type: 'sections_changed', generation: '2' })
  await advance()
  for (const [index, read] of reads.entries()) {
    expect(c.getLayout).toHaveBeenCalledTimes(index + 1)
    c.event({ type: 'sections_changed', generation: String(index + 3) })
    read.resolve(ok(layout(String(index + 2))))
    await advance(199)
    expect(c.getLayout).toHaveBeenCalledTimes(index + 1)
    expect(c.generation()).toBe('1')
    expect(c.sections.get().error).toBeUndefined()
    expect(errors).not.toHaveBeenCalled()
    await advance(1)
  }

  expect(c.getLayout).toHaveBeenCalledTimes(4)
  expect(errors).toHaveBeenCalledExactlyOnceWith(network)
  c.db.layout = layout('5')
  await advance(749)
  expect(c.getLayout).toHaveBeenCalledTimes(4)
  await advance(1)
  expect(c.getLayout).toHaveBeenCalledTimes(5)
  expect(c.generation()).toBe('5')
  expect(c.sections.get().error).toBeUndefined()
})

it('repeated equal-generation notices enter A10 backoff after 3 rejections', async () => {
  const c = await boot()
  const reads = Array.from({ length: 3 }, () => deferred<Result<SectionLayout>>())
  c.getLayout.mockClear()
  for (const read of reads) c.getLayout.mockReturnValueOnce(read.promise)
  c.event({ type: 'sections_changed', generation: '5' })
  await advance()
  for (const [index, read] of reads.entries()) {
    expect(c.getLayout).toHaveBeenCalledTimes(index + 1)
    c.event({ type: 'sections_changed', generation: '5' })
    c.event({ type: 'sections_changed', generation: '4' })
    read.resolve(ok(layout('1')))
    await advance(100)
    c.event({ type: 'sections_changed', generation: '5' })
    if (index < 2) await advance(100)
  }
  // 3rd rejection enters A10 backoff (750 ms at random = 0.5): no 4th read at 200 ms.
  await advance(100)
  expect(c.getLayout).toHaveBeenCalledTimes(3)
  expect(c.generation()).toBe('1')
  expect(c.sections.get().error).toBeUndefined()
  await advance(549)
  expect(c.getLayout).toHaveBeenCalledTimes(3)
  c.db.layout = layout('5')
  await advance(1)
  expect(c.getLayout).toHaveBeenCalledTimes(4)
  expect(c.generation()).toBe('5')
  expect(c.sections.get().error).toBeUndefined()
})

it('Channel creation refetches only the Channel list and sections layout', async () => {
  const c = await boot()
  const unrelated = { invalidate: vi.fn(), close: vi.fn() }
  c.session.holdActivity('archived-channels', unrelated)
  c.session.holdActivity('open-channel', unrelated)
  c.getLayout.mockClear()
  c.list.mockClear()
  c.db.rows = [row('A'), row('new')]
  c.db.layout = { ...c.db.layout, other_channel_ids: ['new'] }
  await expect(c.session.channels.create({ name: 'new', visibility: 'public' })).resolves.toMatchObject({ channel: { id: 'new' } })
  expect(c.session.channels.authorizedList.get().current).toBe(false)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  await advance()
  expect(c.list).toHaveBeenCalledOnce()
  expect(c.getLayout).toHaveBeenCalledOnce()
  expect(c.groups()).toEqual([['S', ['A']], [null, ['new']]])
  expect(unrelated.invalidate).not.toHaveBeenCalled()
})

it('fences both reads on revoke and requires a fresh pair to show the saved slot on regain', async () => {
  const db = database()
  db.rows = [row('A'), row('X', { visibility: 'private', unread_count: 5 }), row('B')]
  db.layout = layout('1', ['B', 'X', 'A'])
  const c = await boot(db)
  const before = c.session.unread.get('X').generation
  const oldLayout = deferred<Result<SectionLayout>>(), oldList = deferred<Result<{ channels: typeof db.rows }>>()
  c.getLayout.mockReturnValueOnce(oldLayout.promise)
  c.list.mockReturnValueOnce(oldList.promise)
  c.event({ type: 'channel_list_changed' })
  await advance()
  c.event({ type: 'channel_access_revoked', channel_id: 'X' })
  expect(c.groups()).toEqual([['S', ['B', 'A']], [null, []]])
  expect(c.session.channels.get().channels.map(r => r.id)).toEqual(['A', 'B'])
  expect(c.session.unread.get('X').unreadCount).not.toBe(5)
  oldLayout.resolve(ok(db.layout))
  oldList.resolve(ok({ channels: db.rows }))
  db.layout = layout('1', ['B', 'A'])
  db.rows = [row('A'), row('B')]
  await advance(400)
  expect(c.groups()).toEqual([['S', ['B', 'A']], [null, []]])

  const regainedList = deferred<Result<{ channels: typeof db.rows }>>()
  c.list.mockReturnValueOnce(regainedList.promise)
  db.layout = layout('2', ['A', 'X', 'B'])
  c.event({ type: 'channel_access_gained', channel_id: 'X' })
  await advance()
  expect(c.groups()).toEqual([['S', ['A', 'B']], [null, []]])
  regainedList.resolve(ok({ channels: [row('A'), row('B'), row('X', { read_seq: 5, unread_count: 0, main_unread_count: 0 })] }))
  await advance(0)
  expect(c.groups()).toEqual([['S', ['A', 'X', 'B']], [null, []]])
  expect(c.session.unread.get('X').generation).not.toBe(before)
  expect(c.session.unread.get('X').unreadCount).toBe(0)
  expect(c.controls.every(control => control.channel_id !== 'X')).toBe(true)
})

it.each(['layout', 'list'] as const)('a fresh %s omission hides and fences its other snapshot until both can show the Channel', async source => {
  const db = database()
  db.rows.push(row('B'))
  db.layout = layout('1', ['A', 'B'])
  const c = await boot(db)
  const fresh = deferred<Result<SectionLayout>>(), authorized = deferred<Result<{ channels: typeof db.rows }>>()
  if (source === 'layout') {
    c.list.mockReturnValueOnce(authorized.promise)
    db.layout = layout('1', ['A'])
  } else {
    c.getLayout.mockReturnValueOnce(fresh.promise)
    db.rows = [row('A')]
  }
  c.event({ type: 'channel_list_changed' })
  await advance()
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  fresh.resolve(ok(layout('99', ['A', 'B'], 'Stale')))
  authorized.resolve(ok({ channels: [row('A'), row('B', { name: 'Stale' })] }))
  await advance(250)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.generation()).toBe('1')
  db.layout = layout('1', ['A', 'B'])
  db.rows = [row('A'), row('B')]
  c.event({ type: 'channel_list_changed' })
  await advance()
  expect(c.groups()).toEqual([['S', ['A', 'B']], [null, []]])
})

it('keeps redundant public grant removal and unwatched subscription loss independent of section placement and Unread', async () => {
  const db = database()
  db.rows.push(row('B'))
  db.layout = layout('1', ['B', 'A'])
  const c = await boot(db)
  const before = c.session.unread.get('B')
  expect(before.unreadCount).toBe(3)
  c.getLayout.mockClear(); c.list.mockClear()
  c.event({ type: 'channel_members_changed', channel_id: 'B' })
  c.event({ type: 'channel_access_lost', channel_id: 'B' })
  await advance()
  expect(c.groups()).toEqual([['S', ['B', 'A']], [null, []]])
  expect(c.session.unread.get('B')).toEqual(before)
  expect(c.getLayout).not.toHaveBeenCalled()
  expect(c.list).not.toHaveBeenCalled()
  expect(c.controls.every(control => control.channel_id !== 'B')).toBe(true)
  c.event({ type: 'channel_list_changed' })
  await advance()
  expect(c.getLayout).toHaveBeenCalledOnce()
  expect(c.list).toHaveBeenCalledOnce()
})

it('layout regain cannot revive a Channel watch that ended under C9', async () => {
  const c = await boot()
  c.event({ type: 'subscribed', history_generation: history, channel_id: 'A', caught_up_seq: 5 })
  await advance(0)
  expect(c.session.sync.get().channels.A?.subscription?.confirmed).toBe(true)
  c.event({ type: 'channel_access_lost', channel_id: 'A' })
  await advance(0)
  expect(c.session.sync.get().channels.A?.state).toBe('unavailable')
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  c.db.rows = []
  c.db.layout = layout('1', [])
  c.event({ type: 'channel_access_revoked', channel_id: 'A' })
  await advance()
  expect(c.groups()).toEqual([['S', []], [null, []]])
  c.db.rows = [row('A')]
  c.db.layout = layout('1')
  const watches = c.controls.filter(control => control.type === 'subscribe').length
  c.event({ type: 'channel_access_gained', channel_id: 'A' })
  await advance()
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.session.sync.get().channels.A?.state).toBe('unavailable')
  expect(c.controls.filter(control => control.type === 'subscribe')).toHaveLength(watches)
})

it('fences reads at mutation start and at completion and serializes local intents', async () => {
  const c = await boot()
  const beforeStart = deferred<Result<SectionLayout>>(), beforeCompletion = deferred<Result<SectionLayout>>()
  const write = deferred<Result<undefined>>()
  c.getLayout.mockReturnValueOnce(beforeStart.promise).mockReturnValueOnce(beforeCompletion.promise)
  c.sectionsApi.rename.mockReturnValueOnce(write.promise)
  c.sections.retry()
  await advance()
  const renaming = c.sections.rename('S', { name: 'Renamed' })
  await expect(c.sections.delete('S')).resolves.toMatchObject({ kind: 'busy' })
  expect(c.sectionsApi.delete).not.toHaveBeenCalled()
  beforeStart.resolve(ok(layout('99', [], 'Pre-start')))
  await advance(250)
  expect(c.generation()).toBe('1')
  c.db.layout = layout('2', ['A'], 'Renamed')
  write.resolve(ok(undefined))
  await expect(renaming).resolves.toEqual(ok(undefined))
  beforeCompletion.resolve(ok(layout('100', [], 'Pre-completion')))
  await advance(0)
  expect(c.generation()).toBe('1')
  await advance()
  expect(c.generation()).toBe('2')
  expect(c.sections.get().groups[0]).toMatchObject({ name: 'Renamed' })
})

it('all six successful writes dirty layout and ACKs leave the last complete snapshot intact', async () => {
  const c = await boot()
  const writes = [
    () => c.sections.create({ id: 'created', name: 'Name' }),
    () => c.sections.rename('S', { name: 'New name' }),
    () => c.sections.reorder({ section_ids: ['S'] }),
    () => c.sections.moveChannel('A', { section_id: null }),
    () => c.sections.reorderChannels({ section_id: 'S', channel_ids: ['A'] }),
    () => c.sections.delete('S'),
  ]
  for (const [i, write] of writes.entries()) {
    const before = c.sections.get().groups
    c.db.layout = layout(String(i + 2), ['A'], `Snapshot ${i}`)
    c.getLayout.mockClear()
    const result = await write()
    expect(result.ok).toBe(true)
    expect(c.sections.get().groups).toBe(before)
    await advance()
    expect(c.getLayout).toHaveBeenCalledOnce()
    expect(c.sections.get().groups[0]).toMatchObject({ name: `Snapshot ${i}` })
  }
})

it('refreshes after unknown outcomes and order conflicts without retrying definite refusals or writes', async () => {
  const c = await boot()
  c.getLayout.mockClear()
  c.sectionsApi.delete.mockResolvedValueOnce({ ...network, error: 'lock_contention' })
  await expect(c.sections.delete('S')).resolves.toEqual({ ...network, error: 'lock_contention' })
  await advance()
  expect(c.getLayout).not.toHaveBeenCalled()
  c.sectionsApi.delete.mockResolvedValueOnce(network)
  c.db.layout = { generation: '2', sections: [], other_channel_ids: ['A'] }
  await expect(c.sections.delete('S')).resolves.toEqual(network)
  await expect(c.sections.delete('S')).resolves.toMatchObject({ kind: 'reconciling' })
  await advance()
  expect(c.groups()).toEqual([[null, ['A']]])
  expect(c.sectionsApi.delete).toHaveBeenCalledTimes(2)

  const conflict = http(409, 'section_layout_changed')
  c.sectionsApi.reorderChannels.mockResolvedValueOnce(conflict)
  const list = deferred<Result<{ channels: typeof c.db.rows }>>()
  c.list.mockReturnValueOnce(list.promise)
  const order = { section_id: null, channel_ids: ['A'] }
  await expect(c.sections.reorderChannels(order)).resolves.toEqual(conflict)
  await expect(c.sections.reorderChannels(order)).resolves.toMatchObject({ kind: 'reconciling' })
  await advance()
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.sectionsApi.reorderChannels).toHaveBeenCalledOnce()
  await expect(c.sections.reorderChannels(order)).resolves.toMatchObject({ kind: 'reconciling' })
  list.resolve(ok({ channels: c.db.rows }))
  await advance(0)
  await expect(c.sections.reorderChannels(order)).resolves.toEqual(ok(undefined))
})

it('a refused DM placement cannot revoke the DM or reset its Unread', async () => {
  const c = await boot(database(), { dms: [dm('D')] })
  const unread = c.session.unread.get('D')
  expect(unread.unreadCount).toBe(8)
  c.sectionsApi.placement.mockResolvedValueOnce(http(404, 'channel not found'))
  await expect(c.sections.placement('D')).resolves.toEqual(http(404, 'channel not found'))
  expect(c.session.dms.get().rows.map(row => row.identity.id)).toEqual(['D'])
  expect(c.session.unread.get('D')).toEqual(unread)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  await expect(c.sections.placement('A')).resolves.toMatchObject({ ok: true })
})

it.each<'placement' | 'moveChannel'>(['placement', 'moveChannel'])('current %s denial hides and fences the placement while preserving access state', async method => {
  const db = database()
  db.rows.push(row('B', { visibility: 'private' }))
  db.layout = layout('1', ['A', 'B'])
  const c = await boot(db)
  const unrelated = { invalidate: vi.fn(), close: vi.fn() }
  for (const key of ['members', 'channel-members:B', 'open-channel', 'archived-channels']) c.session.holdActivity(key, unrelated)
  const oldLayout = deferred<Result<SectionLayout>>(), oldList = deferred<Result<{ channels: typeof db.rows }>>()
  c.getLayout.mockClear().mockReturnValueOnce(oldLayout.promise)
  c.list.mockClear().mockReturnValueOnce(oldList.promise)
  c.sections.retry()
  c.session.channels.authorizedList.invalidate()
  await advance()
  const unread = c.session.unread.get('B')
  expect(unread.unreadCount).toBe(3)
  const denied = http(404, 'channel not found')
  c.sectionsApi[method].mockResolvedValueOnce(denied)
  c.db.rows = [row('A')]
  c.db.layout = layout('1', ['A'])
  const run = () => method === 'placement' ? c.sections.placement('B') : c.sections.moveChannel('B', { section_id: null })
  await expect(run()).resolves.toEqual(denied)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.session.channels.get().channels.map(channel => channel.id)).toEqual(['A', 'B'])
  expect(c.session.unread.get('B')).toEqual(unread)
  expect(unrelated.close).not.toHaveBeenCalled()
  expect(unrelated.invalidate).not.toHaveBeenCalled()

  oldLayout.resolve(ok(layout('99', ['B', 'A'])))
  oldList.resolve(ok({ channels: [row('B', { read_seq: 5, unread_count: 0 }), row('old')] }))
  await advance(0)
  expect(c.generation()).toBe('1')
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.session.channels.get().channels.map(channel => channel.id)).toEqual(['A', 'B'])
  expect(c.session.unread.get('B')).toEqual(unread)
  await advance()
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.list).toHaveBeenCalledTimes(2)
  expect(c.session.channels.get().channels.map(channel => channel.id)).toEqual(['A'])
  c.db.rows = [row('A'), row('B')]
  c.db.layout = layout('1', ['A', 'B'])
  c.event({ type: 'channel_access_gained', channel_id: 'B' })
  await advance()
  await expect(run()).resolves.toMatchObject({ ok: true })
  expect(c.groups()).toEqual([['S', ['A', 'B']], [null, []]])
})

it('archive refusal hides immediately and restores the saved slot and Unread in the same access generation', async () => {
  const db = database()
  db.rows.push(row('B'))
  db.layout = layout('1', ['B', 'A'])
  const c = await boot(db)
  const unread = c.session.unread.get('B')
  expect(unread.unreadCount).toBe(3)
  const old = deferred<Result<SectionLayout>>()
  c.getLayout.mockReturnValueOnce(old.promise)
  c.sections.retry()
  await advance()
  c.sectionsApi.moveChannel.mockResolvedValueOnce(http(409, 'channel_archived'))
  await expect(c.sections.moveChannel('B', { section_id: null })).resolves.toEqual(http(409, 'channel_archived'))
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.session.channels.get().channels.map(channel => channel.id)).toContain('B')
  expect(c.session.unread.get('B')).toEqual(unread)
  old.resolve(ok(db.layout))
  db.rows = [row('A')]
  db.layout = layout('1', ['A'])
  await advance(400)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  db.rows = [row('A'), row('B')]
  db.layout = layout('1', ['B', 'A'])
  c.event({ type: 'channel_list_changed' })
  await advance()
  expect(c.groups()).toEqual([['S', ['B', 'A']], [null, []]])
  expect(c.generation()).toBe('1')
  expect(c.session.unread.get('B')).toMatchObject({ generation: unread.generation, unreadCount: unread.unreadCount })
})

it('a direct denial issued before access changed cannot hide a current placement', async () => {
  const c = await boot()
  const late = deferred<Result<undefined>>()
  c.sectionsApi.moveChannel.mockReturnValueOnce(late.promise)
  const moving = c.sections.moveChannel('A', { section_id: null })
  c.event({ type: 'channel_access_gained', channel_id: 'A' })
  await advance()
  late.resolve(http(404, 'channel not found'))
  await expect(moving).resolves.toEqual(http(404, 'channel not found'))
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
})

it('direct placement reads cannot publish or hide across a local mutation', async () => {
  const c = await boot()
  const before = deferred<Result<ChannelPlacement>>(), during = deferred<Result<ChannelPlacement>>()
  const write = deferred<Result<undefined>>()
  c.sectionsApi.placement.mockReturnValueOnce(before.promise).mockReturnValueOnce(during.promise)
  c.sectionsApi.moveChannel.mockReturnValueOnce(write.promise)
  const old = c.sections.placement('A')
  const moving = c.sections.moveChannel('A', { section_id: null })
  before.resolve(http(404, 'channel not found'))
  await expect(old).resolves.toMatchObject({ kind: 'inactive' })
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  const crossed = c.sections.placement('A')
  write.resolve(ok(undefined))
  await moving
  during.resolve(ok({ generation: '1', section_id: 'S' }))
  await expect(crossed).resolves.toMatchObject({ kind: 'inactive' })
  await expect(c.sections.placement('A')).resolves.toMatchObject({ ok: true })
})
