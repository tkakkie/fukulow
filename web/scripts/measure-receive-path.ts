// Run the paired receive-path trials for #727.
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { components, Message } from '../src/api-schema.d.ts'
import type { SyncCore, SyncView } from '../src/protocol-types.ts'
import { FIXTURE_GENERATION, fixtureUuid } from './client-core-ids.ts'
import { A2_FRAMES, BULK_CASES, type BulkCase } from './receive-cases.ts'

export type BulkTimer = <T>(acc: { ms: number }, fn: () => T) => T
type CoreFactory = (selfId: string) => SyncCore
type RealtimeHandlers = { onReady(): void; onEvent(event: unknown): void; onClose(code: number): void }
type ReplaySocket = {
  send(data: string): void; close(): void
  onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number }) => void) | null
}
type ReplayConnection = { send(message: unknown): void; close(): void }
type ConnectRealtime = (handlers: RealtimeHandlers, open: () => ReplaySocket) => ReplayConnection
type ReplaySync = {
  start(): Promise<void>; watch(ch: string): Promise<void>; get(): SyncView; close(): Promise<void>
  getTimeline(ch: string): { subscribe(listener: () => void): () => void }
}
type ReplaySyncFactory = (opts: {
  selfId: string; newId: () => string
  api: {
    listChannelEvents(ch: string): Promise<{ ok: true; data: components['schemas']['ChannelEventPage'] }>
    listMessages(ch: string): Promise<{ ok: true; data: components['schemas']['MessagePage'] }>
    sendMessage(): Promise<{ ok: false; kind: 'network' }>
  }
  connect(handlers: RealtimeHandlers): ReplayConnection
}) => ReplaySync
export type ReplayRuntime = { connectRealtime: ConnectRealtime; createProdSync: ReplaySyncFactory; createProbeSync: ReplaySyncFactory }
type ReplayParts = { total: number; parse: number; validate: number; stepInput: number; wasm: number; output: number; controller: number; steps: number }

type Options = {
  arm: string
  coreKind: string
  round: number
  bulkWarmup: number
  bulkReps: number
  selfId: string
  runBulk(subCase: BulkCase, create: CoreFactory, time: BulkTimer): number
  timedPlain: BulkTimer
  createProdCore: CoreFactory
  receiveProbe: Pick<typeof import('./receive-probe-core.ts'), 'createCore' | 'probe' | 'parts' | 'resetParts'>
  loadReplay(): Promise<ReplayRuntime>
  makeMessage(seq: number, channel: string): Message
  releaseCores(): Promise<void>
  assertReplay(view: SyncView): void
  emit(record: Record<string, unknown>): void
}

