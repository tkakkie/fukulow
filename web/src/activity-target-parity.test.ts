import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createActivityTarget as createReference } from '../../load/dms-activity-target-reference'
import { createActivityTarget } from './activity-target'
import type { ActivityRead } from './activity-target'
import type { Result } from './api'

type CreateTarget = typeof createActivityTarget<number>
type Settings = Pick<Parameters<CreateTarget>[0], 'manualRetry' | 'retryQueuedTerminal' | 'acceptBelowFloor'> & {
  terminalStatuses?: readonly number[]
}

function observe(create: CreateTarget, settings: Settings) {
  vi.setSystemTime(0)
  const trace: unknown[] = []
  let epoch: number | null = null, allowed = true, floor = 0
  const requests: ((result: Result<number>) => void)[] = []
  const log = (...entry: unknown[]) => { trace.push([Date.now(), ...entry]) }
  const target = create({
    ...settings,
    canLoad: () => { log('canLoad', allowed); return allowed },
    connectionEpoch: () => epoch,
    load(signal, reasons) {
      log('load', [...reasons])
      const index = requests.length
      signal.addEventListener('abort', () => log('abort', index))
      return new Promise(resolve => requests.push(resolve))
    },
    stampRead() { log('stampRead'); return Date.now() },
    covers(value) { log('covers', value, floor); return value >= floor },
    accept(value, startedAt) { log('accept', value, startedAt) },
    error: result => log('error', result),
    terminal(result) {
      log('terminal', result)
      return 'status' in result && (settings.terminalStatuses?.includes(result.status) ?? false)
    },
    hide: reason => log('hide', reason),
    onReadyCovered: () => log('onReadyCovered'),
    random: () => { log('random'); return 0.5 },
    timeoutMs: 1_000,
    settled: () => log('settled'),
  })
  const state = (label: string) =>
    log(label, target.inFlight(), target.idle(), target.pendingNotice(), target.failure(), vi.getTimerCount())
  return {
    target, trace, state,
    setEpoch: (value: number | null) => { epoch = value; log('epoch', epoch) },
    setAllowed: (value: boolean) => { allowed = value },
    setFloor: (value: number) => { floor = value },
    ready: () => log('ready', target.ready()),
    watch(label: string, pending: Promise<ActivityRead<number> | undefined> | undefined) {
      log(label, pending !== undefined)
      void pending?.then(result => log(label, 'resolved', result), error => log(label, 'rejected', String(error)))
    },
    resolve(index: number, result: Result<number>) {
      expect(requests[index], `read ${index} should have started`).toBeDefined()
      requests[index](result)
    },
    async tick(ms: number) {
      await vi.advanceTimersByTimeAsync(ms)
      state(`after ${ms} ms`)
    },
  }
}

const ok = (data: number): Result<number> => ({ ok: true, data })
const http = (status: number, retryAfterMs?: number): Result<number> => ({ ok: false, kind: 'http', status, retryAfterMs })
type Harness = ReturnType<typeof observe>
type Scenario = { name: string; settings?: Settings; run(h: Harness): Promise<void> }

