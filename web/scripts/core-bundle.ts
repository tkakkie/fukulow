import assert from 'node:assert/strict'
export function checkCoreBundle(modules: string[], assets: string[]): void {
  const has = (file: string) => modules.some(id => id.replaceAll('\\', '/').endsWith('/' + file))
  assert.ok(!has('src/protocol-driver-test-helpers.ts') && !has('scripts/core-test-values.ts'), 'test State facade and symbolic IDs must never ship')
  const wasm = assets.filter(file => file.endsWith('.wasm'))
  assert.ok(has('src/core-wasm.ts'), 'wasm bundle must contain the Rust bridge')
  assert.ok(has('wasm/fukulow_client_core.js'), 'wasm glue must be in a manifest chunk')
  assert.equal(wasm.length, 1, 'wasm bundle must emit exactly one wasm asset')
  assert.ok(!has('src/protocol.ts') && !has('src/core-ts.ts'), 'wasm bundle must exclude the TS implementation')
}