export async function measureReceivePath({
  arm, coreKind, round, bulkWarmup, bulkReps, selfId, runBulk, timedPlain, createProdCore,
  receiveProbe, loadReplay, makeMessage, releaseCores, assertReplay, emit,
}: Options): Promise<void> {
  const timedProbe = <T>(acc: { ms: number }, fn: () => T): T => {
    receiveProbe.probe.armed = true
    const t0 = performance.now(), r = fn(); acc.ms += performance.now() - t0
    receiveProbe.probe.armed = false
    return r
  }
  for (const subCase of BULK_CASES) {
    const plain: number[] = [], probed: Array<{ total: number; input: number; wasm: number; output: number; steps: number }> = []
    for (let r = 0; r < bulkWarmup + bulkReps; r++) {
      const plainMs = runBulk(subCase, createProdCore, timedPlain); await releaseCores()
      receiveProbe.resetParts()
      const total = runBulk(subCase, receiveProbe.createCore, timedProbe), { input, wasm, output, steps } = receiveProbe.parts
      await releaseCores()
      if (steps === 0) throw new Error(`A1 ${subCase}: no probed step`)
      if (r >= bulkWarmup) { plain.push(plainMs); probed.push({ total, input, wasm, output, steps }) }
    }
    emit({ type: 'receive_a1', arm, core: coreKind, round, subCase, repetitions: bulkReps, unit: 'ms', plain, probed })
  }

  const { connectRealtime, createProdSync, createProbeSync } = await loadReplay()
  const realParse = JSON.parse
  // One trial: the Channel's base page, then `frameCount` replayed Create frames and `subscribed`, in the S3 order.
  async function runReplay(frameCount: typeof A2_FRAMES[number], probed: boolean): Promise<ReplayParts | number> {
    const ch = fixtureUuid('replay-C0'), baseSeq = 100
    let socket: ReplaySocket | undefined, sendSeq = 0, tEvent = 0, events = 0
    const sent: string[] = []
    const sync = (probed ? createProbeSync : createProdSync)({
      selfId, newId: () => fixtureUuid(`replay-cid-${++sendSeq}`),
      api: {
        async listChannelEvents() { return { ok: true, data: { history_generation: FIXTURE_GENERATION, events: [], has_more: false } } },
        async listMessages() { return { ok: true, data: { history_generation: FIXTURE_GENERATION, as_of_seq: baseSeq, messages: Array.from({ length: baseSeq }, (_, m) => makeMessage(m + 1, ch)), has_more: false } } },
        async sendMessage() { return { ok: false, kind: 'network' } },
      },
      connect: h => connectRealtime(probed ? { ...h, onEvent(event) { tEvent = performance.now(); events++; h.onEvent(event) } } : h,
        () => (socket = { send: d => { sent.push(d) }, close() {}, onopen: null, onmessage: null, onclose: null })),
    })
    await sync.start(); socket!.onopen!(); await sync.watch(ch); await delay(0)
    const subscribe = sent.map((d) => realParse(d) as { type: string; channel_id?: string; after_seq?: number }).find((m) => m.type === 'subscribe' && m.channel_id === ch)
    if (subscribe?.after_seq !== baseSeq) throw new Error(`A2: expected subscribe after_seq ${baseSeq}, sent ${JSON.stringify(sent)}`)
    const frames = Array.from({ length: frameCount }, (_, k) => {
      const message = makeMessage(baseSeq + 1 + k, ch)
      return JSON.stringify({ type: 'message', kind: 'create', seq: message.created_seq, message })
    })
    frames.push(JSON.stringify({ history_generation: FIXTURE_GENERATION, type: 'subscribed', channel_id: ch, caught_up_seq: baseSeq + frameCount }))
    let lastNotify = 0, notifications = 0, parse = 0, validate = 0, armParse = false
    const unsubscribe = sync.getTimeline(ch).subscribe(() => { lastNotify = performance.now(); notifications++ })
    // Only the frame's own JSON.parse in realtime.ts is timed: it is the first parse of each onmessage call.
    const timedParse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (!armParse) return realParse(text, reviver)
      armParse = false
      const p0 = performance.now(), value: unknown = realParse(text, reviver); parse += performance.now() - p0
      return value
    }) as typeof JSON.parse
    if (probed) { JSON.parse = timedParse; receiveProbe.resetParts(); receiveProbe.probe.armed = true }
    const last = frames[frames.length - 1]
    let beforeLast = -1
    const t0 = performance.now()
    try {
      for (const data of frames) {
        if (data === last) beforeLast = notifications
        if (!probed) { socket!.onmessage!({ data }); continue }
        const f0 = performance.now(), parsedBefore = parse
        armParse = true; socket!.onmessage!({ data })
        validate += tEvent - f0 - (parse - parsedBefore)
      }
    } finally {
      receiveProbe.probe.armed = false; JSON.parse = realParse
    }
    const total = lastNotify - t0
    const view = sync.get().channels[ch]
    if (view?.cursor !== baseSeq + frameCount) throw new Error(`A2: cursor ${view?.cursor} !== ${baseSeq + frameCount}`)
    assertReplay(sync.get())
    // total ends at the last notification, so the final frame must notify or total would miss it.
    if (notifications <= beforeLast || total <= 0) throw new Error('A2: the final frame sent no view notification')
    if (probed && events !== frames.length) throw new Error(`A2: ${events} events reached the controller, expected ${frames.length}`)
    const { input: stepInput, wasm, output, steps } = receiveProbe.parts
    unsubscribe(); await sync.close()
    if (!probed) return total
    return { total, parse, validate, stepInput, wasm, output, controller: total - parse - validate - stepInput - wasm - output, steps }
  }
  for (const frameCount of A2_FRAMES) {
    const plain: number[] = [], probed: ReplayParts[] = []
    for (let r = 0; r < bulkWarmup + bulkReps; r++) {
      const plainMs = await runReplay(frameCount, false); await releaseCores()
      const parts = await runReplay(frameCount, true); await releaseCores()
      if (typeof plainMs !== 'number' || typeof parts === 'number') throw new Error('A2: trial kind mismatch')
      if (r >= bulkWarmup) { plain.push(plainMs); probed.push(parts) }
    }
    emit({ type: 'receive_a2', arm, core: coreKind, round, frames: frameCount, repetitions: bulkReps, unit: 'ms', plain, probed })
  }
}
