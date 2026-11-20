import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createCore } from './core-wasm'
import { MAIN_MESSAGE_LIMIT, REPLY_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT, TOTAL_MESSAGE_LIMIT, type Input } from './protocol-types'
import { record } from './protocol-test-helpers'
import { identityOrder, rememberIdentityResponse } from './identity-order'
import { windowClient } from './message-window-test-helpers'

it('the wasm bridge preserves the recorded bounded sync contract and API values', () => {
  const contract = JSON.parse(readFileSync(new URL('../../contract/realtime/core-boundary.json', import.meta.url), 'utf8')) as {
    self: string; initial: unknown; steps: { input: Input; expected: unknown }[]
  }
  const core = createCore(contract.self)
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
  const snapshot = () => ({ view: core.get(),
    requests: Object.fromEntries(Array.from({ length: 9 }, (_, i) => i + 1).flatMap(id => { const r = core.request(id); return r ? [[id, r]] : [] })),
    timers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => i + 1).flatMap(id => { const t = core.timer(id); return t ? [[id, t]] : [] })),
  })
  expect(plain(snapshot())).toEqual(contract.initial)
  for (const { input, expected } of contract.steps) {
    const result = core.step(input)
    expect(Object.keys(result).sort()).toEqual(['changedChannels', 'effects', 'records', 'stateChanged'])
    expect(plain({ ...snapshot(), result: { ...result, changedChannels: [...result.changedChannels], records: [...result.records] } })).toEqual(expected)
    expect('requests' in core.get() || 'timers' in core.get()).toBe(false)
  }
})

it('applies ordered append and disjoint replacements while preserving unchanged Messages, pending entries and subscription', () => {
  const { core, feed, history } = startBoundary()
  const first = record(1), third = record(3)
  history('A', [third, first, third], 3)
  feed({ type: 'event', connection: core.get().connection!, event: {
    type: 'subscribed', channel_id: 'A', history_generation: first.history_generation, caught_up_seq: 3,
  } })
  const original = core.get().channels.A
  expect(original.messages).toEqual([first, third])
  const append = record(4)
  const result = feed({ type: 'event', connection: core.get().connection!, event: { type: 'message', kind: 'create', seq: 4, message: append } })
  expect(core.get().channels.A.messages[2]).toBe(append)
  expect(result.records.get('A')?.[0]).toBe(append)
  const duplicateBefore = core.get()
  feed({ type: 'event', connection: core.get().connection!, event: { type: 'message', kind: 'create', seq: 4, message: append } })
  expect(core.get()).toBe(duplicateBefore)

  feed({ type: 'user_send', channel: 'A', clientMessageId: 'pending1', body: 'shared' })
  const oldPending = core.get().channels.A.pending[0]
  feed({ type: 'user_send', channel: 'A', clientMessageId: 'pending2', body: 'shared' })
  const request = feed({ type: 'refresh', channel: 'A' }).effects.find(e => e.type === 'fetch_history')!.id
  const edit = { ...first, version: 5, body: 'edited' }
  const newer = { ...append, version: 6, body: 'another edit' }
  feed({ type: 'history_result', request, page: {
    history_generation: first.history_generation, as_of_seq: 6, messages: [newer, record(2), edit, edit], has_more: false,
  } })
  const after = core.get().channels.A
  expect(after.messages.map(m => m.created_seq)).toEqual([1, 2, 3, 4])
  expect(after.messages[0]).toBe(edit)
  expect(after.messages[2]).toBe(original.messages[1])
  expect(after.messages[3]).toBe(newer)
  expect(after.pending[0]).toBe(oldPending)
  expect(after.subscription).toBe(original.subscription)
})

