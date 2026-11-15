import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backup } from './backup.ts'
import { checksum, sha256, verifiedGeneration, type BackupBucket, type Manifest, parseManifest } from './backup-r2-model.ts'
import { listObjects, runLockKey } from './backup-r2-list.ts'
import { acquireLocalLock, privateDirectory, SafeFailure, sweepPartials, type RunLock } from './backup-safety.ts'

export interface Request { method: 'PUT' | 'HEAD' | 'GET' | 'DELETE'; key: string; headers: Record<string, string>; query?: Record<string, string>; body?: Buffer; digestOnly?: boolean }
export interface Response { status: number; headers: Record<string, string>; body: Buffer; digest?: { sha256: string; size: number } }
export type Runner = (request: Request) => Promise<Response>
export type UploadBucket = Pick<BackupBucket, 'put' | 'head' | 'get'> & {
  readback?: (key: string) => Promise<{ sha256: string; size: number }>
}
export function objectTransport(run: Runner): BackupBucket & UploadBucket {
  return {
    list: () => listObjects(run),
    async delete(key) {
      const r = await run({ method: 'DELETE', key, headers: {} })
      if (r.status !== 204 && r.status !== 200) throw new Error('Deletion failed')
    },
    async put(key, body) {
      const hex = sha256(body)
      const response = await run({ method: 'PUT', key, body, headers: { 'x-amz-content-sha256': hex, 'x-amz-checksum-sha256': checksum(hex) } })
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

// Config contains credentials only outside the checkout; curl diagnostics never escape.
export async function privateCurlConfig(configFile: string): Promise<string> {
  try {
    const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
    const path = resolve(configFile), info = await lstat(path)
    const canonical = await realpath(path)
    if (canonical.startsWith(await realpath(root) + sep) || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Private external curl config required')
    return path
  } catch { throw new Error('Private external curl config required') }
}
export async function curlRunner(configFile: string, baseUrl: string, execute = executeCurl): Promise<Runner> {
  const path = await privateCurlConfig(configFile)
  if (!/^https:\/\//.test(baseUrl) || /[\r\n"]/.test(baseUrl)) throw new Error('Invalid transport configuration')
  return async request => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-curl-'))
    try {
      const headersFile = join(directory, 'headers'), bodyFile = join(directory, 'body')
      // --retry handles transient HTTP statuses without --fail; other HTTP responses
      // must reach objectTransport (notably missing objects and locked PUT retries).
      // Retrying lock deletion could delete a successor's lock after a lost response.
      const retries = request.key === runLockKey ? ['--retry', '0'] : ['--retry', '3', '--retry-all-errors']
      const args = ['--disable', '--config', path, '--aws-sigv4', 'aws:amz:auto:s3', '--silent', ...retries, '--max-time', '120', '--retry-max-time', '480', '--dump-header', headersFile, '--output', bodyFile, '--request', request.method]
      if (request.method === 'HEAD') args.push('--head')
      for (const [key, value] of Object.entries(request.headers)) args.push('--header', `${key}: ${value}`)
      // URL is supplied via stdin config, so private endpoints never enter argv.
      const query = request.query ? '?' + new URLSearchParams(request.query).toString() : ''
      const input = `url = "${baseUrl.replace(/\/$/, '')}/${request.key.split('/').map(encodeURIComponent).join('/')}${query}"\n`
      if (request.body) {
        const { writeFile } = await import('node:fs/promises')
        const upload = join(directory, 'upload')
        await writeFile(upload, request.body, { mode: 0o600 })
        args.push('--data-binary', '@' + upload)
      }
      args.push('--config', '-')
      await execute(args, input)
      const raw = await readFile(headersFile, 'utf8')
      const block = raw.trim().split(/\r?\n\r?\n/).at(-1)!
      const headers = Object.fromEntries(block.split(/\r?\n/).slice(1).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()] }))
      return { status: Number(block.split(' ')[1]), headers,
        body: request.digestOnly ? Buffer.alloc(0) : await readFile(bodyFile),
        ...(request.digestOnly ? { digest: await fileDigest(bodyFile) } : {}) }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

export async function publish(options: {
  bucket: UploadBucket; ciphertext: Buffer; manifest: Manifest
  now: () => number; attempt?: () => string
}): Promise<string> {
  const { bucket, ciphertext, manifest, now } = options
  if (sha256(ciphertext) !== manifest.ciphertext.sha256 || ciphertext.length !== manifest.ciphertext.size) throw new Error('Local ciphertext mismatch')
  const body = Buffer.from(JSON.stringify(manifest))
  parseManifest(body)
  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = (options.attempt ?? randomUUID)()
    if (!/^[a-zA-Z0-9-]+$/.test(suffix)) throw new Error('Invalid attempt')
    const prefix = `backups/${manifest.captureTime}-${suffix}/`
    try {
      for (const name of ['archive.dump.age', 'manifest.json', 'verified.json']) {
        const bytes = name === 'archive.dump.age' ? ciphertext : name === 'manifest.json' ? body
          : Buffer.from(JSON.stringify({ manifestSha256: sha256(body), verifiedTime: new Date(now()).toISOString() }))
        try { await bucket.put(prefix + name, bytes) } catch { /* Lost PUT responses are resolved by HEAD. */ }
        const stored = await bucket.head(prefix + name)
        if (!stored || stored.size !== bytes.length || stored.checksum !== checksum(sha256(bytes))) throw new Error('Upload verification failed')
        const readback = await readbackDigest(bucket, prefix + name)
        if (readback.size !== bytes.length || readback.sha256 !== sha256(bytes)) throw new Error('Read-back mismatch')
      }
      await verifiedGeneration(bucket, prefix, now())
      return prefix
    } catch { /* Never overwrite an uncertain generation; use a new suffix. */ }
  }
  throw new Error('Backup upload failed')
}

export async function fileDigest(path: string) {
  const hash = createHash('sha256'); let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  return { sha256: hash.digest('hex'), size }
}
export async function runBackup(options: {
  directory: string; recipient: string; bucket: UploadBucket
  lock: RunLock
  now: () => number; notify: (event: string) => Promise<void>
  dump?: (directory: string, capture: () => void) => string; encrypt?: (source: string, target: string, recipient: string) => void
}) {
  return options.lock(() => runBackupLocked(options))
}
async function runBackupLocked(options: Parameters<typeof runBackup>[0]) {
  let temporary: string | undefined
  let release: (() => void) | undefined
  try {
    if (!options.recipient.trim()) throw new Error('Missing recipient')
    const directory = privateDirectory(options.directory)
    release = acquireLocalLock(directory)
    sweepPartials(directory)
    // Conservative snapshot bound after preflight, immediately before pg_dump starts.
    let captureTime: string | undefined
    const capture = () => { captureTime = new Date(options.now()).toISOString() }
    const source = options.dump ? options.dump(directory, capture) : backup(directory, capture, { localLock: release })
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
  } catch {
    try { await options.notify('backup-failed') } catch { /* Notification failure must not expose transport diagnostics. */ }
    throw new Error('Backup failed (diagnostics suppressed)')
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
  const { inventory } = await import('./backup-r2-model.ts')
  const newest = (await inventory(bucket, now)).verified.find(g => g.prefix.startsWith('backups/'))
  if (!newest) throw new Error('No verified restore source')
  const body = await readbackDigest(bucket, newest.prefix + 'archive.dump.age')
  if (body.size !== newest.manifest.ciphertext.size || body.sha256 !== newest.manifest.ciphertext.sha256) throw new Error('Daily integrity check failed')
  return newest
}

// Schedule contract only: activation and host/Worker wiring remain a maintainer gate.
export const backupSchedule = { dailyUTC: '*-*-* 02:15:00 UTC', checkerCron: '0 * * * *', persistent: true } as const
export async function dailyBackup(options: Parameters<typeof runBackup>[0] & { bucket: BackupBucket }) {
  return options.lock(async () => {
    try { await recheckNewest(options.bucket, options.now()) } catch {
      try { await options.notify('daily-readback-failed') } catch { /* Still take the next backup if notification is unavailable. */ }
    }
    return runBackupLocked(options)
  })
}

// Every host uses this same key, outside the retention-locked prefixes. An
// ambiguous PUT/DELETE or crash leaves a lock: no timeout can safely fence a
// suspended pruner. Manual recovery first stops all writers and checks ownership.
export function bucketRunLock(run: Runner): RunLock {
  return async work => {
    const body = Buffer.from(randomUUID()), hex = sha256(body)
    let response: Response
    try {
      response = await run({ method: 'PUT', key: runLockKey, body, headers: {
        'if-none-match': '*', 'x-amz-content-sha256': hex, 'x-amz-checksum-sha256': checksum(hex),
      } })
    } catch { throw new SafeFailure('lock', 'operation') }
    if (response.status < 200 || response.status >= 300) throw new SafeFailure('lock', response.status === 412 || response.status === 409 ? 'busy' : 'operation')
    try { return await work() } finally {
      try {
        const release = await run({ method: 'DELETE', key: runLockKey, headers: {} })
        if (release.status !== 204 && release.status !== 200) throw new Error('Release failed')
      } catch { throw new SafeFailure('lock', 'operation') }
    }
  }
}

export async function executeCurl(args: string[], input: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => reject(new Error('Transport failed')))
    child.on('close', code => code === 0 ? accept() : reject(new Error('Transport failed')))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function readbackDigest(bucket: UploadBucket, key: string) {
  if (bucket.readback) return bucket.readback(key)
  const body = await bucket.get(key)
  return { sha256: sha256(body), size: body.length }
}
