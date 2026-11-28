import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeState } from './backup-checker-state.ts'
import { CheckerLease, jobDeadline, leaseDuration, leaseKey, stateKey } from '../workers/backup-checker/lease.ts'
import { backupAdapter } from '../workers/backup-checker/r2.ts'
import { epoch, deferred, fixture } from './backup-worker-test-helpers.ts'

test('DO lease serializes overlapping starts across storage and long awaited R2 work', async () => {
  const f = fixture(), entered = deferred(), finish = deferred(), acquiring = deferred(), finishAcquire = deferred()
  let first = true
  f.storage.before = async (op, key) => {
    if (first && op === 'get' && key === leaseKey) { first = false; acquiring.resolve(); await finishAcquire.promise }
  }
  f.binding.before = async op => { if (op === 'list') { entered.resolve(); await finish.promise } }
  const checker = f.create(), active = checker.fetch()
  await acquiring.promise
  assert.equal((await checker.fetch()).status, 409)
  finishAcquire.resolve(); await entered.promise
  // Two live instances aren't possible on the platform; simulate one anyway to
  // prove the persisted lease, rather than only an input gate, rejects starts.
  assert.equal((await f.create().fetch()).status, 409)
  f.advance(jobDeadline - 1)
  assert.equal((await checker.fetch()).status, 409)
  assert.equal((await f.create().fetch()).status, 409)
  finish.resolve()
  assert.equal((await active).status, 204)
  assert.deepEqual(f.binding.bucket.calls.filter(c => c.startsWith('DELETE')), ['verified.json', 'manifest.json', 'archive.dump.age'].map(name => 'DELETE ' + f.candidate + name))
  assert.ok(f.binding.bucket.objects.has(f.source + 'verified.json'))
  assert.ok(f.binding.bucket.objects.has(f.drill + 'verified.json'))
  assert.equal(f.storage.values.has(leaseKey), false)
})

test('crashed DO lease expires and fences resumed state writes deletes and old release', async () => {
  const f = fixture(), entered = deferred(), resume = deferred(), newEntered = deferred(), newFinish = deferred()
  const old = new CheckerLease(f.storage, f.clock, () => 'old')
  const stale = old.run(async (guard, store) => {
    entered.resolve(); await resume.promise
    await assert.rejects(store.save({ sentAlerts: ['stale-backup'] }))
    await assert.rejects(backupAdapter(f.binding, guard).delete(f.candidate + 'verified.json'))
  })
  await entered.promise
  // A new object represents a killed isolate; storage survives and finally did
  // not run. Expiry is exclusive: before it the new instance must stay idle.
  const successor = new CheckerLease(f.storage, f.clock, () => 'new')
  f.advance(leaseDuration - 1)
  assert.deepEqual(await successor.run(async () => assert.fail('lease still live')), { busy: true })
  f.advance(1)
  const active = successor.run(async (guard, store) => {
    newEntered.resolve(); await newFinish.promise
    await guard(); await store.save({ sentAlerts: [] })
  })
  await newEntered.promise
  const before = structuredClone(f.storage.values.get(stateKey))
  resume.resolve(); await stale
  assert.deepEqual(f.storage.values.get(stateKey), before)
  assert.equal((f.storage.values.get(leaseKey) as { runId: string }).runId, 'new')
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
  newFinish.resolve(); await active
  assert.deepEqual(decodeState(f.storage.values.get(stateKey)), { state: { sentAlerts: [] } })
  assert.equal((await f.create().fetch()).status, 204)
})

test('live hung DO never permits takeover after lease expiry and stops after its action deadline', async () => {
  const f = fixture(), entered = deferred(), finish = deferred(), checker = f.create()
  f.binding.before = async op => { if (op === 'list') { entered.resolve(); await finish.promise } }
  const active = checker.fetch(); await entered.promise
  f.advance(leaseDuration)
  assert.equal((await checker.fetch()).status, 409)
  finish.resolve()
  assert.equal((await active).status, 500)
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
  f.binding.before = undefined
  assert.equal((await checker.fetch()).status, 204)
})

test('failed DO job releases its lease and a retry can prune without corrupting state', async () => {
  const f = fixture(), list = f.binding.list.bind(f.binding)
  f.binding.list = async () => { throw new Error('PRIVATE_SENTINEL') }
  const before = structuredClone(f.storage.values.get(stateKey))
  assert.equal((await f.create().fetch()).status, 500)
  assert.equal(f.storage.values.has(leaseKey), false)
  assert.deepEqual(f.storage.values.get(stateKey), before)
  assert.ok(f.events.some(e => e.includes('checker-failed')))
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
  f.binding.list = list
  assert.equal((await f.create().fetch()).status, 204)
  assert.equal(f.binding.bucket.objects.has(f.candidate + 'verified.json'), false)
  assert.ok(!f.events.join().includes('PRIVATE_SENTINEL'))
})

test('run ID fencing rejects ownership loss before deadline and never clears the successor', async () => {
  const f = fixture(), lease = new CheckerLease(f.storage, f.clock, () => 'original')
  const before = structuredClone(f.storage.values.get(stateKey))
  await lease.run(async (guard, store) => {
    f.storage.values.set(leaseKey, { runId: 'successor', expires: epoch + leaseDuration })
    await assert.rejects(store.save({ sentAlerts: ['stale-backup'] }), /lease lost/)
    await assert.rejects(backupAdapter(f.binding, guard).delete(f.candidate + 'verified.json'), /lease lost/)
  })
  assert.deepEqual(f.storage.values.get(stateKey), before)
  assert.equal((f.storage.values.get(leaseKey) as { runId: string }).runId, 'successor')
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
})

test('failed lease release keeps valid state and blocks retries until expiry while corrupt leases fail closed', async () => {
  const f = fixture()
  f.storage.before = async (op, key) => { if (op === 'delete' && key === leaseKey) throw new Error('PRIVATE_SENTINEL') }
  assert.equal((await f.create().fetch()).status, 500)
  assert.equal(decodeState(f.storage.values.get(stateKey)).warning, undefined)
  f.storage.before = undefined
  assert.equal((await f.create().fetch()).status, 409)
  f.advance(leaseDuration)
  assert.equal((await f.create().fetch()).status, 204)
  for (const lease of [null, { runId: 'bad' }, { runId: 'bad', expires: NaN }]) {
    f.storage.values.set(leaseKey, lease)
    const before = f.binding.bucket.calls.length
    assert.equal((await f.create().fetch()).status, 500)
    assert.equal(f.binding.bucket.calls.length, before)
  }
})
