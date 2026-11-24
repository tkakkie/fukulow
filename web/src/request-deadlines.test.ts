import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequestDeadlines } from './request-deadlines'

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createRequestDeadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns an early response and clears the deadline timer', async () => {
    const deadlines = createRequestDeadlines()
    let finish!: (value: string) => void
    const request = new Promise<string>(resolve => { finish = resolve })
    const onTimeout = vi.fn(() => 'timeout')
    const result = deadlines.wait(request, 'cancelled', { timeoutMs: 500, onTimeout })

    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(499)
    finish('response')
    await expect(result).resolves.toBe('response')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('times out at the deadline, clears the timer and leaves the request observable', async () => {
    const deadlines = createRequestDeadlines()
    let finish!: (value: string) => void
    const request = new Promise<string>(resolve => { finish = resolve })
    const observe = vi.fn()
    const settled = vi.fn()
    const result = deadlines.wait(request.then(value => { observe(value); return value }), 'timeout', { timeoutMs: 500 })
    void result.then(settled)

    await vi.advanceTimersByTimeAsync(499)
    expect(settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
    expect(observe).not.toHaveBeenCalled()
    finish('late response')
    await expect(request).resolves.toBe('late response')
    expect(observe).toHaveBeenCalledWith('late response')
  })

  it('cancels by Channel while leaving other Channels pending, and cancel() cancels all', async () => {
    const deadlines = createRequestDeadlines()
    const acA = new AbortController()
    const removeA = vi.spyOn(acA.signal, 'removeEventListener')
    const onTimeoutA = vi.fn(() => 'timeout-a')

    const waitA = deadlines.start('cancelled-a', { channel: 'A', timeoutMs: 1000, onTimeout: onTimeoutA, signal: acA.signal })
    const waitB = deadlines.start('cancelled-b', { channel: 'B' })
    const waitGlobal = deadlines.start('cancelled-global', {})

    let bSettled = false
    let globalSettled = false
    void waitB.until.then(() => { bSettled = true })
    void waitGlobal.until.then(() => { globalSettled = true })

    deadlines.cancel('A')
    await expect(waitA.until).resolves.toBe('cancelled-a')
    await flushMicrotasks()

    expect(bSettled).toBe(false)
    expect(globalSettled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(removeA).toHaveBeenCalledTimes(1)
    expect(removeA).toHaveBeenCalledWith('abort', expect.any(Function))

    deadlines.cancel()
    await expect(waitB.until).resolves.toBe('cancelled-b')
    await expect(waitGlobal.until).resolves.toBe('cancelled-global')
    expect(bSettled).toBe(true)
    expect(globalSettled).toBe(true)

    vi.advanceTimersByTime(2000)
    expect(onTimeoutA).not.toHaveBeenCalled()
  })

  it('resolves immediately for a pre-aborted signal without starting a timer or listener', async () => {
    const deadlines = createRequestDeadlines()
    const ac = new AbortController()
    ac.abort()
    const addListener = vi.spyOn(ac.signal, 'addEventListener')
    const onTimeout = vi.fn(() => 'timed-out')

    const wait = deadlines.start('cancelled', { timeoutMs: 1000, onTimeout, channel: 'A', signal: ac.signal })

    expect(vi.getTimerCount()).toBe(0)
    expect(addListener).not.toHaveBeenCalled()
    await expect(wait.until).resolves.toBe('cancelled')

    vi.advanceTimersByTime(2000)
    expect(onTimeout).not.toHaveBeenCalled()
    wait.clear()
    deadlines.cancel('A')
  })

  it('resolves to cancelled when signal aborts after start, clearing the timer and listener', async () => {
    const deadlines = createRequestDeadlines()
    const ac = new AbortController()
    const removeListener = vi.spyOn(ac.signal, 'removeEventListener')
    const onTimeout = vi.fn(() => 'timed-out')

    const wait = deadlines.start('cancelled', { timeoutMs: 1000, onTimeout, channel: 'A', signal: ac.signal })
    expect(vi.getTimerCount()).toBe(1)

    ac.abort()
    await expect(wait.until).resolves.toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    vi.advanceTimersByTime(2000)
    expect(onTimeout).not.toHaveBeenCalled()
    deadlines.cancel('A')
  })

  it('returns onTimeout() on timeout or cancelled when absent, and cleans up the abort listener', async () => {
    const deadlines = createRequestDeadlines()
    const acWithCallback = new AbortController()
    const acWithoutCallback = new AbortController()
    const removeWithCallback = vi.spyOn(acWithCallback.signal, 'removeEventListener')
    const removeWithoutCallback = vi.spyOn(acWithoutCallback.signal, 'removeEventListener')

    const withCallback = deadlines.start('cancelled', {
      timeoutMs: 500,
      onTimeout: () => 'timed-out',
      channel: 'A',
      signal: acWithCallback.signal,
    })
    const withoutCallback = deadlines.start('cancelled', {
      timeoutMs: 500,
      channel: 'B',
      signal: acWithoutCallback.signal,
    })

    let settled = false
    void withCallback.until.then(() => { settled = true })
    vi.advanceTimersByTime(499)
    await flushMicrotasks()
    expect(settled).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(withCallback.until).resolves.toBe('timed-out')
    await expect(withoutCallback.until).resolves.toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    expect(removeWithCallback).toHaveBeenCalledTimes(1)
    expect(removeWithCallback).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(removeWithoutCallback).toHaveBeenCalledTimes(1)
    expect(removeWithoutCallback).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('settles until to cancelled, cleans up, and surfaces the error when onTimeout throws', async () => {
    const deadlines = createRequestDeadlines()
    const ac = new AbortController()
    const removeListener = vi.spyOn(ac.signal, 'removeEventListener')
    const boom = new Error('onTimeout failed')

    const wait = deadlines.start('cancelled', {
      timeoutMs: 500,
      onTimeout: () => { throw boom },
      channel: 'A',
      signal: ac.signal,
    })

    expect(() => vi.advanceTimersByTime(500)).toThrow(boom)
    await expect(wait.until).resolves.toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    // Already cleaned up: subsequent cancel or clear is a no-op.
    deadlines.cancel('A')
    wait.clear()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('clear() removes the timer, abort listener, and pending entry so later abort or cancel has no effect', async () => {
    const deadlines = createRequestDeadlines()
    const ac = new AbortController()
    const removeListener = vi.spyOn(ac.signal, 'removeEventListener')
    const onTimeout = vi.fn(() => 'timed-out')

    const wait = deadlines.start('cancelled', { timeoutMs: 500, onTimeout, channel: 'A', signal: ac.signal })
    let settled = false
    void wait.until.then(() => { settled = true })

    wait.clear()
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))

    ac.abort()
    deadlines.cancel('A')
    deadlines.cancel()
    vi.advanceTimersByTime(1000)
    await flushMicrotasks()

    expect(settled).toBe(false)
    expect(onTimeout).not.toHaveBeenCalled()

    // Calling clear() again is idempotent.
    wait.clear()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('removes the pending entry on timeout and treats later cancel as idempotent', async () => {
    const deadlines = createRequestDeadlines()
    const ac = new AbortController()
    const removeListener = vi.spyOn(ac.signal, 'removeEventListener')
    const mapSet = vi.spyOn(Map.prototype, 'set')
    const mapDelete = vi.spyOn(Map.prototype, 'delete')

    try {
      const wait = deadlines.start('cancelled', {
        timeoutMs: 250,
        onTimeout: () => 'timed-out',
        channel: 'A',
        signal: ac.signal,
      })
      const entry = mapSet.mock.calls.find(([key, value]) => typeof key === 'function' && value === 'A')?.[0]
      expect(entry).toBeTypeOf('function')
      expect(mapDelete.mock.calls.filter(([key]) => key === entry)).toHaveLength(0)

      vi.advanceTimersByTime(250)
      await expect(wait.until).resolves.toBe('timed-out')
      expect(removeListener).toHaveBeenCalledTimes(1)
      expect(mapDelete.mock.calls.filter(([key]) => key === entry)).toHaveLength(1)

      deadlines.cancel('A')
      deadlines.cancel()
      ac.abort()
      await expect(wait.until).resolves.toBe('timed-out')
      expect(removeListener).toHaveBeenCalledTimes(1)
      expect(mapDelete.mock.calls.filter(([key]) => key === entry)).toHaveLength(1)
    } finally {
      mapSet.mockRestore()
      mapDelete.mockRestore()
    }
  })
})
