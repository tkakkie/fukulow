import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext } from 'node:test'
import { FakeBucket } from './backup-r2-fake.ts'
import { day, type ObjectInfo } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'

export const now = Date.UTC(2026, 10, 2)

export function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'backup-adapter-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
export function options() {
  const events: string[] = [], bucket = new FakeBucket(() => now)
  return { events, bucket, backups: bucket, images: { list: async (): Promise<ObjectInfo[]> => [] }, now: () => now,
    notify: async (event: string) => { events.push(event) }, usage: { read: async () => ({ classA: 0, classB: 0 }) } }
}
function seed(bucket: FakeBucket, capture: number, restored = false, uploaded = capture) {
  const body = Buffer.from('cipher'), captureTime = new Date(capture).toISOString()
  const manifest = Buffer.from(JSON.stringify({ formatVersion: 1, captureTime, postgresMajor: 18,
    plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: body.length, sha256: sha256(body) }, recipientFingerprint: sha256('test') }))
  const prefix = `${restored ? 'restore-verified' : 'backups'}/${captureTime}${restored ? '' : '-test'}/`
  for (const [name, bytes] of [['archive.dump.age', body], ['manifest.json', manifest],
    ['verified.json', Buffer.from(JSON.stringify({ manifestSha256: sha256(manifest), verifiedTime: captureTime }))]] as const) {
    bucket.objects.set(prefix + name, { body: bytes, uploaded })
  }
  return prefix
}
export function prunableOptions() {
  const o = options()
  for (let i = 0; i < 30; i++) seed(o.bucket, now - i * day)
  const protectedSource = seed(o.bucket, now - 70 * day)
  const candidate = seed(o.bucket, now - 80 * day)
  seed(o.bucket, now - 70 * day, true, now - day)
  return { ...o, protectedSource, candidate }
}
