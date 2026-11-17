import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createCore } from './core-wasm'
import type { Input } from './protocol-types'
import { fixtureUuid, normalizeInput } from '../scripts/client-core-ids'
import { partitionScenarios } from '../scripts/realtime-fixtures'
import { scenarios } from './protocol-test-helpers'

type Node = null | boolean | number | string | number[] | { [key: string]: number }
const contract = JSON.parse(readFileSync(new URL('../../contract/realtime/core-traces.json', import.meta.url), 'utf8')) as {
  values: Node[]; steps: { trace: string; input: number; expected: number }[]
}
// Arrays and objects contain indexes of earlier values; scalars are literal JSON.
// This lossless table records all 9,170 original TS-reference steps without repeated snapshots.
function expand(index: number, values: Node[] = contract.values): unknown {
  if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) throw new Error('missing contract value')
  const value = values[index]
  const child = (id: number): unknown => {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid contract reference')
    if (id >= index) throw new Error('contract references must point to earlier values')
    return expand(id, values)
  }
  if (Array.isArray(value)) return value.map(child)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, child(v)]))
  return value
}

it('rejects missing values self and forward references and non-integer references', () => {
  expect(() => expand(1, [null])).toThrow('missing contract value')
  for (const reference of [1, 2, 3, -1, 0.5, '0']) {
    for (const node of [[reference], { child: reference }]) {
      const error = typeof reference === 'number' && Number.isSafeInteger(reference) && reference >= 0
        ? 'contract references must point to earlier values' : 'invalid contract reference'
      expect(() => expand(1, [null, node as Node, null]), JSON.stringify(node)).toThrow(error)
    }
  }
  expect(expand(1, [null, [0]])).toEqual([null])
})

it('normalizes symbolic identities consistently without changing payloads or numeric generations', () => {
  expect(fixtureUuid('me')).toBe(fixtureUuid('me'))
  expect(fixtureUuid(fixtureUuid('me'))).toBe(fixtureUuid('me'))
  const symbols = ['A','B','me','other','parent','root','mention',...Array.from({length: 2000},(_,i) => `id${i}`)]
  expect(new Set(symbols.map(fixtureUuid)).size).toBe(symbols.length)
  const input: Input = { type: 'user_send', channel: 'A', clientMessageId: 'A', body: 'A' }
  expect(normalizeInput(input)).toEqual({ ...input, channel: fixtureUuid('A'), clientMessageId: fixtureUuid('A') })
})
it('matches recorded fixture retention and seeded contracts at every wasm step', () => {
  let current = '', core = createCore(fixtureUuid('me')), tokens = new Set<number>()
  const counts = new Map<string, number>()
  for (const entry of contract.steps) {
    const input = expand(entry.input) as Input
    const expected = expand(entry.expected) as { session: { selfId: string } }
    if (entry.trace !== current) {
      current = entry.trace; core = createCore(expected.session.selfId); tokens = new Set()
    }
    const result = core.step(input)
    for (const effect of result.effects) if ('id' in effect) tokens.add(effect.id)
    const requests = Object.fromEntries([...tokens].flatMap(id => { const r = core.request(id); return r ? [[id, r]] : [] }))
    const timers = Object.fromEntries([...tokens].flatMap(id => { const t = core.timer(id); return t ? [[id, t]] : [] }))
    const { channels, ...session } = core.get()
    const observed = { effects: result.effects, changedChannels: [...result.changedChannels], records: [...result.records],
      stateChanged: result.stateChanged, channels, session, requests, timers }
    counts.set(current, (counts.get(current) ?? 0) + 1)
    expect(JSON.parse(JSON.stringify(observed)), `${current} step ${counts.get(current)}`).toEqual(expected)
  }
  const fixtures = partitionScenarios(scenarios).running.filter(s => s.layer !== 'controller')
  expect([...counts.keys()].filter(id => !id.startsWith('generated-') && id !== 'retention-ranges-and-reference-identity')).toEqual(fixtures.map(s => s.id))
  expect(counts.size).toBe(66)
  expect(contract.steps).toHaveLength(9170)
  expect(counts.get('retention-ranges-and-reference-identity')).toBe(923)
  for (const [seed, count] of [[1, 1907], [42, 1907], [464, 1907], [0xdeadbeef, 1911]]) expect(counts.get(`generated-${seed}`)).toBe(count)
}, 60_000)
