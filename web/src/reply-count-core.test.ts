import { expect, it } from 'vitest'
import { createReplyCountCore } from '#sync-core'
import type { CountCore, CountInput, CountTicket } from './reply-count-core'
const tracked = () => {
  const core = createReplyCountCore()
  const ticket = core.step({ type: 'track', roots: ['r'] }).needed[0]
  return { core, ticket }
}
const install = (core: CountCore, ticket: CountTicket, watermark: number, count: number) => core.step({ type: 'install', ticket, watermark, count })
const create = (seq: number, root = 'r'): CountInput => ({ type: 'create', root, id: `m${seq}`, seq })

it('reconciles delayed and out of order baselines with a unique live suffix without advancing any cursor', () => {
  const { core, ticket } = tracked()
  core.step({ type: 'begin', tickets: [ticket] })
  core.step(create(11)); core.step(create(12)); core.step(create(12))
  expect(install(core, ticket, 10, 4).counts.r).toBe(6)
  expect(install(core, ticket, 11, 5).counts.r).toBe(6)
  expect(install(core, ticket, 9, 3).counts.r).toBe(6)
  expect(core.step(create(11)).counts.r).toBe(6)
  expect(core.step(create(12)).counts.r).toBe(6)
  core.free()
})

it('checkpoints overflow at 400 records per Channel and fences every superseded response and forgotten replay', () => {
  const { core, ticket } = tracked()
  core.step({ type: 'begin', tickets: [ticket] })
  for (let seq = 1; seq <= 400; seq++) core.step(create(seq))
  const overflow = core.step(create(401))
  expect(overflow.counts.r).toBeNull()
  const next = overflow.needed[0]
  expect(next.generation).not.toBe(ticket.generation)
  for (let seq = 1; seq <= 401; seq++) expect(core.step(create(seq)).needed).toEqual([next])
  expect(install(core, ticket, 100, 100).counts.r).toBeNull()
  expect(install(core, next, 400, 400).counts.r).toBeNull()
  expect(core.step(create(402)).counts.r).toBeNull()
  expect(install(core, next, 401, 401).counts.r).toBe(402)
  expect(core.step(create(402)).counts.r).toBe(402)
  core.free()
})

it('trims the oldest root first under a shared Channel evidence budget and supersedes repeated pending overflow', () => {
  const { core, ticket } = tracked()
  core.step({ type: 'track', roots: ['r', 's'] })
  install(core, ticket, 0, 0)
  for (let seq = 1; seq <= 200; seq++) core.step(create(seq))
  for (let seq = 201; seq <= 400; seq++) core.step(create(seq, 's'))
  const overflow = core.step(create(401, 's'))
  expect(overflow.counts.r).toBeNull()
  const retry = overflow.needed.find(t => t.root === 'r')!
  core.step({ type: 'begin', tickets: [retry] })
  // First s, then r are checkpointed; no trimmed Set ever becomes authoritative.
  for (let seq = 402; seq <= 1003; seq++) core.step(create(seq))
  expect(install(core, retry, 1003, 1003).counts.r).toBeNull()
  core.free()
})

it('untrack and retrack never borrow an evicted root generation or dropped live evidence', () => {
  const { core, ticket } = tracked()
  core.step(create(200))
  expect(core.step({ type: 'track', roots: [] }).counts).toEqual({})
  const next = core.step({ type: 'track', roots: ['r'] }).needed[0]
  expect(install(core, ticket, 100, 10).counts.r).toBeNull()
  expect(install(core, next, 201, 20).counts.r).toBe(20)
  core.free()
})

it('recoverable resets discard baselines evidence and floors before installing a rewound history', () => {
  const { core, ticket } = tracked()
  for (let seq = 100; seq <= 501; seq++) core.step(create(seq))
  const next = core.step({ type: 'reset' }).needed[0]
  expect(install(core, ticket, 502, 500).counts.r).toBeNull()
  expect(install(core, next, 10, 2).counts.r).toBe(2)
  expect(core.step(create(11)).counts.r).toBe(3)
  core.free()
})

it('mutation invalidation requires a covering snapshot without guessing mutation deltas', () => {
  const { core, ticket } = tracked()
  install(core, ticket, 10, 5000)
  const next = core.step({ type: 'invalidate', root: 'r', seq: 12 }).needed[0]
  expect(install(core, ticket, 13, 5001).counts.r).toBeNull()
  expect(install(core, next, 11, 5001).counts.r).toBeNull()
  expect(install(core, next, 12, 4999).counts.r).toBe(4999)
  core.free()
})

it('duplicate and late Move keep the covering count', () => {
  const { core, ticket } = tracked()
  const moved = (seq: number): CountInput => ({ type: 'invalidate', root: 'r', seq })
  try {
    install(core, ticket, 10, 4)
    const next = core.step(moved(12)).needed[0]
    core.step({ type: 'begin', tickets: [next] })
    core.step(create(13))
    for (const seq of [12, 11]) {
      expect(core.step(moved(seq))).toEqual({ counts: { r: null }, tickets: [next], needed: [] })
    }
    expect(install(core, next, 12, 4).counts.r).toBe(5)
    core.step(create(13))
    for (const seq of [12, 11]) {
      const view = core.step(moved(seq))
      expect(view.counts.r).toBe(5)
      expect(view.needed).toEqual([])
    }
  } finally { core.free() }
})

it('new root seeds preserve newer baselines and reconcile only the unique Reply suffix', () => {
  const { core, ticket } = tracked()
  core.step(create(12))
  expect(core.step({ type: 'seed', root: 'r', seq: 10 }).counts.r).toBe(1)
  expect(install(core, ticket, 9, 999).counts.r).toBe(1)
  expect(core.step(create(12)).counts.r).toBe(1)
  expect(install(core, ticket, 13, 4).counts.r).toBe(4)
  expect(core.step({ type: 'seed', root: 'r', seq: 10 }).counts.r).toBe(4)
  core.free()
})

it('root ticket ordering and generations are lexical regardless of tracking insertion order', () => {
  const core = createReplyCountCore()
  expect(core.step({ type: 'track', roots: ['z', 'b', 'a'] }).needed).toEqual([
    { root: 'a', generation: 1 }, { root: 'b', generation: 2 }, { root: 'z', generation: 3 },
  ])
  expect(core.step({ type: 'reset' }).needed).toEqual([
    { root: 'a', generation: 4 }, { root: 'b', generation: 5 }, { root: 'z', generation: 6 },
  ])
  core.free()
})
