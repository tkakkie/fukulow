import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FakeBucket } from './backup-r2-fake.ts'
import { day, inventory, sha256, uploadGrace } from './backup-r2-model.ts'
import { publish } from './backup-r2.ts'
import { decodeState } from './backup-checker-state.ts'
import scheduled, { BackupChecker } from '../workers/backup-checker/index.ts'
import { CheckerLease, jobDeadline, leaseDuration, leaseKey, stateKey } from '../workers/backup-checker/lease.ts'
import { backupAdapter, imagesAdapter } from '../workers/backup-checker/r2.ts'
import { analyticsUsage, discordNotifier, type Fetch } from '../workers/backup-checker/http.ts'
import type { DurableStorage, Env, R2Binding, R2List, R2Object, StorageTransaction } from '../workers/backup-checker/bindings.ts'

const epoch = Date.UTC(2026, 10, 17, 12)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
class Storage implements DurableStorage {
  values = new Map<string, unknown>()
  writes: string[] = []
  before?: (op: string, key: string) => Promise<void>
  private tail = Promise.resolve()
  async get<T>(key: string): Promise<T | undefined> { await this.before?.('get', key); return structuredClone(this.values.get(key)) as T | undefined }
  async put<T>(key: string, value: T) { await this.before?.('put', key); this.values.set(key, structuredClone(value)); this.writes.push(key) }
  async delete(key: string) { await this.before?.('delete', key); this.writes.push(key); return this.values.delete(key) }
  async transaction<T>(body: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const prior = this.tail, done = deferred()
    this.tail = done.promise
    await prior
    const copy = new Map(structuredClone([...this.values])), writes: string[] = []
    const tx: StorageTransaction = {
      get: async <U>(key: string) => { await this.before?.('get', key); return structuredClone(copy.get(key)) as U | undefined },
      put: async (key, value) => { await this.before?.('put', key); copy.set(key, structuredClone(value)); writes.push(key) },
      delete: async key => { await this.before?.('delete', key); writes.push(key); return copy.delete(key) },
    }
    try {
      const result = await body(tx)
      this.values = copy; this.writes.push(...writes)
      return result
    } finally { done.resolve() }
  }
}
function seed(bucket: FakeBucket, capture: number, restored = false, uploaded = capture) {
  const captureTime = new Date(capture).toISOString(), body = Buffer.from('cipher')
  const manifest = { formatVersion: 1 as const, captureTime, postgresMajor: 18,
    plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: body.length, sha256: sha256(body) }, recipientFingerprint: sha256('public') }
  const json = Buffer.from(JSON.stringify(manifest)), prefix = `${restored ? 'restore-verified' : 'backups'}/${captureTime}${restored ? '' : '-test'}/`
  for (const [name, bytes] of [['archive.dump.age', body], ['manifest.json', json],
    ['verified.json', Buffer.from(JSON.stringify({ manifestSha256: sha256(json), verifiedTime: captureTime }))]] as const) {
    bucket.objects.set(prefix + name, { body: bytes, uploaded })
  }
  return prefix
}
class Binding implements R2Binding {
  bucket: FakeBucket
  pageSize = 1000
  before?: (op: string, key: string) => Promise<void>
  lists: { limit: number; cursor?: string }[] = []
  constructor(bucket = new FakeBucket(() => epoch)) { this.bucket = bucket }
  object(key: string): R2Object | null {
    const object = this.bucket.info(key)
    return object ? { key, size: object.size, uploaded: new Date(object.uploaded),
      checksums: { sha256: Uint8Array.from(Buffer.from(object.checksum, 'base64')).buffer } } : null
  }
  async list(options: { limit: number; cursor?: string }): Promise<R2List> {
    this.lists.push(options)
    await this.before?.('list', '')
    const keys = [...this.bucket.objects.keys()].sort(), start = options.cursor ? keys.indexOf(options.cursor) + 1 : 0
    assert.ok(!options.cursor || start > 0)
    const page = keys.slice(start, start + Math.min(options.limit, this.pageSize))
    const truncated = start + page.length < keys.length
    return { objects: page.map(key => this.object(key)!), truncated, ...(truncated ? { cursor: page.at(-1) } : {}) }
  }
  async head(key: string) { await this.before?.('head', key); return this.object(key) }
  async get(key: string) {
    await this.before?.('get', key)
    const object = this.object(key)
    return object ? { ...object, arrayBuffer: async () => Uint8Array.from(await this.bucket.get(key)).buffer } : null
  }
  async delete(key: string) { await this.before?.('delete', key); await this.bucket.delete(key) }
}
function cachedUsage(now = epoch) {
  const month = new Date(now).toISOString().slice(0, 7), days: Record<string, { classA: number; classB: number }> = {}
  for (let time = Date.parse(month + '-01'); time + day + 6 * 60 * 60 * 1000 <= now; time += day) {
    days[new Date(time).toISOString().slice(0, 10)] = { classA: 0, classB: 1 }
  }
  return { month, days }
}
function fixture() {
  let now = epoch
  const clock = () => now, storage = new Storage(), binding = new Binding(new FakeBucket(clock))
  for (let i = 0; i < 30; i++) seed(binding.bucket, epoch - i * day)
  const source = seed(binding.bucket, epoch - 70 * day), candidate = seed(binding.bucket, epoch - 80 * day)
  const drill = seed(binding.bucket, epoch - 70 * day, true, epoch - day)
  storage.values.set(stateKey, { version: 1, state: { sentAlerts: [], aliveDate: '2026-11-17', usageCache: cachedUsage() } })
  const events: string[] = [], requests: { url: string; init?: RequestInit }[] = []
  const request: Fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('notify.invalid')) {
      events.push(JSON.parse(String(init?.body)).content)
      return new Response(null, { status: 204 })
    }
    return Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 1 } },
    ] }] } } })
  }
  const env: Env = { BACKUPS: binding, IMAGES: { list: async () => ({ objects: [], truncated: false }) },
    DISCORD_WEBHOOK_URL: 'https://notify.invalid/', ANALYTICS_URL: 'https://analytics.invalid/', ANALYTICS_TOKEN: 'test-only', ANALYTICS_ACCOUNT: 'test-only',
    CHECKER: { idFromName: () => { throw new Error('unused') }, get: () => { throw new Error('unused') } } }
  const create = () => new BackupChecker({ storage }, env, { now: clock, request })
  return { storage, binding, env, events, requests, clock, advance: (ms: number) => { now += ms }, create, source, candidate, drill }
}
const noGuard = async () => {}

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

