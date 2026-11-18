import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createCore } from './core-wasm'
import type { Input } from './protocol-types'

it('the wasm bridge preserves the recorded bounded sync contract and API values', () => {
  const contract = JSON.parse(readFileSync(new URL('../../contract/realtime/core-boundary.json', import.meta.url), 'utf8')) as {
    self: string; initial: unknown; steps: { input: Input; expected: unknown }[]
  }
  const core = createCore(contract.self)
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
  const snapshot = () => ({ view: core.get(),
    requests: Object.fromEntries(Array.from({ length: 9 }, (_, i) => i + 1).flatMap(id => { const r = core.request(id); return r ? [[id, r]] : [] })),
    timers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => i + 1).flatMap(id => { const t = core.timer(id); return t ? [[id, t]] : [] })),
  })
  expect(plain(snapshot())).toEqual(contract.initial)
  for (const { input, expected } of contract.steps) {
    const result = core.step(input)
    expect(Object.keys(result).sort()).toEqual(['changedChannels', 'effects', 'records', 'stateChanged'])
    expect(plain({ ...snapshot(), result: { ...result, changedChannels: [...result.changedChannels], records: [...result.records] } })).toEqual(expected)
    expect('requests' in core.get() || 'timers' in core.get()).toBe(false)
  }
})
