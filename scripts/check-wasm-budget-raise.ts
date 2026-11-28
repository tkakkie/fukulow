import { readFileSync } from 'node:fs'
import budget from './wasm-budget.json' with { type: 'json' }

const basePath = process.argv[2]
if (!basePath) throw new Error('Usage: node scripts/check-wasm-budget-raise.ts <base budget file>')

const baseCap = JSON.parse(readFileSync(basePath, 'utf8'))?.gzipCapBytes
if (!Number.isSafeInteger(baseCap) || baseCap <= 0) throw new Error('Invalid base Wasm gzip cap')

const gzipCapBytes = budget?.gzipCapBytes
if (!Number.isSafeInteger(gzipCapBytes) || gzipCapBytes <= 0) throw new Error('Invalid head Wasm gzip cap')

const labeled = process.env.WASM_BUDGET_RAISE_LABELED === 'true'
if (gzipCapBytes > baseCap && !labeled) {
  console.error(`Wasm gzip cap raised from ${baseCap} B to ${gzipCapBytes} B. A raise needs the wasm:budget-raise label and linked maintainer approval (docs/workflow.md §13).`)
  process.exitCode = 1
} else {
  console.log(`Wasm gzip cap: base ${baseCap} B, head ${gzipCapBytes} B${labeled ? ' (wasm:budget-raise set)' : ''}`)
}
