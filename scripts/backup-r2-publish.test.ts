import assert from 'node:assert/strict'
import { test } from 'node:test'
import { epoch, fakeS3, manifest } from './backup-r2-fake.ts'
import { inventory, verifiedGeneration } from './backup-r2-inventory.ts'
import { publish } from './backup-r2-publish.ts'
import { objectTransport } from './backup-r2.ts'

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
    assert.ok((await inventory(fake.buckets.backups, epoch)).inProgress.length)
  }
})
