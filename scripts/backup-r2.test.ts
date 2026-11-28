import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { epoch, FakeBucket, fakeS3 } from './backup-r2-fake.ts'
import { day } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'
import { objectTransport, recheckNewest, runBackup, dailyBackup } from './backup-r2.ts'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { fixture, options } from './backup-r2-test-helpers.ts'
import { seed } from './backup-r2-inventory-test-helpers.ts'

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
  // The separate restore-drill.test.ts suite checks isolation/cleanup and failure paths.
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

for (const entry of ['backup', 'daily'] as const) {
  for (const failure of ['cleanup', 'local-release'] as const) {
    for (const notifierFails of [false, true]) {
      test(`${entry} reports ${failure} failure with notifier failure=${notifierFails} with local locks`, async t => {
        const root = fixture(t), o = options(), source = join(root, 'source')
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
        const backupOptions = { directory: root, recipient: 'test', bucket: o.bucket, now: o.now,
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
      })
    }
  }
}
