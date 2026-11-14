import { expect, it } from 'vitest'
import type { Dm, DmChanges, DmDiscovery, DmList } from './api-schema'
import { chooseDmBaseline, dmListState, stepDmList, type DmInput, type DmLane, type DmRequest } from './dm-list'

import { dm } from './dm-test-helpers'

const changes = (dms: DmDiscovery[] = [], next_cursor = 'next', caught_up = true): DmChanges => ({ dms: dms.map(({ id, kind, peer }) => ({ id, kind, peer })), next_cursor, caught_up })
function client() {
  let state = dmListState()
  const feed = (input: DmInput) => { const result = stepDmList(state, input); state = result.state; return result.effects }
  const wake = () => { feed({ type: 'wake', now: 1000 }); return state.request! }
  const result = (request: DmRequest, data: DmChanges | DmList) => feed({ type: 'result', request, data })
  const run = () => feed({ type: 'demand', boundary: true, periodic: true, replace: [] })
  const discovery = (rows: DmDiscovery[] = []) => { result(wake(), changes(rows)); result(wake(), changes()) }
  return { get state() { return state }, feed, wake, result, run, discovery }
}

it('stale list pages cannot add identities advance continuations or exhaust a traversal', () => {
  const c = client(); c.discovery()
  c.feed({ type: 'browse' }); const old = c.wake()
  c.feed({ type: 'demand', boundary: true, replace: [] })
  c.result(old, { dms: [dm('hidden')], next_cursor: null })
  expect(c.state.rows).toEqual([]); expect(c.state.lanes.browse).toMatchObject({ done: false, pending: true })
  expect(c.state.queued).toBe(true)
  const current = c.wake(); expect(current.lane).toBe('browse'); expect(current.cursor).toBeUndefined()
  c.result(current, { dms: [dm('allowed')], next_cursor: 'below-allowed' })
  expect(c.state.rows.map(r => r.identity.id)).toEqual(['allowed'])
  expect(c.state.lanes.browse.cursor).toBe('below-allowed')
  c.result(old, { dms: [dm('hidden')], next_cursor: null })
  expect(c.state.rows.map(r => r.identity.id)).toEqual(['allowed'])
  expect(c.state.lanes.browse.done).toBe(false)
})

it('access loss and gain fence old identities counts and mutation snapshots without borrowing a grant lifetime', () => {
  const c = client(); c.discovery([dm('A')]); const old = c.wake()
  const oldAccess = c.state.rows[0]!.access
  c.feed({ type: 'access', id: 'A', revoked: true }); c.feed({ type: 'access', id: 'A', revoked: false })
  c.result(old, { dms: [dm('A', { as_of_seq: 100 })], next_cursor: null })
  c.feed({ type: 'opened', generation: old.generation, dm: dm('A') })
  expect(c.state.rows).toEqual([])
  c.run(); c.discovery([dm('A')]); const q = c.wake()
  c.result(q, { dms: [dm('A', { as_of_seq: 1, read_seq: 1, unread_count: 0, main_unread_count: 0 })], next_cursor: null })
  expect(c.state.rows[0]!.access).not.toBe(oldAccess)
  expect(c.state.rows[0]!.baseline?.as_of_seq).toBe(1)
  const before = c.state.rows[0]!.access
  c.feed({ type: 'access', id: 'A', revoked: false })
  expect(c.state.rows[0]!.access).not.toBe(before); expect(c.state.rows[0]!.baseline).toBeUndefined()
})

it('only an id-batch omission drops its requested rows and page absence preserves off-page access', () => {
  const c = client(); c.discovery([dm('A'), dm('B')])
  const batch = c.wake(); expect(batch.ids).toEqual(['A', 'B'])
  const effects = c.result(batch, { dms: [dm('B')], next_cursor: null })
  expect(effects).toContainEqual({ type: 'drop', id: 'A' })
  c.feed({ type: 'browse' }); c.result(c.wake(), { dms: [], next_cursor: null })
  expect(c.state.rows.map(r => r.identity.id)).toEqual(['B'])
})

