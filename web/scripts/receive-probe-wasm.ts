// #727 A1/A2: stands in for the wasm glue, for `src/core-wasm.ts?probe` only, and timestamps each WasmCore.step call.
import init, { WasmCore as GlueCore } from '../wasm/fukulow_client_core.js'

// Every other glue export (for example the #1103 boundaries) passes through unchanged.
export * from '../wasm/fukulow_client_core.js'

export const clock = { enter: -1, exit: -1 }
export default init

export class WasmCore extends GlueCore {
  override step(input: string): string {
    clock.enter = performance.now()
    const output = super.step(input)
    clock.exit = performance.now()
    return output
  }
}
