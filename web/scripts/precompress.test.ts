import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { test } from 'vitest'
import { precompress } from './precompress.ts'

test('Brotli output round-trips every public file and excludes private metadata and sidecars', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fk486-precompress-'))
  try {
    await mkdir(join(directory, 'assets'))
    await mkdir(join(directory, '.vite'))
    await writeFile(join(directory, '.vite/manifest.json'), '{}')
    for (const name of ['index.html', 'favicon.svg', 'assets/app.js', 'assets/app.css', 'assets/core.wasm']) {
      const raw = Buffer.from(name.repeat(100))
      await writeFile(join(directory, name), raw)
    }
    await precompress(directory)
    await precompress(directory)
    for (const name of ['index.html', 'favicon.svg', 'assets/app.js', 'assets/app.css', 'assets/core.wasm']) {
      assert.deepEqual(brotliDecompressSync(await readFile(join(directory, name + '.br'))), await readFile(join(directory, name)))
    }
    assert.deepEqual(await readdir(join(directory, '.vite')), ['manifest.json'])
    assert.ok((await readdir(join(directory, 'assets'))).every(name => !name.endsWith('.br.br')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