it('P8 accepts one atomic winning tuple and rejects contradictory equal-position counts', () => {
  const old = dm('A', { mention_unread_count: 2 })
  const contradictory = dm('A', { main_unread_count: 9, unread_count: 7, mention_unread_count: 1 })
  expect(chooseDmBaseline(old, contradictory)).toBe(old)
  const lower = dm('A', { main_unread_count: 7, unread_count: 7, mention_unread_count: 1 })
  expect(chooseDmBaseline(old, lower)).toBe(lower)
  expect(chooseDmBaseline(old, dm('A', { as_of_seq: 9, read_seq: 9 }))).toBe(old)
  const newer = dm('A', { as_of_seq: 11, main_unread_count: 9, unread_count: 9 })
  expect(chooseDmBaseline(old, newer)).toBe(newer)
  const read = dm('A', { read_seq: 3, main_unread_count: 7, unread_count: 7 })
  expect(chooseDmBaseline(old, read)).toBe(read)
})

it('five attempts include failures retries and user demands while every eligible lane receives its reserved service', () => {
  const c = client(); c.discovery([dm('A')])
  c.feed({ type: 'browse' }); c.feed({ type: 'recover', peer: 'absent' }); c.run()
  const lanes: DmLane[] = []
  for (let i = 0; i < 5; i++) {
    const q = c.wake(); lanes.push(q.lane)
    c.feed({ type: 'failure', request: q, retryAt: 0, terminal: false })
  }
  expect(new Set(lanes)).toEqual(new Set(['delta', 'coverage', 'held', 'browse', 'recovery']))
  for (let i = 0; i < 100; i++) { c.feed({ type: 'browse' }); c.feed({ type: 'demand', boundary: true, replace: [] }); expect(c.wake()).toBeUndefined() }
  expect(c.state.budget).toBe(0)
  c.run(); expect(c.wake().lane).toBe('delta')
})

it('frozen held-id rounds finish within four runs despite newly discovered rows and both traversals', () => {
  const c = client()
  for (let i = 0; i < 200; i++) c.feed({ type: 'opened', generation: c.state.generation, dm: dm(String(i)) })
  c.feed({ type: 'browse' }); c.feed({ type: 'recover', peer: 'absent' })
  const batches: string[][] = []
  for (let run = 0; run < 4; run++) {
    c.run()
    for (let slot = 0; slot < 5; slot++) {
      const q = c.wake(); expect(q).toBeDefined()
      if (q.lane === 'held') { batches.push(q.ids!); c.result(q, { dms: q.ids!.map(id => dm(id)), next_cursor: null }) }
      else if (q.lane === 'delta' || q.lane === 'coverage') c.result(q, changes(run ? [dm('new')] : [], `${q.lane}-${run}`))
      else c.result(q, { dms: [], next_cursor: `below-${q.lane}-${run}` })
    }
    c.feed({ type: 'browse' })
  }
  expect(batches).toHaveLength(4)
  // New identities cannot replace the unfinished batches of this frozen round.
  expect(new Set(batches.flat()).size).toBe(batches.flat().length)
  expect(new Set(batches.flat())).toEqual(new Set(Array.from({ length: 200 }, (_, i) => String(i))))
})

it('lost notices drain pending identities through independent delta pages before bounded LRU eviction', () => {
  for (const count of [500, 501, 9999]) {
  const c = client(), seen = new Set<string>()
  c.feed({ type: 'select', id: '0' })
  const pages = Math.ceil(count / 50)
  for (let page = 0; page < pages; page++) {
    if (page) c.run()
    const delta = c.wake(); expect(delta.lane).toBe('delta'); expect(delta.cursor).toBe(page ? `delta-${page}` : undefined)
    const rows = Array.from({ length: Math.min(50, count - page * 50) }, (_, i) => dm(String(page * 50 + i)))
    for (const effect of c.result(delta, changes(rows, `delta-${page + 1}`, page === pages - 1))) if (effect.type === 'processed') seen.add(effect.identity.id)
    const coverage = c.wake(); expect(coverage.lane).toBe('coverage')
    expect(coverage.cursor).toBe(page ? `coverage-${page}` : undefined)
    c.result(coverage, changes([], `coverage-${page + 1}`, false))
    expect(c.state.rows.length).toBeLessThanOrEqual(200)
    expect(c.state.rows.some(r => r.identity.id === '0')).toBe(true)
  }
  expect(seen.size).toBe(count); expect(c.state.lanes.delta.cursor).toBe(`delta-${pages}`)
  expect(c.state.lanes.coverage.cursor).toBe(`coverage-${pages}`)
  }
})

