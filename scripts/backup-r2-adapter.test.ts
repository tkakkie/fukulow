import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { FakeBucket } from './backup-r2-fake.ts'
import { day, inventory, sha256, type ObjectInfo } from './backup-r2-model.ts'
import { listObjects, runLockKey } from './backup-r2-list.ts'
import { bucketRunLock, curlRunner, dailyBackup, objectTransport, runBackup, type Request, type Response, type Runner } from './backup-r2.ts'
import { accountUsage, analyticsClient } from './backup-r2-usage.ts'
import { fileStateStore } from './backup-r2-state.ts'
import { checkBackups, runChecker } from './backup-r2-checker.ts'
import { memoryRunLock, type RunLock } from './backup-safety.ts'

const now = Date.UTC(2026, 10, 2)
const response = (body: string, status = 200): Response => ({ status, body: Buffer.from(body), headers: {} })
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
const item = (key = 'object') => `<Contents><Key>${escape(key)}</Key><Size>7</Size><LastModified>${new Date(now).toISOString()}</LastModified></Contents>`
const page = (entries: string[], truncated = false, token?: string) => `<ListBucketResult><KeyCount>${entries.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${token === undefined ? '' : `<NextContinuationToken>${escape(token)}</NextContinuationToken>`}${entries.join('')}</ListBucketResult>`
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'backup-adapter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function sharedRunner() {
  const objects = new Map<string, Buffer>(), calls: Request[] = []
  const run: Runner = async r => {
    calls.push(r)
    if (r.method === 'PUT') {
      if (r.headers['if-none-match'] === '*' && objects.has(r.key)) return response('', 412)
      objects.set(r.key, r.body!); return { ...response(''), headers: { etag: sha256(r.body!) } }
    }
    if (r.method === 'GET') {
      const body = objects.get(r.key)
      if (!body) return response('', 404)
      const etag = sha256(body)
      return { ...response(body.toString(), r.headers['if-match'] === etag ? 200 : 412), headers: { etag } }
    }
    if (r.method === 'DELETE') { objects.delete(r.key); return response('', 204) }
    throw new Error('Unexpected request')
  }
  return { run, objects, calls }
}
function options() {
  const events: string[] = [], bucket = new FakeBucket(() => now)
  return { events, bucket, backups: bucket, images: { list: async (): Promise<ObjectInfo[]> => [] }, now: () => now,
    notify: async (event: string) => { events.push(event) }, usage: { read: async () => ({ classA: 0, classB: 0 }) } }
}
function seed(bucket: FakeBucket, capture: number, restored = false, uploaded = capture) {
  const body = Buffer.from('cipher'), captureTime = new Date(capture).toISOString()
  const manifest = Buffer.from(JSON.stringify({ formatVersion: 1, captureTime, postgresMajor: 18,
    plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: body.length, sha256: sha256(body) }, recipientFingerprint: sha256('test') }))
  const prefix = `${restored ? 'restore-verified' : 'backups'}/${captureTime}${restored ? '' : '-test'}/`
  for (const [name, bytes] of [['archive.dump.age', body], ['manifest.json', manifest],
    ['verified.json', Buffer.from(JSON.stringify({ manifestSha256: sha256(manifest), verifiedTime: captureTime }))]] as const) {
    bucket.objects.set(prefix + name, { body: bytes, uploaded })
  }
  return prefix
}
function prunableOptions() {
  const o = options()
  for (let i = 0; i < 30; i++) seed(o.bucket, now - i * day)
  const protectedSource = seed(o.bucket, now - 70 * day)
  const candidate = seed(o.bucket, now - 80 * day)
  seed(o.bucket, now - 70 * day, true, now - day)
  return { ...o, protectedSource, candidate }
}

test('healthy fresh inventory prunes an unlocked candidate and preserves the latest drilled source', async () => {
  const o = prunableOptions()
  assert.equal((await inventory(o.bucket, now)).verified.filter(g => g.prefix.startsWith('backups/')).length, 32)
  const result = await checkBackups({ ...o, state: {}, lock: memoryRunLock() })
  assert.deepEqual(result.alerts, [])
  assert.deepEqual(result.deleted, [o.candidate])
  assert.equal(o.bucket.calls.filter(c => c.startsWith('DELETE')).length, 3)
  assert.ok(o.bucket.objects.has(o.protectedSource + 'verified.json'))
})

