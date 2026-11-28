import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { backup } from './backup.ts'
import type { Runner } from './backup-curl.ts'
import { checksum, type BackupBucket, type Manifest } from './backup-r2-inventory.ts'
import { listObjects } from './backup-r2-list.ts'
import { sha256 } from './backup-r2-model.ts'
import { fileDigest, publish, readbackDigest, type UploadBucket } from './backup-r2-publish.ts'
import { acquireLocalLock, assertLocalLock, privateDirectory, sweepPartials } from './backup-safety.ts'

export function objectTransport(run: Runner): BackupBucket & UploadBucket {
  return {
    list: () => listObjects(run),
    async delete(key) {
      const r = await run({ method: 'DELETE', key, headers: {} })
      if (r.status !== 204 && r.status !== 200) throw new Error('Deletion failed')
    },
    async put(key, body) {
      const hex = sha256(body)
      const response = await run({ method: 'PUT', key, body: Buffer.isBuffer(body) ? body : Buffer.from(body), headers: { 'x-amz-content-sha256': hex, 'x-amz-checksum-sha256': checksum(hex) } })
      if (response.status < 200 || response.status >= 300) throw new Error('Upload failed')
    },
    async head(key) {
      const r = await run({ method: 'HEAD', key, headers: { 'x-amz-checksum-mode': 'ENABLED' } })
      if (r.status === 404) return null
      if (r.status !== 200) throw new Error('HEAD failed')
      return { key, size: Number(r.headers['content-length']), checksum: r.headers['x-amz-checksum-sha256'], uploaded: Date.parse(r.headers['last-modified']) }
    },
    async readback(key) {
      const r = await run({ method: 'GET', key, headers: {}, digestOnly: true })
      if (r.status !== 200) throw new Error('Read-back failed')
      return r.digest ?? { sha256: sha256(r.body), size: r.body.length }
    },
    async get(key) {
      const r = await run({ method: 'GET', key, headers: {} })
      if (r.status !== 200) throw new Error('Read-back failed')
      return r.body
    },
  }
}

export async function runBackup(options: {
  directory: string; recipient: string; bucket: UploadBucket
  localLock?: () => void
  now: () => number; notify: (event: string) => Promise<void>
  dump?: (directory: string, capture: () => void) => string; encrypt?: (source: string, target: string, recipient: string) => void
}) {
  try { return await runBackupLocked(options) }
  catch {
    try { await options.notify('backup-failed') } catch { /* Keep notification diagnostics private. */ }
    throw new Error('Backup failed (diagnostics suppressed)')
  }
}
async function runBackupLocked(options: Parameters<typeof runBackup>[0]) {
  let temporary: string | undefined
  let release: (() => void) | undefined
  try {
    if (!options.recipient.trim()) throw new Error('Missing recipient')
    const directory = privateDirectory(options.directory)
    if (options.localLock) assertLocalLock(directory, options.localLock)
    else release = acquireLocalLock(directory)
    sweepPartials(directory)
    // Conservative snapshot bound after preflight, immediately before pg_dump starts.
    let captureTime: string | undefined
    const capture = () => { captureTime = new Date(options.now()).toISOString() }
    const source = options.dump ? options.dump(directory, capture) : backup(directory, capture, { localLock: options.localLock ?? release })
    if (!captureTime) throw new Error('Missing capture timestamp')
    temporary = await mkdtemp(join(options.directory, '.partial-age-'))
    const target = join(temporary, 'archive.dump.age')
    const encrypt = options.encrypt ?? ((source, target, recipient) => {
      const r = spawnSync('age', ['--encrypt', '--recipient', recipient, '--output', target, source], { stdio: 'ignore' })
      if (r.status !== 0) throw new Error('Encryption failed')
    })
    encrypt(source, target, options.recipient)
    const manifest: Manifest = { formatVersion: 1, captureTime, postgresMajor: 18,
      plaintext: await fileDigest(source), ciphertext: await fileDigest(target), recipientFingerprint: sha256(options.recipient) }
    return await publish({ bucket: options.bucket, ciphertext: await readFile(target), manifest, now: options.now })
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true })
    } catch { throw new Error('Backup cleanup failed (diagnostics suppressed)') }
    finally {
      try { release?.() } catch { throw new Error('Backup lock release failed (diagnostics suppressed)') }
    }
  }
}

export async function recheckNewest(bucket: BackupBucket & UploadBucket, now: number) {
  const { inventory } = await import('./backup-r2-inventory.ts')
  const newest = (await inventory(bucket, now)).verified.find(g => g.prefix.startsWith('backups/'))
  if (!newest) throw new Error('No verified restore source')
  const body = await readbackDigest(bucket, newest.prefix + 'archive.dump.age')
  if (body.size !== newest.manifest.ciphertext.size || body.sha256 !== newest.manifest.ciphertext.sha256) throw new Error('Daily integrity check failed')
  return newest
}

// Schedule contract only: activation and host/Worker wiring remain a maintainer gate.
export const backupSchedule = { dailyUTC: '*-*-* 02:15:00 UTC', checkerCron: '0 * * * *', persistent: true } as const
export async function dailyBackup(options: Parameters<typeof runBackup>[0] & { bucket: BackupBucket }) {
  try {
    const directory = privateDirectory(options.directory)
    const release = options.localLock ?? acquireLocalLock(directory)
    assertLocalLock(directory, release)
    try {
      try { await recheckNewest(options.bucket, options.now()) } catch {
        try { await options.notify('daily-readback-failed') } catch { /* Still take the next backup if notification is unavailable. */ }
      }
      return await runBackupLocked({ ...options, localLock: release })
    } finally { if (!options.localLock) release() }
  } catch {
    try { await options.notify('backup-failed') } catch { /* Keep notification diagnostics private. */ }
    throw new Error('Backup failed (diagnostics suppressed)')
  }
}
