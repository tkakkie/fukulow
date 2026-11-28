import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { day, inventory, uploadGrace } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'
import { publish } from './backup-r2-publish.ts'
import { decodeState } from './backup-checker-state.ts'
import scheduled, { BackupChecker } from '../workers/backup-checker/index.ts'
import { leaseDuration, leaseKey, stateKey } from '../workers/backup-checker/lease.ts'
import { discordNotifier, type Fetch } from '../workers/backup-checker/http.ts'
import { epoch, deferred, seed, cachedUsage, fixture, noGuard } from './backup-worker-test-helpers.ts'

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
