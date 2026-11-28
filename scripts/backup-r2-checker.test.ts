import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { checkBackups, runChecker } from './backup-r2-checker.ts'
import { epoch, FakeBucket, fakeS3 } from './backup-r2-fake.ts'
import { day, inventory } from './backup-r2-inventory.ts'
import { memoryRunLock } from './backup-test-helpers.ts'
import { randomUUID } from 'node:crypto'
import { listObjects } from './backup-r2-list.ts'
import { fileStateStore } from './backup-r2-state.ts'
import { response, escape, item, page, scopes, withScope } from './backup-r2-list-test-helpers.ts'
import { now, fixture, options, prunableOptions } from './backup-r2-test-helpers.ts'
import { seed, checker } from './backup-r2-inventory-test-helpers.ts'

test('long outage and insufficient or stale inventory freeze all pruning', async () => {
  for (const [count, newestAge] of [[30, 100 * day], [29, 0], [40, day]]) {
    const bucket = new FakeBucket(() => epoch)
    for (let i = 0; i < count; i++) await seed(bucket, epoch - newestAge - i * day)
    const result = await checker(bucket).run()
    assert.ok(result.alerts.includes('pruning-refused'))
    assert.equal(result.deleted.length, 0)
    assert.equal((await inventory(bucket, epoch)).verified.length, count)
  }
})

test('newest thirty exclusion alone retains thirty with old unlocked inventory', async () => {
  const bucket = new FakeBucket(() => epoch)
  await seed(bucket, epoch)
  for (let i = 0; i < 39; i++) await seed(bucket, epoch - (40 + i) * day)
  assert.equal((await checker(bucket).run()).deleted.length, 5)
  assert.equal((await checker(bucket).run()).deleted.length, 5)
  assert.deepEqual((await checker(bucket).run()).deleted, [])
  const backups = (await inventory(bucket, epoch)).verified
  assert.equal(backups.length, 30)
  assert.deepEqual(backups.map(g => g.manifest.captureTime), [epoch, ...Array.from({ length: 29 }, (_, i) => epoch - (40 + i) * day)].map(t => new Date(t).toISOString()))
})

test('insufficient inventory freezes an otherwise deletable older restore copy', async () => {
  const bucket = new FakeBucket(() => epoch)
  for (let i = 0; i < 29; i++) await seed(bucket, epoch - i * day)
  await seed(bucket, epoch - 60 * day, 100, true, epoch - 10 * day)
  const older = await seed(bucket, epoch - 70 * day, 100, true, epoch - 41 * day)
  const result = await checker(bucket).run()
  assert.deepEqual(result.deleted, [])
  assert.ok(result.alerts.includes('insufficient-generations'))
  assert.ok(result.alerts.includes('pruning-refused'))
  assert.ok(await bucket.head(older + 'verified.json'))
})

test('latest restore copy completion controls protection and overdue alert despite older capture', async () => {
  for (const copyAge of [41, 34]) {
    const bucket = new FakeBucket(() => epoch)
    for (let i = 0; i < 30; i++) await seed(bucket, epoch - i * day)
    const earlierSource = await seed(bucket, epoch - 60 * day)
    const latestSource = await seed(bucket, epoch - 70 * day)
    const earlier = await seed(bucket, epoch - 60 * day, 100, true, epoch - 50 * day)
    const latest = await seed(bucket, epoch - 70 * day, 100, true, epoch - copyAge * day)
    // Copy completion is the last object upload, even if the archive was copied earlier.
    bucket.objects.get(latest + 'archive.dump.age')!.uploaded = epoch - 51 * day
    const result = await checker(bucket).run()
    assert.deepEqual(result.deleted, [earlierSource, earlier])
    assert.ok(await bucket.head(latest + 'verified.json'))
    assert.ok(await bucket.head(latestSource + 'verified.json'))
    assert.equal(result.alerts.includes('drill-overdue'), copyAge >= 35)
  }
})

test('pruning keeps newest thirty latest drilled source locks and maximum five', async () => {
  const bucket = new FakeBucket(() => epoch)
  for (let i = 0; i < 50; i++) await seed(bucket, epoch - i * day)
  const latestDrill = await seed(bucket, epoch - 48 * day, 100, true, epoch - 10 * day)
  const olderDrill = await seed(bucket, epoch - 49 * day, 100, true, epoch - 45 * day)
  const result = await checker(bucket).run()
  assert.equal(result.deleted.length, 5)
  assert.ok(await bucket.head(latestDrill + 'archive.dump.age'))
  assert.ok(await bucket.head(`backups/${new Date(epoch - 48 * day).toISOString()}-test/archive.dump.age`))
  for (const prefix of result.deleted) assert.ok(!prefix.includes(new Date(epoch - 34 * day).toISOString()))
  for (let i = 0; i < 8; i++) await checker(bucket).run()
  assert.equal(await bucket.head(olderDrill + 'archive.dump.age'), null)
  assert.ok(await bucket.head(latestDrill + 'archive.dump.age'))
  assert.ok((await inventory(bucket, epoch)).verified.filter(g => g.prefix.startsWith('backups/')).length >= 30)
})

