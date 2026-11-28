import { describe, expect, it, vi } from 'vitest'
import type { Result } from './api'
import { isBelowMutationFloor, observeReadAccess } from './projection-read-fences'
import { createRequestDeadlines } from './request-deadlines'
import { createSync } from './sync'
import { deferred } from './topic-test-helpers'

const unauthorized = { ok: false, kind: 'http', status: 401 } as const

describe('observeReadAccess', () => {
  it('ignores a late 401 after Account Session replacement', async () => {
    const onSessionEnded = vi.fn()
    const sync = createSync({ selfId: 'self', onSessionEnded })
    const response = deferred<Result<unknown>>()
    let session = 0
    observeReadAccess(sync, response.promise, session, () => session)

    session++
    response.resolve(unauthorized)
    await response.promise
    expect(onSessionEnded).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'unwatch'])('ends the same Account Session on a late 401 after %s', async reason => {
    vi.useFakeTimers()
    try {
      const onSessionEnded = vi.fn()
      const sync = createSync({ selfId: 'self', onSessionEnded })
      const deadlines = createRequestDeadlines()
      const response = deferred<Result<unknown>>()
      observeReadAccess(sync, response.promise, 0, () => 0)
      const cancelled = { ok: false, kind: 'network' } as const
      const waiting = deadlines.wait(response.promise, cancelled, { channel: 'A', timeoutMs: 10 })

      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(10)
      else deadlines.cancel('A')
      await expect(waiting).resolves.toEqual(cancelled)
      expect(onSessionEnded).not.toHaveBeenCalled()

      response.resolve(unauthorized)
      await response.promise
      expect(onSessionEnded).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports C10 with the original Organization sync as the source', async () => {
    const reportSyncAccess = vi.fn()
    const sync = createSync({ selfId: 'self', reportSyncAccess })
    const response = Promise.resolve<Result<unknown>>({
      ok: false, kind: 'http', status: 404, error: 'organization_unavailable',
    })
    observeReadAccess(sync, response, 0, () => 0)

    expect(reportSyncAccess).toHaveBeenCalledExactlyOnceWith(await response, sync)
  })
})

describe('isBelowMutationFloor', () => {
  it('rejects watermarks below a mutation observed during the read', () => {
    const channel = { mutationSeq: 10, moveSeq: 5 }
    expect(isBelowMutationFloor(9, 6, channel)).toBe(true)
    expect(isBelowMutationFloor(10, 6, channel)).toBe(false)
  })

  it('uses the Move floor when the mutation sequence has not advanced', () => {
    const channel = { mutationSeq: 10, moveSeq: 5 }
    expect(isBelowMutationFloor(4, 10, channel)).toBe(true)
    expect(isBelowMutationFloor(5, 10, channel)).toBe(false)
  })

  it('defaults to a zero floor when no Move or Channel is known', () => {
    expect(isBelowMutationFloor(0, 10, { mutationSeq: 10 })).toBe(false)
    expect(isBelowMutationFloor(0, 0, undefined)).toBe(false)
  })
})
