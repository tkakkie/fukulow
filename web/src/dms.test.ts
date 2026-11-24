import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createActivity } from './activity'
import { createDms, type DmsApi } from './dms'
import type { Dm, Result } from './api'
import { dm } from './dm-test-helpers'
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const held = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => vi.useRealTimers())
function client(timeoutMs = 1000) {
  let rows: Dm[] = [], watched = false
  const baseline = vi.fn(), drop = vi.fn(), select = vi.fn(), processed = vi.fn()
  const api = {
    changes: vi.fn<DmsApi['changes']>(async q => ok({ dms: rows.map(({ id, kind, peer }) => ({ id, kind, peer })), next_cursor: `${q.lane}-cursor`, caught_up: true })),
    list: vi.fn<DmsApi['list']>(async q => ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: q.channel_id ? rows.filter(row => q.channel_id?.includes(row.id)) : rows, next_cursor: null })),
    open: vi.fn<DmsApi['open']>(async () => ok(rows[0]!)),
  }
  let dms!: ReturnType<typeof createDms>
  const activity = createActivity({ watched: () => watched, random: () => 0.5,
    kind: id => dms.get().rows.some(row => row.identity.id === id) ? 'dm' : undefined,
    access: id => dms.access(id), revoke: id => dms.access(id, true),
  })
  dms = createDms({ api, activity, watched: () => watched, baseline, drop, select, processed, timeoutMs, random: () => 0.5 })
  return { dms, activity, api, baseline, drop, select, processed,
    set rows(value: Dm[]) { rows = value }, set watched(value: boolean) { watched = value },
    async ready() { dms.ready(); activity.notice({ type: 'activity_ready' }); await vi.advanceTimersByTimeAsync(1000) },
    close() { dms.close(); activity.close() },
  }
}

it('lost notices and delayed COMMIT converge on the existing O5 schedule with no Message or selection effects', async () => {
  const c = client(); await c.ready()
  expect(c.dms.get().rows).toEqual([])
  c.rows = [dm('old-renewed')]
  await vi.advanceTimersByTimeAsync(15_000)
  expect(c.dms.get().rows.map(r => r.identity.id)).toEqual(['old-renewed'])
  expect(c.baseline).toHaveBeenCalledWith(dm('old-renewed'), true)
  expect(c.select).not.toHaveBeenCalled()
  expect(c.api.changes.mock.calls.some(([q]) => q.lane === 'delta' && q.cursor === 'delta-cursor')).toBe(true)
  expect(c.api.changes.mock.calls.some(([q]) => q.lane === 'coverage' && q.cursor === 'coverage-cursor')).toBe(true)
  c.close(); expect(vi.getTimerCount()).toBe(0)
})

it('history reset aborts and fences old discovery and open results before restarting every lane', async () => {
  const c = client(); c.rows = [dm('old')]; await c.ready()
  c.dms.browse(); await vi.advanceTimersByTimeAsync(1000)
  const old = held<Awaited<ReturnType<DmsApi['changes']>>>(), opening = held<Result<Dm>>()
  c.api.changes.mockReturnValueOnce(old.promise)
  await vi.advanceTimersByTimeAsync(14_000)
  const signal = c.api.changes.mock.calls.at(-1)![1]
  c.api.open.mockReturnValueOnce(opening.promise)
  const pendingOpen = c.dms.open('peer-old')
  c.dms.resetHistory(); await flush()
  expect(signal.aborted).toBe(true)
  expect(c.dms.get()).toMatchObject({ rows: [], busy: false, budget: 5 })
  expect(c.dms.get().recoveryPeer).toBeUndefined()
  old.resolve(ok({ dms: [dm('late')], next_cursor: 'stale', caught_up: true }))
  opening.resolve(ok(dm('late'))); await pendingOpen; await flush()
  expect(c.dms.get().rows).toEqual([]); expect(c.select).not.toHaveBeenCalled()
  c.rows = [dm('new', { as_of_seq: 0 })]; c.api.changes.mockClear()
  await c.ready(); c.dms.browse(); await vi.advanceTimersByTimeAsync(1000)
  expect(c.api.changes.mock.calls.slice(0, 2).map(([q]) => q)).toEqual([{ lane: 'delta' }, { lane: 'coverage' }])
  expect(c.dms.get().rows.map(r => r.identity.id)).toEqual(['new'])
  c.close()
})

