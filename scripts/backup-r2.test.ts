import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBucket, fakeS3 } from './backup-r2-fake.ts'
import { checksum, day, inventory, sha256, verifiedGeneration, type Manifest } from './backup-r2-model.ts'
import { curlRunner, objectTransport, publish, recheckNewest, runBackup } from './backup-r2.ts'
import { checkBackups } from './backup-r2-checker.ts'

const epoch = Date.UTC(2026, 10, 14, 12)
function manifest(capture = epoch, bytes = Buffer.from('encrypted-test-data')): Manifest {
  return { formatVersion: 1, captureTime: new Date(capture).toISOString(), postgresMajor: 18,
    plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: bytes.length, sha256: sha256(bytes) }, recipientFingerprint: sha256('public recipient') }
}
async function seed(bucket: FakeBucket, capture: number, size = 100, restored = false, uploaded = capture) {
  const body = Buffer.alloc(size, 1), m = manifest(capture, body), json = Buffer.from(JSON.stringify(m))
  const prefix = `${restored ? 'restore-verified' : 'backups'}/${m.captureTime}${restored ? '' : '-test'}/`
  for (const [key, data] of [['archive.dump.age', body], ['manifest.json', json], ['verified.json', Buffer.from(JSON.stringify({ manifestSha256: sha256(json), verifiedTime: m.captureTime }))]] as const) {
    bucket.objects.set(prefix + key, { body: data, uploaded })
  }
  return prefix
}
function checker(bucket: FakeBucket, now = epoch) {
  const events: string[] = [], images = new FakeBucket(() => now), state = {}
  const options = { backups: bucket, images, now: () => now, notify: async (event: string) => { events.push(event) }, state, operations: { classA: 0, classB: 0 } }
  return { events, images, options, run: () => checkBackups(options) }
}

test('verified predicate rejects partial malformed unmarked and future generations', async () => {
  const bucket = new FakeBucket(() => epoch)
  const good = await seed(bucket, epoch)
  assert.equal((await inventory(bucket, epoch)).verified.length, 1)
  for (const mutation of ['marker', 'hash', 'schema', 'future', 'prefix', 'archive', 'size', 'checksum']) {
    const b = new FakeBucket(() => epoch)
    await seed(b, epoch)
    if (mutation === 'marker') b.objects.delete(good + 'verified.json')
    if (mutation === 'hash') b.objects.get(good + 'manifest.json')!.body = Buffer.from(JSON.stringify({
      ...manifest(epoch, Buffer.alloc(100, 1)), postgresMajor: 17,
    }))
    if (mutation === 'schema') {
      const m = { ...manifest(epoch, Buffer.alloc(100, 1)), extra: true }, body = Buffer.from(JSON.stringify(m))
      b.objects.get(good + 'manifest.json')!.body = body
      b.objects.get(good + 'verified.json')!.body = Buffer.from(JSON.stringify({ manifestSha256: sha256(body), verifiedTime: new Date(epoch).toISOString() }))
    }
    if (mutation === 'future') { b.objects.clear(); await seed(b, epoch + 300_001) }
    if (mutation === 'prefix') for (const [key, value] of [...b.objects]) { b.objects.delete(key); b.objects.set(key.replace(new Date(epoch).toISOString(), new Date(epoch - day).toISOString()), value) }
    if (mutation === 'archive') b.objects.delete(good + 'archive.dump.age')
    if (mutation === 'size') b.objects.get(good + 'archive.dump.age')!.body = Buffer.from('short')
    if (mutation === 'checksum') b.objects.get(good + 'archive.dump.age')!.body = Buffer.alloc(100, 2)
    assert.equal((await inventory(b, epoch)).verified.length, 0, mutation)
    await assert.rejects(recheckNewest(b, epoch), /No verified/)
    assert.ok((await checker(b).run()).alerts.includes('malformed-generations'))
  }
})

test('upload verifies checksums readback and lost PUT response without overwriting', async t => {
  const fake = await fakeS3(() => epoch); t.after(fake.close)
  fake.faults.push({ method: 'PUT', fault: 'lost-response', remaining: 1 })
  const transport = objectTransport(fake.runner('backups'))
  const prefix = await publish({ bucket: transport, ciphertext: Buffer.from('encrypted-test-data'), manifest: manifest(), now: () => epoch, attempt: () => 'first' })
  assert.equal((await verifiedGeneration(fake.buckets.backups, prefix, epoch)).manifest.captureTime, manifest().captureTime)
  assert.equal(fake.accesses.filter(c => c.endsWith(':PUT')).length, 3)
  await assert.rejects(transport.put(prefix + 'archive.dump.age', Buffer.from('overwrite')))
  await assert.rejects(fake.buckets.backups.delete(prefix + 'archive.dump.age'), /Locked/)
  assert.ok(fake.buckets.backups.calls.some(c => c.startsWith('GET ')))
})