test('DO state missing or corrupt alerts and freezes then retry recovers with persisted dedup', async () => {
  for (const value of [undefined, null, { version: 2, state: { sentAlerts: [] } },
    { version: 1, state: { sentAlerts: ['PRIVATE_SENTINEL'] } }, { version: 1, state: { sentAlerts: [], aliveDate: '2026-13-01' } }]) {
    const f = fixture()
    if (value === undefined) f.storage.values.delete(stateKey)
    else f.storage.values.set(stateKey, value)
    assert.equal((await f.create().fetch()).status, 204)
    assert.ok(f.events.some(e => e.includes(value === undefined ? 'state-missing' : 'state-corrupt')))
    assert.ok(f.events.some(e => e.includes('pruning-refused')))
    assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
    assert.equal(decodeState(f.storage.values.get(stateKey)).warning, undefined)
    const count = f.events.length
    assert.equal((await f.create().fetch()).status, 204)
    assert.equal(f.events.length, count)
    for (let i = 0; i < 5; i++) assert.equal((await f.create().fetch()).status, 204)
    assert.equal(f.binding.bucket.objects.has(f.candidate + 'verified.json'), false)
    assert.ok(!f.events.join().includes('PRIVATE_SENTINEL'))
  }
})

test('DO crash mid-prune leaves marker absent valid state and a frozen safe recovery', async () => {
  const f = fixture(), entered = deferred(), resume = deferred(), checker = f.create()
  f.binding.before = async (op, key) => { if (op === 'delete' && key === f.candidate + 'manifest.json') { entered.resolve(); await resume.promise } }
  const dying = checker.fetch(); await entered.promise
  assert.equal(f.binding.bucket.objects.has(f.candidate + 'verified.json'), false)
  assert.ok(f.binding.bucket.objects.has(f.candidate + 'manifest.json'))
  assert.equal(decodeState(f.storage.values.get(stateKey)).warning, undefined)
  f.advance(leaseDuration)
  // Restart while the dead instance's already-issued R2 deletion is still in
  // flight. Recovery must freeze even before that remote operation settles.
  f.binding.before = undefined
  assert.equal((await f.create().fetch()).status, 204)
  assert.ok(f.events.some(e => e.includes('malformed-generations')))
  assert.ok(f.events.some(e => e.includes('pruning-refused')))
  const recovered = structuredClone(f.storage.values.get(stateKey))
  resume.resolve(); assert.equal((await dying).status, 500)
  assert.deepEqual(f.storage.values.get(stateKey), recovered)
  assert.ok(f.binding.bucket.objects.has(f.candidate + 'archive.dump.age'))
  assert.ok(f.binding.bucket.objects.has(f.source + 'verified.json'))
  assert.ok(f.binding.bucket.objects.has(f.drill + 'verified.json'))
  assert.equal((await inventory(f.binding.bucket, f.clock())).verified.filter(g => g.prefix.startsWith('backups/')).length, 31)
})