it('duplicate reordered notices coalesce behind one in-flight request and one queued demand', async () => {
  const c = client(10_000), old = held<Awaited<ReturnType<DmsApi['changes']>>>()
  c.api.changes.mockReturnValueOnce(old.promise)
  await c.ready()
  for (let i = 0; i < 50; i++) {
    c.activity.notice({ type: 'dm_list_changed' })
    c.activity.notice({ type: 'channel_activity', channel_id: 'A', seq: i })
  }
  expect(c.api.changes).toHaveBeenCalledOnce(); expect(c.dms.get().queued).toBe(true)
  old.resolve(ok({ dms: [dm('stale')], next_cursor: 'stale', caught_up: true })); await flush()
  expect(c.dms.get().rows).toEqual([]); expect(c.dms.get().lanes.delta.cursor).toBeUndefined()
  c.rows = [dm('fresh')]
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.api.changes).toHaveBeenCalledTimes(2) // coverage still owns its reserved initial slot
  expect(c.dms.get().rows.map(r => r.identity.id)).toEqual(['fresh'])
  expect(c.dms.get().lanes.coverage.cursor).toBe('coverage-cursor')
  c.close()
})

it('timeout aborts old work and a late success cannot overwrite the current request or exceed five starts', async () => {
  const c = client(), late = held<Awaited<ReturnType<DmsApi['changes']>>>()
  c.api.changes.mockReturnValueOnce(late.promise); await c.ready()
  const signal = c.api.changes.mock.calls[0]![1]
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(2000); expect(signal.aborted).toBe(true)
  c.rows = [dm('current')]
  await vi.advanceTimersByTimeAsync(14_000)
  expect(c.dms.get().rows.some(row => row.identity.id === 'current')).toBe(true)
  late.resolve(ok({ dms: [dm('late')], next_cursor: 'late', caught_up: true })); await flush()
  expect(c.dms.get().rows.some(row => row.identity.id === 'late')).toBe(false)
  const calls = c.api.changes.mock.calls.length + c.api.list.mock.calls.length
  expect(calls).toBeLessThanOrEqual(10)
  c.close()
})

it('O5 coalesces with Retry-After and does not restart the independent schedule or retry a discovery slot early', async () => {
  const c = client()
  c.api.changes.mockResolvedValueOnce({ ok: false, kind: 'http', status: 429, retryAfterMs: 60_000 })
  await c.ready()
  for (let i = 0; i < 10; i++) c.activity.notice({ type: 'dm_list_changed' })
  await vi.advanceTimersByTimeAsync(59_000)
  expect(c.api.changes.mock.calls.filter(([q]) => q.lane === 'delta')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(14_000)
  expect(c.api.changes.mock.calls.filter(([q]) => q.lane === 'delta')).toHaveLength(2)
  c.close()
})

it('unknown open outcome traverses authorized pages while definitive refusals never retry POST', async () => {
  const c = client(); await c.ready()
  c.api.open.mockResolvedValueOnce({ ok: false, kind: 'network' })
  const first = [dm('other')], found = dm('target', { peer: { id: 'target-peer', name: 'Target', active: false } })
  c.api.list.mockImplementation(async q => q.channel_id ? ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: [], next_cursor: null }) : q.cursor ? ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: [found], next_cursor: null }) : ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: first, next_cursor: 'below-other' }))
  await c.dms.open('target-peer'); await vi.advanceTimersByTimeAsync(2000)
  expect(c.api.open).toHaveBeenCalledOnce(); expect(c.select).toHaveBeenCalledWith('target')
  expect(c.dms.get().recoveryAbsent).toBe(false)
  c.api.open.mockResolvedValueOnce({ ok: false, kind: 'http', status: 403, error: 'forbidden' })
  await c.dms.open('denied'); await vi.advanceTimersByTimeAsync(60_000)
  expect(c.api.open).toHaveBeenCalledTimes(2)
  expect(c.dms.get().message).toContain('権限')
  c.close()
})

