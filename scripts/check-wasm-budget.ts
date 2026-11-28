import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import budget from './wasm-budget.json' with { type: 'json' }

const directory = process.argv[2]
if (!directory) throw new Error('Usage: node scripts/check-wasm-budget.ts <build directory>')
const { gzipCapBytes } = budget
if (!Number.isSafeInteger(gzipCapBytes) || gzipCapBytes <= 0) throw new Error('Invalid Wasm gzip cap in scripts/wasm-budget.json')

const assets = readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.wasm'))
if (assets.length !== 1) throw new Error(`Expected exactly one Wasm asset in ${directory}, found ${assets.length}`)

const [asset] = assets
if (!/^fukulow_client_core_bg(?:-[\w-]+)?\.wasm$/.test(asset.name)) {
  throw new Error(`Expected the fukulow_client_core_bg Wasm asset, found ${asset.name}`)
}

const wasm = readFileSync(join(asset.parentPath, asset.name))
const gzipBytes = gzipSync(wasm, { level: 6 }).length
console.log(`${asset.name}: ${wasm.length} B raw, ${gzipBytes} B gzip (level 6, cap ${gzipCapBytes} B)`)
if (gzipBytes > gzipCapBytes) {
  console.error(`Wasm exceeds the gzip cap by ${gzipBytes - gzipCapBytes} B`)
  process.exitCode = 1
}
