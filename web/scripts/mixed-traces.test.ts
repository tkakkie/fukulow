import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import * as driver from '../src/protocol-driver-test-helpers.ts'
import { fixtureUuid } from './client-core-ids.ts'
import { loadClientScenarios } from './measure-fixture-client.ts'
import { buildMixedTraces } from './mixed-traces.ts'
import { partitionScenarios } from './realtime-fixtures.ts'

it('keeps protocol scenarios in fixture order followed by the retention and seeded traces', () => {
  const traces = buildMixedTraces(fixtureUuid('me'), driver)
  const ids = partitionScenarios(loadClientScenarios()).running.filter((scenario) => scenario.layer !== 'controller').map((scenario) => scenario.id)
  expect(traces.map((trace) => trace.id)).toEqual([
    ...ids, 'retention-ranges-and-reference-identity', 'generated-1', 'generated-42', 'generated-464', 'generated-3735928559',
  ])
  const retention = traces[ids.length].inputs
  expect(retention).toHaveLength(923)
  expect(retention[0]).toEqual({ type: 'session_start', selfId: fixtureUuid('me') })
  const seeded = traces[ids.length + 2].inputs
  // Golden prefix from 2aba8236 through bootstrap and the first seeded action.
  expect(createHash('sha256').update(JSON.stringify(seeded.slice(0, 27))).digest('hex'))
    .toBe('aa814542c3cf1d31969127caf57d53c54d5d2787ead8e95d3638f6b1f1d5a602')
  expect(seeded.length).toBeGreaterThan(1600)
}, 20_000)