test('listing follows opaque continuation tokens and returns every page with decoded keys', async () => {
  const calls: Request[] = [], token = 'opaque+/=&<token'
  const run: Runner = async r => { calls.push(r); return response(calls.length === 1 ? page([item('one&<')], true, token) : page([item('two')])) }
  assert.deepEqual((await objectTransport(run).list()).map(o => o.key), ['one&<', 'two'])
  assert.equal(calls[0].query?.['list-type'], '2')
  assert.equal(calls[1].query?.['continuation-token'], token)
})

test('listing fails closed on missing repeated inconsistent tokens and a page cap', async () => {
  const malformed = [page([item()], true), page([item()], true, ''), page([item()], false, 'unexpected'),
    page([], true, 'token'), page([item()]).replace('<KeyCount>1', '<KeyCount>2'),
    page([item()]).replace('false', 'maybe'), page([item()]).replace('</ListBucketResult>', '<ContinuationToken>wrong</ContinuationToken></ListBucketResult>')]
  for (const body of malformed) await assert.rejects(listObjects(async () => response(body)))
  await assert.rejects(listObjects(async () => response(page([item()], true, 'token')), 1), /cap/)
  let n = 0
  await assert.rejects(listObjects(async () => response(page([item(String(++n))], true, 'same'))), /repeated/)
  n = 0
  await assert.rejects(listObjects(async () => response(page([item()], ++n === 1, n === 1 ? 'next' : undefined))), /object/)
  await assert.rejects(listObjects(async () => response('', 503)), /failed/)
})

test('listing rejects malformed XML unsafe entities invalid metadata and truncated response', async () => {
  for (const body of ['<!DOCTYPE x [<!ENTITY secret SYSTEM "private">]>' + page([item()]), page([item()]).slice(0, -1),
    page([item()]).replace('<Size>7', '<Size>-1'), page([item()]).replace('<Size>7', '<Size>9007199254740992'),
    page([item()]).replace('object', '&unknown;'), page([item()]).replace('object', 'bad&entity'),
    page([item()]).replace(new Date(now).toISOString(), 'invalid'), page([item()]).replace('</Key>', '</Size>')]) {
    await assert.rejects(listObjects(async () => response(body)))
  }
  await assert.rejects(listObjects(async () => response(page([])), 0))
  assert.deepEqual(await listObjects(async () => response(page([item(runLockKey)]))), [])
})

test('a failed pagination page aborts the checker before any pruning and emits only a fixed failure event', async () => {
  const o = options()
  o.backups.list = () => listObjects(async () => response(page([item()], true)), 1)
  await assert.rejects(checkBackups({ ...o, lock: memoryRunLock(), state: {} }), { message: 'Checker failed (diagnostics suppressed)' })
  assert.deepEqual(o.events, ['checker-failed'])
  assert.ok(!o.bucket.calls.some(call => call.startsWith('DELETE')))
})

test('account analytics sums the whole month across actions without a bucket filter', async () => {
  const requests: { query: string; variables: Record<string, string> }[] = []
  const account = randomUUID()
  const client = accountUsage({ query: async r => {
    requests.push(r)
    return { data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'PutObject' }, sum: { requests: 350_000 } },
      { dimensions: { actionType: 'ListObjectsV2' }, sum: { requests: 1 } },
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 3_500_000 } },
      { dimensions: { actionType: 'DeleteObject' }, sum: { requests: 100 } },
    ] }] } } }
  } }, account)
  assert.deepEqual(await client.read(now + day), { classA: 700_002, classB: 7_000_000 })
  assert.equal(requests.length, 2)
  assert.ok(requests.every(r => r.variables.account === account && !r.query.includes('bucket')))
  assert.ok(requests.every(r => /groupBy:\s*\[actionType\]/.test(r.query)))
  assert.equal(requests[0].variables.start, '2026-11-01T00:00:00.000Z')
  assert.equal(requests[1].variables.end, '2026-11-03T00:00:00.000Z')
})

