import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountUsage, type UsageState } from './backup-usage-model.ts'
import { decodeState } from './backup-checker-state.ts'

const day = 86_400_000
const payload = { data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
  { dimensions: { actionType: 'PutObject' }, sum: { requests: 2 } },
  { dimensions: { actionType: 'GetObject' }, sum: { requests: 3 } },
] }] } } }
function usageFixture() {
  const dates: string[] = [], state: UsageState = {}
  const usage = () => accountUsage({ async query(request) { dates.push(request.variables.start); return payload } }, 'test-only')
  return { dates, state, usage }
}

test('usage backfill bounds misses and persists closed days across clients until full month coverage', async () => {
  const f = usageFixture(), now = Date.UTC(2026, 9, 31, 12)
  await assert.rejects(f.usage().read(now, f.state), /unavailable/)
  assert.equal(f.dates.length, 4)
  assert.deepEqual(Object.keys(f.state.usageCache!.days), ['2026-10-01', '2026-10-02', '2026-10-03'])
  for (let i = 0; i < 8; i++) {
    const before: number = f.dates.length
    await assert.rejects(f.usage().read(now, f.state), /unavailable/)
    assert.equal(f.dates.length - before, 4)
  }
  assert.deepEqual(await f.usage().read(now, f.state), { classA: 62, classB: 93 })
  const before: number = f.dates.length
  assert.deepEqual(await f.usage().read(now, f.state), { classA: 62, classB: 93 })
  assert.deepEqual(f.dates.slice(before), ['2026-10-31T00:00:00.000Z'])
  assert.equal(Object.keys(f.state.usageCache!.days).length, 30)
})

test('usage rollover discards previous month and midnight never invents zero usage', async () => {
  const f = usageFixture()
  assert.deepEqual(await f.usage().read(Date.UTC(2026, 9, 2, 12), f.state), { classA: 4, classB: 6 })
  await assert.rejects(f.usage().read(Date.UTC(2026, 10, 1), f.state), /unavailable/)
  assert.deepEqual(f.state.usageCache, { month: '2026-11', days: {} })
  assert.deepEqual(await f.usage().read(Date.UTC(2026, 10, 1, 1), f.state), { classA: 2, classB: 3 })
  assert.deepEqual(f.state.usageCache.days, {})
})

test('usage only caches closed days at the six hour analytics lag boundary', async () => {
  const f = usageFixture(), closed = Date.UTC(2026, 10, 2)
  assert.deepEqual(await f.usage().read(closed + day / 4 - 1, f.state), { classA: 4, classB: 6 })
  assert.deepEqual(f.state.usageCache!.days, {})
  assert.equal(f.dates.length, 2)
  await f.usage().read(closed + day / 4, f.state)
  assert.deepEqual(f.state.usageCache!.days, { '2026-11-01': { classA: 2, classB: 3 } })
  const before: number = f.dates.length
  await f.usage().read(closed + day / 4 + 1, f.state)
  assert.deepEqual(f.dates.slice(before), ['2026-11-02T00:00:00.000Z'])
})

test('corrupt cached usage is refused instead of silently becoming trusted or zero', async () => {
  const valid = { usageCache: { month: '2026-11', days: { '2026-11-01': { classA: 2, classB: 3 } } } }
  assert.equal(decodeState({ version: 1, state: { sentAlerts: [], ...valid } }).warning, undefined)
  const f = usageFixture()
  await assert.rejects(f.usage().read(Date.UTC(2026, 10, 2, 12), {
    usageCache: { month: '2026-11', days: { '2026-11-01': { classA: -1, classB: 0 } } },
  }), /unavailable/)
  assert.equal(f.dates.length, 0)
  for (const cache of [null, [], { month: '2026-13', days: {} }, { month: '2026-11', days: { '2026-11-31': { classA: 0, classB: 0 } } },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(classA => ({ month: '2026-11', days: { '2026-11-01': { classA, classB: 0 } } })),
    { month: '2026-11', days: { '2026-10-31': { classA: 0, classB: 0 } } },
    { month: '2026-11', days: { '2026-11-01': { classA: 0, classB: 0, extra: 1 } } }]) {
    assert.equal(decodeState({ version: 1, state: { sentAlerts: [], usageCache: cache } }).warning, 'state-corrupt')
  }
})

test('empty closed days count as zero only before the month first usage', async () => {
  const empty = { data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [] }] } } }
  const client = (active: (start: string) => boolean) => accountUsage({ async query(request) {
    return active(request.variables.start) ? payload : empty } }, 'test-only')
  const state: UsageState = {}, now = Date.UTC(2026, 10, 5, 12)
  const leading = client(start => start >= '2026-11-03')
  await assert.rejects(leading.read(now, state), /unavailable/)
  assert.deepEqual(state.usageCache!.days, { '2026-11-01': { classA: 0, classB: 0 }, '2026-11-02': { classA: 0, classB: 0 }, '2026-11-03': { classA: 2, classB: 3 } })
  assert.deepEqual(await leading.read(now, state), { classA: 6, classB: 9 })
  await assert.rejects(client(start => start !== '2026-11-02T00:00:00.000Z').read(Date.UTC(2026, 10, 4, 12), {}), /unavailable/)
  await assert.rejects(client(start => start !== '2026-11-04T00:00:00.000Z').read(now, { usageCache: { month: '2026-11', days: {
    '2026-11-01': { classA: 0, classB: 0 }, '2026-11-02': { classA: 0, classB: 0 }, '2026-11-03': { classA: 2, classB: 3 } } } }), /unavailable/)
  const lag = Date.UTC(2026, 10, 2, 6) - 1
  await assert.rejects(client(() => false).read(lag, {}), /unavailable/)
  await assert.rejects(client(start => start >= '2026-11-02').read(lag, {}), /unavailable/)
  assert.deepEqual(await client(() => false).read(lag + 1, {}), { classA: 0, classB: 0 })
  assert.deepEqual(await client(start => start >= '2026-11-02').read(lag + 1, {}), { classA: 2, classB: 3 })
})

test('an empty today counts as zero at the first run after UTC midnight', async () => {
  const empty = { data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [] }] } } }
  const cached = { month: '2026-11', days: Object.fromEntries(Array.from({ length: 18 }, (_, i) =>
    [`2026-11-${String(i + 1).padStart(2, '0')}`, { classA: 2, classB: 3 }])) }
  const dates: string[] = []
  const usage = accountUsage({ async query(request) {
    dates.push(request.variables.start)
    return request.variables.start === '2026-11-20T00:00:00.000Z' ? empty : payload } }, 'test-only')
  assert.deepEqual(await usage.read(Date.UTC(2026, 10, 20, 0, 0, 5), { usageCache: structuredClone(cached) }), { classA: 38, classB: 57 })
  assert.deepEqual(dates, ['2026-11-19T00:00:00.000Z', '2026-11-20T00:00:00.000Z'])
  const emptyAfterUsage = accountUsage({ async query(request) {
    return request.variables.start === '2026-11-19T00:00:00.000Z' ? empty : payload } }, 'test-only')
  await assert.rejects(emptyAfterUsage.read(Date.UTC(2026, 10, 20, 0, 0, 5), { usageCache: structuredClone(cached) }), /unavailable/)
})