test('mismatched HEAD or truncated GET abandons generation and retries new suffix', async t => {
  for (const fault of ['bad-checksum', 'truncated', '5xx'] as const) {
    const fake = await fakeS3(() => epoch); t.after(fake.close)
    fake.faults.push({ method: fault === 'truncated' ? 'GET' : 'HEAD', fault, remaining: 1 })
    let attempt = 0
    const prefix = await publish({ bucket: objectTransport(fake.runner('backups')), ciphertext: Buffer.from('encrypted-test-data'), manifest: manifest(), now: () => epoch, attempt: () => String(++attempt) })
    assert.match(prefix, /-2\/$/)
    assert.equal((await inventory(fake.buckets.backups, epoch)).verified.length, 1)
    assert.ok((await inventory(fake.buckets.backups, epoch)).malformed.length)
  }
})

test('fake rejects incorrect PUT digest and requires checksum mode', async t => {
  const fake = await fakeS3(() => epoch); t.after(fake.close)
  const run = fake.runner('backups'), body = Buffer.from('cipher')
  assert.equal((await run({ method: 'PUT', key: 'bad', body, headers: { 'x-amz-content-sha256': sha256('wrong'), 'x-amz-checksum-sha256': checksum(sha256(body)) } })).status, 400)
  await objectTransport(run).put('good', body)
  assert.equal((await run({ method: 'HEAD', key: 'good', headers: {} })).status, 400)
})

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
  c.options.operations = { classA: 700_000, classB: 7_000_000 }
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

test('dump encryption upload and verification failures alert without exposing diagnostics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'backup-flow-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'archive'); writeFileSync(source, 'dump')
  for (const stage of ['dump', 'encrypt', 'upload', 'verify']) {
    const bucket = new FakeBucket(() => epoch), events: string[] = []
    await seed(bucket, epoch - day)
    if (stage === 'upload') bucket.put = async () => { throw new Error('sensitive diagnostics') }
    if (stage === 'verify') bucket.get = async () => Buffer.from('wrong')
    await assert.rejects(runBackup({ directory: root, recipient: 'test-public-recipient', bucket, now: () => epoch,
      notify: async e => { events.push(e) }, dump: (_directory, capture) => { if (stage === 'dump') throw new Error('sensitive diagnostics'); capture(); return source },
      encrypt: (_s, target) => { if (stage === 'encrypt') throw new Error('sensitive diagnostics'); writeFileSync(target, 'ciphertext') },
    }), { message: 'Backup failed (diagnostics suppressed)' })
    assert.deepEqual(events, ['backup-failed'])
    assert.ok(bucket.objects.size >= 3)
    assert.equal([...bucket.objects.keys()].filter(key => key.endsWith('verified.json')).length, 1)
    assert.ok(![...bucket.objects.values()].some(o => o.body.equals(Buffer.from('dump'))))
  }
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

