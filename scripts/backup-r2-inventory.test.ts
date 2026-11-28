import assert from 'node:assert/strict'
import { test } from 'node:test'
import { epoch, FakeBucket, manifest } from './backup-r2-fake.ts'
import { day, inventory } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'
import { recheckNewest } from './backup-r2.ts'
import { seed, checker } from './backup-r2-inventory-test-helpers.ts'

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
    for (const object of b.objects.values()) object.uploaded = epoch - 6 * 3_600_000
    assert.ok((await checker(b).run()).alerts.includes('malformed-generations'))
  }
})