it('keeps the latest Main window and trims a different Channel at the total budget', () => {
  const { core, feed, history } = startBoundary()
  const first = Array.from({ length: MAIN_MESSAGE_LIMIT + 1 }, (_, i) => record(i + 1))
  history('A', first.slice(0, 200), 200)
  const request = feed({ type: 'refresh', channel: 'A' }).effects.find(e => e.type === 'fetch_history')!.id
  feed({ type: 'history_result', request, page: {
    history_generation: first[0].history_generation, as_of_seq: 400, messages: first.slice(200, 400), has_more: false,
  } })
  const held = core.get().channels.A.messages
  expect(held).toHaveLength(MAIN_MESSAGE_LIMIT)
  const append = first.at(-1)!
  feed({ type: 'event', connection: core.get().connection!, event: {
    type: 'subscribed', channel_id: 'A', history_generation: append.history_generation, caught_up_seq: 400,
  } })
  feed({ type: 'event', connection: core.get().connection!, event: { type: 'message', kind: 'create', seq: 401, message: append } })
  expect(core.get().channels.A.messages).toEqual(first.slice(1))
  expect(core.get().channels.A.messages[0]).toBe(held[1])

  history('B', Array.from({ length: 200 }, (_, i) => record(i + 1, 'B')), 200)
  history('C', [record(1, 'C')], 1)
  const { A, B, C } = core.get().channels
  expect(A.messages.length + B.messages.length + C.messages.length + MAIN_MESSAGE_LIMIT + TOPIC_MESSAGE_LIMIT + REPLY_MESSAGE_LIMIT).toBe(TOTAL_MESSAGE_LIMIT)
  expect(A.messages[0]).toBe(held[2])
  expect(A.messages.at(-1)).toBe(append)
})

it('applies live wasm records at the Topic and Reply limits', async () => {
  const client = windowClient(1)
  await client.boot()
  try {
    await client.topics.loadTopic('A', 'T')
    await client.replies.open('A', record(1))
    const last = MAIN_MESSAGE_LIMIT + 2
    for (let seq = 2; seq <= last; seq++) {
      const message = { ...record(seq), topic_id: 'T', reply_to: 'id1', reply_root_id: 'id1' }
      client.event(message)
      client.event(message)
    }
    const topic = client.topics.get('A').topic('T').messages
    const replies = client.replies.get('A').messages
    const expected = (limit: number) => Array.from({ length: limit }, (_, i) => last - limit + 1 + i)
    expect(topic.map(m => m.created_seq)).toEqual(expected(TOPIC_MESSAGE_LIMIT))
    expect(replies.map(m => m.created_seq)).toEqual(expected(REPLY_MESSAGE_LIMIT))
  } finally {
    await client.close()
  }
})

it('refreshes value-equal mention snapshots and removes Channels with a changed Session', () => {
  const { core, feed, history } = startBoundary()
  const first = { ...record(1), mentions: [{ member_id: 'member', name: 'Name' }] }
  history('A', [first], 1)
  const request = feed({ type: 'refresh', channel: 'A' }).effects.find(e => e.type === 'fetch_history')!.id
  const alias = { ...first, mentions: [...first.mentions] }
  rememberIdentityResponse(alias)
  feed({ type: 'history_result', request, refreshMentionNames: true, page: {
    history_generation: first.history_generation, as_of_seq: 1, messages: [alias], has_more: false,
  } })
  expect(core.get().channels.A.messages[0]).toBe(alias)
  const renamed = { ...alias, body: 'ignored at the same version', mentions: [{ member_id: 'member', name: 'New name' }] }
  rememberIdentityResponse(renamed)
  const next = feed({ type: 'refresh', channel: 'A' }).effects.find(e => e.type === 'fetch_history')!.id
  feed({ type: 'history_result', request: next, refreshMentionNames: true, page: {
    history_generation: first.history_generation, as_of_seq: 1, messages: [renamed], has_more: false,
  } })
  const canonical = core.get().channels.A.messages[0]
  expect(canonical).toMatchObject({ body: first.body, mentions: renamed.mentions })
  expect(identityOrder(canonical.mentions!)).toBe(identityOrder(renamed))
  const before = core.get()
  const duplicate = feed({ type: 'watch', channel: 'A' })
  expect(duplicate.stateChanged).toBe(false)
  expect(core.get()).toBe(before)
  expect(feed({ type: 'stop' }).changedChannels.has('A')).toBe(true)
  expect(core.get()).toMatchObject({ channels: {}, running: false, connection: null })
  expect(core.get().channels.A).toBeUndefined()
})

