import { createHash } from 'node:crypto'

export const day = 86_400_000
export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
export const checksum = (hex: string) => Buffer.from(hex, 'hex').toString('base64')
export interface ObjectInfo { key: string; size: number; checksum: string; uploaded: number }
export interface ReadBucket {
  list(): Promise<ObjectInfo[]>
  head(key: string): Promise<ObjectInfo | null>
  get(key: string): Promise<Buffer>
}
export interface BackupBucket extends ReadBucket {
  put(key: string, body: Buffer): Promise<void>
  delete(key: string): Promise<void>
}
export interface Manifest {
  formatVersion: 1; captureTime: string; postgresMajor: number
  plaintext: { sha256: string; size: number }; ciphertext: { sha256: string; size: number }
  recipientFingerprint: string
}
export interface Generation { prefix: string; manifest: Manifest; objects: ObjectInfo[] }
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === keys.sort().join()
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const utc = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
const digest = (v: unknown) => exact(v, ['sha256', 'size']) && hash(v.sha256) && Number.isSafeInteger(v.size) && Number(v.size) > 0
export function parseManifest(body: Buffer): Manifest {
  const m = JSON.parse(body.toString())
  if (!exact(m, ['formatVersion', 'captureTime', 'postgresMajor', 'plaintext', 'ciphertext', 'recipientFingerprint']) ||
    m.formatVersion !== 1 || !utc(m.captureTime) || !Number.isSafeInteger(m.postgresMajor) || Number(m.postgresMajor) < 1 ||
    !digest(m.plaintext) || !digest(m.ciphertext) || !hash(m.recipientFingerprint)) throw new Error('Malformed manifest')
  return m as unknown as Manifest
}
export async function verifiedGeneration(bucket: Pick<ReadBucket, 'head' | 'get'>, prefix: string, now: number): Promise<Generation> {
  const match = /^(backups|restore-verified)\/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)(?:-([a-zA-Z0-9-]+))?\/$/.exec(prefix)
  if (!match || (match[1] === 'backups' ? !match[3] : !!match[3])) throw new Error('Malformed prefix')
  const marker = JSON.parse((await bucket.get(prefix + 'verified.json')).toString())
  const body = await bucket.get(prefix + 'manifest.json')
  if (!exact(marker, ['manifestSha256', 'verifiedTime']) || !hash(marker.manifestSha256) ||
    !utc(marker.verifiedTime) || marker.manifestSha256 !== sha256(body)) throw new Error('Malformed marker')
  const manifest = parseManifest(body)
  if (manifest.captureTime !== match[2] || Date.parse(manifest.captureTime) > now + 300_000) throw new Error('Invalid capture time')
  const objects: ObjectInfo[] = []
  for (const key of ['archive.dump.age', 'manifest.json', 'verified.json']) {
    const info = await bucket.head(prefix + key)
    if (!info) throw new Error('Missing object')
    objects.push(info)
  }
  if (objects[0].size !== manifest.ciphertext.size || objects[0].checksum !== checksum(manifest.ciphertext.sha256)) throw new Error('Invalid archive')
  return { prefix, manifest, objects }
}
export async function inventory(bucket: ReadBucket, now: number) {
  const objects = await bucket.list()
  const prefixes = new Set(objects.map(o => o.key.slice(0, o.key.lastIndexOf('/') + 1)))
  const verified: Generation[] = [], malformed: string[] = []
  for (const prefix of prefixes) {
    try { verified.push(await verifiedGeneration(bucket, prefix, now)) } catch { malformed.push(prefix) }
  }
  verified.sort((a, b) => Date.parse(b.manifest.captureTime) - Date.parse(a.manifest.captureTime) || b.prefix.localeCompare(a.prefix))
  return { objects, verified, malformed }
}
