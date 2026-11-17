import type { BackupBucket, ObjectInfo } from '../../scripts/backup-r2-inventory.ts'
import type { Guard, R2Binding, R2Listing, R2Object } from './bindings.ts'

function info(object: R2Object): ObjectInfo {
  if (!object || typeof object.key !== 'string' || !object.key || !Number.isSafeInteger(object.size) || object.size < 0 ||
    !(object.uploaded instanceof Date) || !Number.isFinite(object.uploaded.getTime())) throw new Error('Invalid R2 metadata')
  const sha = object.checksums?.sha256
  if (sha !== undefined && (!(sha instanceof ArrayBuffer) || sha.byteLength !== 32)) throw new Error('Invalid R2 checksum')
  return { key: object.key, size: object.size, uploaded: object.uploaded.getTime(),
    checksum: sha ? btoa(String.fromCharCode(...new Uint8Array(sha))) : '' }
}
export function imagesAdapter(binding: R2Listing, guard: Guard, maxPages = 10_000) {
  return { async list(): Promise<ObjectInfo[]> {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('Invalid R2 page cap')
    const objects: ObjectInfo[] = [], keys = new Set<string>(), cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      await guard()
      const result = await binding.list({ limit: 1000, ...(cursor ? { cursor } : {}) })
      await guard()
      if (!result || !Array.isArray(result.objects) || result.objects.length > 1000 || typeof result.truncated !== 'boolean' ||
        (result.delimitedPrefixes !== undefined && (!Array.isArray(result.delimitedPrefixes) || result.delimitedPrefixes.length))) throw new Error('Invalid R2 listing')
      for (const object of result.objects) {
        const value = info(object)
        if (keys.has(value.key)) throw new Error('Duplicate R2 key')
        keys.add(value.key); objects.push(value)
      }
      if (!result.truncated) {
        if (result.cursor !== undefined) throw new Error('Unexpected R2 cursor')
        return objects
      }
      if (typeof result.cursor !== 'string' || !result.cursor || cursors.has(result.cursor) || !result.objects.length) throw new Error('Inconsistent R2 cursor')
      cursors.add(result.cursor); cursor = result.cursor
    }
    throw new Error('R2 page cap exceeded')
  } }
}
export function backupAdapter(binding: R2Binding, guard: Guard): BackupBucket {
  return {
    ...imagesAdapter(binding, guard),
    async head(key) {
      await guard()
      const object = await binding.head(key)
      await guard()
      if (!object) return null
      const value = info(object)
      if (value.key !== key) throw new Error('R2 key mismatch')
      return value
    },
    async get(key) {
      // Only small JSON objects may be fetched by the independent checker.
      if (!/\/(manifest|verified)\.json$/.test(key)) throw new Error('Checker body access refused')
      await guard()
      const object = await binding.get(key)
      await guard()
      if (!object || info(object).key !== key || object.size > 16_384) throw new Error('Invalid R2 JSON object')
      const body = await object.arrayBuffer()
      await guard()
      if (body.byteLength !== object.size || body.byteLength > 16_384) throw new Error('Invalid R2 JSON body')
      return new Uint8Array(body)
    },
    async delete(key) {
      await guard()
      await binding.delete(key)
      await guard()
    },
    async put() { throw new Error('Checker upload refused') },
  }
}
