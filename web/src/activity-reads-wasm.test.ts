import { expect, it, vi } from 'vitest'
import { WasmActivityReads } from '../wasm/fukulow_client_core'
import { createActivityReadsCore, EffectCode, InputCode } from './activity-reads-wasm'

it('rejects an unknown activity read effect code', () => {
  const step = vi.spyOn(WasmActivityReads.prototype, 'step')
    .mockReturnValueOnce(Float64Array.of(EffectCode.Run, 255))
  try {
    const core = createActivityReadsCore({})
    expect(() => core.step({ type: InputCode.Ensure }, 0))
      .toThrow('Unknown activity read effect code: 255')
  } finally {
    step.mockRestore()
  }
})
