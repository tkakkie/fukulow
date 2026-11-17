import { createHash } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import { createServer as createSecureServer, type ServerOptions } from 'node:https'
import { networkInterfaces } from 'node:os'
import { day, checksum, sha256, type BackupBucket, type ObjectInfo } from './backup-r2-model.ts'
import type { Request, Response, Runner } from './backup-r2.ts'
import { runLockKey } from './backup-r2-list.ts'

export type Fault = 'lost-response' | 'truncated' | 'bad-checksum' | '5xx'
export class FakeBucket implements BackupBucket {
  objects = new Map<string, { body: Buffer; uploaded: number }>()
  calls: string[] = []
  now: () => number
  constructor(now: () => number) { this.now = now }
  async list() { this.calls.push('LIST'); return [...this.objects.keys()].filter(key => key !== runLockKey).map(key => this.info(key)!) }
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
    return o && key !== runLockKey && !key.startsWith('verification/') && this.now() - o.uploaded < (key.startsWith('restore-verified/') ? 40 : 35) * day
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

// Local loopback only; role labels are test capabilities, not stored credentials.
export async function fakeS3(now: () => number, tls?: ServerOptions) {
  const buckets = { backups: new FakeBucket(now), images: new FakeBucket(now) }
  const faults: { method: string; fault: Fault; remaining: number }[] = []
  const accesses: string[] = []
  const handler: RequestListener = async (req, res) => {
    const [pathname, query = ''] = req.url!.slice(1).split('?')
    const parameters = new URLSearchParams(query)
    const [bucketName, ...parts] = pathname.split('/').map(decodeURIComponent)
    const role = req.headers['x-test-role']
    accesses.push(`${role}:${bucketName}:${req.method}`)
    if (!['backups', 'images'].includes(bucketName) || role !== bucketName) { res.writeHead(403).end(); return }
    const bucket = buckets[bucketName as keyof typeof buckets], key = parts.join('/')
    if (String(req.headers.authorization ?? '').includes('verification-invalid')) { res.writeHead(403).end(); return }
    const injected = faults.find(f => f.method === req.method && f.remaining > 0)
    if (injected) injected.remaining--
    if (injected?.fault === '5xx') { res.writeHead(503).end(); return }
    try {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks), hash = sha256(body)
        if (req.headers['x-amz-content-sha256'] !== hash || req.headers['x-amz-checksum-sha256'] !== checksum(hash)) { res.writeHead(400).end(); return }
        if (req.headers['if-none-match'] === '*' && bucket.objects.has(key)) { res.writeHead(412).end(); return }
        await bucket.put(key, body)
        if (injected?.fault === 'lost-response') { req.socket.destroy(); return }
        res.writeHead(200, { etag: sha256(body) }).end()
      } else if (req.method === 'DELETE') {
        if (req.headers['if-match'] && req.headers['if-match'] !== sha256(bucket.objects.get(key)?.body ?? '')) { res.writeHead(412).end(); return }
        await bucket.delete(key); res.writeHead(204).end()
      } else if (!key && req.method === 'GET') {
        if (parameters.get('list-type') !== '2') { res.writeHead(400).end(); return }
        const prefix = parameters.get('prefix') ?? ''
        const all = [...bucket.objects.keys()].filter(key => key.startsWith(prefix)).sort(), token = parameters.get('continuation-token')
        const start = token ? all.indexOf(token) + 1 : 0
        if (token && start === 0) { res.writeHead(400).end(); return }
        const page = all.slice(start, start + Math.min(2, Number(parameters.get('max-keys') ?? 2))), truncated = start + page.length < all.length
        const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
        res.end(`<ListBucketResult>${prefix ? `<Prefix>${escape(prefix)}</Prefix>` : ''}<KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${escape(page.at(-1)!)}</NextContinuationToken>` : ''}${page.map(key => {
          const info = bucket.info(key)!
          return `<Contents><Key>${escape(key)}</Key><Size>${info.size}</Size><LastModified>${new Date(info.uploaded).toISOString()}</LastModified></Contents>`
        }).join('')}</ListBucketResult>`)
      } else {
        const info = await bucket.head(key)
        if (!info) { res.writeHead(404).end(); return }
        if (req.headers['if-match'] && req.headers['if-match'] !== sha256(bucket.objects.get(key)!.body)) { res.writeHead(412).end(); return }
        if (req.method === 'HEAD' && req.headers['x-amz-checksum-mode'] !== 'ENABLED') { res.writeHead(400).end(); return }
        const headers = { etag: sha256(bucket.objects.get(key)!.body), 'content-length': info.size, 'x-amz-checksum-sha256': injected?.fault === 'bad-checksum' ? checksum(sha256('wrong')) : info.checksum,
          'last-modified': new Date(info.uploaded).toUTCString() }
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else {
          const body = await bucket.get(key)
          if (injected?.fault === 'truncated') res.write(body.subarray(0, 1), () => res.destroy())
          else res.end(body)
        }
      }
    } catch { res.writeHead(409).end() }
  }
  const server = tls ? createSecureServer(tls, handler) : createServer(handler)
  const loopback = Object.values(networkInterfaces()).flat().find(info => info?.internal && info.family === 'IPv4')?.address
  if (!loopback) throw new Error('Local loopback unavailable')
  await new Promise<void>(accept => server.listen(0, loopback, accept))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local server unavailable')
  const base = new URL(`${tls ? 'https' : 'http'}://${address.address}:${address.port}`)
  const runner = (role: keyof typeof buckets, bucketName: keyof typeof buckets = role): Runner => async (request: Request): Promise<Response> => {
    const url = new URL(`/${bucketName}/${request.key.split('/').map(encodeURIComponent).join('/')}`, base)
    if (request.query) url.search = new URLSearchParams(request.query).toString()
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
  return { buckets, faults, accesses, runner, base: base.origin, close: () => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())) }
}