test('failed incomplete capped and unknown analytics are unavailable instead of zero', async () => {
  const group = { dimensions: { actionType: 'GetObject' }, sum: { requests: 1 } }
  for (const payload of [null, {}, { errors: [{ message: 'PRIVATE_SENTINEL' }] },
    ...[[], [{ ...group, sum: { requests: -1 } }], [{ ...group, sum: { requests: 0.5 } }],
      [{ ...group, dimensions: { actionType: 'UnknownAction' } }], [group, group], Array(1000).fill(group)].map(groups => ({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: groups }] } } }))]) {
    await assert.rejects(accountUsage({ query: async () => payload }, randomUUID()).read(now), { message: 'Account operation usage unavailable' })
  }
  await assert.rejects(accountUsage({ query: async () => { throw new Error('PRIVATE_SENTINEL') } }, randomUUID()).read(now), { message: 'Account operation usage unavailable' })
})

test('analytics transport keeps private configuration and query out of argv and suppresses raw failures', async t => {
  const root = fixture(t), config = join(root, 'config'), account = randomUUID()
  writeFileSync(config, '', { mode: 0o600 })
  const requests: { args: string[]; input: string }[] = []
  const client = await analyticsClient(config, async (args, input) => {
    requests.push({ args, input })
    writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ data: 'test' }))
  })
  assert.deepEqual(await client.query({ query: 'query test', variables: { account } }), { data: 'test' })
  assert.ok(!requests[0].args.join().includes(account))
  assert.ok(!requests[0].args.includes('query test'))
  assert.equal(JSON.parse(requests[0].input).variables.account, account)
  assert.ok(requests[0].args.includes('--fail') && requests[0].args.includes('--max-time'))
  assert.deepEqual(readdirSync(root), ['config'])
  const failed = await analyticsClient(config, async () => { throw new Error('PRIVATE_SENTINEL') })
  await assert.rejects(failed.query({ query: '', variables: {} }), { message: 'Account operation usage unavailable' })
  const malformed = await analyticsClient(config, async args => writeFileSync(args[args.indexOf('--output') + 1], 'PRIVATE_SENTINEL'))
  await assert.rejects(malformed.query({ query: '', variables: {} }), { message: 'Account operation usage unavailable' })
  chmodSync(config, 0o644)
  await assert.rejects(analyticsClient(config), /Private external/)
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

test('shared conditional lock refuses overlapping backup checker and stale locks', async t => {
  const root = fixture(t), shared = sharedRunner(), lock = bucketRunLock(shared.run), o = options()
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>(r => { enter = r }), waiting = new Promise<void>(r => { finish = r })
  const active = lock(async () => { enter(); await waiting })
  await entered
  await assert.rejects(runBackup({ directory: root, recipient: 'test', bucket: o.bucket, now: () => now, notify: o.notify, lock: bucketRunLock(shared.run), dump: () => assert.fail('must not dump') }), /Backup failed/)
  await assert.rejects(runChecker({ ...o, store: fileStateStore(join(root, 'state')), lock: bucketRunLock(shared.run) }), /Checker failed/)
  assert.deepEqual(o.bucket.calls, [])
  finish(); await active
  assert.equal(shared.objects.size, 0)
  shared.objects.set(runLockKey, Buffer.from('stale'))
  await assert.rejects(bucketRunLock(shared.run)(async () => assert.fail('must not take over')), /busy/)
  assert.ok(shared.objects.has(runLockKey))
  assert.equal(shared.calls.filter(r => r.method === 'DELETE').length, 1)
})

test('lock is released after work failure but uncertain acquisition never releases another owner', async () => {
  const shared = sharedRunner(), lock = bucketRunLock(shared.run)
  await assert.rejects(lock(async () => { throw new Error('work failed') }), /work failed/)
  assert.equal(shared.objects.size, 0)
  let deletes = 0
  const uncertain: Runner = async r => { if (r.method === 'DELETE') deletes++; throw new Error('PRIVATE_SENTINEL') }
  await assert.rejects(bucketRunLock(uncertain)(async () => assert.fail('must not run')), { message: 'stage=lock category=operation' })
  assert.equal(deletes, 0)
  await assert.rejects(bucketRunLock(async r => r.method === 'PUT' ? response('') : response('', 503))(async () => {}), /stage=lock category=operation/)
})

