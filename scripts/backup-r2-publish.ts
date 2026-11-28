import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { checksum, parseManifest, verifiedGeneration, type BackupBucket, type Manifest } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'

export type UploadBucket = Pick<BackupBucket, 'put' | 'head' | 'get'> & {
  readback?: (key: string) => Promise<{ sha256: string; size: number }>
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

export async function readbackDigest(bucket: UploadBucket, key: string) {
  if (bucket.readback) return bucket.readback(key)
  const body = await bucket.get(key)
  return { sha256: sha256(body), size: body.length }
}