test('capture time drives exact staleness boundary and independent checker alerts', async () => {
  const bucket = new FakeBucket(() => epoch)
  await seed(bucket, epoch - day, 100, false, epoch)
  assert.ok((await checker(bucket).run()).alerts.includes('stale-backup'))
  assert.ok(!(await checker(bucket, epoch - 1).run()).alerts.includes('stale-backup'))
  assert.ok((await checker(new FakeBucket(() => epoch)).run()).alerts.includes('stale-backup'))
})

test('capacity operations plausibility overdue drill and daily alive alerts', async () => {
  const bucket = new FakeBucket(() => epoch)
  for (let i = 0; i < 8; i++) await seed(bucket, epoch - i * day, i === 0 ? 201 : 100)
  await seed(bucket, epoch - 40 * day, 100, true)
  const c = checker(bucket)
  c.options.images = { list: async () => [{ key: 'image', size: 9_000_000_000, checksum: '', uploaded: epoch }] } as FakeBucket
  c.options.usage = { read: async () => ({ classA: 700_000, classB: 7_000_000 }) }
  const result = await c.run()
  for (const alert of ['capacity-70', 'capacity-90', 'class-a-70', 'class-b-70', 'implausible-size', 'drill-overdue']) assert.ok(result.alerts.includes(alert), alert)
  await c.run()
  assert.equal(c.events.filter(e => e.includes('checker-alive')).length, 1)
  const alive = JSON.parse(c.events.find(e => e.includes('checker-alive'))!)
  assert.equal(alive.total, alive.backupBytes + alive.imageBytes)
  bucket.calls = []
  await c.run()
  assert.ok(!bucket.calls.some(c => c.includes('GET ') && c.endsWith('archive.dump.age')))
})

test('backup and image capabilities cannot cross buckets and checker only lists images', async t => {
  const fake = await fakeS3(() => epoch); t.after(fake.close)
  for (const [role, target] of [['backups', 'images'], ['images', 'backups']] as const) {
    for (const method of ['PUT', 'HEAD', 'GET'] as const) assert.equal((await fake.runner(role, target)({ method, key: 'object', headers: {} })).status, 403)
  }
  const c = checker(fake.buckets.backups)
  c.options.images = fake.buckets.images
  await c.run()
  assert.deepEqual(fake.buckets.images.calls, ['LIST'])
})

test('checker or notification failure is observable and alive state advances only after delivery', async () => {
  const bucket = new FakeBucket(() => epoch), c = checker(bucket)
  bucket.list = async () => { throw new Error('private diagnostics') }
  await assert.rejects(c.run(), /Checker failed/)
  assert.deepEqual(c.events, ['checker-failed'])
  const broken = checker(new FakeBucket(() => epoch))
  broken.options.notify = async () => { throw new Error('channel down') }
  await assert.rejects(broken.run())
  assert.deepEqual(broken.options.state, {})
})

test('plausibility uses strict half and double median boundaries', async () => {
  for (const [size, alert] of [[49, true], [50, false], [200, false], [201, true]] as const) {
    const bucket = new FakeBucket(() => epoch)
    for (let i = 1; i <= 7; i++) await seed(bucket, epoch - i * day)
    await seed(bucket, epoch, size)
    assert.equal((await checker(bucket).run()).alerts.includes('implausible-size'), alert)
  }
})

test('restore copy lock uses upload time and only older copies become prune candidates', async () => {
  const bucket = new FakeBucket(() => epoch)
  for (let i = 0; i < 30; i++) await seed(bucket, epoch - i * day)
  const newest = await seed(bucket, epoch - 40 * day, 100, true, epoch - 39 * day)
  const olderLocked = await seed(bucket, epoch - 50 * day, 100, true, epoch - 40 * day + 1)
  assert.equal((await checker(bucket).run()).deleted.length, 0)
  assert.ok(await bucket.head(newest + 'verified.json'))
  assert.ok(await bucket.head(olderLocked + 'verified.json'))
  bucket.now = () => epoch + 1
  assert.deepEqual((await checker(bucket, epoch + 1).run()).deleted, [olderLocked])
  assert.ok(await bucket.head(newest + 'verified.json'))
})

test('healthy fresh inventory prunes an unlocked candidate and preserves the latest drilled source', async () => {
  const o = prunableOptions()
  assert.equal((await inventory(o.bucket, now)).verified.filter(g => g.prefix.startsWith('backups/')).length, 32)
  const result = await checkBackups({ ...o, state: {}, lock: memoryRunLock() })
  assert.deepEqual(result.alerts, [])
  assert.deepEqual(result.deleted, [o.candidate])
  assert.equal(o.bucket.calls.filter(c => c.startsWith('DELETE')).length, 3)
  assert.ok(o.bucket.objects.has(o.protectedSource + 'verified.json'))
})