test('grace uses newest upload time just under and at six hours in both namespaces', async () => {
  for (const restored of [false, true]) for (const age of [uploadGrace - 1, uploadGrace]) {
    const f = fixture(), prefix = seed(f.binding.bucket, epoch - 100 * day, restored, epoch - age)
    f.binding.bucket.objects.delete(prefix + 'verified.json')
    // A later manifest upload resets grace even with a very old capture/archive.
    f.binding.bucket.objects.get(prefix + 'archive.dump.age')!.uploaded = epoch - 101 * day
    const data = await inventory(f.binding.bucket, epoch)
    assert.deepEqual(data.inProgress, age < uploadGrace ? [prefix] : [])
    assert.deepEqual(data.malformed, age < uploadGrace ? [] : [prefix])
    assert.ok(!data.verified.some(g => g.prefix === prefix))
    assert.equal((await f.create().fetch()).status, 204)
    assert.equal(f.events.some(e => e.includes('malformed-generations')), age >= uploadGrace)
    assert.equal(f.binding.bucket.objects.has(f.candidate + 'verified.json'), age >= uploadGrace)
    assert.ok(f.binding.bucket.objects.has(prefix + 'archive.dump.age'))
  }
})

test('unfinished generations never satisfy RPO or thirty count and never become prune candidates', async () => {
  for (const stale of [false, true]) {
    const f = fixture()
    f.binding.bucket.objects.clear()
    for (let i = 0; i < 29; i++) seed(f.binding.bucket, epoch - (i + (stale ? 1 : 0)) * day)
    const prefix = seed(f.binding.bucket, epoch + 1000, false, epoch)
    f.binding.bucket.objects.delete(prefix + 'verified.json')
    assert.equal((await f.create().fetch()).status, 204)
    assert.ok(f.events.some(e => e.includes('insufficient-generations')))
    assert.equal(f.events.some(e => e.includes('stale-backup')), stale)
    assert.ok(!f.events.some(e => e.includes('malformed-generations')))
    assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
  }
})

test('VPS upload and retry can progress concurrently with the checker without verification anomaly or pruning', async () => {
  const f = fixture(), body = Buffer.from('cipher'), entered = deferred(), finish = deferred()
  let attempt = 0
  // The first suffix is abandoned; the second is suspended between archive and
  // manifest publication while the independent DO lists the bucket.
  const upload = publish({ bucket: { ...f.binding.bucket,
    put: f.binding.bucket.put.bind(f.binding.bucket), get: f.binding.bucket.get.bind(f.binding.bucket),
    head: async key => {
      if (key.includes('-attempt1/')) return null
      if (key.endsWith('archive.dump.age')) { entered.resolve(); await finish.promise }
      return f.binding.bucket.head(key)
    } }, ciphertext: body, manifest: { formatVersion: 1, captureTime: new Date(epoch).toISOString(), postgresMajor: 18,
    plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: body.length, sha256: sha256(body) }, recipientFingerprint: sha256('public') },
    now: f.clock, attempt: () => `attempt${++attempt}` })
  await entered.promise
  assert.equal((await f.create().fetch()).status, 204)
  let data = await inventory(f.binding.bucket, epoch)
  assert.equal(data.inProgress.length, 2)
  assert.equal(data.verified.filter(g => g.prefix.startsWith('backups/')).length, 31)
  assert.deepEqual(data.malformed, [])
  assert.ok(!f.events.some(e => e.includes('malformed-generations')))
  for (const prefix of data.inProgress) assert.ok(f.binding.bucket.objects.has(prefix + 'archive.dump.age'))
  finish.resolve(); const prefix = await upload
  data = await inventory(f.binding.bucket, epoch)
  assert.ok(data.verified.some(g => g.prefix === prefix))
  assert.equal(data.inProgress.length, 1)
  assert.equal((await f.create().fetch()).status, 204)
})