it('stale open cannot select or restore a row and current list recovery selects only after authorization', async () => {
  const c = client(); await c.ready()
  const old = held<Result<Dm>>(), again = held<Result<Dm>>()
  c.api.open.mockReturnValueOnce(old.promise).mockReturnValueOnce(again.promise)
  const opening = c.dms.open('peer-A')
  c.activity.notice({ type: 'dm_list_changed' })
  old.resolve(ok(dm('A'))); await opening; await flush()
  // The one re-resolution is fenced too, so only list recovery may select.
  expect(c.api.open).toHaveBeenCalledTimes(2)
  c.activity.notice({ type: 'dm_list_changed' })
  again.resolve(ok(dm('A'))); await flush()
  expect(c.select).not.toHaveBeenCalled(); expect(c.dms.get().rows).toEqual([])
  c.rows = [dm('A')]; await vi.advanceTimersByTimeAsync(2000)
  expect(c.select).toHaveBeenCalledWith('A')
  expect(c.api.open).toHaveBeenCalledTimes(2)
  c.close()
})

it('a fenced open re-resolves once under current authority and selects without waiting for an O5 list slot (#956)', async () => {
  for (const renew of [false, true]) {
    const c = client(); c.rows = [dm('M')]; await c.ready()
    if (renew) c.dms.peerRefusal('M', { ok: false, kind: 'http', status: 409, error: 'dm_peer_access_lapsed' })
    // Another DM notice spends this O5 run's shared slots, so list recovery would wait for the next run.
    c.activity.notice({ type: 'dm_list_changed' }); await vi.advanceTimersByTimeAsync(1000)
    const target = renew ? 'M' : 'G'
    const first = held<Result<Dm>>(); c.api.open.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok(dm(target)))
    const opening = c.dms.open(`peer-${target}`, renew)
    c.rows = [dm('M'), dm('G')]
    // The open's own commit notice arrives before its response and fences the snapshot.
    c.activity.notice({ type: 'dm_list_changed' }); await vi.advanceTimersByTimeAsync(300)
    expect(c.dms.get().budget).toBe(0)
    const lists = c.api.list.mock.calls.length + c.api.changes.mock.calls.length
    first.resolve(ok(dm(target))); await opening; await flush()
    expect(c.api.open.mock.calls.map(([body]) => body)).toEqual([
      { member_id: `peer-${target}`, ...(renew ? { renew: true } : {}) }, { member_id: `peer-${target}`, ...(renew ? { renew: true } : {}) }])
    expect(c.select).toHaveBeenCalledWith(target)
    expect(c.dms.get().rows.some(row => row.identity.id === target)).toBe(true)
    if (renew) expect(c.dms.get().sendBlocks.M).toBeUndefined()
    expect(c.dms.get().busy).toBe(false)
    expect(c.api.list.mock.calls.length + c.api.changes.mock.calls.length).toBe(lists)
    c.close()
  }
})

