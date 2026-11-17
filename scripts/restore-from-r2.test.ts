import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fakeS3 } from './backup-r2-fake.ts'
import { sha256, inventory } from './backup-r2-model.ts'
import { objectTransport, publish } from './backup-r2.ts'
import { restoreFromR2 } from './restore-from-r2.ts'

const now = Date.now()
const keyRoot = mkdtempSync(join(tmpdir(), 'restore-identity-'))
process.on('exit', () => rmSync(keyRoot, { recursive: true, force: true }))
const privateIdentity = join(keyRoot, 'identity')
writeFileSync(privateIdentity, 'AGE-SECRET-KEY-TEST', { mode: 0o600 })
const manifest = (cipher: Buffer) => ({ formatVersion: 1 as const, captureTime: new Date(now).toISOString(), postgresMajor: 18,
  plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: cipher.length, sha256: sha256(cipher) }, recipientFingerprint: sha256('recipient') })
test('R2 restore rejects tampered downloads before decryption and never selects unverified generations', async t => {
  const fake = await fakeS3(() => now); t.after(fake.close)
  const bucket = objectTransport(fake.runner('backups')), cipher = Buffer.from('cipher')
  const prefix = await publish({ bucket, ciphertext: cipher, manifest: manifest(cipher), now: () => now })
  const get = bucket.get
  let decrypts = 0, temporary = ''
  const decrypt = (_archive: string, target: string) => { decrypts++; temporary = dirname(target); writeFileSync(target, 'dump') }
  await restoreFromR2({ bucket, identityFile: privateIdentity, decrypt, drill: path => {
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
    assert.equal(statSync(join(dirname(path), 'manifest.json')).mode & 0o777, 0o600)
  } })
  assert.equal(decrypts, 1); assert.ok(!existsSync(temporary))
  bucket.get = async key => key.endsWith('archive.dump.age') ? Buffer.from('tampered') : get(key)
  await assert.rejects(restoreFromR2({ bucket, identityFile: privateIdentity, decrypt }), /stage=restore/)
  assert.equal(decrypts, 1)
  bucket.get = get
  await fake.buckets.backups.put('backups/malformed/archive.dump.age', cipher)
  await assert.rejects(restoreFromR2({ bucket, identityFile: privateIdentity, prefix: 'backups/malformed/', decrypt }))
  assert.equal(decrypts, 1)
  fake.buckets.backups.objects.delete(prefix + 'verified.json')
  await assert.rejects(restoreFromR2({ bucket, identityFile: privateIdentity, decrypt }))
  assert.equal(decrypts, 1)
})
test('R2 restore decrypts with a throwaway age identity rejects wrong identity and cleans all temporary files', async t => {
  if (['age', 'age-keygen'].some(bin => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== 0)) {
    if (process.env.FUKULOW_REQUIRE_AGE === '1') assert.fail('age and age-keygen required')
    t.skip('age and age-keygen unavailable'); return
  }
  const root = mkdtempSync(join(tmpdir(), 'restore-age-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const identity = join(root, 'identity'), wrong = join(root, 'wrong'), source = join(root, 'dump')
  for (const path of [identity, wrong]) assert.equal(spawnSync('age-keygen', ['-o', path], { stdio: 'ignore' }).status, 0)
  const recipient = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(source, 'dump')
  const encrypted = spawnSync('age', ['-r', recipient, source]); assert.equal(encrypted.status, 0)
  const fake = await fakeS3(() => now); t.after(fake.close)
  const bucket = objectTransport(fake.runner('backups'))
  await publish({ bucket, ciphertext: encrypted.stdout, manifest: manifest(encrypted.stdout), now: () => now })
  let drills = 0, temporary = ''
  const drill = (path: string) => { drills++; temporary = dirname(path); assert.equal(readFileSync(path, 'utf8'), 'dump') }
  await restoreFromR2({ bucket, identityFile: identity, drill })
  assert.equal(drills, 1); assert.ok(!existsSync(temporary))
  await assert.rejects(restoreFromR2({ bucket, identityFile: wrong, drill }), { message: 'stage=restore category=operation' })
  assert.equal(drills, 1)
  // A malformed newer candidate cannot displace the verified source.
  await fake.buckets.backups.put('backups/not-a-capture/manifest.json', Buffer.from('{}'))
  assert.equal((await inventory(bucket, now)).verified.length, 1)
  await restoreFromR2({ bucket, identityFile: identity, drill })
  assert.equal(drills, 2)
})

test('R2 restore removes temporary files when decryption or drill fails', async t => {
  const fake = await fakeS3(() => now); t.after(fake.close)
  const bucket = objectTransport(fake.runner('backups')), cipher = Buffer.from('cipher')
  const prefix = await publish({ bucket, ciphertext: cipher, manifest: manifest(cipher), now: () => now })
  for (const failure of ['decrypt', 'drill']) {
    let temporary = ''
    await assert.rejects(restoreFromR2({ bucket, identityFile: privateIdentity, prefix,
      decrypt: (_archive, target) => {
        temporary = dirname(target); writeFileSync(target, 'dump')
        if (failure === 'decrypt') throw new Error('PRIVATE_SENTINEL')
      }, drill: () => { throw new Error('PRIVATE_SENTINEL') },
    }), { message: 'stage=restore category=operation' })
    assert.ok(temporary); assert.ok(!existsSync(temporary))
  }
})

test('R2 restore refuses an identity file that is not private before any download', async t => {
  const fake = await fakeS3(() => now); t.after(fake.close)
  const bucket = objectTransport(fake.runner('backups')), cipher = Buffer.from('cipher')
  await publish({ bucket, ciphertext: cipher, manifest: manifest(cipher), now: () => now })
  let decrypts = 0, reads = 0
  const get = bucket.get
  bucket.get = async key => { reads++; return get(key) }
  const decrypt = (_archive: string, target: string) => { decrypts++; writeFileSync(target, 'dump') }
  const readable = join(keyRoot, 'readable'), link = join(keyRoot, 'link')
  writeFileSync(readable, 'AGE-SECRET-KEY-TEST', { mode: 0o600 }); chmodSync(readable, 0o644)
  symlinkSync(privateIdentity, link)
  const inside = join(dirname(new URL(import.meta.url).pathname), 'restore-from-r2.test.ts')
  const fifo = join(keyRoot, 'fifo')
  assert.equal(spawnSync('mkfifo', ['-m', '600', fifo]).status, 0)
  for (const identityFile of [readable, link, inside, fifo, join(keyRoot, 'missing')]) {
    await assert.rejects(restoreFromR2({ bucket, identityFile, decrypt, drill: () => {} }), /stage=restore/)
  }
  assert.equal(decrypts, 0); assert.equal(reads, 0)
  // age gets a private staged copy, never the operator path, so a swap after the check cannot reach it.
  let staged = ''
  const stagedDecrypt = (_archive: string, target: string, identity: string) => {
    decrypts++; staged = identity
    assert.notEqual(identity, privateIdentity); assert.equal(dirname(identity), dirname(target))
    assert.equal(statSync(identity).mode & 0o777, 0o600); assert.equal(readFileSync(identity, 'utf8'), 'AGE-SECRET-KEY-TEST')
    writeFileSync(target, 'dump')
  }
  await restoreFromR2({ bucket, identityFile: privateIdentity, decrypt: stagedDecrypt, drill: () => {} })
  assert.equal(decrypts, 1); assert.ok(staged !== '' && !existsSync(staged))
})
