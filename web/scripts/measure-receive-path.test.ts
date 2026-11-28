import { expect, it } from 'vitest'
import type { Message } from '../src/api-schema.d.ts'
import type { SyncView } from '../src/protocol-types.ts'
import { FIXTURE_GENERATION, fixtureUuid } from './client-core-ids.ts'
import { measureReceivePath, type ReplayRuntime } from './measure-receive-path.ts'

function makeMessage(seq: number, channel: string): Message {
  return {
    history_generation: FIXTURE_GENERATION, id: fixtureUuid(`message-${seq}`), channel_id: channel,
    created_seq: seq, version: seq, deleted: false, sender: fixtureUuid('other'),
    client_message_id: fixtureUuid(`client-${seq}`), body: `m${seq}`, created_at: '2026-01-01T00:00:00Z',
    mentions: [], topic_id: null, reply_to: null, reply_root_id: null,
  }
}

function fixture() {
  const rows: Record<string, unknown>[] = []
  const order: string[] = []
  const parts = { input: 0, wasm: 0, output: 0, steps: 0 }
  const probe = { armed: false }
  const unusedCore = () => { throw new Error('the bulk fixture supplies its own result') }
  const probedCore = () => unusedCore()
  const runtime: ReplayRuntime = {
    connectRealtime(handlers, open) {
      const socket = open()
      socket.onopen = handlers.onReady
      socket.onmessage = ({ data }) => handlers.onEvent(JSON.parse(String(data)))
      return { send: (message) => socket.send(JSON.stringify(message)), close: () => socket.close() }
    },
    createProdSync: createSync,
    createProbeSync: createSync,
  }
  function createSync({ api, connect }: Parameters<ReplayRuntime['createProdSync']>[0]) {
    let channel = '', cursor = 0, notify = () => {}
    let connection: ReturnType<typeof connect>
    return {
      async start() {
        connection = connect({
          onReady() {}, onClose() {},
          onEvent(event) {
            const { type, seq, caught_up_seq } = event as { type: string; seq?: number; caught_up_seq?: number }
            cursor = type === 'subscribed' ? caught_up_seq! : seq!
            if (probe.armed) parts.steps++
            notify()
          },
        })
      },
      async watch(ch: string) {
        const { data } = await api.listMessages(ch)
        expect(data.messages).toHaveLength(100)
        expect(data.history_generation).toBe(FIXTURE_GENERATION)
        cursor = data.as_of_seq
        connection.send({ type: 'subscribe', channel_id: ch, after_seq: cursor })
        channel = ch
      },
      get: () => ({ channels: { [channel]: { cursor } } }) as SyncView,
      async close() { connection.close() },
      getTimeline: () => ({ subscribe(listener: () => void) { notify = listener; return () => { notify = () => {} } } }),
    }
  }
  const options: Parameters<typeof measureReceivePath>[0] = {
    arm: 'W', coreKind: 'wasm', round: 2, bulkWarmup: 1, bulkReps: 2, selfId: fixtureUuid('me'),
    createProdCore: unusedCore,
    receiveProbe: {
      createCore: probedCore, parts, probe,
      resetParts: () => { Object.assign(parts, { input: 0, wasm: 0, output: 0, steps: 0 }) },
    },
    async loadReplay() { order.push('replay'); return runtime },
    makeMessage, timedPlain: (_acc, run) => run(),
    async releaseCores() {},
    assertReplay: (view) => { order.push(`cursor:${Object.values(view.channels)[0].cursor}`) },
    emit: (row) => rows.push(row),
    runBulk(subCase, create, time) {
      const probed = create === probedCore
      order.push(`${subCase}:${probed ? 'probed' : 'plain'}`)
      return time({ ms: 0 }, () => {
        expect(probe.armed).toBe(probed)
        if (probed) Object.assign(parts, { input: 1, wasm: 2, output: 3, steps: 4 })
        return probed ? 6 : 5
      })
    },
  }
  return { options, rows, order }
}

it('emits A1 before A2 with alternating trials and excludes warmups', async () => {
  const { options, rows, order } = fixture()
  const originalParse = JSON.parse
  await measureReceivePath(options)
  const cases = ['history_8x50', 'history_2x200', 'catchup_250', 'catchup_1000']
  expect(order).toEqual([
    ...cases.flatMap((subCase) => Array.from({ length: 3 }, () => [`${subCase}:plain`, `${subCase}:probed`]).flat()),
    'replay', ...Array(6).fill('cursor:350'), ...Array(6).fill('cursor:1100'),
  ])
  expect(rows.slice(0, 4)).toEqual(cases.map((subCase) => ({
    type: 'receive_a1', arm: 'W', core: 'wasm', round: 2, subCase, repetitions: 2, unit: 'ms',
    plain: [5, 5], probed: Array(2).fill({ total: 6, input: 1, wasm: 2, output: 3, steps: 4 }),
  })))
  expect(rows.slice(4)).toEqual([250, 1000].map((frames) => ({
    type: 'receive_a2', arm: 'W', core: 'wasm', round: 2, frames, repetitions: 2, unit: 'ms',
    plain: Array(2).fill(expect.any(Number)),
    probed: Array(2).fill(expect.objectContaining({ total: expect.any(Number), parse: expect.any(Number), steps: frames + 1 })),
  })))
  expect(JSON.parse).toBe(originalParse)
  expect(options.receiveProbe.probe.armed).toBe(false)
})

it('rejects an A1 trial with no probed step before loading the replay', async () => {
  const { options, rows, order } = fixture()
  await expect(measureReceivePath({ ...options, runBulk: () => 0 })).rejects.toThrow('A1 history_8x50: no probed step')
  expect(rows).toEqual([])
  expect(order).toEqual([])
})
