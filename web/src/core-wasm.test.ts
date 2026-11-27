import { expect, it, vi } from 'vitest'
import type { Message } from './api'
import { record } from './protocol-test-helpers'

const queuedDeltas: unknown[] = []

vi.mock('../wasm/fukulow_client_core', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  WasmCore: class {
    session() {
      return JSON.stringify({ selfId: 'me', running: true, connection: 1, generation: 1, nextRequest: 1, nextTimer: 1, reconnectAttempts: 0 })
    }
    request() { return 'null' }
    timer() { return 'null' }
    hasPending() { return false }
    step() {
      const next = queuedDeltas.shift()
      if (!next) throw new Error('unexpected WasmCore.step call')
      return JSON.stringify(next)
    }
  },
}))

import { createCore } from './core-wasm'

const channelMeta = {
  watched: true, cursor: 2, hasOlder: false, exhausted: false,
  loadingLatest: false, loadingOlder: false, filling: false,
  failedLatest: false, failedOlder: false, failedFill: false,
  unavailable: false,
}

const interned = (m: Message, bodyIndex: number) => ({ ...m, body: bodyIndex })

it.each([1, 7, 8])('preserves first-match prior identity for duplicate ids and refreshMentionNames with %i inserted Messages', (insertCount) => {
  const core = createCore('me')
  const first: Message = { ...record(1), id: 'dup', body: 'first-body' }
  const second: Message = { ...record(2), id: 'dup', body: 'second-body' }
  const fillers: Message[] = Array.from({ length: insertCount - 1 }, (_, i) => ({
    ...record(10 + i), id: `pad-${i}`, body: `pad-body-${i}`,
  }))

  // Step 1: populate Channel A with two Messages sharing id 'dup' (distinct created_seq) plus fillers.
  const initialMessages = [first, second, ...fillers]
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', initialMessages.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [{ start: 0, delete: 0, insert: initialMessages.map((m, i) => interned(m, i)) }],
      },
    },
    bodies: initialMessages.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 1,
    page: { history_generation: first.history_generation, as_of_seq: 20, messages: initialMessages, has_more: false },
  })
  const initial = core.get().channels.A.messages
  expect(initial).toHaveLength(2 + fillers.length)
  // Note: originals Map in step() maps by id (last wins), so initial[0] is the expanded copy and initial[1] is second.
  const priorFirst = initial[0]
  const priorSecond = initial[1]
  const priorFillers = initial.slice(2)
  expect(priorFirst.created_seq).toBe(1)
  expect(priorSecond.created_seq).toBe(2)

  // Step 2: splice re-inserts a value-equal copy of first (plus fillers to hit insertCount) without refreshMentionNames.
  // Must resolve prior by first match (priorFirst), returning priorFirst rather than the incoming copy.
  const incomingFirst: Message = { ...first }
  const step2Fillers = fillers.map(f => ({ ...f }))
  const step2Messages = [incomingFirst, ...step2Fillers]
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', step2Messages.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [
          { start: 0, delete: 1, insert: [interned(incomingFirst, 0)] },
          ...(step2Fillers.length ? [{ start: 2, delete: step2Fillers.length, insert: step2Fillers.map((m, i) => interned(m, i + 1)) }] : []),
        ],
      },
    },
    bodies: step2Messages.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 2,
    page: { history_generation: first.history_generation, as_of_seq: 20, messages: step2Messages, has_more: false },
  })
  expect(core.get().channels.A.messages[0]).toBe(priorFirst)
  expect(core.get().channels.A.messages[1]).toBe(priorSecond)
  for (let i = 0; i < priorFillers.length; i++) {
    expect(core.get().channels.A.messages[2 + i]).toBe(priorFillers[i])
  }

  // Step 3: splice re-inserts a value-equal copy of second (plus fillers) without refreshMentionNames.
  // First-match lookup finds priorFirst (created_seq 1 !== 2), so sameMessage(prior, m) is false
  // and restore falls through to the incoming record — matching Array.prototype.find.
  const incomingSecond: Message = { ...second }
  const step3Fillers = fillers.map(f => ({ ...f }))
  const step3Messages = [incomingSecond, ...step3Fillers]
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', step3Messages.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [
          { start: 1, delete: 1, insert: [interned(incomingSecond, 0)] },
          ...(step3Fillers.length ? [{ start: 2, delete: step3Fillers.length, insert: step3Fillers.map((m, i) => interned(m, i + 1)) }] : []),
        ],
      },
    },
    bodies: step3Messages.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 3,
    page: { history_generation: first.history_generation, as_of_seq: 20, messages: step3Messages, has_more: false },
  })
  expect(core.get().channels.A.messages[0]).toBe(priorFirst)
  expect(core.get().channels.A.messages[1]).toBe(incomingSecond)
  expect(core.get().channels.A.messages[1]).not.toBe(priorSecond)

  // Step 4: with refreshMentionNames: true, a value-equal copy of first with a matching record
  // returns the new record instead of priorFirst.
  const refreshedFirst: Message = { ...first, mentions: [] }
  const step4Fillers = fillers.map(f => ({ ...f }))
  const step4Messages = [refreshedFirst, ...step4Fillers]
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', step4Messages.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [
          { start: 0, delete: 1, insert: [interned(refreshedFirst, 0)] },
          ...(step4Fillers.length ? [{ start: 2, delete: step4Fillers.length, insert: step4Fillers.map((m, i) => interned(m, i + 1)) }] : []),
        ],
      },
    },
    bodies: step4Messages.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 4,
    refreshMentionNames: true,
    page: { history_generation: first.history_generation, as_of_seq: 20, messages: step4Messages, has_more: false },
  })
  expect(core.get().channels.A.messages[0]).toBe(refreshedFirst)
  expect(core.get().channels.A.messages[0]).not.toBe(priorFirst)
})

