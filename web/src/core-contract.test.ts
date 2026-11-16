import { expect, it } from 'vitest'
import { createCore as wasmCore } from './core-wasm'
import { createCore as tsCore } from './core-ts'
import type { Input } from './protocol-types'

it('the build switch preserves the bounded sync contract and never changes API values', () => {
  const self = '00000000-0000-0000-0000-000000000001'
  const channel = '00000000-0000-0000-0000-000000000002'
  const wasm = wasmCore(self), ts = tsCore(self)
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
  const inputs: Input[] = [
    { type: 'session_start', selfId: self }, { type: 'connection_ready', connection: 1 },
    { type: 'watch', channel },
    { type: 'history_result', request: 3, page: { messages: [], has_more: false } },
    { type: 'user_send', channel, clientMessageId: self, body: '本文\n👋', topic_name: 'Topic' },
    { type: 'channel_unavailable', channel }, { type: 'organization_unavailable' },
    { type: 'stop' }, { type: 'stop' },
  ]
  expect(plain(wasm.get())).toEqual(plain(ts.get()))
  for (const input of inputs) {
    const a = wasm.step(input), b = ts.step(input)
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
    expect({ ...a, changedChannels: [...a.changedChannels], records: [...a.records] })
      .toEqual({ ...b, changedChannels: [...b.changedChannels], records: [...b.records] })
    expect(plain(wasm.get())).toEqual(plain(ts.get()))
    expect(Object.keys(wasm.get()).sort()).toEqual(Object.keys(ts.get()).sort())
    expect('requests' in wasm.get() || 'timers' in wasm.get()).toBe(false)
    for (let token = 1; token < 10; token++) {
      expect(plain(wasm.request(token) ?? null)).toEqual(plain(ts.request(token) ?? null))
      expect(plain(wasm.timer(token) ?? null)).toEqual(plain(ts.timer(token) ?? null))
    }
  }
})