test('R2 binding follows all cursors and fails closed on inconsistent truncation metadata or pages', async () => {
  const f = fixture(); f.binding.pageSize = 7
  const objects = await backupAdapter(f.binding, noGuard).list()
  assert.equal(objects!.length, f.binding.bucket.objects.size)
  assert.ok(f.binding.lists.length > 1)
  assert.equal(f.binding.lists[0].cursor, undefined)
  assert.ok(f.binding.lists.slice(1).every(page => !!page.cursor))
  const object = f.binding.object([...f.binding.bucket.objects.keys()][0])!
  const bad: R2List[] = [
    { objects: [object], truncated: true }, { objects: [object], truncated: true, cursor: '' },
    { objects: [], truncated: true, cursor: 'next' }, { objects: [object], truncated: false, cursor: 'next' },
    { objects: [object], truncated: false, delimitedPrefixes: ['backups/'] },
    { objects: [object, object], truncated: false },
    { objects: [{ ...object, size: -1 }], truncated: false },
    { objects: [{ ...object, uploaded: new Date(NaN) }], truncated: false },
    { objects: [{ ...object, checksums: { sha256: new ArrayBuffer(1) } }], truncated: false },
  ]
  for (const page of bad) {
    f.binding.list = async () => page
    await assert.rejects(imagesAdapter(f.binding, noGuard).list())
    assert.equal((await f.create().fetch()).status, 500)
  }
  let page = 0
  f.binding.list = async () => ({ objects: [{ ...object, key: String(++page) }], truncated: true, cursor: 'same' })
  await assert.rejects(imagesAdapter(f.binding, noGuard).list(), /cursor/)
  f.binding.list = async () => ({ objects: [object], truncated: true, cursor: 'one' })
  await assert.rejects(imagesAdapter(f.binding, noGuard, 1).list(), /cap/)
  page = 0
  f.binding.list = async () => { if (++page === 2) throw new Error('PRIVATE_SENTINEL'); return { objects: [object], truncated: true, cursor: 'next' } }
  assert.equal((await f.create().fetch()).status, 500)
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
})

test('R2 checker requires stored SHA256 HEAD checksums and reads only bounded JSON while images only list', async () => {
  const f = fixture(), bucket = backupAdapter(f.binding, noGuard)
  const head = f.binding.head.bind(f.binding)
  assert.equal((await bucket.head(f.candidate + 'archive.dump.age'))?.checksum, f.binding.bucket.info(f.candidate + 'archive.dump.age')?.checksum)
  await assert.rejects(bucket.get(f.candidate + 'archive.dump.age'))
  f.binding.head = async key => { const object = await head(key); return object ? { ...object, checksums: {} } : null }
  assert.equal((await f.create().fetch()).status, 204)
  assert.ok(f.events.some(e => e.includes('malformed-generations')))
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
  f.binding.head = head
  const get = f.binding.get.bind(f.binding)
  f.binding.get = async key => { const object = await get(key); return object ? { ...object, size: 16_385 } : null }
  await assert.rejects(bucket.get(f.candidate + 'manifest.json'))
  let listed = 0
  assert.deepEqual(await imagesAdapter({ list: async () => { listed++; return { objects: [], truncated: false } } }, noGuard).list(), [])
  assert.equal(listed, 1)
})

