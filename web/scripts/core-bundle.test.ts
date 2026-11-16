import { expect, it } from 'vitest'
import { checkCoreBundle } from './core-bundle.ts'
it('ships exactly one implementation and rejects mixed missing or duplicate wasm bundles', () => {
  const wasm = ['/src/core-wasm.ts', '/wasm/fukulow_client_core.js']
  const ts = ['/src/core-ts.ts', '/src/protocol.ts']
  expect(() => checkCoreBundle('wasm', wasm, ['assets/core.wasm'])).not.toThrow()
  expect(() => checkCoreBundle('ts', ts, [])).not.toThrow()
  for (const [implementation, modules, assets] of [
    ['wasm', [...wasm, ...ts], ['assets/core.wasm']], ['ts', [...wasm, ...ts], []],
    ['wasm', wasm, []], ['wasm', wasm, ['a.wasm', 'b.wasm']], ['ts', ts, ['core.wasm']],
    ['wasm', [...wasm, '/scripts/core-test-values.ts'], ['assets/core.wasm']],
    ['wasm', [...wasm, '/src/protocol-driver.ts'], ['assets/core.wasm']],
    ['wasm', [], ['core.wasm']], ['ts', [], []], ['wasm', [wasm[0]], ['core.wasm']],
  ] as [string, string[], string[]][]) expect(() => checkCoreBundle(implementation, modules, assets)).toThrow()
})
