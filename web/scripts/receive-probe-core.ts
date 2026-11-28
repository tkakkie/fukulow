// #727 A1/A2: splits each armed SyncCore.step into input conversion, wasm and output, around the production
// `src/core-wasm.ts` (loaded as `?probe` with production core-values and the timestamping glue).
import type { SyncCore } from '../src/protocol-types.ts'
import { clock } from './receive-probe-wasm.ts'

export type StepParts = { input: number; wasm: number; output: number; steps: number }
export const parts: StepParts = { input: 0, wasm: 0, output: 0, steps: 0 }
export const probe = { armed: false }
export function resetParts(): void {
  parts.input = 0; parts.wasm = 0; parts.output = 0; parts.steps = 0
}

const inner = (await import(`${new URL('../src/core-wasm.ts', import.meta.url).href}?probe`)) as {
  createCore(selfId: string): SyncCore
  inputMessages: typeof import('#sync-core').inputMessages
}
export const { inputMessages } = inner

export function createCore(selfId: string): SyncCore {
  const core = inner.createCore(selfId)
  return {
    ...core,
    step(input) {
      if (!probe.armed) return core.step(input)
      clock.enter = clock.exit = -1
      const t0 = performance.now(), result = core.step(input), t3 = performance.now()
      if (clock.enter < t0 || clock.exit < clock.enter || t3 < clock.exit) throw new Error('probe: WasmCore.step was not timed inside SyncCore.step')
      parts.input += clock.enter - t0; parts.wasm += clock.exit - clock.enter; parts.output += t3 - clock.exit; parts.steps++
      return result
    },
  }
}
