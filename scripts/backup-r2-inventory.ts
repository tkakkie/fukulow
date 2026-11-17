export const day = 86_400_000
export const uploadGrace = 6 * 60 * 60 * 1000
export const checksum = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map(byte => parseInt(byte, 16))))
async function sha256(body: Uint8Array): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new Uint8Array(body))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export interface ObjectInfo { key: string; size: number; checksum: string; uploaded: number }
export interface ReadBucket {
  list(): Promise<ObjectInfo[]>
  head(key: string): Promise<ObjectInfo | null>
  get(key: string): Promise<Uint8Array>
}
export interface BackupBucket extends ReadBucket {
  put(key: string, body: Uint8Array): Promise<void>
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
function captureFromPrefix(prefix: string): string | null {
  const match = /^(backups|restore-verified)\/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)(?:-([a-zA-Z0-9-]+))?\/$/.exec(prefix)
  return match && utc(match[2]) && (match[1] === 'backups' ? !!match[3] : !match[3]) ? match[2] : null
}
export function parseManifest(body: Uint8Array): Manifest {
  const m = JSON.parse(new TextDecoder().decode(body))
  if (!exact(m, ['formatVersion', 'captureTime', 'postgresMajor', 'plaintext', 'ciphertext', 'recipientFingerprint']) ||
    m.formatVersion !== 1 || !utc(m.captureTime) || !Number.isSafeInteger(m.postgresMajor) || Number(m.postgresMajor) < 1 ||
    !digest(m.plaintext) || !digest(m.ciphertext) || !hash(m.recipientFingerprint)) throw new Error('Malformed manifest')
  return m as unknown as Manifest
}
export async function verifiedGeneration(bucket: Pick<ReadBucket, 'head' | 'get'>, prefix: string, now: number): Promise<Generation> {
  const capture = captureFromPrefix(prefix)
  if (!capture) throw new Error('Malformed prefix')
  const marker = JSON.parse(new TextDecoder().decode(await bucket.get(prefix + 'verified.json')))
  const body = await bucket.get(prefix + 'manifest.json')
  if (!exact(marker, ['manifestSha256', 'verifiedTime']) || !hash(marker.manifestSha256) ||
    !utc(marker.verifiedTime) || marker.manifestSha256 !== await sha256(body)) throw new Error('Malformed marker')
  const manifest = parseManifest(body)
  if (manifest.captureTime !== capture || Date.parse(manifest.captureTime) > now + 300_000) throw new Error('Invalid capture time')
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
  // Locked provider probes are capacity only: never generations or prune candidates.
  const prefixes = new Set(objects.filter(o => !/^backups\/verification-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\//.test(o.key)).map(o => o.key.slice(0, o.key.lastIndexOf('/') + 1)))
  const verified: Generation[] = [], malformed: string[] = [], inProgress: string[] = []
  for (const prefix of prefixes) {
    try { verified.push(await verifiedGeneration(bucket, prefix, now)) } catch {
      // Upload time is safer than capture time: dumps and restore copies can be
      // old when their first object arrives. Unknown namespaces never get grace.
      const generation = captureFromPrefix(prefix) !== null
      const newest = Math.max(...objects.filter(object => object.key.startsWith(prefix)).map(object => object.uploaded))
      if (generation && Number.isFinite(newest) && now - newest < uploadGrace) inProgress.push(prefix)
      else malformed.push(prefix)
    }
  }
  verified.sort((a, b) => Date.parse(b.manifest.captureTime) - Date.parse(a.manifest.captureTime) || b.prefix.localeCompare(a.prefix))
  return { objects, verified, malformed, inProgress }
}
