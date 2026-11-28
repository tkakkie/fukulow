import { checkBackups } from './backup-r2-checker.ts'
import { epoch, FakeBucket, manifest } from './backup-r2-fake.ts'
import { sha256 } from './backup-r2-model.ts'
import { memoryRunLock } from './backup-test-helpers.ts'

export async function seed(bucket: FakeBucket, capture: number, size = 100, restored = false, uploaded = capture) {
  const body = Buffer.alloc(size, 1), m = manifest(capture, body), json = Buffer.from(JSON.stringify(m))
  const prefix = `${restored ? 'restore-verified' : 'backups'}/${m.captureTime}${restored ? '' : '-test'}/`
  for (const [key, data] of [['archive.dump.age', body], ['manifest.json', json], ['verified.json', Buffer.from(JSON.stringify({ manifestSha256: sha256(json), verifiedTime: m.captureTime }))]] as const) {
    bucket.objects.set(prefix + key, { body: data, uploaded })
  }
  return prefix
}
export function checker(bucket: FakeBucket, now = epoch) {
  const events: string[] = [], images = new FakeBucket(() => now), state = {}
  const options = { backups: bucket, images, now: () => now, notify: async (event: string) => { events.push(event) }, state, lock: memoryRunLock(), usage: { read: async () => ({ classA: 0, classB: 0 }) } }
  return { events, images, options, run: () => checkBackups(options) }
}