it('uses find for 7 inserted Messages and a prior Map for 8 inserted Messages across splices', () => {
  const core = createCore('me')
  const seed: Message[] = Array.from({ length: 8 }, (_, i) => ({
    ...record(i + 1), id: `m-${i}`, body: `body-${i}`,
  }))
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', seed.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [{ start: 0, delete: 0, insert: seed.map((m, i) => interned(m, i)) }],
      },
    },
    bodies: seed.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 1,
    page: { history_generation: seed[0].history_generation, as_of_seq: 8, messages: seed, has_more: false },
  })
  const prior = core.get().channels.A.messages

  // 7 total inserts across two splices (3 + 4): stays on the find path.
  const findSpy7 = vi.spyOn(core.get().channels.A.messages, 'find')
  const sevenCopies = seed.slice(0, 7).map(m => ({ ...m }))
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', sevenCopies.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [
          { start: 0, delete: 3, insert: sevenCopies.slice(0, 3).map((m, i) => interned(m, i)) },
          { start: 3, delete: 4, insert: sevenCopies.slice(3, 7).map((m, i) => interned(m, i + 3)) },
        ],
      },
    },
    bodies: sevenCopies.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 2,
    page: { history_generation: seed[0].history_generation, as_of_seq: 8, messages: sevenCopies, has_more: false },
  })
  expect(findSpy7).toHaveBeenCalledTimes(7)
  for (let i = 0; i < 7; i++) expect(core.get().channels.A.messages[i]).toBe(prior[i])

  // 8 total inserts across two splices (3 + 5): switches to the Map path without calling find.
  const findSpy8 = vi.spyOn(core.get().channels.A.messages, 'find')
  const eightCopies = seed.map(m => ({ ...m }))
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', eightCopies.map((m, i) => interned(m, i))]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [
          { start: 0, delete: 3, insert: eightCopies.slice(0, 3).map((m, i) => interned(m, i)) },
          { start: 3, delete: 5, insert: eightCopies.slice(3, 8).map((m, i) => interned(m, i + 3)) },
        ],
      },
    },
    bodies: eightCopies.map(m => m.body ?? ''),
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 3,
    page: { history_generation: seed[0].history_generation, as_of_seq: 8, messages: eightCopies, has_more: false },
  })
  expect(findSpy8).not.toHaveBeenCalled()
  for (let i = 0; i < 8; i++) expect(core.get().channels.A.messages[i]).toBe(prior[i])
})
