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

it('preserves first-match prior identity for duplicate ids in before.messages and keeps refreshMentionNames semantics', () => {
  const core = createCore('me')
  const first: Message = { ...record(1), id: 'dup', body: 'first-body' }
  const second: Message = { ...record(2), id: 'dup', body: 'second-body' }

  // Step 1: populate Channel A with two Messages sharing id 'dup' (distinct created_seq).
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', [interned(first, 0), interned(second, 1)]]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [{ start: 0, delete: 0, insert: [interned(first, 0), interned(second, 1)] }],
      },
    },
    bodies: ['first-body', 'second-body'],
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 1,
    page: { history_generation: first.history_generation, as_of_seq: 2, messages: [first, second], has_more: false },
  })
  const initial = core.get().channels.A.messages
  expect(initial).toHaveLength(2)
  // Note: originals Map in step() maps by id (last wins), so initial[0] is the expanded copy and initial[1] is second.
  const priorFirst = initial[0]
  const priorSecond = initial[1]
  expect(priorFirst.created_seq).toBe(1)
  expect(priorSecond.created_seq).toBe(2)

  // Step 2: splice re-inserts a value-equal copy of first (without refreshMentionNames).
  // Must resolve prior by first match (priorFirst), returning priorFirst rather than the incoming copy.
  const incomingFirst: Message = { ...first }
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', [interned(incomingFirst, 0)]]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [{ start: 0, delete: 1, insert: [interned(incomingFirst, 0)] }],
      },
    },
    bodies: ['first-body'],
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 2,
    page: { history_generation: first.history_generation, as_of_seq: 2, messages: [incomingFirst], has_more: false },
  })
  expect(core.get().channels.A.messages[0]).toBe(priorFirst)
  expect(core.get().channels.A.messages[1]).toBe(priorSecond)

  // Step 3: splice re-inserts a value-equal copy of second (without refreshMentionNames).
  // First-match lookup finds priorFirst (created_seq 1 !== 2), so sameMessage(prior, m) is false
  // and restore falls through to the incoming record — matching Array.prototype.find.
  const incomingSecond: Message = { ...second }
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', [interned(incomingSecond, 0)]]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [{ start: 1, delete: 1, insert: [interned(incomingSecond, 0)] }],
      },
    },
    bodies: ['second-body'],
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 3,
    page: { history_generation: first.history_generation, as_of_seq: 2, messages: [incomingSecond], has_more: false },
  })
  expect(core.get().channels.A.messages[0]).toBe(priorFirst)
  expect(core.get().channels.A.messages[1]).toBe(incomingSecond)
  expect(core.get().channels.A.messages[1]).not.toBe(priorSecond)

  // Step 4: with refreshMentionNames: true, a value-equal copy of first with a matching record
  // returns the new record instead of priorFirst.
  const refreshedFirst: Message = { ...first, mentions: [] }
  queuedDeltas.push({
    effects: [],
    changedChannels: ['A'],
    records: [['A', [interned(refreshedFirst, 0)]]],
    channels: {
      A: {
        metadata: channelMeta,
        splices: [{ start: 0, delete: 1, insert: [interned(refreshedFirst, 0)] }],
      },
    },
    bodies: ['first-body'],
    stateChanged: true,
  })
  core.step({
    type: 'history_result',
    request: 4,
    refreshMentionNames: true,
    page: { history_generation: first.history_generation, as_of_seq: 2, messages: [refreshedFirst], has_more: false },
  })
  expect(core.get().channels.A.messages[0]).toBe(refreshedFirst)
  expect(core.get().channels.A.messages[0]).not.toBe(priorFirst)
})
