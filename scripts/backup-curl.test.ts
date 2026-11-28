import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { curlRunner } from './backup-curl.ts'
import { epoch, fakeS3, manifest } from './backup-r2-fake.ts'
import { checksum, verifiedGeneration } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'
import { publish } from './backup-r2-publish.ts'
import { objectTransport } from './backup-r2.ts'

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
  const { curlRunner } = await import('./backup-curl.ts')
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

test('curl encodes opaque list tokens without exposing the endpoint', async t => {
  const root = mkdtempSync(join(tmpdir(), 'backup-adapter-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, 'config')
  writeFileSync(config, '', { mode: 0o600 })
  const requests: { args: string[]; input: string }[] = []
  const run = await curlRunner(config, 'https://' + randomUUID(), async (args, input) => {
    requests.push({ args, input })
    writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 200 OK\r\n\r\n')
    writeFileSync(args[args.indexOf('--output') + 1], '')
  })
  await run({ method: 'GET', key: '', query: { 'list-type': '2', 'continuation-token': '+/=&' }, headers: {} })
  assert.ok(requests[0].input.includes('continuation-token=%2B%2F%3D%26'))

})

test('curl child failure suppresses credentials and config on both output streams', t => {
  const root = mkdtempSync(join(tmpdir(), 'backup-curl-output-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, 'config')
  const credentials = 'test-curl-user:test-curl-secret'
  const endpoint = 'https://test-curl-endpoint.invalid'
  writeFileSync(config, `user = "${credentials}"\n`, { mode: 0o600 })
  writeFileSync(join(root, 'curl'), `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const config = readFileSync(args[args.indexOf('--config') + 1], 'utf8')
const input = readFileSync(0, 'utf8')
writeSync(1, config + input)
writeSync(2, config + input)
if (config.includes(${JSON.stringify(credentials)}) && input.includes(${JSON.stringify(endpoint)})) {
  writeFileSync(join(__dirname, 'echoed'), '')
}
process.exitCode = 23
`, { mode: 0o700 })

  const parent = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { curlRunner } from ${JSON.stringify(new URL('./backup-curl.ts', import.meta.url).href)}
    const run = await curlRunner(process.argv[1], process.argv[2])
    await assert.rejects(run({ method: 'GET', key: 'object', headers: {} }), error => {
      assert.deepEqual(error, new Error(error.message))
      process.stdout.write(error.message + '\\n')
      return true
    })
  `, config, endpoint], {
    encoding: 'utf8', env: { PATH: root + delimiter + process.env.PATH }, timeout: 10_000,
  })
  assert.equal(parent.status, 0)
  assert.equal(readFileSync(join(root, 'echoed'), 'utf8'), '')
  assert.equal(parent.stdout, 'Transport failed\n')
  assert.equal(parent.stderr, '')
})