test('fetch Discord notifier shares fixed text bounds retries and caps Retry-After', async () => {
  for (const statuses of [[429, 503, 204], [503, 503, 503], [400], [0, 0, 0]]) {
    let calls = 0
    const delays: number[] = []
    const notify = discordNotifier('https://notify.invalid/', noGuard, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).content, 'Fukulow backup: checker-failed.')
      assert.deepEqual(JSON.parse(String(init?.body)).allowed_mentions, { parse: [] })
      assert.ok(init?.signal instanceof AbortSignal)
      const status = statuses[calls++]
      if (!status) throw new Error('PRIVATE_SENTINEL')
      return new Response(null, { status, headers: { 'retry-after': '9999' } })
    }, async ms => { delays.push(ms) })
    if (statuses.at(-1) === 204) await notify('checker-failed')
    else await assert.rejects(notify('checker-failed'), /Notification failed category=(unavailable|rejected)/)
    assert.equal(calls, statuses.length)
    assert.deepEqual(delays, statuses.slice(1).map((_, i) => statuses[i] ? 30_000 : 1000))
    await assert.rejects(notify('PRIVATE_SENTINEL'))
    assert.equal(calls, statuses.length)
  }
})

test('fetch analytics uses the shared account-wide parser and unknown usage freezes DO pruning', async () => {
  const f = fixture()
  const usage = analyticsUsage({ url: f.env.ANALYTICS_URL, account: f.env.ANALYTICS_ACCOUNT, token: f.env.ANALYTICS_TOKEN }, noGuard, async (url, init) => {
    assert.equal(String(url), f.env.ANALYTICS_URL)
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-only')
    const body = JSON.parse(String(init?.body))
    assert.ok(!body.query.includes('bucket'))
    assert.match(body.query, /groupBy: \[actionType\]/)
    return Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'PutObject' }, sum: { requests: 2 } },
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 3 } },
    ] }] } } })
  })
  assert.deepEqual(await usage.read(epoch, { usageCache: cachedUsage() }), { classA: 2, classB: 19 })
  f.env.ANALYTICS_TOKEN = ''
  assert.equal((await f.create().fetch()).status, 204)
  assert.ok(f.events.some(e => e.includes('operations-unknown')))
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
})

test('hourly schedule always calls one named SQLite DO and configuration enables no paid settings', async () => {
  const f = fixture(), names: string[] = [], checker = f.create()
  f.env.CHECKER = { idFromName: name => { names.push(name); return name }, get: id => {
    assert.equal(id, 'backup-checker')
    return { fetch: async request => { assert.equal(request.method, 'POST'); return checker.fetch() } }
  } }
  await scheduled.scheduled({}, f.env); await scheduled.scheduled({}, f.env)
  assert.deepEqual(names, ['backup-checker', 'backup-checker'])
  const config = readFileSync(new URL('../workers/backup-checker/wrangler.toml', import.meta.url), 'utf8')
  assert.match(config, /crons = \["0 \* \* \* \*"\]/)
  assert.match(config, /new_sqlite_classes = \["BackupChecker"\]/)
  assert.doesNotMatch(config, /account_id|script_name|nodejs_compat|usage_model|cpu_ms/)
  // The bound deliberately counts application row writes (including deletion).
  assert.ok(f.storage.writes.length <= 19 * 2)
  assert.ok(f.storage.values.size <= 2)
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

test('month end failures batch every active alert and reserve checker-failed within fifty external fetches', async () => {
  const f = fixture(), now = Date.UTC(2026, 9, 31, 12)
  f.advance(now - epoch)
  f.storage.values.set(stateKey, { version: 1, state: { sentAlerts: [] } })
  f.binding.bucket.objects.clear()
  for (let i = 0; i < 8; i++) seed(f.binding.bucket, now - (i + 2) * day)
  seed(f.binding.bucket, now - 50 * day, true)
  // Malformed inventory also contributes to capacity without allowing pruning.
  const alien = { key: 'unknown/object', size: 9_500_000_000, uploaded: new Date(now) }
  const list = f.binding.list.bind(f.binding)
  f.binding.list = async options => { const result = await list(options); result.objects.push(alien); return result }
  const requests: string[] = [], contents: string[] = []
  const request: Fetch = async (url, init) => {
    requests.push(String(url))
    if (String(url) === f.env.ANALYTICS_URL) return Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 1 } },
    ] }] } } })
    contents.push(JSON.parse(String(init?.body)).content)
    return new Response(null, { status: 503, headers: { 'retry-after': '0' } })
  }
  const checker = new BackupChecker({ storage: f.storage }, f.env, { now: f.clock, request })
  assert.equal((await checker.fetch()).status, 500)
  assert.equal(requests.filter(url => url === f.env.ANALYTICS_URL).length, 4)
  assert.equal(contents.length, 6)
  assert.ok(requests.length <= 50)
  assert.equal(new Set(contents.slice(0, 3)).size, 1)
  for (const event of ['malformed-generations', 'stale-backup', 'insufficient-generations', 'drill-overdue',
    'capacity-70', 'capacity-90', 'operations-unknown', 'pruning-refused', 'checker-alive']) assert.ok(contents[0].includes(event), event)
  assert.deepEqual(contents.slice(3), Array(3).fill('Fukulow backup: checker-failed.'))
  assert.ok(!f.binding.bucket.calls.some(call => call.startsWith('DELETE')))
  const state = decodeState(f.storage.values.get(stateKey)).state
  assert.deepEqual(state.sentAlerts, [])
  assert.equal(state.aliveDate, undefined)
  assert.equal(Object.keys(state.usageCache!.days).length, 3)
})