it('browse and unknown-open recovery preserve independent keys beyond eviction and O5', () => {
  for (const match of [true, false]) {
  const c = client(); c.discovery(); c.feed({ type: 'recover', peer: match ? 'peer-5499' : 'absent' })
  c.feed({ type: 'browse' })
  for (let page = 0; page < 110; page++) {
    c.run(); c.discovery()
    // Shared service rotates, but each traversal receives its own boundary once per run.
    for (let slot = 0; slot < 3; slot++) {
      const q = c.wake(); if (!q) break
      if (q.lane === 'held') { c.result(q, { dms: q.ids!.map(id => dm(id)), next_cursor: null }); continue }
      expect(['browse', 'recovery']).toContain(q.lane)
      expect(q.cursor).toBe(page ? `${q.lane}-${page}` : undefined)
      const data = { dms: Array.from({ length: 50 }, (_, i) => dm(String(page * 50 + i))), next_cursor: page === 109 ? null : `${q.lane}-${page + 1}` }
      c.result(q, data)
      c.result(q, { dms: [dm('late-duplicate')], next_cursor: null })
      expect(c.state.rows.some(r => r.identity.id === 'late-duplicate')).toBe(false)
    }
    c.feed({ type: 'browse' })
  }
  expect(c.state.lanes.browse.done).toBe(true)
  expect(c.state.recovered).toBe(match ? '5499' : undefined)
  expect(c.state.recoveryAbsent).toBe(!match)
  expect(c.state.rows.length).toBe(200)
  }
})

it('reconnect preserves all cursors but fences old requests and close stops all work', () => {
  const c = client(); c.discovery(); c.feed({ type: 'browse' }); const old = c.wake()
  c.feed({ type: 'pause' }); c.result(old, { dms: [dm('old')], next_cursor: null }); expect(c.wake()).toBeUndefined()
  expect(c.state.lanes.delta.cursor).toBe('next'); expect(c.state.lanes.coverage.cursor).toBe('next')
  c.feed({ type: 'resume' }); c.run(); c.discovery(); const current = c.wake()
  expect(current.lane).toBe('browse'); expect(current.cursor).toBeUndefined()
  c.result(current, { dms: [dm('fresh')], next_cursor: 'below-fresh' }); expect(c.state.rows).toHaveLength(1)
  c.feed({ type: 'close' }); c.run(); expect(c.wake()).toBeUndefined()
})

it('O5 fences a delayed continuation without rewinding its accepted boundary or restoring stale peer identity', () => {
  const c = client(); c.discovery([dm('A')]); c.result(c.wake(), { dms: [dm('A')], next_cursor: null })
  c.feed({ type: 'browse' }); c.result(c.wake(), { dms: [dm('B')], next_cursor: 'below-B' })
  c.feed({ type: 'browse' }); c.run(); c.discovery()
  let old = c.wake()
  if (old.lane === 'held') { c.result(old, { dms: old.ids!.map(id => dm(id)), next_cursor: null }); old = c.wake() }
  expect(old.lane).toBe('browse'); expect(old.cursor).toBe('below-B')
  c.run()
  c.result(old, { dms: [dm('B', { peer: { id: 'peer-B', name: 'Stale name', active: false } }), dm('stale')], next_cursor: null })
  expect(c.state.lanes.browse.cursor).toBe('below-B'); expect(c.state.lanes.browse.done).toBe(false)
  expect(c.state.rows.find(row => row.identity.id === 'B')!.identity.peer.name).toBe('Peer B')
  c.discovery()
  let fresh = c.wake()
  if (fresh.lane === 'held') { c.result(fresh, { dms: fresh.ids!.map(id => dm(id)), next_cursor: null }); fresh = c.wake() }
  expect(fresh.cursor).toBe('below-B')
  c.result(fresh, { dms: [dm('C')], next_cursor: null })
  expect(c.state.rows.some(row => row.identity.id === 'C')).toBe(true)
  expect(c.state.rows.some(row => row.identity.id === 'stale')).toBe(false)
  expect(c.state.lanes.browse.done).toBe(true)
})
