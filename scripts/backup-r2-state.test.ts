import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { chmodSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { runChecker } from './backup-r2-checker.ts'
import { fileStateStore } from './backup-r2-state.ts'
import { memoryRunLock } from './backup-test-helpers.ts'
import { now, fixture, prunableOptions } from './backup-r2-test-helpers.ts'

test('checker atomically persists private state and dedup across fresh checker instances', async t => {
  const root = fixture(t), path = join(root, 'state'), o = prunableOptions(), lock = memoryRunLock()
  const first = await runChecker({ ...o, store: fileStateStore(path), lock })
  assert.deepEqual(first.alerts, ['state-missing', 'pruning-refused'])
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.ok(first.alerts.includes('pruning-refused'))
  assert.deepEqual(first.deleted, [])
  assert.ok(!o.bucket.calls.some(c => c.startsWith('DELETE')))
  o.events.length = 0
  const recovered = await runChecker({ ...o, store: fileStateStore(path), lock })
  assert.deepEqual(recovered.deleted, [o.candidate])
  assert.deepEqual(o.events, [])
  assert.equal(readdirSync(root).length, 1)
  const loaded = await fileStateStore(path).load()
  assert.equal(loaded.state.aliveDate, '2026-11-02')
})

test('corrupt checker state alerts safely freezes pruning and replaces only a private regular file', async t => {
  const root = fixture(t), path = join(root, 'state')
  for (const content of ['PRIVATE_SENTINEL', JSON.stringify({ version: 1, state: { sentAlerts: ['PRIVATE_SENTINEL'] } }),
    JSON.stringify({ version: 1, state: { sentAlerts: [], aliveDate: '2026-13-01' } }), 'x'.repeat(17_000)]) {
    const o = prunableOptions()
    writeFileSync(path, content, { mode: 0o600 })
    const result = await runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock() })
    assert.deepEqual(result.alerts, ['state-corrupt', 'pruning-refused'])
    assert.deepEqual(result.deleted, [])
    assert.ok(!o.bucket.calls.some(c => c.startsWith('DELETE')))
    assert.ok(!o.events.join().includes('PRIVATE_SENTINEL'))
    assert.equal((await fileStateStore(path).load()).warning, undefined)
  }
  const o = prunableOptions()
  const other = join(root, 'other'); writeFileSync(other, 'preserve', { mode: 0o600 }); rmSync(path); symlinkSync(other, path)
  await assert.rejects(runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock() }), /Checker failed/)
  assert.equal(readFileSync(other, 'utf8'), 'preserve')
  rmSync(path); writeFileSync(path, '{}'); chmodSync(path, 0o644)
  await assert.rejects(runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock() }))
})

test('state directory fsync failure is visible and atomic replacement leaves valid state', async t => {
  const root = fixture(t), path = join(root, 'state')
  await fileStateStore(path).save({ sentAlerts: [] })
  let syncs = 0
  await assert.rejects(fileStateStore(path, () => { syncs++; throw new Error('PRIVATE_SENTINEL') }).save({ aliveDate: '2026-11-02', sentAlerts: [] }), { message: 'State persistence failed' })
  assert.equal(syncs, 1)
  assert.equal((await fileStateStore(path).load()).state.aliveDate, '2026-11-02')
  assert.deepEqual(readdirSync(root), ['state'])
})

for (const notifierFails of [false, true]) {
  test(`checker reports local state cleanup failure with notifier failure=${notifierFails} with local locks`, async t => {
    const root = fixture(t), o = prunableOptions(), path = join(root, 'state')
    await fileStateStore(path).save({ sentAlerts: [], aliveDate: '2026-11-02' })
    const remove = fsPromises.rm
    let cleanups = 0
    t.mock.method(fsPromises, 'rm', async (target: Parameters<typeof remove>[0], options: Parameters<typeof remove>[1]) => {
      if (String(target).startsWith(join(root, '.checker-state-'))) { cleanups++; throw new Error('PRIVATE_SENTINEL') }
      return remove(target, options)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(runChecker({ ...o, lock: memoryRunLock(), store: fileStateStore(path),
        notify: async event => { o.events.push(event); if (notifierFails) throw new Error('PRIVATE_SENTINEL') } }),
      { message: 'Checker failed (diagnostics suppressed)' })
    } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(cleanups, 1)
    assert.equal(o.events.filter(e => e === 'checker-failed').length, 1)
  })
}

test('FIFO state is promptly refused without pruning and the local checker lock is released', t => {
  const root = fixture(t), path = join(root, 'state'), o = prunableOptions()
  const fifo = spawnSync('mkfifo', ['-m', '600', path], { stdio: 'ignore' })
  assert.equal(fifo.status, 0)
  const script = `
    import { readFileSync } from 'node:fs';
    import { FakeBucket } from './scripts/backup-r2-fake.ts';
    import { memoryRunLock } from './scripts/backup-test-helpers.ts';
    import { runChecker } from './scripts/backup-r2-checker.ts';
    import { fileStateStore } from './scripts/backup-r2-state.ts';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const bucket = new FakeBucket(() => input.now), events = [];
    for (const [key, value] of input.objects) bucket.objects.set(key, { ...value, body: Buffer.from(value.body, 'base64') });
    let released = 0, acquired = 0, error, owner;
    const lock = async work => { acquired++; owner = true; try { return await memoryRunLock()(work) } finally { released++; owner = false } };
    try { await runChecker({ backups: bucket, images: { list: async () => [] }, now: () => input.now,
      usage: { read: async () => ({ classA: 0, classB: 0 }) }, store: fileStateStore(input.path),
      notify: async event => { events.push(event) }, lock });
    } catch (failure) { error = failure.message }
    console.log(JSON.stringify({ error, events, acquired, released, lockHeld: !!owner, deletes: bucket.calls.filter(c => c.startsWith('DELETE')).length }));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: new URL('../', import.meta.url),
    input: JSON.stringify({ path, now, objects: [...o.bucket.objects].map(([key, value]) => [key, { ...value, body: value.body.toString('base64') }]) }),
    encoding: 'utf8', timeout: 5000 })
  assert.equal(result.error, undefined, 'FIFO refusal must finish before the child deadline')
  assert.equal(result.status, 0)
  const actual = JSON.parse(result.stdout)
  assert.equal(actual.error, 'Checker failed (diagnostics suppressed)')
  assert.equal(actual.acquired, 1)
  assert.equal(actual.released, 1)
  assert.equal(actual.lockHeld, false)
  assert.equal(actual.deletes, 0)
  assert.deepEqual(actual.events, ['state-corrupt', 'checker-failed'])
  assert.ok(statSync(path).isFIFO())
})