test('Worker batches all supported alerts with alive and preserves dedup and at least once retries', async () => {
  const { checkerAlerts } = await import('./backup-checker-state.ts')
  const content: string[] = []
  const notify = discordNotifier('https://notify.invalid/', noGuard, async (_url, init) => {
    content.push(JSON.parse(String(init?.body)).content)
    return new Response(null, { status: 204 })
  })
  await notify(JSON.stringify({ event: 'checker-summary', events: [...checkerAlerts,
    JSON.stringify({ event: 'checker-alive', newestCapture: null, backupBytes: 0, imageBytes: 0, total: 0, percentage: 0, operations: null })] }))
  assert.equal(content.length, 1)
  assert.ok(content[0].length <= 2000)
  for (const event of checkerAlerts) assert.ok(content[0].includes(event))
  const f = fixture()
  f.storage.values.delete(stateKey)
  assert.equal((await f.create().fetch()).status, 204)
  assert.equal(f.events.length, 1)
  assert.ok(f.events[0].includes('state-missing') && f.events[0].includes('checker-alive'))
  assert.equal((await f.create().fetch()).status, 204)
  assert.equal(f.events.length, 1)
  // Replay the pre-delivery snapshot, as if delivery succeeded but saving died.
  f.storage.values.delete(stateKey)
  assert.equal((await f.create().fetch()).status, 204)
  assert.equal(f.events.length, 2)
})

test('corrupt or prematurely cached usage alerts and freezes Worker pruning until safe backfill', async () => {
  for (const usageCache of [{ month: '2026-11', days: { '2026-11-01': { classA: -1, classB: 0 } } },
    { month: '2026-11', days: { '2026-11-17': { classA: 0, classB: 0 } } }]) {
    const f = fixture()
    f.storage.values.set(stateKey, { version: 1, state: { sentAlerts: [], usageCache } })
    assert.equal((await f.create().fetch()).status, 204)
    assert.equal(f.events.length, 1)
    assert.ok(f.events[0].includes('state-corrupt') && f.events[0].includes('operations-unknown') && f.events[0].includes('pruning-refused'))
    assert.ok(!f.binding.bucket.calls.some(call => call.startsWith('DELETE')))
    assert.equal(decodeState(f.storage.values.get(stateKey)).warning, undefined)
  }
})

