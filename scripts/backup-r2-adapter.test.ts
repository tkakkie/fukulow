import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { FakeBucket } from './backup-r2-fake.ts'
import { day, type ObjectInfo } from './backup-r2-model.ts'
import { listObjects, runLockKey } from './backup-r2-list.ts'
import { bucketRunLock, curlRunner, dailyBackup, objectTransport, runBackup, type Request, type Response, type Runner } from './backup-r2.ts'
import { accountUsage, analyticsClient } from './backup-r2-usage.ts'
import { fileStateStore } from './backup-r2-state.ts'
import { checkBackups, runChecker } from './backup-r2-checker.ts'
import { memoryRunLock } from './backup-safety.ts'

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
      objects.set(r.key, r.body!); return response('')
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
    const o = options()
    const result = await checkBackups({ ...o, usage: { read }, state: {}, lock: memoryRunLock() })
    assert.ok(result.alerts.includes('operations-unknown'))
    assert.ok(result.alerts.includes('pruning-refused'))
    assert.deepEqual(result.deleted, [])
    const alive = JSON.parse(o.events.find(e => e.includes('checker-alive'))!)
    assert.equal(alive.operations, null)
    assert.ok(!o.events.join().includes('PRIVATE_SENTINEL'))
  }
})

test('checker atomically persists private state and dedup across fresh checker instances', async t => {
  const root = fixture(t), path = join(root, 'state'), o = options(), lock = memoryRunLock()
  const first = await runChecker({ ...o, store: fileStateStore(path), lock })
  assert.ok(first.alerts.includes('state-missing'))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.ok(first.alerts.includes('pruning-refused'))
  o.events.length = 0
  await runChecker({ ...o, store: fileStateStore(path), lock })
  assert.deepEqual(o.events, [])
  assert.equal(readdirSync(root).length, 1)
  const loaded = await fileStateStore(path).load()
  assert.equal(loaded.state.aliveDate, '2026-11-02')
})

test('corrupt checker state alerts safely freezes pruning and replaces only a private regular file', async t => {
  const root = fixture(t), path = join(root, 'state'), o = options()
  for (const content of ['PRIVATE_SENTINEL', JSON.stringify({ version: 1, state: { sentAlerts: ['PRIVATE_SENTINEL'] } }),
    JSON.stringify({ version: 1, state: { sentAlerts: [], aliveDate: '2026-13-01' } }), 'x'.repeat(17_000)]) {
    writeFileSync(path, content, { mode: 0o600 })
    const result = await runChecker({ ...o, store: fileStateStore(path), lock: memoryRunLock() })
    assert.ok(result.alerts.includes('state-corrupt'))
    assert.deepEqual(result.deleted, [])
    assert.ok(!o.events.join().includes('PRIVATE_SENTINEL'))
    assert.equal((await fileStateStore(path).load()).warning, undefined)
  }
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
  await assert.rejects(runBackup({ directory: root, recipient: 'test', bucket: o.bucket, now: () => now, notify: o.notify, lock: bucketRunLock(shared.run), dump: () => assert.fail('must not dump') }), /stage=lock category=busy/)
  await assert.rejects(runChecker({ ...o, store: fileStateStore(join(root, 'state')), lock: bucketRunLock(shared.run) }), /stage=lock category=busy/)
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
