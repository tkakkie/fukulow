import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyProvider } from './backup-r2-verify.ts'
import { accountUsage } from './backup-usage-model.ts'
import { fakeS3 } from './backup-r2-fake.ts'
import { inventory } from './backup-r2-inventory.ts'
import type { Runner } from './backup-curl.ts'

test('provider probes pass on local S3 and locked probes count capacity without freezing inventory', async t => {
  const fake = await fakeS3(Date.now); t.after(fake.close)
  const lines: string[] = [], base = fake.runner('backups')
  const run: Runner = request => {
    if (!request.key) assert.match(request.query?.prefix ?? '', /^verification\/[a-f0-9-]+\/$/)
    else assert.match(request.key, /^(?:verification\/[a-f0-9-]+\/|backups\/verification-[a-f0-9-]+\/probe$)/)
    return base(request)
  }
  const ok = await verifyProvider({ run, wrongSignature: request => run({ ...request, headers: { authorization: 'verification-invalid' } }),
    usage: { read: async () => ({ classA: 1, classB: 2 }) }, report: line => { lines.push(line) } })
  assert.ok(ok); assert.ok(lines.every(line => /^PASS [a-z0-9-]+$/.test(line)))
  const data = await inventory(fake.buckets.backups, Date.now())
  assert.deepEqual(data.malformed, []); assert.deepEqual(data.verified, [])
  assert.equal(data.objects.length, 1); assert.ok(data.objects[0].size > 0)
  assert.ok([...fake.buckets.backups.objects.keys()].every(key => /^backups\/verification-[a-f0-9-]+\/probe$/.test(key)))
})
test('provider probes report unsupported conditional delete and fixed failures without raw responses', async t => {
  const fake = await fakeS3(Date.now); t.after(fake.close)
  const lines: string[] = [], base = fake.runner('backups')
  const run: Runner = request => base(request.method === 'DELETE' ? { ...request, headers: {} } : request)
  assert.ok(await verifyProvider({ run, wrongSignature: async () => ({ status: 403, headers: {}, body: Buffer.from('PRIVATE_SENTINEL') }), report: line => { lines.push(line) } }))
  assert.ok(lines.includes('UNSUPPORTED conditional-delete'))
  lines.length = 0
  const fail: Runner = async () => { throw new Error('PRIVATE_SENTINEL') }
  assert.equal(await verifyProvider({ run: fail, wrongSignature: fail, report: line => { lines.push(line) } }), false)
  assert.ok(lines.every(line => /^FAIL [a-z0-9-]+$/.test(line)))
})

test('negative signature probe changes only signing secret on stdin and never exposes credentials in argv', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { wrongSignatureRunner } = await import('./backup-r2-verify.ts')
  const root = mkdtempSync(join(tmpdir(), 'verify-signature-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, 'curl'), access = randomUUID(), secret = randomUUID()
  writeFileSync(config, `user = "${access}:${secret}"\n`, { mode: 0o600 })
  const run = await wrongSignatureRunner(config, 'https://backup.invalid/', async (args, input) => {
    assert.ok(!args.join().includes(access)); assert.ok(!args.join().includes(secret))
    assert.ok(input.includes(`user = "${access}:`)); assert.ok(!input.includes(secret))
    writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 403 Forbidden\r\n\r\n')
    writeFileSync(args[args.indexOf('--output') + 1], 'PRIVATE_SENTINEL')
  })
  assert.equal((await run({ method: 'GET', key: '', headers: {} })).status, 403)
})

test('analytics verification backfills the whole month on one in-memory state and fails without progress', async t => {
  const fake = await fakeS3(Date.now); t.after(fake.close)
  const run = fake.runner('backups'), wrongSignature: Runner = async () => ({ status: 403, headers: {}, body: Buffer.alloc(0) })
  const payload = { data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [{ dimensions: { actionType: 'PutObject' }, sum: { requests: 1 } }] }] } } }
  let queries = 0
  const usage = accountUsage({ async query() { queries++; return payload } }, 'test-only')
  const lines: string[] = []
  assert.ok(await verifyProvider({ run, wrongSignature, usage, now: () => Date.UTC(2026, 10, 30, 12), report: line => { lines.push(line) } }))
  assert.ok(lines.includes('PASS analytics')); assert.ok(queries > 29)
  lines.length = 0; queries = 0
  const broken = accountUsage({ async query() { queries++; return { errors: [{}] } } }, 'test-only')
  assert.equal(await verifyProvider({ run, wrongSignature, usage: broken, now: () => Date.UTC(2026, 10, 30, 12), report: line => { lines.push(line) } }), false)
  assert.ok(lines.includes('FAIL analytics')); assert.equal(queries, 1)
})
