/// <reference types="node" />
import type { Message, ServerEvent } from './api'
import { loadClientScenarios, type ClientScenario } from '../scripts/realtime-fixtures'
import { makeProtocolClient, msgFromFixture, observe } from '../scripts/measure-fixture-client'
import { initialState, step, type Input } from './protocol-driver-test-helpers'

// The fixture loader and protocol client live once in web/scripts (#866); these names wrap them.
export const scenarios: ClientScenario[] = loadClientScenarios()
export const message = msgFromFixture
export { observe }
export const record = (seq: number, channel = 'A'): Message => ({ history_generation: '00000000-0000-4000-8000-000000000515', mentions: [], channel_id: channel, created_seq: seq, version: seq, deleted: false, body: `m${seq}`, id: `id${seq}`,
  sender: 'other', client_message_id: `auto-${seq}`, created_at: '2026-01-01T00:00:00Z', topic_id: null, reply_to: null, reply_root_id: null })
export const moveEvent = (seq: number, root = 'id1', channel = 'A'): Extract<ServerEvent, { kind: 'move' }> => ({
  type: 'message', kind: 'move', seq, version: seq, channel_id: channel, root_id: root,
  history_generation: record(seq, channel).history_generation, source_topic_id: null,
  destination_topic_id: 'destination', operation_id: `move-${seq}`,
})
export const protocolClient = (onInput?: (input: Input) => void) => makeProtocolClient(onInput ?? (() => {}), { initialState, step })