test('age throwaway key roundtrip rejects wrong key and tampering', async t => {
  if (spawnSync('age', ['--version'], { stdio: 'ignore' }).status !== 0 || spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status !== 0) {
    // CI installs age and sets FUKULOW_REQUIRE_AGE so this integration never silently skips there.
    if (process.env.FUKULOW_REQUIRE_AGE === '1') assert.fail('age and age-keygen are required (FUKULOW_REQUIRE_AGE=1) but unavailable')
    t.skip('age and age-keygen are unavailable; encryption integration requires the approved host binaries'); return
  }
  const root = mkdtempSync(join(tmpdir(), 'backup-age-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const key = join(root, 'identity'), wrong = join(root, 'wrong')
  for (const path of [key, wrong]) assert.equal(spawnSync('age-keygen', ['-o', path], { stdio: 'ignore' }).status, 0)
  const recipient = spawnSync('age-keygen', ['-y', key], { encoding: 'utf8' }).stdout.trim()
  const source = join(root, 'source'); writeFileSync(source, 'dump')
  const fake = await fakeS3(() => epoch); t.after(fake.close)
  const bucket = { ...objectTransport(fake.runner('backups')), list: () => fake.buckets.backups.list(), delete: (key: string) => fake.buckets.backups.delete(key) }
  await runBackup({ directory: root, recipient, bucket, now: () => epoch, notify: async () => assert.fail('unexpected alert'), dump: (_directory, capture) => { capture(); return source } })
  const newest = await recheckNewest(bucket, epoch), downloaded = join(root, 'downloaded')
  writeFileSync(downloaded, await bucket.get(newest.prefix + 'archive.dump.age'))
  const restored = spawnSync('age', ['-d', '-i', key, downloaded])
  assert.equal(restored.status, 0); assert.equal(sha256(restored.stdout), newest.manifest.plaintext.sha256)
  // Exercise the existing drill entry point using a local Docker command double.
  // The separate backup.test.ts suite checks isolation/cleanup and failure paths.
  const restoredPath = join(root, 'restored.dump'); writeFileSync(restoredPath, restored.stdout)
  const docker = join(root, 'docker')
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('/proc/1/comm')) console.log('postgres');
if (args.includes('pg_restore') && !fs.readFileSync(0).equals(fs.readFileSync(process.env.TEST_RESTORED))) process.exit(1);
`)
  chmodSync(docker, 0o700)
  const drill = spawnSync(process.execPath, [new URL('./restore-drill.ts', import.meta.url).pathname, restoredPath], {
    encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH, TEST_RESTORED: restoredPath },
  })
  assert.equal(drill.status, 0); assert.match(drill.stdout, /Restore drill passed/)
  assert.notEqual(spawnSync('age', ['-d', '-i', wrong, downloaded], { stdio: 'ignore' }).status, 0)
  const bytes = readFileSync(downloaded); bytes[bytes.length - 1] ^= 1; writeFileSync(downloaded, bytes)
  assert.notEqual(spawnSync('age', ['-d', '-i', key, downloaded], { stdio: 'ignore' }).status, 0)
})

test('normal mock flow preserves local dump and daily recheck hashes newest ciphertext', async t => {
  const { dailyBackup } = await import('./backup-r2.ts')
  const root = mkdtempSync(join(tmpdir(), 'backup-daily-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source'); writeFileSync(source, 'dump')
  const bucket = new FakeBucket(() => epoch), events: string[] = []
  await seed(bucket, epoch - day)
  const prefix = await dailyBackup({ directory: root, recipient: 'test-public-recipient', bucket,
    now: () => epoch, notify: async event => { events.push(event) }, dump: (_directory, capture) => { capture(); return source },
    encrypt: (_source, target) => writeFileSync(target, 'mock encrypted data') })
  assert.equal(events.length, 0)
  assert.equal(readFileSync(source, 'utf8'), 'dump')
  assert.equal((await recheckNewest(bucket, epoch)).prefix, prefix)
  const get = bucket.get.bind(bucket)
  bucket.get = async key => key.endsWith('archive.dump.age') ? Buffer.alloc(19, 3) : get(key)
  await assert.rejects(recheckNewest(bucket, epoch), /Daily integrity check failed/)
  await assert.rejects(runBackup({ directory: root, recipient: '', bucket, now: () => epoch,
    notify: async event => { events.push(event) }, dump: () => assert.fail('dump must not run without recipient') }))
  assert.deepEqual(events, ['backup-failed'])
})

async function realCurlS3(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'backup-curl-real-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const key = join(root, 'key'), cert = join(root, 'cert'), config = join(root, 'config')
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' }).status, 0)
  const fake = await fakeS3(() => epoch, { key: readFileSync(key), cert: readFileSync(cert) })
  let closed = false
  const close = async () => { if (!closed) { await fake.close(); closed = true } }
  t.after(close)
  // Self-signed TLS and credentials are confined to this throwaway local fixture.
  writeFileSync(config, 'insecure\nnoproxy = "*"\nuser = "test-access:test-secret"\nheader = "x-test-role: backups"\n', { mode: 0o600 })
  const run = await curlRunner(config, fake.base + '/backups')
  return { ...fake, close, run, bucket: objectTransport(run) }
}

test('real curl HEAD of a missing key returns null', async t => {
  const { bucket, accesses } = await realCurlS3(t)
  assert.equal(await bucket.head('missing'), null)
  assert.deepEqual(accesses, ['backups:backups:HEAD'])
})

test('real curl returns locked PUT status and reconciles a lost response through HEAD', async t => {
  const { bucket, run, faults, accesses, buckets } = await realCurlS3(t)
  const body = Buffer.from('encrypted-test-data')
  await bucket.put('locked', body)
  assert.equal((await run({ method: 'PUT', key: 'locked', body,
    headers: { 'x-amz-content-sha256': sha256(body), 'x-amz-checksum-sha256': checksum(sha256(body)) } })).status, 409)
  await assert.rejects(bucket.put('locked', Buffer.from('overwrite')), { message: 'Upload failed' })
  accesses.length = 0
  faults.push({ method: 'PUT', fault: 'lost-response', remaining: 1 })
  const prefix = await publish({ bucket, ciphertext: body, manifest: manifest(), now: () => epoch, attempt: () => 'first' })
  assert.match(prefix, /-first\/$/)
  // The first PUT commits but loses its response; curl retries into the lock.
  assert.deepEqual(accesses.slice(0, 3), ['backups:backups:PUT', 'backups:backups:PUT', 'backups:backups:HEAD'])
  assert.equal(accesses.filter(c => c.endsWith(':PUT')).length, 4)
  assert.equal((await verifiedGeneration(buckets.backups, prefix, epoch)).manifest.captureTime, manifest().captureTime)
})

test('real curl retries a 5xx then success and surfaces an exhausted HTTP error', async t => {
  const { bucket, run, faults, accesses } = await realCurlS3(t)
  const body = Buffer.from('cipher')
  faults.push({ method: 'PUT', fault: '5xx', remaining: 1 })
  await bucket.put('retry', body)
  assert.equal(accesses.length, 2)
  assert.equal((await bucket.head('retry'))?.checksum, checksum(sha256(body)))
  accesses.length = 0
  faults.push({ method: 'GET', fault: '5xx', remaining: 4 })
  assert.equal((await run({ method: 'GET', key: 'retry', headers: {} })).status, 503)
  assert.equal(accesses.length, 4)
  faults.push({ method: 'GET', fault: '5xx', remaining: 4 })
  await assert.rejects(bucket.get('retry'), { message: 'Read-back failed' })
})

test('real curl rejects a truncated transfer even after receiving HTTP 200 headers', async t => {
  const { bucket, faults, accesses } = await realCurlS3(t)
  await bucket.put('truncated', Buffer.from('cipher'))
  accesses.length = 0
  faults.push({ method: 'GET', fault: 'truncated', remaining: 4 })
  await assert.rejects(bucket.get('truncated'), { message: 'Transport failed' })
  assert.equal(accesses.length, 4)
})

test('real curl rejects connection failure with sanitized diagnostics', async t => {
  const { bucket, close } = await realCurlS3(t)
  await close()
  await assert.rejects(bucket.head('private-key'), { message: 'Transport failed' })
})

test('curl runner keeps configuration private signs checksums bounds retries and suppresses failures', async t => {
  const { curlRunner } = await import('./backup-r2.ts')
  const { chmodSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'backup-curl-test-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, 'config'); writeFileSync(config, '', { mode: 0o600 })
  const { networkInterfaces } = await import('node:os')
  const loopback = Object.values(networkInterfaces()).flat().find(info => info?.internal && info.family === 'IPv4')!.address
  const endpoint = `https://${loopback}`
  let seen = false
  const run = await curlRunner(config, endpoint, async (args, input) => {
    seen = true
    assert.ok(!args.some(arg => arg.includes(endpoint)))
    assert.ok(input.includes(endpoint))
    assert.ok(args.includes('--aws-sigv4'))
    assert.equal(args[args.indexOf('--retry') + 1], '3')
    assert.ok(args.includes('--retry-all-errors'))
    assert.ok(!args.includes('--fail')); assert.ok(!args.includes('--fail-with-body'))
    assert.ok(args.includes('--max-time')); assert.ok(args.includes('--retry-max-time'))
    assert.ok(args.includes('x-amz-content-sha256: ' + sha256('cipher')))
    assert.ok(args.includes('x-amz-checksum-sha256: ' + checksum(sha256('cipher'))))
    writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n')
    writeFileSync(args[args.indexOf('--output') + 1], '')
  })
  await objectTransport(run).put('object', Buffer.from('cipher'))
  assert.ok(seen)
  chmodSync(config, 0o644)
  await assert.rejects(curlRunner(config, endpoint), /Private external/)
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
