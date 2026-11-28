import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const wasmName = 'fukulow_client_core_bg-ABC123.wasm'
// Mix repeated text with seeded xorshift32 bytes so level 6 has a distinct gzip size.
const wasm = Buffer.alloc(256 * 1024, 'channel message ')
let randomState = 0x12345678
for (let offset = 0; offset < wasm.length; offset += 64) {
  for (let index = offset; index < offset + 16; index++) {
    randomState ^= randomState << 13
    randomState ^= randomState >>> 17
    randomState ^= randomState << 5
    wasm[index] = randomState & 0xff
  }
}
const gzipBytes = 73_743

function fixture(t: TestContext, headBudget: object = { gzipCapBytes: gzipBytes }) {
  const root = mkdtempSync(join(tmpdir(), 'fukulow-wasm-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const script of ['check-wasm-budget.ts', 'check-wasm-budget-raise.ts']) {
    copyFileSync(join(import.meta.dirname, script), join(root, script))
  }
  writeFileSync(join(root, 'wasm-budget.json'), JSON.stringify(headBudget))
  mkdirSync(join(root, 'dist/assets'), { recursive: true })

  const run = (script: string, arg: string, labeled = false) => spawnSync(process.execPath, [script, arg], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WASM_BUDGET_RAISE_LABELED: String(labeled) },
  })
  return {
    asset: (name: string) => writeFileSync(join(root, 'dist/assets', name), wasm),
    checkSize: () => run('check-wasm-budget.ts', 'dist'),
    checkRaise(base: object, labeled = false) {
      writeFileSync(join(root, 'base.json'), JSON.stringify(base))
      return run('check-wasm-budget-raise.ts', 'base.json', labeled)
    },
  }
}

test('rejects a Wasm asset one gzip byte over the cap', (t) => {
  const { asset, checkSize } = fixture(t, { gzipCapBytes: gzipBytes - 1 })
  asset(wasmName)
  const result = checkSize()
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /exceeds the gzip cap by 1 B/)
})

test('accepts a Wasm asset exactly at the gzip cap and prints both sizes', (t) => {
  const { asset, checkSize } = fixture(t)
  asset(wasmName)
  asset(`${wasmName}.br`)
  const result = checkSize()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`${wasm.length} B raw, ${gzipBytes} B gzip`))
})

test('reports the exact level-6 gzip size of the fixture', (t) => {
  const { asset, checkSize } = fixture(t, { gzipCapBytes: wasm.length })
  asset(wasmName)
  const result = checkSize()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout.trimEnd(),
    `${wasmName}: ${wasm.length} B raw, ${gzipBytes} B gzip (level 6, cap ${wasm.length} B)`,
  )
})

test('accepts raw size above the cap when gzip size is below it', (t) => {
  const cap = gzipBytes + 1
  assert.ok(wasm.length > cap)
  const { asset, checkSize } = fixture(t, { gzipCapBytes: cap })
  asset(wasmName)
  const result = checkSize()
  assert.equal(result.status, 0, result.stderr)
})

test('rejects a build with no Wasm asset', (t) => {
  const result = fixture(t).checkSize()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Expected exactly one Wasm asset .* found 0/)
})

test('rejects a build with multiple Wasm assets', (t) => {
  const { asset, checkSize } = fixture(t)
  asset(wasmName)
  asset('other.wasm')
  const result = checkSize()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Expected exactly one Wasm asset .* found 2/)
})

test('rejects a lone Wasm asset from a different module', (t) => {
  const { asset, checkSize } = fixture(t)
  asset('other.wasm')
  const result = checkSize()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Expected the fukulow_client_core_bg Wasm asset/)
})

test('rejects a non-integer gzip cap', (t) => {
  const { asset, checkSize } = fixture(t, { gzipCapBytes: gzipBytes + 0.5 })
  asset(wasmName)
  const result = checkSize()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid Wasm gzip cap/)
})

test('rejects a cap raise without the label', (t) => {
  const result = fixture(t, { gzipCapBytes: 100 }).checkRaise({ gzipCapBytes: 99 })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /raised from 99 B to 100 B.*wasm:budget-raise/)
})

test('accepts a cap raise with the label', (t) => {
  const result = fixture(t, { gzipCapBytes: 100 }).checkRaise({ gzipCapBytes: 99 }, true)
  assert.equal(result.status, 0, result.stderr)
})

test('accepts a lower cap without the label', (t) => {
  const result = fixture(t, { gzipCapBytes: 100 }).checkRaise({ gzipCapBytes: 101 })
  assert.equal(result.status, 0, result.stderr)
})

test('accepts an unchanged cap without the label', (t) => {
  const result = fixture(t, { gzipCapBytes: 100 }).checkRaise({ gzipCapBytes: 100 })
  assert.equal(result.status, 0, result.stderr)
})

test('rejects an invalid base cap even with the label', (t) => {
  const result = fixture(t, { gzipCapBytes: 100 }).checkRaise({ gzipCapBytes: '99' }, true)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid base Wasm gzip cap/)
})

for (const [description, headBudget] of [
  ['null', { gzipCapBytes: null }],
  ['string', { gzipCapBytes: 'abc' }],
  ['negative', { gzipCapBytes: -1 }],
  ['non-integer', { gzipCapBytes: 99.5 }],
  ['missing', {}],
] as const) {
  test(`rejects a ${description} head cap with and without the label`, (t) => {
    const { checkRaise } = fixture(t, headBudget)
    for (const labeled of [false, true]) {
      const result = checkRaise({ gzipCapBytes: 100 }, labeled)
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.match(result.stderr, /^Error: Invalid head Wasm gzip cap$/m)
    }
  })
}
