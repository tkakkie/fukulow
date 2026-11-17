import { expect, it } from 'vitest'
import { createCore as wasmCore } from './core-wasm'
import { createCore as tsCore } from './core-ts'
import { fixtureUuid } from '../scripts/client-core-ids'
import type { Effect, Input, SyncCore } from './protocol-types'

const oldGeneration = '00000000-0000-4000-8000-000000000515'
const newGeneration = '00000000-0000-4000-8000-000000000516'
const a = fixtureUuid('A'), b = fixtureUuid('B'), self = fixtureUuid('me')
const effect = (effects: Effect[], type: Effect['type']) => effects.find(e => e.type === type)!
function boot(core: SyncCore, channel: string) {
  const fetch = effect(core.step({ type: 'watch', channel }).effects, 'fetch_history')
  if (fetch.type !== 'fetch_history') throw new Error('Missing bootstrap')
  const result = core.step({ type: 'history_result', request: fetch.id,
    page: { history_generation: oldGeneration, as_of_seq: 10, messages: [], has_more: true } })
  const sub = effect(result.effects, 'subscribe')
  if (sub.type !== 'subscribe') throw new Error('Missing subscribe')
  core.step({ type: 'event', connection: core.get().connection!, subscription: sub.id,
    event: { type: 'subscribed', history_generation: oldGeneration, channel_id: channel, caught_up_seq: 10 } })
}
function start(make: typeof wasmCore) {
    const core = make(self)
    core.step({ type: 'session_start', selfId: self })
    core.step({ type: 'connection_ready', connection: core.get().connection! })
    boot(core, a); boot(core, b)
    return core
}

it('Organization generation resets every Channel and preserves send intent and late 401 in both cores', () => {
  for (const make of [wasmCore, tsCore]) {
    const core = start(make)
    const send = (channel: string, label: string) => {
      const id = fixtureUuid(label)
      const result = core.step({ type: 'user_send', channel, clientMessageId: id, body: label })
      const request = effect(result.effects, 'send')
      if (request.type !== 'send') throw new Error('Missing send')
      return { id, request: request.id }
    }
    const failed = send(a, 'failed'), unknown = send(a, 'unknown'), sending = send(b, 'sending'), throttled = send(b, 'throttled')
    core.step({ type: 'send_failed', request: failed.request, status: 400 })
    core.step({ type: 'send_failed', request: unknown.request, status: 'network' })
    core.step({ type: 'send_failed', request: throttled.request, status: 429, retryAfterMs: 5000 })
    const retryTimer = core.get().channels[b]!.pending.find(p => p.clientMessageId === throttled.id)!.retryWait!
    const previousConnection = core.get().connection!
    const reset = core.step({ type: 'event', connection: previousConnection,
      event: { type: 'subscribed', channel_id: a, caught_up_seq: 50, history_generation: newGeneration } })
    expect(reset.effects.filter(e => e.type === 'unsubscribe').map(e => e.channel)).toEqual([a, b])
    expect(reset.effects.filter(e => e.type === 'fetch_history')).toHaveLength(2)
    expect(reset.effects.some(e => e.type === 'send')).toBe(false)
    expect(core.timer(retryTimer)).toBeUndefined()
    for (const channel of [a, b]) expect(core.get().channels[channel]).toMatchObject({ cursor: null, messages: [], versions: {}, advancing: [], mutationSeq: 0, retiredVersions: [] })
    expect(core.get().channels[a]!.pending.map(p => p.state)).toEqual(['failed', 'unknown'])
    expect(core.get().channels[b]!.pending.map(p => p.state)).toEqual(['unknown', 'unknown'])
    expect(core.request(sending.request)?.stale).toBe(true)
    // An old socket and all old data completions are fenced; authentication retains Account scope.
    core.step({ type: 'event', connection: previousConnection, event: { type: 'subscribed', channel_id: a, caught_up_seq: 100, history_generation: oldGeneration } })
    expect(core.get().historyGeneration).toBe(newGeneration)
    core.step({ type: 'send_failed', request: sending.request, status: 401 })
    expect(core.get().session).toBe('sign_in_required')
  }
})
it('snapshot expiry preserves the cursor generation and other Channel in both cores', () => {
  for (const make of [wasmCore, tsCore]) {
    const core = start(make), other = core.get().channels[b], subscription = core.get().channels[a]!.subscription
    // Supply one visible creation only to provide an older-page continuation.
    const refresh = effect(core.step({ type: 'refresh', channel: a }).effects, 'fetch_history')
    if (refresh.type !== 'fetch_history') throw new Error('Missing refresh')
    const message = { history_generation: oldGeneration, id: fixtureUuid('message'), channel_id: a, created_seq: 5, version: 5, deleted: false,
      client_message_id: fixtureUuid('key'), sender: self, body: 'held', created_at: '2026-11-17T00:00:00Z', topic_id: null, reply_to: null, reply_root_id: null, mentions: [] }
    core.step({ type: 'history_result', request: refresh.id, page: { history_generation: oldGeneration, as_of_seq: 10, messages: [message], has_more: true } })
    const older = effect(core.step({ type: 'load_older', channel: a }).effects, 'fetch_history')
    if (older.type !== 'fetch_history') throw new Error('Missing older')
    const result = core.step({ type: 'history_failed', request: older.id, status: 409, error: 'snapshot_expired' })
    expect(result.effects.filter(e => e.type === 'fetch_history')).toHaveLength(1)
    expect(result.effects.some(e => ['connect', 'subscribe', 'unsubscribe'].includes(e.type))).toBe(false)
    expect(core.get().channels[b]).toBe(other)
    expect(core.get().channels[a]).toMatchObject({ cursor: 10, messages: [], subscription })
    expect(core.get().historyGeneration).toBe(oldGeneration)
    expect(core.get().historyEpoch).toBe(0)
    const latest = effect(result.effects, 'fetch_history')
    if (latest.type !== 'fetch_history') throw new Error('Missing latest')
    const stopped = core.step({ type: 'history_failed', request: latest.id, status: 409, error: 'snapshot_expired' } satisfies Input)
    expect(stopped.effects).toEqual([])
  }
})
