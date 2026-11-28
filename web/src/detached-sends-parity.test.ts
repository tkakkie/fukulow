import { expect, it } from 'vitest'
import type { Result } from './api'
import { createCore } from './core-wasm'
import { canRestoreDraft, createDetachedSends } from './detached-sends-wasm'

// The pre-slice D submitted-draft policy from composer-drafts.ts.
function createReference() {
  const submitted = new Map<string, { channel: string; detached: boolean; restore: () => void }>()
  return {
    trackSubmitted(id: string, channel: string, restore: () => void) {
      submitted.set(id, { channel, detached: false, restore })
    },
    dropSubmitted(id: string) { submitted.delete(id) },
    detachSubmitted(shouldDetach: (channel: string, id: string) => boolean) {
      for (const [id, entry] of submitted) {
        if (entry.detached) continue
        entry.detached = shouldDetach(entry.channel, id)
      }
    },
    observeSendResult(id: string, result: Result<unknown>) {
      const entry = submitted.get(id)
      if (entry?.detached || result.ok || (result.kind === 'http' && result.status !== 429)) submitted.delete(id)
      if (entry?.detached && !result.ok && result.kind === 'http' && [400, 403, 404, 409, 413, 415].includes(result.status)) {
        entry.restore()
      }
    },
    reset() {
      for (const [id, entry] of submitted) {
        if (!entry.detached) submitted.delete(id)
      }
    },
  }
}

const http = (status: number): Result<unknown> => ({ ok: false, kind: 'http', status })
const network: Result<unknown> = { ok: false, kind: 'network', retryAfterMs: 3000 }
const ack: Result<unknown> = { ok: true, data: {} }

function observe(create: typeof createDetachedSends) {
  const sends = create()
  const trace: string[][] = []
  return {
    ...sends, trace,
    track(id: string, channel = 'Channel', draft = id) {
      sends.trackSubmitted(id, channel, () => {
        trace.push(['restore', id, draft])
        // A restore can notify listeners synchronously. The submission must already be consumed.
        if (trace.filter(entry => entry[0] === 'restore' && entry[1] === id).length === 1) {
          sends.observeSendResult(id, http(409))
        }
      })
    },
    detach(...detachable: string[]) {
      sends.detachSubmitted((channel, id) => {
        trace.push(['check', channel, id])
        return detachable.includes(id)
      })
    },
  }
}

it.each([ack, network, ...[400, 401, 403, 404, 409, 413, 415, 429, 500, 503, 400.5, NaN].map(http)])(
  'matches the former attached and detached outcomes for %j', result => {
    const run = (create: typeof createDetachedSends) => {
      const h = observe(create)
      h.track('first')
      h.track('second')
      h.detach('second')
      h.observeSendResult('first', result)
      h.observeSendResult('second', result)
      h.detach('first')
      h.reset()
      h.observeSendResult('first', http(400))
      h.observeSendResult('second', http(400))
      return h.trace
    }
    expect(run(createDetachedSends)).toEqual(run(createReference))
  },
)

it('matches submission order, replacement, settlement and repeated stops across same-key retries', () => {
  const run = (create: typeof createDetachedSends) => {
    const h = observe(create)
    h.track('retry', 'A', 'original text')
    h.track('settled', 'B')
    h.track('inactive', 'A')
    h.track('same key', 'B', 'replaced callback')
    h.track('settled', 'A', 'replacement in original position')
    h.observeSendResult('retry', http(429))
    h.observeSendResult('retry', network)
    h.detach('retry', 'settled', 'same key')
    h.dropSubmitted('settled')
    h.reset()
    h.track('fresh')
    h.detach()
    h.reset()
    h.observeSendResult('inactive', http(400))
    h.observeSendResult('settled', http(403))
    h.observeSendResult('same key', http(404))
    h.observeSendResult('retry', http(409))
    return h.trace
  }
  expect(run(createDetachedSends)).toEqual(run(createReference))
})

it('matches the former revision fence for local edits, cross-controller edits and Account Session clear', () => {
  for (const local of [0, 1]) {
    for (const saved of [undefined, 0, 1, -1]) {
      for (const current of [undefined, 0, 1, -1]) {
        for (const body of ['', 'edit']) {
          for (const topic of ['', 'Topic edit']) {
            const expected = local === 0 && saved === current && body === '' && topic === ''
            expect(canRestoreDraft(0, local, saved, current, body === '' && topic === '')).toBe(expected)
          }
        }
      }
    }
  }
})

it('matches the former stop predicate before and after a retry, generation change and discard', () => {
  const core = createCore('me')
  const channel = 'Channel'
  const clientMessageId = 'submitted'
  const history = '00000000-0000-0000-0000-000000000001'
  core.step({ type: 'session_start', selfId: 'me' })
  core.step({ type: 'history_generation', generation: history })
  core.step({ type: 'user_send', channel, clientMessageId, body: 'text' })
  const pending = () => core.get().channels[channel]?.pending.find(p => p.clientMessageId === clientMessageId)
  const check = (expected: boolean) => {
    const candidate = pending()
    const request = candidate && core.request(candidate.request)
    const original = candidate !== undefined && candidate.state !== 'unknown' && request !== undefined && !request.stale
    expect(original).toBe(expected)
    expect(candidate !== undefined && core.canDetachSend(candidate.request)).toBe(original)
  }
  check(true)
  core.step({ type: 'send_failed', request: pending()!.request, status: 'network' })
  check(false)
  core.step({ type: 'user_retry', channel, clientMessageId })
  check(true)
  core.step({ type: 'history_generation', generation: '00000000-0000-0000-0000-000000000002' })
  check(false)
  core.step({ type: 'user_discard', channel, clientMessageId })
  check(false)
  core.step({ type: 'stop' })
  check(false)
})
