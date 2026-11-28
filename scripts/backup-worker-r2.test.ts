import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backupAdapter, imagesAdapter } from '../workers/backup-checker/r2.ts'
import type { R2List } from '../workers/backup-checker/bindings.ts'
import { fixture, noGuard } from './backup-worker-test-helpers.ts'

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
