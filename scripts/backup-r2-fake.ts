import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { day, checksum, sha256, type BackupBucket, type ObjectInfo } from './backup-r2-model.ts'
import type { Request, Response, Runner } from './backup-r2.ts'

export type Fault = 'lost-response' | 'truncated' | 'bad-checksum' | '5xx'
export class FakeBucket implements BackupBucket {
  objects = new Map<string, { body: Buffer; uploaded: number }>()
  calls: string[] = []
  now: () => number
  constructor(now: () => number) { this.now = now }
  async list() { this.calls.push('LIST'); return [...this.objects.keys()].map(key => this.info(key)!) }
  info(key: string): ObjectInfo | null {
    const o = this.objects.get(key)
    return o ? { key, size: o.body.length, checksum: checksum(sha256(o.body)), uploaded: o.uploaded } : null
  }
  async head(key: string) { this.calls.push('HEAD ' + key); return this.info(key) }
  async get(key: string) {
    this.calls.push('GET ' + key)
    const o = this.objects.get(key)
    if (!o) throw new Error('Missing')
    return Buffer.from(o.body)
  }
  locked(key: string) {
    const o = this.objects.get(key)
    return o && this.now() - o.uploaded < (key.startsWith('restore-verified/') ? 40 : 35) * day
  }
  async put(key: string, body: Buffer) {
    if (this.locked(key)) throw new Error('Locked')
    this.objects.set(key, { body: Buffer.from(body), uploaded: this.now() })
  }
  async delete(key: string) {
    this.calls.push('DELETE ' + key)
    if (this.locked(key)) throw new Error('Locked')
    this.objects.delete(key)
  }
}

// Local HTTP only; role labels are test capabilities, not stored credentials.
export async function fakeS3(now: () => number) {
  const buckets = { backups: new FakeBucket(now), images: new FakeBucket(now) }
  const faults: { method: string; fault: Fault; remaining: number }[] = []
  const accesses: string[] = []
  const server = createServer(async (req, res) => {
    const [bucketName, ...parts] = decodeURIComponent(req.url!.slice(1)).split('/')
    const role = req.headers['x-test-role']
    accesses.push(`${role}:${bucketName}:${req.method}`)
    if (!['backups', 'images'].includes(bucketName) || role !== bucketName) { res.writeHead(403).end(); return }
    const bucket = buckets[bucketName as keyof typeof buckets], key = parts.join('/')
    const injected = faults.find(f => f.method === req.method && f.remaining > 0)
    if (injected) injected.remaining--
    if (injected?.fault === '5xx') { res.writeHead(503).end(); return }
    try {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks), hash = sha256(body)
        if (req.headers['x-amz-content-sha256'] !== hash || req.headers['x-amz-checksum-sha256'] !== checksum(hash)) { res.writeHead(400).end(); return }
        await bucket.put(key, body)
        if (injected?.fault === 'lost-response') { req.socket.destroy(); return }
        res.writeHead(200).end()
      } else if (req.method === 'DELETE') {
        await bucket.delete(key); res.writeHead(204).end()
      } else if (!key && req.method === 'GET') {
        res.end(JSON.stringify(await bucket.list()))
      } else {
        const info = await bucket.head(key)
        if (!info) { res.writeHead(404).end(); return }
        if (req.method === 'HEAD' && req.headers['x-amz-checksum-mode'] !== 'ENABLED') { res.writeHead(400).end(); return }
        const headers = { 'content-length': info.size, 'x-amz-checksum-sha256': injected?.fault === 'bad-checksum' ? checksum(sha256('wrong')) : info.checksum,
          'last-modified': new Date(info.uploaded).toUTCString() }
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else {
          const body = await bucket.get(key)
          if (injected?.fault === 'truncated') { res.write(body.subarray(0, 1)); res.destroy() }
          else res.end(body)
        }
      }
    } catch { res.writeHead(409).end() }
  })
  const loopback = Object.values(networkInterfaces()).flat().find(info => info?.internal && info.family === 'IPv4')?.address
  if (!loopback) throw new Error('Local loopback unavailable')
  await new Promise<void>(accept => server.listen(0, loopback, accept))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local server unavailable')
  const base = new URL(`http://${address.address}:${address.port}`)
  const runner = (role: keyof typeof buckets, bucketName: keyof typeof buckets = role): Runner => async (request: Request): Promise<Response> => {
    const url = new URL(`/${bucketName}/${request.key}`, base)
    const r = await fetch(url, { method: request.method, headers: { ...request.headers, 'x-test-role': role }, body: request.body ? new Uint8Array(request.body) : undefined })
    if (request.digestOnly && r.body) {
      const hash = createHash('sha256'); let size = 0
      const reader = r.body.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          hash.update(chunk.value); size += chunk.value.length
        }
      } finally { reader.releaseLock() }
      return { status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.alloc(0), digest: { sha256: hash.digest('hex'), size } }
    }
    return { status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) }
  }
  return { buckets, faults, accesses, runner, close: () => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())) }
}
