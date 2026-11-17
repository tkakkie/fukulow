import { expect, it } from 'vitest'
import { checkCoreBundle } from './core-bundle.ts'
it('ships exactly one implementation and rejects mixed missing or duplicate wasm bundles', () => {
  const wasm = ['/src/core-wasm.ts', '/wasm/fukulow_client_core.js']
  const ts = ['/src/core-ts.ts', '/src/protocol.ts']
  expect(() => checkCoreBundle(wasm, ['assets/core.wasm'])).not.toThrow()
  for (const [modules, assets] of [
    [[...wasm, ...ts], ['assets/core.wasm']], [[...wasm, ...ts], []],
    [wasm, []], [wasm, ['a.wasm', 'b.wasm']], [ts, ['core.wasm']],
    [[...wasm, '/scripts/core-test-values.ts'], ['assets/core.wasm']],
    [[...wasm, '/src/protocol-driver.ts'], ['assets/core.wasm']],
    [[], ['core.wasm']], [[], []], [[wasm[0]], ['core.wasm']],
  ] as [string[], string[]][]) expect(() => checkCoreBundle(modules, assets)).toThrow()
})
