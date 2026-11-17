import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

// Run after Vite writes public files too; the private manifest is never served.
export async function precompress(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.endsWith('.br')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await precompress(path)
    else if (entry.isFile()) await writeFile(path + '.br', brotliCompressSync(await readFile(path), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }))
  }
}
