import assert from 'node:assert/strict'
import { brotliDecompressSync } from 'node:zlib'

export interface AssetResponse { headers: string; body: Buffer }
export type AssetFetch = (path: string, encoding?: string) => AssetResponse

// Discover the shipped bundle, including lazy chunks and wasm, from identity
// responses rather than assuming host and Docker builds have identical hashes.
export function checkAssetCompression(fetch: AssetFetch) {
  const pending = new Set(['/', '/index.html', '/favicon.svg'])
  const rows = []
  for (const path of pending) {
    const raw = fetch(path)
    for (const match of raw.body.toString().matchAll(/(?:\/?assets\/[\w.-]+\.(?:js|css|wasm|svg))/g)) {
      pending.add('/' + match[0].replace(/^\//, ''))
    }
    const type = raw.headers.match(/^content-type:\s*(.+)$/im)?.[1]?.trim()
    const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    let brBytes = 0
    for (const [encoding, br] of [
      [undefined, false], ['', false], ['gzip, zstd', false], ['br;q=0, gzip', false],
      ['*;q=1, br;q=0', false], ['br', true], ['gzip, br;q=0.5', true],
      ['gzip, deflate, br, zstd', true], ['*;q=0.5', true],
    ] as const) {
      const response = fetch(path, encoding)
      assert.match(response.headers, /^HTTP\/\S+ 200/m, `${path} ${encoding}`)
      assert.ok(response.headers.toLowerCase().includes('cache-control: ' + cache))
      assert.equal(response.headers.match(/^content-type:\s*(.+)$/im)?.[1]?.trim(), type)
      assert.match(response.headers, /^vary:.*\bAccept-Encoding\b/im)
      const codings = [...response.headers.matchAll(/^content-encoding:\s*(.+)$/gim)].map(m => m[1]?.trim())
      assert.deepEqual(codings, br ? ['br'] : [], `${path} ${encoding}: no proxy recompression`)
      assert.deepEqual(br ? brotliDecompressSync(response.body) : response.body, raw.body)
      if (br) brBytes = response.body.length
    }
    if (path.endsWith('.wasm')) assert.equal(type, 'application/wasm')
    rows.push({ path, raw: raw.body.length, br: brBytes })
  }
  assert.ok(rows.some(row => row.path.endsWith('.wasm')), 'bundle includes wasm')
  assert.ok(rows.some(row => row.path.endsWith('.css')), 'bundle includes CSS')
  return rows
}