test('a failed pagination page aborts the checker before any pruning and emits only a fixed failure event', async () => {
  const o = options()
  o.backups.list = () => listObjects(async () => response(page([item()], true)), 1)
  await assert.rejects(checkBackups({ ...o, lock: memoryRunLock(), state: {} }), { message: 'Checker failed (diagnostics suppressed)' })
  assert.deepEqual(o.events, ['checker-failed'])
  assert.ok(!o.bucket.calls.some(call => call.startsWith('DELETE')))
})

test('unknown or failed usage alerts freezes pruning and appears as null in alive', async () => {
  for (const read of [async () => { throw new Error('PRIVATE_SENTINEL') }, async () => ({ classA: NaN, classB: 0 }), async () => ({ classA: -1, classB: 0 })]) {
    const o = prunableOptions()
    const result = await checkBackups({ ...o, usage: { read }, state: {}, lock: memoryRunLock() })
    assert.deepEqual(result.alerts, ['operations-unknown', 'pruning-refused'])
    assert.deepEqual(result.deleted, [])
    assert.ok(!o.bucket.calls.some(c => c.startsWith('DELETE')))
    const alive = JSON.parse(o.events.find(e => e.includes('checker-alive'))!)
    assert.equal(alive.operations, null)
    assert.ok(!o.events.join().includes('PRIVATE_SENTINEL'))
  }
})

test('notification failure leaves undelivered alerts and alive state retryable', async t => {
  const root = fixture(t), path = join(root, 'state'), o = options()
  await assert.rejects(runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock(), notify: async () => { throw new Error('PRIVATE_SENTINEL') } }))
  assert.equal((await fileStateStore(path).load()).warning, 'state-missing')
  await runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock() })
  assert.ok(o.events.includes('state-missing'))
  assert.ok(o.events.some(e => e.includes('checker-alive')))
})

test('alive notification failure persists delivered alerts but leaves the alive day retryable', async t => {
  const root = fixture(t), path = join(root, 'state'), o = options()
  await assert.rejects(runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock(), notify: async event => {
    if (event.includes('checker-alive')) throw new Error('PRIVATE_SENTINEL')
    o.events.push(event)
  } }))
  const state = (await fileStateStore(path).load()).state
  assert.equal(state.aliveDate, undefined)
  assert.ok(state.sentAlerts?.includes('stale-backup'))
  o.events.length = 0
  await runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock() })
  assert.equal(o.events.length, 1)
  assert.ok(o.events[0].includes('checker-alive'))
})

test('persistent alerts rearm after recovery and alive advances on the next UTC day', async t => {
  const root = fixture(t), path = join(root, 'state'), o = options(), lock = memoryRunLock()
  let broken = true
  const usage = { read: async () => { if (broken) throw new Error('PRIVATE_SENTINEL'); return { classA: 0, classB: 0 } } }
  const run = (time = now) => runChecker({ ...o, usage, now: () => time, store: fileStateStore(path), lock })
  await run(); await run(); broken = false; await run(); broken = true; await run(now + day)
  assert.equal(o.events.filter(e => e === 'operations-unknown').length, 2)
  assert.equal(o.events.filter(e => e.includes('checker-alive')).length, 2)
})

test('scope mismatches reject an otherwise prunable checker inventory without any DELETE', async () => {
  for (const scope of scopes) {
    const o = prunableOptions()
    const contents = [...o.bucket.objects].filter(([key]) => key.startsWith('backups/')).map(([key, value]) =>
      `<Contents><Key>${escape(key)}</Key><Size>${value.body.length}</Size><LastModified>${new Date(value.uploaded).toISOString()}</LastModified></Contents>`)
    o.backups.list = () => listObjects(async () => response(withScope(page(contents), scope)))
    await assert.rejects(checkBackups({ ...o, state: {}, lock: memoryRunLock() }), { message: 'Checker failed (diagnostics suppressed)' })
    assert.deepEqual(o.events, ['checker-failed'])
    assert.ok(!o.bucket.calls.some(c => c.startsWith('DELETE')))
  }
})

test('locked verification probes cannot freeze otherwise healthy pruning and remain in capacity totals', async () => {
  const o = prunableOptions(), key = `backups/verification-${randomUUID()}/probe`
  await o.bucket.put(key, Buffer.from('probe'))
  const data = await inventory(o.bucket, now)
  assert.deepEqual(data.malformed, [])
  assert.ok(data.objects.some(object => object.key === key))
  const result = await checkBackups({ ...o, state: {}, lock: memoryRunLock() })
  assert.deepEqual(result.alerts, [])
  assert.deepEqual(result.deleted, [o.candidate])
  assert.ok(o.bucket.objects.has(key))
  // Similar unreserved prefixes remain malformed; only UUID probe namespaces qualify.
  await o.bucket.put('backups/verification-not-a-probe/archive.dump.age', Buffer.from('partial'))
  assert.deepEqual((await inventory(o.bucket, now)).malformed, ['backups/verification-not-a-probe/'])
})