const scenarios: Scenario[] = [
  {
    name: 'coalesced reasons retain order and share a Promise until the queued follow-up',
    async run(h) {
      h.target.invalidate('notice')
      await h.tick(50)
      h.target.invalidate('access')
      h.target.invalidate('periodic')
      h.target.invalidate('notice')
      await h.tick(149)
      await h.tick(1)
      const joined = h.target.ensure()
      expect(h.target.refresh('reconcile')).toBe(joined)
      expect(h.target.flushQueued()).toBe(joined)
      h.watch('joined', joined)
      h.resolve(0, ok(1))
      await h.tick(199)
      await h.tick(1)
      h.resolve(1, ok(2))
      await h.tick(0)
    },
  },
  {
    name: 'Ready replaces a startup read, reuses only the current epoch, and loses reuse after a fence',
    async run(h) {
      h.watch('startup', h.target.ensure())
      h.ready()
      await h.tick(50)
      h.setEpoch(1)
      h.ready()
      h.resolve(0, ok(1))
      await h.tick(0)
      h.setEpoch(2)
      h.ready()
      h.setEpoch(1)
      h.ready()
      h.resolve(1, ok(2))
      await h.tick(0)
      h.setEpoch(2)
      h.ready()
      h.setEpoch(1)
      h.ready()
      h.target.fence()
      h.ready()
      await h.tick(200)
    },
  },
  {
    name: 'admission denial leaves demand for a later refresh',
    async run(h) {
      h.setAllowed(false)
      h.watch('blocked', h.target.ensure())
      await h.tick(1_000)
      h.setAllowed(true)
      h.watch('admitted', h.target.refresh())
      h.resolve(0, ok(2))
      await h.tick(0)
    },
  },
  ...[false, true].map(acceptBelowFloor => ({
    name: `third below-floor read enters backoff with acceptBelowFloor=${acceptBelowFloor}`,
    settings: { acceptBelowFloor },
    async run(h: Harness) {
      h.setFloor(4)
      h.target.demandCoverage()
      for (let request = 0; request < 3; request++) {
        await h.tick(200)
        h.resolve(request, ok(request))
      }
      await h.tick(0)
      h.target.demandCoverage()
      await h.tick(749)
      await h.tick(1)
      h.resolve(3, ok(4))
      await h.tick(0)
    },
  })),
  ...[401, 403, 404].map(status => ({
    name: `an old ${status} cannot stop a fresh read and a current ${status} drops queued work`,
    settings: { terminalStatuses: [status], retryQueuedTerminal: true },
    async run(h: Harness) {
      h.watch('stale', h.target.ensure())
      h.target.invalidate('access')
      h.resolve(0, http(status))
      await h.tick(200)
      h.target.invalidate('notice')
      h.resolve(1, http(status))
      await h.tick(1_000)
      h.watch('stopped', h.target.ensure())
      h.watch('retryNow', h.target.retryNow())
      h.resolve(2, ok(2))
      await h.tick(0)
    },
  })),
  {
    name: 'an ordinary terminal status with queued demand initiates a single follow-up',
    settings: { retryQueuedTerminal: true },
    async run(h) {
      h.target.invalidate('notice')
      await h.tick(200)
      h.target.invalidate('notice')
      h.resolve(0, http(422))
      await h.tick(200)
      h.resolve(1, http(422))
      await h.tick(1_000)
    },
  },
  ...[undefined, 17].flatMap(kind => [403, 429, 503].map(status => ({
    name: `failure kind ${kind ?? 'missing'} classifies HTTP ${status} by status`,
    async run(h: Harness) {
      // Exercise out-of-contract failure objects from the former JavaScript boundary.
      const failure = { ok: false, status, retryAfterMs: 1_700, ...(kind === undefined ? {} : { kind }) }
      h.watch('first', h.target.ensure())
      h.resolve(0, failure as unknown as Result<number>)
      await h.tick(1_699)
      await h.tick(1)
      if (status !== 403) {
        h.resolve(1, ok(2))
        await h.tick(0)
      }
    },
  }))),
  {
    name: 'a deadline aborts an ignored request and a fenced 429 retains Retry-After',
    async run(h) {
      h.watch('deadline', h.target.ensure())
      await h.tick(999)
      await h.tick(1)
      h.resolve(0, ok(1))
      await h.tick(750)
      h.target.invalidate('periodic')
      h.resolve(1, http(429, 1_750))
      await h.tick(1_749)
      await h.tick(1)
      h.resolve(2, ok(3))
      await h.tick(0)
    },
  },
  {
    name: 'manual retry pulls the deadline forward and delegates failure admission',
    settings: { manualRetry: true },
    async run(h) {
      h.target.invalidate('notice', 1_000)
      await h.tick(50)
      h.target.invalidate('notice', 20)
      await h.tick(20)
      h.resolve(0, http(503))
      await h.tick(1_000)
      h.watch('lane admitted retry', h.target.retryNow())
      h.resolve(1, ok(2))
      await h.tick(0)
    },
  },
  {
    name: 'suspend aborts the read and only new demand may run before close',
    async run(h) {
      h.target.invalidate('notice')
      await h.tick(200)
      h.watch('suspended', h.target.ensure())
      h.target.suspend()
      h.target.invalidate('access')
      h.resolve(0, ok(1))
      await h.tick(1)
      h.watch('closed', h.target.ensure())
      h.target.close()
      h.resolve(1, ok(2))
      await h.tick(1_000)
      h.watch('after close', h.target.retryNow())
      await h.tick(0)
    },
  },
]

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it.each(scenarios)('matches the pre-Slice G scheduler when $name', async ({ settings = {}, run }) => {
  const runTrace = async (create: CreateTarget) => {
    const h = observe(create, settings)
    try {
      await run(h)
    } finally {
      h.target.close()
      await h.tick(0)
    }
    expect(vi.getTimerCount()).toBe(0)
    return h.trace
  }
  const expected = await runTrace(createReference)
  expect(await runTrace(createActivityTarget)).toEqual(expected)
})