test('internal budget accommodates thirty eight generations and five prunes including fenced DO operations', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) seed(f.binding.bucket, epoch - (90 + i) * day)
  seed(f.binding.bucket, epoch - 100 * day, true, epoch - 50 * day)
  assert.equal((await inventory(f.binding.bucket, epoch)).verified.length, 38)
  let operations = 0
  f.storage.before = async () => { operations++ }
  const transaction = f.storage.transaction.bind(f.storage)
  f.storage.transaction = async body => { operations++; return transaction(body) }
  f.binding.before = async () => { operations++ }
  f.env.IMAGES.list = async () => { operations++; return { objects: [], truncated: false } }
  const before = f.binding.bucket.objects.size
  assert.equal((await f.create().fetch()).status, 204)
  assert.equal(before - f.binding.bucket.objects.size, 15)
  assert.ok(operations <= 800, String(operations))
  assert.ok(f.binding.bucket.objects.has(f.source + 'verified.json'))
  assert.ok(f.binding.bucket.objects.has(f.drill + 'verified.json'))
  const excessive = fixture()
  excessive.binding.pageSize = 1
  let calls = 0
  excessive.storage.before = async () => { calls++ }
  const tx = excessive.storage.transaction.bind(excessive.storage)
  excessive.storage.transaction = async body => { calls++; return tx(body) }
  excessive.binding.before = async () => { calls++ }
  assert.equal((await excessive.create().fetch()).status, 500)
  assert.ok(calls <= 800, String(calls))
  assert.ok(excessive.events.some(event => event.includes('checker-failed')))
  assert.ok(!excessive.binding.bucket.calls.some(call => call.startsWith('DELETE')))
})

test('image listing stops at internal budget with unknown capacity alert and frozen pruning', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) seed(f.binding.bucket, epoch - (90 + i) * day)
  seed(f.binding.bucket, epoch - 100 * day, true, epoch - 50 * day)
  f.storage.values.set(stateKey, { version: 1, state: { sentAlerts: [], usageCache: cachedUsage() } })
  let operations = 0, pages = 0
  f.storage.before = async () => { operations++ }
  const transaction = f.storage.transaction.bind(f.storage)
  f.storage.transaction = async body => { operations++; return transaction(body) }
  f.binding.before = async () => { operations++ }
  f.env.IMAGES.list = async () => {
    operations++
    const page = ++pages
    if (page > 1000) throw new Error('test must not permit an unbounded listing')
    return { objects: [{ key: String(page), size: 1, uploaded: new Date(epoch) }], truncated: true, cursor: String(page) }
  }
  assert.equal((await f.create().fetch()).status, 204)
  assert.ok(pages > 1 && pages < 30, String(pages))
  assert.ok(operations <= 800, String(operations))
  assert.equal(f.events.length, 1)
  assert.ok(f.events[0].includes('capacity-unknown') && f.events[0].includes('pruning-refused'))
  assert.match(f.events[0], /imageBytes=null total=null percentage=null/)
  assert.ok(!f.binding.bucket.calls.some(call => call.startsWith('DELETE')))
  assert.equal(f.storage.values.has(leaseKey), false)
})

test('shared external adapter budget rejects work before fetch and retains three failure attempts', async () => {
  const { RunBudget } = await import('../workers/backup-checker/budget.ts')
  const budget = new RunBudget(), calls: string[] = []
  const request: Fetch = async url => {
    calls.push(String(url))
    return String(url).includes('analytics') ? Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 1 } },
    ] }] } } }) : new Response(null, { status: 503 })
  }
  const usage = analyticsUsage({ url: 'https://analytics.invalid/', token: 'test-only', account: 'test-only' }, noGuard, request, budget)
  const notify = discordNotifier('https://notify.invalid/', noGuard, request, async () => {}, Date.now, budget)
  // Nine normal attempts: four + four analytics, then one notification attempt.
  for (let i = 0; i < 2; i++) await assert.rejects(usage.read(Date.UTC(2026, 9, 31, 12)), /unavailable/)
  await assert.rejects(notify('stale-backup'), /budget/)
  assert.equal(calls.length, 9)
  await assert.rejects(usage.read(Date.UTC(2026, 9, 1, 12)), /unavailable/)
  assert.equal(calls.length, 9)
  await assert.rejects(notify('checker-failed'), /unavailable/)
  assert.equal(calls.length, 12)
  assert.equal(calls.filter(url => url.includes('notify')).length, 4)
  await assert.rejects(notify('checker-failed'), /budget/)
  assert.equal(calls.length, 12)
})