test('daily backup holds the global lock through recheck dump upload and cleanup', async t => {
  const root = fixture(t), shared = sharedRunner(), o = options(), source = join(root, 'source')
  writeFileSync(source, 'dump')
  const head = o.bucket.head.bind(o.bucket)
  o.bucket.head = async key => { assert.ok(shared.objects.has(runLockKey)); return head(key) }
  await dailyBackup({ directory: root, recipient: 'test', bucket: o.bucket, now: () => now, notify: o.notify, lock: bucketRunLock(shared.run),
    dump: (_directory, capture) => { assert.ok(shared.objects.has(runLockKey)); capture(); return source },
    encrypt: (_source, target) => writeFileSync(target, 'cipher') })
  assert.equal(shared.objects.size, 0)
  assert.deepEqual(readdirSync(root), ['source'])
  assert.deepEqual(shared.calls.slice(-2).map(r => r.method), ['GET', 'DELETE'])
  assert.equal(shared.calls.at(-2)?.headers['if-match'], sha256(shared.calls[0].body!))
})

test('curl encodes list tokens and never retries lock acquisition or deletion', async t => {
  const root = fixture(t), config = join(root, 'config')
  writeFileSync(config, '', { mode: 0o600 })
  const requests: { args: string[]; input: string }[] = []
  const run = await curlRunner(config, 'https://' + randomUUID(), async (args, input) => {
    requests.push({ args, input })
    writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 200 OK\r\n\r\n')
    writeFileSync(args[args.indexOf('--output') + 1], '')
  })
  await run({ method: 'GET', key: '', query: { 'list-type': '2', 'continuation-token': '+/=&' }, headers: {} })
  assert.ok(requests[0].input.includes('continuation-token=%2B%2F%3D%26'))
  for (const method of ['PUT', 'DELETE'] as const) await run({ method, key: runLockKey, headers: {} })
  for (const r of requests.slice(1)) {
    assert.equal(r.args[r.args.indexOf('--retry') + 1], '0')
    assert.ok(!r.args.includes('--retry-all-errors'))
    assert.ok(!r.args.includes(requests[0].input))
  }
})

const scopes = ['<Prefix>backups/</Prefix>', '<StartAfter>offset</StartAfter>', '<Delimiter>/</Delimiter>',
  '<CommonPrefixes><Prefix>backups/</Prefix></CommonPrefixes>', '<EncodingType>url</EncodingType>',
  '<Prefix/><Prefix/>', '<StartAfter/><StartAfter/>', '<Delimiter/><Delimiter/>']
const withScope = (body: string, scope: string) => body.replace('</ListBucketResult>', scope + '</ListBucketResult>')