it('replaces a Message with a body-free tombstone at the same creation position', () => {
  const { core, feed, history } = startBoundary()
  const first = { ...record(1), mentions: [{ member_id: 'member', name: 'Name' }] }
  const second = record(2)
  history('A', [first, second], 2)
  const connection = core.get().connection!
  feed({ type: 'event', connection, event: {
    type: 'subscribed', channel_id: 'A', history_generation: first.history_generation, caught_up_seq: 2,
  } })
  const before = core.get().channels.A.messages
  const result = feed({ type: 'event', connection, event: {
    type: 'message', kind: 'delete', seq: 3, message: { ...first, version: 3, deleted: true },
  } })
  const [tombstone, kept] = core.get().channels.A.messages
  expect(tombstone).not.toBe(before[0])
  expect(tombstone).toMatchObject({ id: first.id, created_seq: first.created_seq, version: 3, deleted: true })
  expect('body' in tombstone).toBe(false)
  expect('mentions' in tombstone).toBe(false)
  expect(result.records.get('A')?.[0]).toBe(tombstone)
  expect(kept).toBe(before[1])
})

it('repopulates the same Channel after stopping and starting the Session', () => {
  const { core, feed, history } = startBoundary()
  const first = record(1)
  history('A', [first, record(2)], 2)
  feed({ type: 'user_send', channel: 'A', clientMessageId: 'old-pending', body: 'old body' })
  const before = core.get().channels.A
  expect(before.pending).toHaveLength(1)

  feed({ type: 'stop' })
  feed({ type: 'session_start', selfId: 'me' })
  feed({ type: 'connection_ready', connection: core.get().connection! })
  const request = feed({ type: 'watch', channel: 'A' }).effects.find(e => e.type === 'fetch_history')!.id
  expect(core.get().channels.A).toMatchObject({ watched: true, cursor: null, messages: [], pending: [] })
  const fresh = { ...first, body: 'new Session body' }
  feed({ type: 'history_result', request, page: {
    history_generation: fresh.history_generation, as_of_seq: 1, messages: [fresh], has_more: false,
  } })
  const after = core.get().channels.A
  expect(after.cursor).toBe(1)
  expect(after.messages).toHaveLength(1)
  expect(after.messages[0]).toBe(fresh)
  expect(after.pending).toEqual([])
})

it('clears reconnectWait when the next Session snapshot omits it', () => {
  const { core, feed } = startBoundary()
  const closed = feed({ type: 'socket_closed', connection: core.get().connection!, code: 1006 })
  const wait = closed.effects.find(e => e.type === 'wait')!
  expect(wait.purpose).toBe('reconnect_backoff')
  expect(core.get().reconnectWait).toBe(wait.id)
  const reconnect = feed({ type: 'timer_elapsed', id: wait.id })
  expect(reconnect.effects).toContainEqual({ type: 'connect', id: core.get().connection })
  expect('reconnectWait' in core.get()).toBe(false)
})

it('preserves JSON number semantics for large Channel sequence values', () => {
  const { core, history } = startBoundary()
  const seq = Number.MAX_SAFE_INTEGER + 1
  const message = record(seq)
  history('A', [message], seq)
  expect(core.get().channels.A.cursor).toBe(seq)
  expect(core.get().channels.A.messages[0]).toBe(message)
})

function startBoundary() {
  const core = createCore('me')
  const feed = (input: Input) => core.step(input)
  feed({ type: 'session_start', selfId: 'me' })
  feed({ type: 'connection_ready', connection: core.get().connection! })
  function history(channel: string, messages: ReturnType<typeof record>[], asOf: number) {
    const request = feed({ type: 'watch', channel }).effects.find(e => e.type === 'fetch_history')!.id
    feed({ type: 'history_result', request, page: {
      history_generation: messages[0].history_generation, as_of_seq: asOf, messages, has_more: false,
    } })
  }
  return { core, feed, history }
}
