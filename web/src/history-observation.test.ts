import { expect, it } from 'vitest'
import { historyObservation, type Result } from './api'
import { createCore } from './core-wasm'
import { fixtureUuid } from '../scripts/client-core-ids'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import { createSession } from './session'

const previous = '00000000-0000-4000-8000-000000000515'
const fresh = fixtureUuid('fresh generation')

function previousControllerDecision(result: Result<unknown>, stale: boolean, known?: string) {
  if (stale) return result.ok ? 'stale' : 'ignored'
  if (result.ok) {
    const data = result.data
    if (data && typeof data === 'object' && 'history_generation' in data && typeof data.history_generation === 'string') {
      return known !== undefined && known !== data.history_generation ? 'reset' : 'accepted'
    }
  } else if (result.kind === 'http' && result.status === 409 && result.error === 'history_generation_changed') {
    return 'reset'
  }
  return 'ignored'
}

it('matches the previous Session generation decision across results and issue epochs', () => {
  const selfId = fixtureUuid('me')
  const results: Result<unknown>[] = [
    ok({ history_generation: previous }), ok({ history_generation: fresh }),
    ok({}), ok({ history_generation: null }), ok(undefined),
    { ok: false, kind: 'http', status: 409, error: 'history_generation_changed' },
    { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' },
    { ok: false, kind: 'http', status: 404, error: 'history_generation_changed' },
    { ok: false, kind: 'http', status: 401 },
    { ok: false, kind: 'network', error: 'history_generation_changed' },
  ]
  for (const known of [undefined, previous]) {
    for (const stale of [false, true]) {
      for (const result of results) {
        const core = createCore(selfId)
        core.step({ type: 'session_start', selfId })
        const issue = core.historyIssue()
        if (stale) core.step({ type: 'history_generation' })
        if (known !== undefined) core.step({ type: 'history_generation', generation: known })
        const epoch = core.get().historyEpoch
        const expected = previousControllerDecision(result, stale, known)
        const out = core.step({
          type: 'observe_history_generation', issue, lifetime: 'current', result: historyObservation(result),
        })
        expect(out.historyObservation).toBe(expected)
        expect(core.get().historyEpoch).toBe(epoch + Number(expected === 'reset'))
      }
    }
  }
})

it('a stale Channel list cannot install rows across a history reset', async () => {
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options() })
  try {
    await settle()
    expect(net.lists).toHaveLength(1)
    session.sync.observeHistoryGeneration(previous)
    session.sync.observeHistoryGeneration(fresh)
    net.lists[0].resolve(ok({ history_generation: previous, channels: [channel('A')] }))
    await settle()
    expect(session.sync.get()).toMatchObject({ historyGeneration: fresh, historyEpoch: 1 })
    expect(session.channels.get().channels).toEqual([])
  } finally {
    session.close()
  }
})

it('a current send generation conflict resets history and reaches sync as stale', async () => {
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options() })
  const failures: unknown[] = []
  const stop = session.sync.onInput(input => {
    if (input.type === 'send_failed') failures.push(input.status)
  })
  try {
    await session.sync.watch('A')
    const sent = session.sync.getTimeline('A').send('pending')
    net.sends[0].resolve({ ok: false, kind: 'http', status: 409, error: 'history_generation_changed' })
    await sent
    expect(session.sync.get().historyEpoch).toBe(1)
    expect(failures).toEqual(['network'])
  } finally {
    stop()
    session.close()
  }
})