it('peer refusal never automatically resends or renews and only explicit renewal clears its send block', async () => {
  const c = client(); c.rows = [dm('A')]; await c.ready()
  c.dms.peerRefusal('A', { ok: false, kind: 'http', status: 409, error: 'dm_peer_access_lapsed' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.api.open).not.toHaveBeenCalled()
  await c.dms.open('peer-A')
  expect(c.api.open.mock.calls[0]![0]).toEqual({ member_id: 'peer-A' })
  expect(c.dms.get().sendBlocks.A).toBe('dm_peer_access_lapsed')
  await c.dms.open('peer-A', true)
  expect(c.api.open.mock.calls[1]![0]).toEqual({ member_id: 'peer-A', renew: true })
  expect(c.dms.get().sendBlocks.A).toBeUndefined()
  c.close()
})

it('terminal Session or Organization loss stops discovery recovery and timers', async () => {
  for (const status of [401, 404]) {
  const c = client(); c.rows = [dm('denied')]
  c.api.changes.mockResolvedValueOnce({ ok: false, kind: 'http', status, error: status === 404 ? 'organization_unavailable' : 'invalid credentials' })
  await c.ready()
  const calls = c.api.changes.mock.calls.length
  c.activity.notice({ type: 'dm_list_changed' }); c.dms.browse(); await c.dms.open('peer')
  await vi.advanceTimersByTimeAsync(90_000)
  expect(c.api.changes).toHaveBeenCalledTimes(calls); expect(c.api.open).not.toHaveBeenCalled(); expect(c.api.list).not.toHaveBeenCalled()
  c.close()
  }
})

it('disconnect fences responses and close cancels abort-ignoring work across Organization replacement', async () => {
  const c = client(5000), late = held<Awaited<ReturnType<DmsApi['changes']>>>()
  c.api.changes.mockReturnValueOnce(late.promise); await c.ready()
  c.activity.disconnected(); expect(c.api.changes.mock.calls[0]![1].aborted).toBe(true)
  late.resolve(ok({ dms: [dm('old')], next_cursor: 'old', caught_up: true })); await flush()
  expect(c.dms.get().rows).toEqual([])
  c.rows = [dm('fresh')]; await c.ready()
  expect(c.dms.get().rows.some(row => row.identity.id === 'fresh')).toBe(true)
  c.close(); const calls = c.api.changes.mock.calls.length
  await vi.advanceTimersByTimeAsync(90_000); expect(c.api.changes).toHaveBeenCalledTimes(calls)
  expect(vi.getTimerCount()).toBe(0)
})

it('a confirmed renewal with a fenced POST snapshot clears the send block only after current list recovery', async () => {
  const c = client(); c.rows = [dm('A')]; await c.ready()
  c.dms.peerRefusal('A', { ok: false, kind: 'http', status: 409, error: 'dm_peer_access_lapsed' })
  const response = held<Result<Dm>>(), again = held<Result<Dm>>()
  c.api.open.mockReturnValueOnce(response.promise).mockReturnValueOnce(again.promise)
  const renewing = c.dms.open('peer-A', true)
  c.activity.notice({ type: 'dm_list_changed' })
  response.resolve(ok(dm('A'))); await renewing; await flush()
  c.activity.notice({ type: 'dm_list_changed' })
  again.resolve(ok(dm('A'))); await flush()
  expect(c.dms.get().sendBlocks.A).toBe('dm_peer_access_lapsed')
  await vi.advanceTimersByTimeAsync(2000)
  expect(c.select).toHaveBeenCalledWith('A')
  expect(c.dms.get().sendBlocks.A).toBeUndefined()
  c.close()
})

it('a frozen held-id batch honors Retry-After without spinning wakeups while O5 adds demand', async () => {
  const c = client(); c.rows = [dm('A')]; await c.ready()
  c.api.list.mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 60_000 })
  c.dms.refresh(); await vi.advanceTimersByTimeAsync(1000)
  const calls = c.api.list.mock.calls.length, updates = vi.fn()
  const discoveryCalls = c.api.changes.mock.calls.length
  c.dms.subscribe(updates)
  await vi.advanceTimersByTimeAsync(58_000)
  expect(c.api.list).toHaveBeenCalledTimes(calls)
  expect(c.api.changes.mock.calls.length).toBeGreaterThanOrEqual(discoveryCalls + 4)
  expect(updates.mock.calls.length).toBeLessThan(30)
  await vi.advanceTimersByTimeAsync(16_000)
  expect(c.api.list.mock.calls.length).toBeGreaterThan(calls)
  c.close()
})

it('a refused held-id lane stays visibly failed until refresh notice reconnect or O5 recovers it', async () => {
  for (const trigger of ['refresh', 'notice', 'reconnect', 'periodic']) {
    const c = client(); c.rows = [dm('A')]
    c.api.list.mockResolvedValueOnce({ ok: false, kind: 'http', status: 400, error: 'invalid input' })
    await c.ready()
    expect(c.api.list).toHaveBeenCalledOnce()
    expect(c.dms.get().status).toBe('error')
    expect(c.dms.get().message).not.toBe('')
    if (trigger === 'refresh') c.dms.refresh()
    if (trigger === 'notice') c.activity.notice({ type: 'dm_list_changed' })
    if (trigger === 'reconnect') { c.activity.disconnected(); c.dms.ready(); c.activity.notice({ type: 'activity_ready' }) }
    await vi.advanceTimersByTimeAsync(16_000)
    expect(c.api.list.mock.calls.length).toBeGreaterThan(1)
    expect(c.dms.get().rows[0]?.baseline).toEqual(dm('A'))
    expect(c.dms.get().status).toBe('ready')
    c.close()
  }
})

it('Unread-only DM responses cannot cover Mention invalidations and retry through the shared schedule', async () => {
  const c = client(); c.rows = [dm('A', { mention_unread_count: 2 })]
  c.api.list.mockResolvedValueOnce(ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: [{ ...dm('A'), mention_unread_count: undefined } as unknown as Dm], next_cursor: null }))
  await c.ready()
  expect(c.baseline).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(16_000)
  expect(c.baseline).toHaveBeenCalledWith(dm('A', { mention_unread_count: 2 }), true)
  c.close()
})