test('listing rejects filtering grouping encoding and scope changes on every page', async () => {
  for (const scope of scopes) {
    await assert.rejects(listObjects(async () => response(withScope(page([item()]), scope))), /listing/)
    let calls = 0
    await assert.rejects(listObjects(async () => response(++calls === 1
      ? withScope(page([item('one')], true, 'next'), '<Prefix/><Delimiter/>')
      : withScope(page([item('two')]), scope))), /listing/)
    assert.equal(calls, 2)
  }
  assert.equal((await listObjects(async () => response(withScope(page([item()]), '<Prefix/><Delimiter/><StartAfter/>')))).length, 1)
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

for (const entry of ['backup', 'daily', 'checker'] as const) {
  for (const failure of ['busy', 'uncertain', 'release'] as const) {
    for (const notifierFails of [false, true]) {
      test(`${entry} reports ${failure} lock failure with notifier failure=${notifierFails} without retries`, async t => {
        const root = fixture(t), o = options(), shared = sharedRunner(), source = join(root, 'source')
        writeFileSync(source, 'dump')
        let work = 0
        const calls: Request[] = []
        const lock = bucketRunLock(async r => {
          calls.push(r)
          if (r.method === 'PUT' && failure === 'busy') return response('', 412)
          if (r.method === 'PUT' && failure === 'uncertain') throw new Error('PRIVATE_SENTINEL')
          if (r.method === 'DELETE' && failure === 'release') return response('', 503)
          return shared.run(r)
        })
        const notify = async (event: string) => {
          o.events.push(event)
          if (notifierFails) throw new Error('PRIVATE_SENTINEL')
        }
        const backupOptions = { directory: root, recipient: 'test', bucket: o.bucket, now: o.now, notify, lock,
          dump: (_directory: string, capture: () => void) => { work++; capture(); return source },
          encrypt: (_source: string, target: string) => writeFileSync(target, 'cipher') }
        const run = () => entry === 'checker' ? runChecker({ ...o, notify, lock,
          store: { load: async () => { work++; return { state: { sentAlerts: [] } } }, save: async () => {} } })
          : entry === 'daily' ? dailyBackup(backupOptions) : runBackup(backupOptions)
        const event = entry === 'checker' ? 'checker-failed' : 'backup-failed'
        await assert.rejects(run(), { message: entry === 'checker' ? 'Checker failed (diagnostics suppressed)' : 'Backup failed (diagnostics suppressed)' })
        assert.equal(o.events.filter(e => e === event).length, 1)
        assert.ok(!o.events.join().includes('PRIVATE_SENTINEL'))
        assert.equal(calls.filter(r => r.method === 'PUT').length, 1)
        assert.equal(calls.filter(r => r.method === 'DELETE').length, failure === 'release' ? 1 : 0)
        assert.equal(work, failure === 'release' ? 1 : 0)
        if (failure !== 'release') assert.deepEqual(o.bucket.calls, [])
      })
    }
  }
}

for (const entry of ['backup', 'daily'] as const) {
  for (const failure of ['cleanup', 'local-release'] as const) {
    for (const notifierFails of [false, true]) {
      test(`${entry} reports ${failure} failure with notifier failure=${notifierFails} and releases shared lock`, async t => {
        const root = fixture(t), o = options(), shared = sharedRunner(), source = join(root, 'source')
        writeFileSync(source, 'dump')
        const remove = fsPromises.rm
        let cleanups = 0
        t.mock.method(fsPromises, 'rm', async (target: Parameters<typeof remove>[0], options: Parameters<typeof remove>[1]) => {
          if (failure === 'cleanup' && String(target).startsWith(join(root, '.partial-age-'))) {
            cleanups++; throw new Error('PRIVATE_SENTINEL')
          }
          return remove(target, options)
        })
        syncBuiltinESMExports()
        const backupOptions = { directory: root, recipient: 'test', bucket: o.bucket, now: o.now, lock: bucketRunLock(shared.run),
          notify: async (event: string) => { o.events.push(event); if (notifierFails) throw new Error('PRIVATE_SENTINEL') },
          dump: (_directory: string, capture: () => void) => { capture(); return source },
          encrypt: (_source: string, target: string) => {
            writeFileSync(target, 'cipher')
            if (failure === 'local-release') {
              const path = join(root, '.backup-run.lock')
              rmSync(path); mkdirSync(path); writeFileSync(join(path, 'preserve'), '')
            }
          } }
        try {
          await assert.rejects(entry === 'daily' ? dailyBackup(backupOptions) : runBackup(backupOptions), { message: 'Backup failed (diagnostics suppressed)' })
        } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
        assert.equal(cleanups, failure === 'cleanup' ? 1 : 0)
        assert.equal(o.events.filter(e => e === 'backup-failed').length, 1)
        assert.equal(shared.calls.filter(r => r.method === 'PUT').length, 1)
        assert.equal(shared.calls.filter(r => r.method === 'DELETE').length, 1)
        assert.equal(shared.objects.size, 0)
      })
    }
  }
}

for (const notifierFails of [false, true]) {
  test(`checker reports local state cleanup failure with notifier failure=${notifierFails} and releases shared lock`, async t => {
    const root = fixture(t), o = prunableOptions(), shared = sharedRunner(), path = join(root, 'state')
    await fileStateStore(path).save({ sentAlerts: [], aliveDate: '2026-11-02' })
    const remove = fsPromises.rm
    let cleanups = 0
    t.mock.method(fsPromises, 'rm', async (target: Parameters<typeof remove>[0], options: Parameters<typeof remove>[1]) => {
      if (String(target).startsWith(join(root, '.checker-state-'))) { cleanups++; throw new Error('PRIVATE_SENTINEL') }
      return remove(target, options)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(runChecker({ ...o, lock: bucketRunLock(shared.run), store: fileStateStore(path),
        notify: async event => { o.events.push(event); if (notifierFails) throw new Error('PRIVATE_SENTINEL') } }),
      { message: 'Checker failed (diagnostics suppressed)' })
    } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
    assert.equal(cleanups, 1)
    assert.equal(o.events.filter(e => e === 'checker-failed').length, 1)
    assert.equal(shared.calls.filter(r => r.method === 'DELETE').length, 1)
    assert.equal(shared.objects.size, 0)
  })
}

test('release verifies the acquired version and owner token and never deletes a successor lock', async t => {
  for (const mismatch of ['etag', 'token'] as const) {
    const root = fixture(t), o = options(), shared = sharedRunner()
    const run: Runner = async r => {
      if (r.method === 'GET' && mismatch === 'token') {
        // Even a provider ignoring the conditional must not bypass token checking.
        return { ...response('successor'), headers: { etag: sha256(shared.calls[0].body!) } }
      }
      return shared.run(r)
    }
    const lock: RunLock = work => bucketRunLock(run)(async () => {
      const result = await work()
      shared.objects.set(runLockKey, Buffer.from('successor'))
      return result
    })
    await assert.rejects(runChecker({ ...o, lock, store: fileStateStore(join(root, 'state')) }), { message: 'Checker failed (diagnostics suppressed)' })
    assert.equal(shared.objects.get(runLockKey)?.toString(), 'successor')
    assert.equal(shared.calls.filter(r => r.method === 'DELETE').length, 0)
    assert.equal(o.events.filter(e => e === 'checker-failed').length, 1)
  }
})

test('missing acquisition ETag or uncertain owner verification refuses lock deletion', async () => {
  for (const failure of ['missing-etag', 'get-failed', 'get-uncertain'] as const) {
    const shared = sharedRunner(), calls: Request[] = []
    const lock = bucketRunLock(async r => {
      calls.push(r)
      if (r.method === 'GET') {
        if (failure === 'get-failed') return response('', 503)
        if (failure === 'get-uncertain') throw new Error('PRIVATE_SENTINEL')
      }
      const result = await shared.run(r)
      return r.method === 'PUT' && failure === 'missing-etag' ? { ...result, headers: {} } : result
    })
    await assert.rejects(lock(async () => {}), { message: 'stage=lock category=operation' })
    assert.ok(shared.objects.has(runLockKey))
    assert.equal(calls.filter(r => r.method === 'PUT').length, 1)
    assert.equal(calls.filter(r => r.method === 'GET').length, failure === 'missing-etag' ? 0 : 1)
    assert.equal(calls.filter(r => r.method === 'DELETE').length, 0)
  }
})

test('FIFO state is promptly refused without pruning and the checker lock is released', t => {
  const root = fixture(t), path = join(root, 'state'), o = prunableOptions()
  const fifo = spawnSync('mkfifo', ['-m', '600', path], { stdio: 'ignore' })
  assert.equal(fifo.status, 0)
  const script = `
    import { readFileSync } from 'node:fs';
    import { FakeBucket } from './scripts/backup-r2-fake.ts';
    import { bucketRunLock } from './scripts/backup-r2.ts';
    import { sha256 } from './scripts/backup-r2-model.ts';
    import { runChecker } from './scripts/backup-r2-checker.ts';
    import { fileStateStore } from './scripts/backup-r2-state.ts';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const bucket = new FakeBucket(() => input.now), events = [];
    for (const [key, value] of input.objects) bucket.objects.set(key, { ...value, body: Buffer.from(value.body, 'base64') });
    let released = 0, acquired = 0, error, owner;
    const lock = bucketRunLock(async request => {
      if (request.method === 'PUT') { acquired++; owner = request.body; return { status: 200, headers: { etag: sha256(owner) }, body: Buffer.alloc(0) } }
      if (request.method === 'GET') return { status: request.headers['if-match'] === sha256(owner) ? 200 : 412, headers: { etag: sha256(owner) }, body: owner };
      if (request.method === 'DELETE') { released++; owner = undefined; return { status: 204, headers: {}, body: Buffer.alloc(0) } }
      throw new Error('Unexpected request');
    });
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
