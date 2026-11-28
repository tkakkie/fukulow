import assert from 'node:assert/strict'
import { FakeBucket } from './backup-r2-fake.ts'
import { day } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'
import { BackupChecker } from '../workers/backup-checker/index.ts'
import { stateKey } from '../workers/backup-checker/lease.ts'
import type { Fetch } from '../workers/backup-checker/http.ts'
import type { DurableStorage, Env, R2Binding, R2List, R2Object, StorageTransaction } from '../workers/backup-checker/bindings.ts'

export const epoch = Date.UTC(2026, 10, 17, 12)
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
class Storage implements DurableStorage {
  values = new Map<string, unknown>()
  writes: string[] = []
  before?: (op: string, key: string) => Promise<void>
  private tail = Promise.resolve()
  async get<T>(key: string): Promise<T | undefined> { await this.before?.('get', key); return structuredClone(this.values.get(key)) as T | undefined }
  async put<T>(key: string, value: T) { await this.before?.('put', key); this.values.set(key, structuredClone(value)); this.writes.push(key) }
  async delete(key: string) { await this.before?.('delete', key); this.writes.push(key); return this.values.delete(key) }
  async transaction<T>(body: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    const prior = this.tail, done = deferred()
    this.tail = done.promise
    await prior
    const copy = new Map(structuredClone([...this.values])), writes: string[] = []
    const tx: StorageTransaction = {
      get: async <U>(key: string) => { await this.before?.('get', key); return structuredClone(copy.get(key)) as U | undefined },
      put: async (key, value) => { await this.before?.('put', key); copy.set(key, structuredClone(value)); writes.push(key) },
      delete: async key => { await this.before?.('delete', key); writes.push(key); return copy.delete(key) },
    }
    try {
      const result = await body(tx)
      this.values = copy; this.writes.push(...writes)
      return result
    } finally { done.resolve() }
  }
}
export function seed(bucket: FakeBucket, capture: number, restored = false, uploaded = capture) {
  const captureTime = new Date(capture).toISOString(), body = Buffer.from('cipher')
  const manifest = { formatVersion: 1 as const, captureTime, postgresMajor: 18,
    plaintext: { size: 4, sha256: sha256('dump') }, ciphertext: { size: body.length, sha256: sha256(body) }, recipientFingerprint: sha256('public') }
  const json = Buffer.from(JSON.stringify(manifest)), prefix = `${restored ? 'restore-verified' : 'backups'}/${captureTime}${restored ? '' : '-test'}/`
  for (const [name, bytes] of [['archive.dump.age', body], ['manifest.json', json],
    ['verified.json', Buffer.from(JSON.stringify({ manifestSha256: sha256(json), verifiedTime: captureTime }))]] as const) {
    bucket.objects.set(prefix + name, { body: bytes, uploaded })
  }
  return prefix
}
class Binding implements R2Binding {
  bucket: FakeBucket
  pageSize = 1000
  before?: (op: string, key: string) => Promise<void>
  lists: { limit: number; cursor?: string }[] = []
  constructor(bucket = new FakeBucket(() => epoch)) { this.bucket = bucket }
  object(key: string): R2Object | null {
    const object = this.bucket.info(key)
    return object ? { key, size: object.size, uploaded: new Date(object.uploaded),
      checksums: { sha256: Uint8Array.from(Buffer.from(object.checksum, 'base64')).buffer } } : null
  }
  async list(options: { limit: number; cursor?: string }): Promise<R2List> {
    this.lists.push(options)
    await this.before?.('list', '')
    const keys = [...this.bucket.objects.keys()].sort(), start = options.cursor ? keys.indexOf(options.cursor) + 1 : 0
    assert.ok(!options.cursor || start > 0)
    const page = keys.slice(start, start + Math.min(options.limit, this.pageSize))
    const truncated = start + page.length < keys.length
    return { objects: page.map(key => this.object(key)!), truncated, ...(truncated ? { cursor: page.at(-1) } : {}) }
  }
  async head(key: string) { await this.before?.('head', key); return this.object(key) }
  async get(key: string) {
    await this.before?.('get', key)
    const object = this.object(key)
    return object ? { ...object, arrayBuffer: async () => Uint8Array.from(await this.bucket.get(key)).buffer } : null
  }
  async delete(key: string) { await this.before?.('delete', key); await this.bucket.delete(key) }
}
export function cachedUsage(now = epoch) {
  const month = new Date(now).toISOString().slice(0, 7), days: Record<string, { classA: number; classB: number }> = {}
  for (let time = Date.parse(month + '-01'); time + day + 6 * 60 * 60 * 1000 <= now; time += day) {
    days[new Date(time).toISOString().slice(0, 10)] = { classA: 0, classB: 1 }
  }
  return { month, days }
}
export function fixture() {
  let now = epoch
  const clock = () => now, storage = new Storage(), binding = new Binding(new FakeBucket(clock))
  for (let i = 0; i < 30; i++) seed(binding.bucket, epoch - i * day)
  const source = seed(binding.bucket, epoch - 70 * day), candidate = seed(binding.bucket, epoch - 80 * day)
  const drill = seed(binding.bucket, epoch - 70 * day, true, epoch - day)
  storage.values.set(stateKey, { version: 1, state: { sentAlerts: [], aliveDate: '2026-11-17', usageCache: cachedUsage() } })
  const events: string[] = [], requests: { url: string; init?: RequestInit }[] = []
  const request: Fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('notify.invalid')) {
      events.push(JSON.parse(String(init?.body)).content)
      return new Response(null, { status: 204 })
    }
    return Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 1 } },
    ] }] } } })
  }
  const env: Env = { BACKUPS: binding, IMAGES: { list: async () => ({ objects: [], truncated: false }) },
    DISCORD_WEBHOOK_URL: 'https://notify.invalid/', ANALYTICS_URL: 'https://analytics.invalid/', ANALYTICS_TOKEN: 'test-only', ANALYTICS_ACCOUNT: 'test-only',
    CHECKER: { idFromName: () => { throw new Error('unused') }, get: () => { throw new Error('unused') } } }
  const create = () => new BackupChecker({ storage }, env, { now: clock, request })
  return { storage, binding, env, events, requests, clock, advance: (ms: number) => { now += ms }, create, source, candidate, drill }
}
export const noGuard = async () => {}
