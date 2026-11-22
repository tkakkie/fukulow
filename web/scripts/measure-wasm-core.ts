// Rust/wasm measurement harness; historical #466 TS arms run from their original checkout.
// Usage:
//   node --expose-gc web/scripts/measure-wasm-core.ts --core wasm --out <dir> [--round <n>] [--smoke]
//   node web/scripts/measure-wasm-core.ts --aggregate --out <dir>
//   node web/scripts/aggregate-receive-path.ts <dir>   (#727 A1/A2 split and start criteria)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { components } from '../src/api-schema.d.ts'
import {
  MAIN_MESSAGE_LIMIT, REPLY_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT, TOTAL_MESSAGE_LIMIT,
  type Effect, type Input, type State,
} from '../src/protocol-types.ts'
import { aggregateDirectory, nearestRank, olsSlope, type Arm } from './aggregate-wasm-core.ts'
import { fixtureUuid, normalizeInput } from './client-core-ids.ts'
import { loadClientScenarios, makeProtocolClient } from './measure-fixture-client.ts'
import { partitionScenarios, runClientScenario } from './realtime-fixtures.ts'

type Message = components['schemas']['Message']
type MessagePage = components['schemas']['MessagePage']
type TimelinePage = components['schemas']['TimelinePage']
type TopicPage = components['schemas']['TopicPage']
type TopicSummaryResponse = components['schemas']['TopicSummaryResponse']
type ReplyChainPage = components['schemas']['ReplyChainPage']
type SendMessageRequest = components['schemas']['SendMessageRequest']
type OkResult<T> = { ok: true; data: T } | { ok: false; kind: 'network' }
type SyncView = Omit<State, 'requests' | 'timers'>
type CoreResult = { effects: Effect[]; changedChannels: ReadonlySet<string>; records: ReadonlyMap<string, Message[]>; stateChanged: boolean }
export interface SyncCore {
  get(): SyncView
  request(id: number): State['requests'][number] | undefined
  timer(id: number): State['timers'][number] | undefined
  hasPending(): boolean
  step(input: Input): CoreResult
}
type SocketHandlers = {
  onReady(): void
  onEvent(ev: Extract<import('../src/api-schema.d.ts').ServerEvent, { type: 'message' | 'subscribed' }>): void
}
type SyncInstance = {
  get(): SyncView; start(): Promise<void>; watch(ch: string): Promise<void>; unwatch(ch: string): Promise<void>
  close(): Promise<void>; getTimeline(ch: string): { send(body: string): Promise<boolean> }
}
type TopicsInstance = {
  get(ch: string): { lines: unknown[]; topic(id: string): { messages: Message[] } }
  loadMain(ch: string): Promise<unknown>; loadMainLatest(ch: string): Promise<unknown>
  loadTopic(ch: string, id: string): Promise<unknown>; releaseTopic(ch: string, id: string): void; close(): void
}
type RepliesInstance = {
  get(ch: string): { messages: Message[] }; open(ch: string, anchor: Message): Promise<void>
  loadMore(ch: string): Promise<void>; dismiss(ch: string): void; close(): void
}
type UnreadInstance = { get(ch: string): unknown; close(): void }
type CreateSyncFn = (opts: {
  selfId: string; newId?: () => string
  api: { listMessages(ch: string): Promise<OkResult<MessagePage>>; sendMessage(ch: string, body: SendMessageRequest): Promise<OkResult<Message>> }
  connect(h: SocketHandlers): { send(): void; close(): void }
}) => SyncInstance
type CreateTopicsFn = (sync: SyncInstance, opts: {
  api: {
    listTimeline(ch: string, q?: { as_of_seq?: number; before_position?: number }): Promise<OkResult<TimelinePage>>
    listTopics(ch: string): Promise<OkResult<TopicPage>>
    getTopicSummary(ch: string, topicId: string): Promise<OkResult<TopicSummaryResponse>>
    listTopicMessages(ch: string, topicId: string, q?: { before_seq?: number }): Promise<OkResult<MessagePage>>
  }
}) => TopicsInstance
type CreateTopicSyncFn = (opts: {
  selfId: string; topicsApi: Parameters<CreateTopicsFn>[1]['api']; api: Parameters<CreateSyncFn>[0]['api']; connect: Parameters<CreateSyncFn>[0]['connect']
}) => { sync: SyncInstance; topics: TopicsInstance }
type CreateRepliesFn = (sync: SyncInstance, opts: { api: { listReplyChain(ch: string, anchor: string, q?: { after_seq?: number }): Promise<OkResult<ReplyChainPage>> } }) => RepliesInstance
type CreateUnreadFn = (sync: SyncInstance, opts: {
  topics?: TopicsInstance
  api: {
    listChannels(): Promise<OkResult<Pick<components['schemas']['ChannelList'], 'history_generation'> & { channels: unknown[]; unread_channels: unknown[] }>>
    markRead(scope: unknown, body: components['schemas']['MarkReadRequest']): Promise<OkResult<components['schemas']['ReadPosition']>>
    getTopicSummary(ch: string, topicId: string): Promise<OkResult<TopicSummaryResponse>>
  }
}) => UnreadInstance

const scriptDir = dirname(fileURLToPath(import.meta.url)), webDir = resolve(scriptDir, '..')
const BASE_PHRASE = '業務連絡: リリース前確認と同期プロトコル検証を実施します。各チャネルの順序保証・重複排除・再接続差分取得を確認してください。'
const body155 = (seq: number, ch: string) => [...(`[${ch.slice(0, 8)}#${seq}] ` + BASE_PHRASE.repeat(3))].slice(0, 155).join('')
const SELF_UUID = fixtureUuid('me'), OTHER_UUID = fixtureUuid('other'), MENTION_UUID = fixtureUuid('mention-member')
const TOPIC_T_UUID = fixtureUuid('T'), TOPIC_U_UUID = fixtureUuid('U'), ROOT_MSG_UUID = fixtureUuid('id1')

function makeMessage(seq: number, channelUuid: string, opts?: {
  sender?: string; clientMessageId?: string; bodyText?: string; mention?: boolean
  topicId?: string | null; replyTo?: string | null; replyRootId?: string | null
}): Message {
  return { history_generation: '00000000-0000-4000-8000-000000000515',
    id: fixtureUuid(`${channelUuid}-msg-${seq}`), channel_id: channelUuid, created_seq: seq, version: seq, deleted: false,
    sender: opts?.sender ?? OTHER_UUID, client_message_id: opts?.clientMessageId ?? fixtureUuid(`${channelUuid}-cid-${seq}`),
    body: opts?.bodyText ?? body155(seq, channelUuid), created_at: '2026-01-01T00:00:00Z',
    topic_id: opts?.topicId ?? null, reply_to: opts?.replyTo ?? null, reply_root_id: opts?.replyRootId ?? null,
    mentions: opts?.mention ? [{ member_id: MENTION_UUID, name: '山田太郎' }] : [],
  }
}

let g3StepAssertions = 0, g3CompletionAssertions = 0

function assertG3Step(view: SyncView, expectedCursors?: ReadonlyMap<string, number>): void {
  g3StepAssertions++
  for (const [id, ch] of Object.entries(view.channels)) {
    const msgs = ch.messages
    for (let i = 1; i < msgs.length; i++) {
      if (!(msgs[i - 1].created_seq < msgs[i].created_seq)) throw new Error(`G3(a) violation on ${id}: ${msgs[i - 1].created_seq} >= ${msgs[i].created_seq}`)
    }
    const expCursor = expectedCursors?.get(id)
    if (expCursor !== undefined && ch.cursor !== expCursor) throw new Error(`G3(b) violation on ${id}: cursor=${ch.cursor} !== ${expCursor}`)
  }
}

function assertG3CatchUpComplete(view: SyncView, channelId: string, expectedHighWaterSeq: number, cap = MAIN_MESSAGE_LIMIT): void {
  g3CompletionAssertions++
  assertG3Step(view, new Map([[channelId, expectedHighWaterSeq]]))
  const ch = view.channels[channelId]
  if (!ch || ch.cursor !== expectedHighWaterSeq) throw new Error(`G3(c) cursor=${ch?.cursor} !== ${expectedHighWaterSeq}`)
  const expectedLen = Math.min(cap, expectedHighWaterSeq)
  if (ch.messages.length !== expectedLen) throw new Error(`G3(c) length=${ch.messages.length} !== ${expectedLen}`)
  const firstSeq = expectedHighWaterSeq - expectedLen + 1
  for (let i = 0; i < expectedLen; i++) {
    if (ch.messages[i].created_seq !== firstSeq + i) throw new Error(`G3(c) missing seq at ${i}: ${ch.messages[i].created_seq} !== ${firstSeq + i}`)
  }
}

const summarizeSamples = (samples: number[]) => ({
  p50: Number(nearestRank(samples, 50).toFixed(3)),
  p95: Number(nearestRank(samples, 95).toFixed(3)),
  p99: Number(nearestRank(samples, 99).toFixed(3)),
})

function buildMixedTraces(driver: Pick<typeof import('../src/protocol-driver.ts'), 'initialState' | 'step'>): { id: string; inputs: Input[] }[] {
  const { initialState, step } = driver
  const scenarios = loadClientScenarios()
  const rec = (seq: number, channel = 'A'): Message => ({ history_generation: '00000000-0000-4000-8000-000000000515',
    mentions: [], channel_id: channel, created_seq: seq, version: seq, deleted: false, body: `m${seq}`, id: `id${seq}`, sender: 'other',
    client_message_id: `auto-${seq}`, created_at: '2026-01-01T00:00:00Z', topic_id: null, reply_to: null, reply_root_id: null,
  })
  function makeRecorder(id: string) {
    let state = initialState(SELF_UUID)
    const inputs: Input[] = []
    const feed = (raw: Input): Effect[] => {
      const norm = normalizeInput(raw); inputs.push(norm)
      const res = step(state, norm); state = res.state; return res.effects
    }
    return { id, inputs, feed, get: () => state }
  }
  const traces: { id: string; inputs: Input[] }[] = []
  for (const scenario of partitionScenarios(scenarios).running.filter((s) => s.layer !== 'controller')) {
    const d = makeRecorder(scenario.id)
    const errs = runClientScenario(scenario, makeProtocolClient(d.feed, driver))
    if (errs.length > 0) throw new Error(`Fixture ${scenario.id} failed: ${errs.join('; ')}`)
    traces.push({ id: d.id, inputs: d.inputs })
  }
  {
    const d = makeRecorder('retention-ranges-and-reference-identity')
    d.feed({ type: 'session_start', selfId: 'me' })
    const connection = d.get().connection!
    d.feed({ type: 'connection_ready', connection })
    const channel = 'A', view = () => d.get().channels[fixtureUuid(channel)]
    const event = (seq: number) => d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (rec(seq)).created_seq, message: rec(seq) } })
    const page = (request: number, start: number, length: number) =>
      d.feed({ type: 'history_result', request, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: start + length - 1,  messages: Array.from({ length }, (_, i) => rec(start + i)), has_more: true } })
    // After-cursor fills answer with Channel events since #515 slice 3; only events advance the cursor.
    const fill = (request: number, start: number, length: number) =>
      d.feed({ type: 'events_result', request, page: { history_generation: '00000000-0000-4000-8000-000000000515', has_more: true,
        events: Array.from({ length }, (_, i) => ({ type: 'message' as const, kind: 'create' as const, seq: start + i, message: rec(start + i) })) } })
    d.feed({ type: 'watch', channel }); page(view().latest!, 1, 200)
    d.feed({ type: 'event', connection, subscription: -1, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
    d.feed({ type: 'event', connection, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: channel, caught_up_seq: 200 } })
    for (let i = 0; i < 425; i++) event(202 + i * 2)
    d.feed({ type: 'timer_elapsed', id: view().wait! })
    while (view().fill !== undefined) fill(view().fill!, view().cursor! + 1, 200)
    if (view().cursor! < 1050 || view().forgottenThrough !== undefined) throw new Error(`Retention trace did not catch up: cursor=${view().cursor}`)
    for (let seq = view().cursor! + 1, end = seq + 450; seq < end; seq++) event(seq)
    const duplicate = rec(view().cursor!)
    d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (duplicate).created_seq, message: duplicate } })
    d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (duplicate).created_seq, message: duplicate } })
    d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: (duplicate).created_seq, message: duplicate }, refreshMentionNames: true })
    for (const name of ['Retained', 'Retained', 'Renamed']) {
      d.feed({ type: 'event', connection, event: { type: 'message', kind: 'create', seq: ({ ...duplicate, mentions: [{ member_id: 'target', name }] }).created_seq, message: { ...duplicate, mentions: [{ member_id: 'target', name }] } } })
    }
    d.feed({ type: 'load_older', channel }); page(view().older!, 1, 200); d.feed({ type: 'refresh', channel })
    d.feed({ type: 'history_result', request: view().latest!, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1901,  messages: [rec(1901), rec(1900), { ...rec(1901), body: 'canonical' }], has_more: false } })
    d.feed({ type: 'user_send', channel, clientMessageId: 'reply', body: 'pending', reply_to: 'parent', replyRootId: 'root' })
    d.feed({ type: 'user_send', channel, clientMessageId: 'reply', body: 'same key' }); d.feed({ type: 'unwatch', channel })
    for (const ch of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) {
      d.feed({ type: 'watch', channel: ch })
      const c = d.get().channels[fixtureUuid(ch)]
      d.feed({ type: 'history_result', request: c.latest!, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 200,  messages: Array.from({ length: 200 }, (_, i) => rec(i + 1, ch)), has_more: true } })
      d.feed({ type: 'unwatch', channel: ch })
    }
    d.feed({ type: 'watch', channel })
    d.feed({ type: 'event', connection, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: channel, caught_up_seq: 2 } })
    traces.push({ id: d.id, inputs: d.inputs })
  }
  for (const seed of [1, 42, 464, 0xdeadbeef]) {
    const d = makeRecorder(`generated-${seed}`)
    let rng = seed
    const random = (n: number) => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n }
    const channels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    const boot = () => {
      d.feed({ type: 'session_start', selfId: 'me' }); d.feed({ type: 'connection_ready', connection: d.get().connection! })
      for (const ch of channels) {
        const req = d.feed({ type: 'watch', channel: ch }).find((e) => e.type === 'fetch_history')!
        if (req.type !== 'fetch_history') throw new Error('missing bootstrap')
        d.feed({ type: 'history_result', request: req.id, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 200,  messages: Array.from({ length: 200 }, (_, i) => rec(i + 1, ch)), has_more: true } })
        d.feed({ type: 'event', connection: d.get().connection!, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: ch, caught_up_seq: 200 } })
      }
    }
    boot()
    for (let index = 0; index < 1600; index++) {
      const state = d.get(), ch = channels[random(channels.length)], c = state.channels[fixtureUuid(ch)]
      const requests = Object.entries(state.requests), request = requests[random(requests.length)], timers = Object.keys(state.timers)
      const pending = c?.pending[random(c.pending.length)], connection = state.connection ?? 999_999
      const seq = random(3) === 0 ? (c?.cursor ?? 200) + 1 : 1 + random(1300)
      const message = {
        ...rec(seq, ch), ...(random(4) === 0 ? { sender: 'me', client_message_id: pending?.clientMessageId ?? 'c1' } : {}),
        mentions: random(3) === 0 ? [{ member_id: 'mention', name: `name${random(3)}` }] : [],
      }
      const choices: Input[] = [
        { type: 'watch', channel: ch }, { type: 'unwatch', channel: ch }, { type: 'refresh', channel: ch },
        { type: 'load_older', channel: ch }, { type: 'channel_unavailable', channel: ch },
        { type: 'user_send', channel: ch, clientMessageId: `c${random(4)}`, body: ['hello', '  ', '\ufeff', '\u0085'][random(4)],
          ...(random(3) === 0 ? { reply_to: 'parent', replyRootId: 'root' } : random(2) === 0 ? { topic_name: 'Topic' } : {}) },
        { type: 'user_retry', channel: ch, clientMessageId: pending?.clientMessageId ?? 'c1' },
        { type: 'user_discard', channel: ch, clientMessageId: pending?.clientMessageId ?? 'c1' },
        { type: 'event', connection, event: { type: 'message', kind: 'create', seq: (message).created_seq, message }, ...(random(5) === 0 ? { refreshMentionNames: true } : {}) },
        { type: 'event', connection, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: ch, caught_up_seq: random(500) }, ...(random(3) === 0 ? { subscription: 99999 } : {}) },
        { type: 'event', connection, event: { type: 'error', channel_id: ch, code: ['channel_not_found', 'subscription_limit', 'unknown'][random(3)] } },
        { type: 'event', connection, event: { type: 'channel_access_lost', channel_id: ch } },
        { type: 'settle_history', channel: ch, messages: [message] },
        { type: 'connection_ready', connection },
        { type: 'timer_elapsed', id: timers.length ? Number(timers[random(timers.length)]) : 99999 },
      ]
      if (request) {
        const [token, r] = request
        if (r.type === 'history') {
          const hasMore = random(2) === 0
          const messages = Array.from({ length: random(8) }, (_, i) => ({ ...rec((r.seq ?? 190) + i + 1, r.channel), ...(random(5) === 0 ? { sender: 'me', client_message_id: 'c1' } : {}) }))
          choices.push(r.page === 'after'
            ? { type: 'events_result', request: Number(token), page: { history_generation: '00000000-0000-4000-8000-000000000515', has_more: hasMore,
              events: messages.map((m) => ({ type: 'message' as const, kind: 'create' as const, seq: m.created_seq, message: m })) } }
            : { type: 'history_result', request: Number(token), page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: messages.at(-1)?.created_seq ?? 0, messages, has_more: hasMore } })
          choices.push({ type: 'history_failed', request: Number(token), status: [401, 403, 404, 500, 'network', 'timeout'][random(6)] as 401 })
        } else {
          choices.push({ type: 'ack', request: Number(token), message: { ...message, channel_id: r.channel, sender: 'me', client_message_id: r.clientMessageId } })
          choices.push({ type: 'send_failed', request: Number(token), status: [400, 401, 403, 404, 409, 413, 415, 429, 503, 'network', 'timeout'][random(11)] as 400,
            retryAfterMs: [0, 1000.5, 2000, Number.MAX_SAFE_INTEGER, 1e16][random(5)], error: 'refused' })
        }
      }
      if (index % 71 === 0) d.feed({ type: 'socket_closed', connection, code: [1006, 4008, 4029, 4001, 4003][random(5)] })
      else if (index % 127 === 0) d.feed({ type: 'organization_unavailable' })
      else if (index % 173 === 0) { d.feed({ type: 'stop' }); d.feed({ type: 'stop' }); boot() }
      else if (index % 89 === 0 || !state.running) { d.feed({ type: 'session_replaced', selfId: 'me' }); d.feed({ type: 'connection_ready', connection: d.get().connection! }) }
      else d.feed(choices[random(choices.length)])
    }
    traces.push({ id: d.id, inputs: d.inputs })
  }
  return traces
}

function bootstrapGridCore(createCoreFn: (selfId: string) => SyncCore, channelsCount: number, messagesPerChannel: number) {
  const core = createCoreFn(SELF_UUID)
  const connId = (core.step({ type: 'session_start', selfId: SELF_UUID }).effects.find((e) => e.type === 'connect') as { id: number }).id
  core.step({ type: 'connection_ready', connection: connId })
  const channelUuids = Array.from({ length: channelsCount }, (_, i) => fixtureUuid(`grid-C${i}`))
  for (let i = channelsCount - 1; i >= 1; i--) {
    const ch = channelUuids[i]
    const histId = (core.step({ type: 'watch', channel: ch }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
    core.step({ type: 'history_result', request: histId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 50,  messages: Array.from({ length: 50 }, (_, m) => makeMessage(m + 1, ch)), has_more: false } })
    core.step({ type: 'event', connection: connId, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: ch, caught_up_seq: 50 } })
    if (messagesPerChannel === 400 || i >= 8) core.step({ type: 'unwatch', channel: ch })
  }
  const c0 = channelUuids[0]
  const h0Id = (core.step({ type: 'watch', channel: c0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
  if (messagesPerChannel <= 200) {
    core.step({ type: 'history_result', request: h0Id, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: messagesPerChannel,  messages: Array.from({ length: messagesPerChannel }, (_, m) => makeMessage(m + 1, c0)), has_more: true } })
  } else {
    core.step({ type: 'history_result', request: h0Id, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 400,  messages: Array.from({ length: 200 }, (_, m) => makeMessage(201 + m, c0)), has_more: true } })
    const olderId = (core.step({ type: 'load_older', channel: c0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
    core.step({ type: 'history_result', request: olderId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 400,  messages: Array.from({ length: 200 }, (_, m) => makeMessage(1 + m, c0)), has_more: true } })
  }
  core.step({ type: 'event', connection: connId, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: c0, caught_up_seq: messagesPerChannel } })
  assertG3Step(core.get(), new Map([[c0, messagesPerChannel]]))
  return { core, connId, c0, cursor: messagesPerChannel }
}

async function main() {
  const args = process.argv.slice(2), outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : ''
  if (!outDir) { console.error('Usage: node --expose-gc web/scripts/measure-wasm-core.ts --core wasm --out <dir> [--smoke]'); process.exit(1) }
  if (args.includes('--aggregate')) { console.log(aggregateDirectory(outDir).markdownTable); return }

  const coreIdx = args.indexOf('--core'), coreKind = (coreIdx >= 0 ? args[coreIdx + 1] : 'wasm') as 'wasm'
  if (coreKind !== 'wasm') throw new Error(`--core must be wasm (got ${coreKind}); use the historical checkout for TS measurements`)
  const smoke = args.includes('--smoke'), armIdx = args.indexOf('--arm')
  const arm: Arm = (armIdx >= 0 ? args[armIdx + 1] : 'W') as Arm

  mkdirSync(outDir, { recursive: true })
  const roundIdx = args.indexOf('--round')
  let round = roundIdx >= 0 ? Number(args[roundIdx + 1]) : 1
  if (roundIdx < 0) while (existsSync(join(outDir, `round-${round}-${coreKind}.jsonl`))) round++
  const outFile = join(outDir, `round-${round}-${coreKind}.jsonl`)

  const syncCoreTargetUrl = pathToFileURL(resolve(webDir, 'src/core-wasm.ts')).href
  // #727 A1/A2 load `?prod` and `?probe` copies of core-wasm.ts and sync.ts with production core-values; the
  // existing sections above keep the test translator. `?probe` also swaps in the timestamping wasm glue.
  const variantOf = (url: string | undefined) => url?.endsWith('?prod') ? 'prod' : url?.endsWith('?probe') ? 'probe' : undefined

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const variant = variantOf(context.parentURL)
      if (variant && specifier === './core-values') return { url: pathToFileURL(resolve(webDir, 'src/core-values.ts')).href, shortCircuit: true }
      if (variant && specifier === '#sync-core') {
        return { url: variant === 'probe' ? pathToFileURL(resolve(webDir, 'scripts/receive-probe-core.ts')).href : `${syncCoreTargetUrl}?prod`, shortCircuit: true }
      }
      if (variant === 'probe' && specifier === '../wasm/fukulow_client_core') return { url: pathToFileURL(resolve(webDir, 'scripts/receive-probe-wasm.ts')).href, shortCircuit: true }
      if (specifier === './core-values') return { url: pathToFileURL(resolve(webDir, 'scripts/core-test-values.ts')).href, shortCircuit: true }
      if (specifier === '#sync-core') return { url: syncCoreTargetUrl, shortCircuit: true }
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
        const base = dirname(fileURLToPath(context.parentURL))
        if (specifier.endsWith('.js') && existsSync(resolve(base, specifier.slice(0, -3) + '.ts'))) return nextResolve(pathToFileURL(resolve(base, specifier.slice(0, -3) + '.ts')).href, context)
        for (const ext of ['', '.ts', '.js']) {
          const full = resolve(base, specifier + ext)
          if (existsSync(full)) return nextResolve(pathToFileURL(full).href, context)
        }
      }
      return nextResolve(specifier, context)
    },
  })

  let wasmMemory: WebAssembly.Memory | null = null
  if (coreKind === 'wasm') {
    const initMod = (await import(pathToFileURL(resolve(webDir, 'wasm/fukulow_client_core.js')).href)) as {
      default: (arg: { module_or_path: Buffer }) => Promise<{ memory: WebAssembly.Memory }>
    }
    wasmMemory = (await initMod.default({ module_or_path: readFileSync(resolve(webDir, 'wasm/fukulow_client_core_bg.wasm')) })).memory
  }
  const releaseCores = async () => {
    if (typeof global.gc === 'function') { global.gc(); await delay(0); global.gc(); await delay(0) }
  }
  const createSelectedCore: (selfId: string) => SyncCore = ((await import(syncCoreTargetUrl)) as { createCore: (selfId: string) => SyncCore }).createCore

  const jsonLines: string[] = [], emit = (record: Record<string, unknown>) => jsonLines.push(JSON.stringify(record))
  emit({ type: 'meta', arm, core: coreKind, round, smoke, nodeVersion: process.version, timestamp: new Date().toISOString() })

  const { createSync } = (await import(pathToFileURL(resolve(webDir, 'src/sync.ts')).href)) as { createSync: CreateSyncFn }
  const { createTopics } = (await import(pathToFileURL(resolve(webDir, 'src/topics.ts')).href)) as { createTopics: CreateTopicsFn }
  const { createReplies } = (await import(pathToFileURL(resolve(webDir, 'src/replies.ts')).href)) as { createReplies: CreateRepliesFn }
  const { createUnread } = (await import(pathToFileURL(resolve(webDir, 'src/unread.ts')).href)) as { createUnread: CreateUnreadFn }
  const { createTopicSync } = (await import(pathToFileURL(resolve(webDir, 'src/topic-sync.ts')).href)) as { createTopicSync: CreateTopicSyncFn }

  // 4. Memory (§5.4 row 4) runs first, in a fresh process, so earlier workloads neither inflate the JS heap
  // nor grow wasm linear memory (which is never returned) before it is sampled.
  if (typeof global.gc !== 'function') throw new Error('Run with node --expose-gc')
  await releaseCores()
  const memory = await (async () => {
    const chA = fixtureUuid('mem-A')
    let highSeq = 2000, memSocket: SocketHandlers | undefined
    const makeSynth = (seq: number, ch = chA, topicId: string | null = null): Message =>
      makeMessage(seq, ch, { topicId, replyTo: seq > 1 && seq % 3 === 0 ? ROOT_MSG_UUID : null, replyRootId: seq > 1 && seq % 3 === 0 ? ROOT_MSG_UUID : null })
    const summaryResp = (ch: string, topic: string): OkResult<TopicSummaryResponse> => ({
      ok: true,
      data: { history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: highSeq,
        topic: { id: topic, name: 'T', first_seq: 1, last_seq: highSeq, message_count: highSeq, unread_count: 0, mention_unread_count: 0, read_seq: highSeq, latest_message: makeSynth(highSeq, ch, topic) },
      },
    })
    const { sync, topics } = createTopicSync({
      selfId: SELF_UUID,
      topicsApi: {
        async listTimeline(channel, query = {}) {
          const w = query.as_of_seq ?? highSeq, endSeq = Math.min(w, (query.before_position ?? w + 1) - 1), startSeq = Math.max(1, endSeq - 49)
          const items = Array.from({ length: Math.max(0, endSeq - startSeq + 1) }, (_, i) => ({ kind: 'message' as const, message: makeSynth(startSeq + i, channel) }))
          return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: w, has_more: startSeq > 1, items } }
        },
        async listTopics() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: highSeq, topics: [], has_more: false } } },
        async getTopicSummary(channel, topic) { return summaryResp(channel, topic) },
        async listTopicMessages(channel, topic, query = {}) {
          const endSeq = Math.min(highSeq, (query.before_seq ?? highSeq + 1) - 1), startSeq = Math.max(1, endSeq - 49)
          const messages = Array.from({ length: Math.max(0, endSeq - startSeq + 1) }, (_, i) => makeSynth(startSeq + i, channel, topic))
          return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: (messages).at(-1)?.created_seq ?? 0,  messages, has_more: startSeq > 1 } }
        },
      },
      api: {
        async listMessages() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0,  messages: [], has_more: false } } },
        async sendMessage() { return { ok: false, kind: 'network' } },
      },
      connect(h) { memSocket = h; return { send() {}, close() {} } },
    })
    const replies = createReplies(sync, {
      api: {
        async listReplyChain(channel, _anchor, query = {}) {
          const startSeq = (query.after_seq ?? 0) + 1, count = Math.max(0, Math.min(50, highSeq - startSeq + 1))
          const messages = Array.from({ length: count }, (_, i) => {
            const m = makeSynth(startSeq + i, channel)
            return m.created_seq === 1 ? m : { ...m, reply_to: ROOT_MSG_UUID, reply_root_id: ROOT_MSG_UUID }
          })
          return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: (messages).at(-1)?.created_seq ?? 0, chain_version: highSeq, root_id: ROOT_MSG_UUID, has_more: startSeq + count <= highSeq, messages } }
        },
      },
    })
    const unread = createUnread(sync, {
      topics,
      api: {
        async listChannels() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', channels: [], unread_channels: [] } } },
        async markRead(_s, body) { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', read_seq: body.read_seq } } },
        async getTopicSummary(channel, topic) { return summaryResp(channel, topic) },
      },
    })

    await sync.start(); memSocket!.onReady()
    for (let s = 0; s < 5; s++) {
      const initOther = fixtureUuid(`mem-init-lru-${s}`)
      await sync.watch(initOther); memSocket!.onEvent({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: initOther, caught_up_seq: highSeq })
      for (let k = 1; k <= 50; k++) memSocket!.onEvent({ type: 'message', kind: 'create', seq: (makeSynth(highSeq + k, initOther)).created_seq, message: makeSynth(highSeq + k, initOther) })
      await sync.unwatch(initOther)
    }
    await sync.watch(chA); memSocket!.onEvent({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: chA, caught_up_seq: highSeq })

    const checkCaps = () => {
      const syncCount = Object.values(sync.get().channels).reduce((n, ch) => n + ch.messages.length, 0), proj = topics.get(chA)
      const mainCount = proj.lines.length, topicCount = proj.topic(TOPIC_T_UUID).messages.length, replyCount = replies.get(chA).messages.length
      if (mainCount > MAIN_MESSAGE_LIMIT || topicCount > TOPIC_MESSAGE_LIMIT || replyCount > REPLY_MESSAGE_LIMIT ||
          syncCount + mainCount + topicCount + replyCount > TOTAL_MESSAGE_LIMIT) {
        throw new Error(`#308 cap exceeded: sync=${syncCount} main=${mainCount} topic=${topicCount} reply=${replyCount}`)
      }
    }

    global.gc!()
    const memSamples: Array<{ messages: number; preGcHeapBytes: number; postGcHeapBytes: number; wasmBytes: number; wasmPages: number; peakBytes: number; steadyBytes: number }> = []
    let arrivedMessages = 0
    const sampleMemory = (messages: number) => {
      const preGcHeapBytes = process.memoryUsage().heapUsed, wasmBytesPre = wasmMemory ? wasmMemory.buffer.byteLength : 0
      const peakBytes = preGcHeapBytes + wasmBytesPre
      global.gc!()
      const postGcHeapBytes = process.memoryUsage().heapUsed, wasmBytes = wasmMemory ? wasmMemory.buffer.byteLength : 0
      const entry = { messages, preGcHeapBytes, postGcHeapBytes, wasmBytes, wasmPages: wasmBytes / 65536, peakBytes, steadyBytes: postGcHeapBytes + wasmBytes }
      memSamples.push(entry); emit({ type: 'memory_sample', arm, core: coreKind, round, ...entry })
    }

    for (let cycle = 0; cycle < 10; cycle++) {
      for (let n = 1; n <= 1000; n++) {
        highSeq++; arrivedMessages++
        memSocket!.onEvent({ type: 'message', kind: 'create', seq: (makeSynth(highSeq, chA, n % 2 === 0 ? TOPIC_T_UUID : TOPIC_U_UUID)).created_seq, message: makeSynth(highSeq, chA, n % 2 === 0 ? TOPIC_T_UUID : TOPIC_U_UUID) })
        topics.get(chA); replies.get(chA); unread.get(chA); assertG3Step(sync.get())
        if (n === 500) { checkCaps(); sampleMemory(arrivedMessages) }
      }
      for (let page = 0; page < 10; page++) await topics.loadMain(chA)
      for (let page = 0; page < 8; page++) await topics.loadTopic(chA, TOPIC_T_UUID)
      await replies.open(chA, makeSynth(1, chA))
      for (let page = 0; page < 5; page++) await replies.loadMore(chA)
      checkCaps(); topics.releaseTopic(chA, TOPIC_T_UUID); replies.dismiss(chA)
      const otherCh = fixtureUuid(`mem-other-${cycle}`)
      await sync.unwatch(chA); await sync.watch(otherCh)
      memSocket!.onEvent({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: otherCh, caught_up_seq: highSeq })
      for (let k = 1; k <= 100; k++) memSocket!.onEvent({ type: 'message', kind: 'create', seq: (makeSynth(highSeq + k, otherCh)).created_seq, message: makeSynth(highSeq + k, otherCh) })
      await sync.unwatch(otherCh); await sync.watch(chA)
      memSocket!.onEvent({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: chA, caught_up_seq: highSeq })
      await topics.loadMainLatest(chA); checkCaps(); sampleMemory(arrivedMessages)
    }

    unread.close(); replies.close(); await sync.close()
    const postWarmup = memSamples.filter((s) => s.messages >= 2500)
    const steadyMedianBytes = nearestRank(postWarmup.map((s) => s.steadyBytes), 50)
    const peakMaxBytes = Math.max(...memSamples.map((s) => s.peakBytes)), wasmPeakBytes = Math.max(...memSamples.map((s) => s.wasmBytes))
    const wasmPagesAddedPostWarmup = (Math.max(...postWarmup.map((s) => s.wasmBytes)) - (postWarmup[0]?.wasmBytes ?? 0)) / 65536
    const slope = olsSlope(postWarmup.map((s) => s.messages), postWarmup.map((s) => s.steadyBytes))

    emit({
      type: 'memory_summary', arm, core: coreKind, round, steadyMedianBytes,
      steadyMedianMiB: Number((steadyMedianBytes / 1024 ** 2).toFixed(3)),
      peakMaxBytes, peakMaxMiB: Number((peakMaxBytes / 1024 ** 2).toFixed(3)),
      wasmPeakBytes, wasmPeakKiB: Number((wasmPeakBytes / 1024).toFixed(1)),
      wasmPeakPages: wasmPeakBytes / 65536, wasmPagesAddedPostWarmup,
      olsSlopeBytesPerMessage: Number(slope.toFixed(3)), postWarmupSamples: postWarmup.length,
    })
    return { steadyMedianBytes, peakMaxBytes, wasmPeakBytes, wasmPagesAddedPostWarmup, slope }
  })()
  await releaseCores()

  // 1. step() Grid Suite & Mixed Trace Suite (§5.4 Row 1)
  const warmupSteps = 30, gridSteps = smoke ? 40 : 1000, allGridSamples: number[] = []
  for (const channelsCount of [1, 8, 16]) {
    for (const messagesPerChannel of [50, 400]) {
      {
        const { core, connId, c0, cursor: initCursor } = bootstrapGridCore(createSelectedCore, channelsCount, messagesPerChannel)
        let cur = initCursor
        for (let i = 0; i < warmupSteps; i++) core.step({ type: 'event', connection: connId, event: { type: 'message', kind: 'create', seq: cur + 1, message: makeMessage(++cur, c0, { mention: true }) } })
        const samples: number[] = []
        for (let i = 0; i < gridSteps; i++) {
          const input: Input = { type: 'event', connection: connId, event: { type: 'message', kind: 'create', seq: cur + 1, message: makeMessage(++cur, c0, { mention: true }) } }
          const t0 = performance.now(); core.step(input); samples.push((performance.now() - t0) * 1000)
          assertG3Step(core.get(), new Map([[c0, cur]]))
        }
        allGridSamples.push(...samples)
        emit({ type: 'step_grid', arm, core: coreKind, round, channels: channelsCount, messagesPerChannel, stepClass: 'stream_append', unit: 'us', samples, ...summarizeSamples(samples) })
      }
      await releaseCores()
      {
        const { core, connId, c0, cursor } = bootstrapGridCore(createSelectedCore, channelsCount, messagesPerChannel)
        const dupInput: Input = { type: 'event', connection: connId, event: { type: 'message', kind: 'create', seq: ({ ...core.get().channels[c0].messages.at(-1)! }).created_seq, message: { ...core.get().channels[c0].messages.at(-1)! } } }
        for (let i = 0; i < warmupSteps; i++) if (core.step(dupInput).stateChanged) throw new Error('Duplicate mutated state')
        const samples: number[] = []
        for (let i = 0; i < gridSteps; i++) {
          const t0 = performance.now(), r = core.step(dupInput); samples.push((performance.now() - t0) * 1000)
          if (r.stateChanged) throw new Error('Duplicate mutated state')
          assertG3Step(core.get(), new Map([[c0, cursor]]))
        }
        allGridSamples.push(...samples)
        emit({ type: 'step_grid', arm, core: coreKind, round, channels: channelsCount, messagesPerChannel, stepClass: 'duplicate', unit: 'us', samples, ...summarizeSamples(samples) })
      }
      await releaseCores()
      {
        const { core, c0, cursor: initCursor } = bootstrapGridCore(createSelectedCore, channelsCount, messagesPerChannel)
        let cur = initCursor
        for (let i = 0; i < warmupSteps / 2; i++) {
          cur++
          const cid = fixtureUuid(`warm-send-${channelsCount}-${messagesPerChannel}-${i}`)
          const reqId = (core.step({ type: 'user_send', channel: c0, clientMessageId: cid, body: body155(cur, c0) }).effects.find((e) => e.type === 'send') as { id: number }).id
          core.step({ type: 'ack', request: reqId, message: makeMessage(cur, c0, { sender: SELF_UUID, clientMessageId: cid }) })
        }
        const samples: number[] = []
        for (let i = 0; i < Math.floor(gridSteps / 2); i++) {
          cur++
          const cid = fixtureUuid(`timed-send-${channelsCount}-${messagesPerChannel}-${i}`)
          const sendInput: Input = { type: 'user_send', channel: c0, clientMessageId: cid, body: body155(cur, c0) }
          const t0 = performance.now(), sendRes = core.step(sendInput); samples.push((performance.now() - t0) * 1000)
          assertG3Step(core.get())
          const reqId = (sendRes.effects.find((e) => e.type === 'send') as { id: number }).id
          const ackInput: Input = { type: 'ack', request: reqId, message: makeMessage(cur, c0, { sender: SELF_UUID, clientMessageId: cid }) }
          const t1 = performance.now(); core.step(ackInput); samples.push((performance.now() - t1) * 1000)
          assertG3Step(core.get())
        }
        allGridSamples.push(...samples)
        emit({ type: 'step_grid', arm, core: coreKind, round, channels: channelsCount, messagesPerChannel, stepClass: 'send_ack', unit: 'us', samples, ...summarizeSamples(samples) })
      }
      await releaseCores()
      {
        const { core, c0, cursor } = bootstrapGridCore(createSelectedCore, channelsCount, messagesPerChannel)
        // Each page edits the 50 newest Messages (distinct body per iteration), so every step really merges and,
        // on wasm, crosses the boundary as a messages delta; an identical page would be a no-op duplicate.
        const page = (iteration: number) => Array.from({ length: 50 }, (_, m) => {
          const seq = cursor - 49 + m
          return makeMessage(seq, c0, { bodyText: body155(seq, `${iteration}-${c0}`) })
        })
        for (let i = 0; i < warmupSteps; i++) {
          const reqId = (core.step({ type: 'refresh', channel: c0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
          core.step({ type: 'history_result', request: reqId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: cursor,  messages: page(i), has_more: true } })
        }
        const samples: number[] = []
        for (let i = 0; i < gridSteps; i++) {
          const reqId = (core.step({ type: 'refresh', channel: c0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
          const histInput: Input = { type: 'history_result', request: reqId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: cursor,  messages: page(warmupSteps + i), has_more: true } }
          const t0 = performance.now(), r = core.step(histInput); samples.push((performance.now() - t0) * 1000)
          if (!r.changedChannels.has(c0)) throw new Error('history_50 page did not change the Channel')
          assertG3Step(core.get(), new Map([[c0, cursor]]))
        }
        allGridSamples.push(...samples)
        emit({ type: 'step_grid', arm, core: coreKind, round, channels: channelsCount, messagesPerChannel, stepClass: 'history_50', unit: 'us', samples, ...summarizeSamples(samples) })
      }
      await releaseCores()
    }
  }

  const driver = await import('../src/protocol-driver.ts')
  const mixedTraces = buildMixedTraces(driver)
  const totalTraceSteps = mixedTraces.reduce((acc, t) => acc + t.inputs.length, 0)
  if (totalTraceSteps <= 6000) throw new Error(`Expected >6000 trace steps, got ${totalTraceSteps}`)
  { const warmCore = createSelectedCore(SELF_UUID); for (const input of mixedTraces[0].inputs.slice(0, warmupSteps)) warmCore.step(input) }
  await releaseCores()
  const traceSamples: number[] = []
  for (const trace of mixedTraces) {
    {
      const core = createSelectedCore(SELF_UUID)
      for (const input of trace.inputs) {
        const t0 = performance.now(); core.step(input); traceSamples.push((performance.now() - t0) * 1000)
        assertG3Step(core.get())
      }
    }
    await releaseCores()
  }
  emit({ type: 'step_trace', arm, core: coreKind, round, totalSteps: traceSamples.length, traceCount: mixedTraces.length, unit: 'us', samples: traceSamples, ...summarizeSamples(traceSamples) })
  const gridSum = summarizeSamples(allGridSamples), traceSum = summarizeSamples(traceSamples), combinedSum = summarizeSamples([...allGridSamples, ...traceSamples])
  emit({
    type: 'step_summary', arm, core: coreKind, round, unit: 'us',
    gridP50: gridSum.p50, gridP95: gridSum.p95, gridP99: gridSum.p99,
    traceP50: traceSum.p50, traceP95: traceSum.p95, traceP99: traceSum.p99,
    combinedP50: combinedSum.p50, combinedP95: combinedSum.p95, combinedP99: combinedSum.p99,
  })

  // 2. Sustained Event Processing & Max Sustainable Rate (§5.4 Row 2)
  async function runPacedWindow(rateMsgPerSec: number, durationSec: number, doWarmup: boolean) {
    const channelIds = Array.from({ length: 8 }, (_, i) => fixtureUuid(`sust-C${i}`)), cursors = new Map<string, number>()
    let socketHandlers: SocketHandlers | undefined, sendSeqCounter = 0, lastSentMessage: Message | undefined
    const topicSummary = (topicId: string): OkResult<TopicSummaryResponse> => ({
      ok: true,
      data: { history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 200,
        topic: { id: topicId, name: 'Topic', first_seq: 1, last_seq: 200, message_count: 1, unread_count: 0, mention_unread_count: 0, read_seq: 200, latest_message: makeMessage(200, channelIds[0], { topicId }) },
      },
    })
    const sync = createSync({
      selfId: SELF_UUID, newId: () => fixtureUuid(`sust-send-cid-${++sendSeqCounter}`),
      api: {
        async listMessages(ch) {
          const count = ch === channelIds[0] ? 200 : 50; cursors.set(ch, count)
          return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: count,  messages: Array.from({ length: count }, (_, m) => makeMessage(m + 1, ch)), has_more: false } }
        },
        async sendMessage(ch, body) {
          const nextSeq = (cursors.get(ch) ?? 0) + 1; cursors.set(ch, nextSeq)
          lastSentMessage = makeMessage(nextSeq, ch, { sender: SELF_UUID, clientMessageId: body.client_message_id, bodyText: body.body })
          return { ok: true, data: lastSentMessage }
        },
      },
      connect(h) { socketHandlers = h; return { send() {}, close() {} } },
    })
    const topics = createTopics(sync, {
      api: {
        async listTimeline() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 200, items: [], has_more: false } } },
        async listTopics() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 200, topics: [], has_more: false } } },
        async getTopicSummary(_ch, topicId) { return topicSummary(topicId) },
        async listTopicMessages() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0,  messages: [], has_more: false } } },
      },
    })
    const replies = createReplies(sync, { api: { async listReplyChain() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0, chain_version: 1, root_id: ROOT_MSG_UUID, messages: [], has_more: false } } } } })
    const unread = createUnread(sync, {
      topics,
      api: {
        async listChannels() { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', channels: [], unread_channels: [] } } },
        async markRead(_s, body) { return { ok: true, data: { history_generation: '00000000-0000-4000-8000-000000000515', read_seq: body.read_seq } } },
        async getTopicSummary(_ch, topicId) { return topicSummary(topicId) },
      },
    })

    await sync.start(); socketHandlers!.onReady()
    for (const ch of channelIds) { await sync.watch(ch); socketHandlers!.onEvent({ history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: ch, caught_up_seq: cursors.get(ch)! }) }
    assertG3Step(sync.get(), cursors)

    const dispatchOne = async (idx: number) => {
      const ch = idx % 2 === 0 ? channelIds[0] : channelIds[1 + (idx % 7)], hasTopicOrReply = idx % 10 === 0
      if (idx % 20 === 0) {
        await sync.getTimeline(ch).send(body155((cursors.get(ch) ?? 0) + 1, ch))
        socketHandlers!.onEvent({ type: 'message', kind: 'create', seq: (lastSentMessage!).created_seq, message: lastSentMessage! })
      } else {
        const nextSeq = (cursors.get(ch) ?? 0) + 1; cursors.set(ch, nextSeq)
        socketHandlers!.onEvent({
          type: 'message', kind: 'create', seq: (makeMessage(nextSeq, ch, {
            topicId: hasTopicOrReply ? TOPIC_T_UUID : null,
            replyTo: hasTopicOrReply && idx % 20 === 10 ? ROOT_MSG_UUID : null,
            replyRootId: hasTopicOrReply && idx % 20 === 10 ? ROOT_MSG_UUID : null,
          })).created_seq,
          message: makeMessage(nextSeq, ch, {
            topicId: hasTopicOrReply ? TOPIC_T_UUID : null,
            replyTo: hasTopicOrReply && idx % 20 === 10 ? ROOT_MSG_UUID : null,
            replyRootId: hasTopicOrReply && idx % 20 === 10 ? ROOT_MSG_UUID : null,
          }),
        })
      }
      topics.get(ch); replies.get(ch); unread.get(ch)
    }

    if (doWarmup) for (let w = 0; w < warmupSteps; w++) { await dispatchOne(w); assertG3Step(sync.get(), cursors) }
    const totalEvents = Math.max(1, Math.round(rateMsgPerSec * durationSec)), intervalMs = 1000 / rateMsgPerSec, windowMs = durationSec * 1000
    const samples: number[] = []
    let maxQueue = 0, prevCompletionTs = performance.now(), completed = 0
    const tStart = prevCompletionTs
    for (let i = 0; i < totalEvents; i++) {
      const scheduledArrivalTs = tStart + i * intervalMs
      let now = performance.now()
      if (now < scheduledArrivalTs) {
        const waitMs = scheduledArrivalTs - now
        if (waitMs > 2) await delay(Math.floor(waitMs - 1))
        while ((now = performance.now()) < scheduledArrivalTs) { /* spin */ }
      }
      const qDepth = prevCompletionTs > scheduledArrivalTs ? Math.floor((prevCompletionTs - scheduledArrivalTs) / intervalMs) + 1 : 0
      if (qDepth > maxQueue) maxQueue = qDepth
      await dispatchOne(warmupSteps + i)
      const completionTs = performance.now(); prevCompletionTs = completionTs
      samples.push(Number((completionTs - scheduledArrivalTs).toFixed(4))); completed++
      // Checked after the completion timestamp so the G3 scan is not part of the measured latency.
      assertG3Step(sync.get(), cursors)
      if (rateMsgPerSec > 100 && completionTs > tStart + windowMs + 250 && completed < totalEvents) break
    }
    const uncompleted = totalEvents - completed
    const trailingBacklog = prevCompletionTs > tStart + totalEvents * intervalMs
      ? Math.floor((prevCompletionTs - (tStart + totalEvents * intervalMs)) / intervalMs) : 0
    const finalQueue = uncompleted > 0 ? uncompleted : trailingBacklog
    assertG3Step(sync.get(), cursors); g3CompletionAssertions++
    unread.close(); replies.close(); topics.close(); await sync.close()
    return { samples, completed, totalEvents, finalQueue, maxQueue, ...summarizeSamples(samples) }
  }

  const sustainedDurationSec = smoke ? 1 : 60, sustainedRes = await runPacedWindow(100, sustainedDurationSec, true)
  await releaseCores()
  emit({
    type: 'sustained', arm, core: coreKind, round, rateMsgPerSec: 100, durationSec: sustainedDurationSec,
    totalEvents: sustainedRes.totalEvents, completedEvents: sustainedRes.completed,
    finalQueue: sustainedRes.finalQueue, maxQueue: sustainedRes.maxQueue, unit: 'ms',
    samples: sustainedRes.samples, p50: sustainedRes.p50, p95: sustainedRes.p95, p99: sustainedRes.p99,
  })

  const steppedDurationSec = smoke ? 0.15 : 10, windowSummaries: Array<{ rate: number; p95: number; finalQueue: number; sustainable: boolean }> = []
  let maxSustainableRate = 0
  for (const rate of [250, 500, 1000, 2000, 4000, 8000]) {
    const winRes = await runPacedWindow(rate, steppedDurationSec, false); await releaseCores()
    const sustainable = winRes.finalQueue === 0 && winRes.p95 <= 10.0
    if (sustainable) maxSustainableRate = rate
    windowSummaries.push({ rate, p95: winRes.p95, finalQueue: winRes.finalQueue, sustainable })
    emit({
      type: 'max_rate_window', arm, core: coreKind, round, rateMsgPerSec: rate, durationSec: steppedDurationSec,
      completedEvents: winRes.completed, finalQueue: winRes.finalQueue, maxQueue: winRes.maxQueue, unit: 'ms',
      samples: winRes.samples, p50: winRes.p50, p95: winRes.p95, p99: winRes.p99, sustainable,
    })
  }
  emit({ type: 'max_rate_summary', arm, core: coreKind, round, maxSustainableRateMsgPerSec: maxSustainableRate, windows: windowSummaries })

  // 3. Bulk Message Receipt (§5.4 Row 3)
  // Only core.step() is timed; get() returns the cached view, and the G3 scans run between steps outside the timer.
  const timedPlain = <T>(acc: { ms: number }, fn: () => T): T => { const t0 = performance.now(), r = fn(); acc.ms += performance.now() - t0; return r }
  const bulkWarmup = smoke ? 3 : 30, bulkReps = smoke ? 5 : 100, bulkC0 = fixtureUuid('bulk-C0')
  type BulkTimer = <T>(acc: { ms: number }, fn: () => T) => T
  function runBulkHistory8x50(create = createSelectedCore, timed: BulkTimer = timedPlain): number {
    const core = create(SELF_UUID)
    const connId = (core.step({ type: 'session_start', selfId: SELF_UUID }).effects.find((e) => e.type === 'connect') as { id: number }).id
    core.step({ type: 'connection_ready', connection: connId })
    const latestId = (core.step({ type: 'watch', channel: bulkC0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
    core.step({ type: 'history_result', request: latestId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 401,  messages: [makeMessage(401, bulkC0)], has_more: true } })
    core.step({ type: 'event', connection: connId, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: bulkC0, caught_up_seq: 401 } })
    const pages = Array.from({ length: 8 }, (_, p) => Array.from({ length: 50 }, (__, m) => makeMessage(400 - (p + 1) * 50 + 1 + m, bulkC0)))
    const acc = { ms: 0 }
    for (let p = 0; p < 8; p++) {
      const olderEff = timed(acc, () => core.step({ type: 'load_older', channel: bulkC0 })).effects; assertG3Step(core.get(), new Map([[bulkC0, 401]]))
      const reqId = (olderEff.find((e) => e.type === 'fetch_history') as { id: number }).id
      timed(acc, () => core.step({ type: 'history_result', request: reqId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: (pages[p]).at(-1)?.created_seq ?? 0,  messages: pages[p], has_more: p < 7 } })); assertG3Step(core.get(), new Map([[bulkC0, 401]]))
    }
    const elapsed = acc.ms
    if (core.get().channels[bulkC0].messages.length !== MAIN_MESSAGE_LIMIT) throw new Error('Expected 400 messages after 8x50')
    g3CompletionAssertions++; return Number(elapsed.toFixed(4))
  }
  function runBulkHistory2x200(create = createSelectedCore, timed: BulkTimer = timedPlain): number {
    const core = create(SELF_UUID)
    const connId = (core.step({ type: 'session_start', selfId: SELF_UUID }).effects.find((e) => e.type === 'connect') as { id: number }).id
    core.step({ type: 'connection_ready', connection: connId })
    const latestId = (core.step({ type: 'watch', channel: bulkC0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id
    const page1 = Array.from({ length: 200 }, (_, m) => makeMessage(201 + m, bulkC0)), page2 = Array.from({ length: 200 }, (_, m) => makeMessage(1 + m, bulkC0))
    const acc = { ms: 0 }
    timed(acc, () => core.step({ type: 'history_result', request: latestId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: (page1).at(-1)?.created_seq ?? 0,  messages: page1, has_more: true } })); assertG3Step(core.get(), new Map([[bulkC0, 400]]))
    const olderId = (timed(acc, () => core.step({ type: 'load_older', channel: bulkC0 })).effects.find((e) => e.type === 'fetch_history') as { id: number }).id; assertG3Step(core.get(), new Map([[bulkC0, 400]]))
    timed(acc, () => core.step({ type: 'history_result', request: olderId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: (page2).at(-1)?.created_seq ?? 0,  messages: page2, has_more: false } }))
    const elapsed = acc.ms; assertG3CatchUpComplete(core.get(), bulkC0, 400, MAIN_MESSAGE_LIMIT)
    return Number(elapsed.toFixed(4))
  }
  function runBulkCatchup(totalMessages: 250 | 1000, create = createSelectedCore, timed: BulkTimer = timedPlain): number {
    const core = create(SELF_UUID)
    const conn1 = (core.step({ type: 'session_start', selfId: SELF_UUID }).effects.find((e) => e.type === 'connect') as { id: number }).id
    core.step({ type: 'connection_ready', connection: conn1 })
    const latestId = (core.step({ type: 'watch', channel: bulkC0 }).effects.find((e) => e.type === 'fetch_history') as { id: number }).id, baseCursor = 100
    core.step({ type: 'history_result', request: latestId, page: { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 100,  messages: Array.from({ length: 100 }, (_, m) => makeMessage(1 + m, bulkC0)), has_more: false } })
    core.step({ type: 'event', connection: conn1, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: bulkC0, caught_up_seq: baseCursor } })
    if (totalMessages === 1000) {
      for (let i = 0; i < 405; i++) core.step({ type: 'event', connection: conn1, event: { type: 'message', kind: 'create', seq: (makeMessage(baseCursor + 2 + i * 2, bulkC0)).created_seq, message: makeMessage(baseCursor + 2 + i * 2, bulkC0) } })
      if (!core.get().channels[bulkC0].forgottenThrough) throw new Error('Expected forgottenThrough before 1000 catch-up')
    }
    const waitId = (core.step({ type: 'socket_closed', connection: conn1, code: totalMessages === 1000 ? 4008 : 1006 }).effects.find((e) => e.type === 'wait') as { id: number }).id
    const conn2 = (core.step({ type: 'timer_elapsed', id: waitId }).effects.find((e) => e.type === 'connect') as { id: number }).id
    core.step({ type: 'connection_ready', connection: conn2 })
    const pageCount = totalMessages / 50, highWaterSeq = baseCursor + totalMessages
    const pages = Array.from({ length: pageCount }, (_, p) => Array.from({ length: 50 }, (__, m) => makeMessage(baseCursor + p * 50 + 1 + m, bulkC0)))
    const acc = { ms: 0 }
    let subEff = timed(acc, () => core.step({ type: 'event', connection: conn2, event: { history_generation: '00000000-0000-4000-8000-000000000515', type: 'subscribed', channel_id: bulkC0, caught_up_seq: highWaterSeq } })).effects
    assertG3Step(core.get())
    for (let p = 0; p < pageCount; p++) {
      const fillReq = subEff.find((e) => e.type === 'fetch_history' && e.page === 'after') as { id: number } | undefined
      if (!fillReq) throw new Error(`Missing after_seq fill request at page ${p}`)
      // After-cursor fill answers with Channel events since #515 slice 3; only events advance the cursor.
      subEff = timed(acc, () => core.step({ type: 'events_result', request: fillReq.id, page: { history_generation: '00000000-0000-4000-8000-000000000515',
        events: pages[p].map((message) => ({ type: 'message' as const, kind: 'create' as const, seq: message.created_seq, message })), has_more: p < pageCount - 1 } })).effects
      assertG3Step(core.get(), new Map([[bulkC0, baseCursor + (p + 1) * 50]]))
    }
    const elapsed = acc.ms; assertG3CatchUpComplete(core.get(), bulkC0, highWaterSeq, MAIN_MESSAGE_LIMIT)
    if (core.get().channels[bulkC0].forgottenThrough !== undefined) throw new Error('Expected forgottenThrough cleared')
    return Number(elapsed.toFixed(4))
  }

  for (const [subCase, fn] of [
    ['history_8x50', runBulkHistory8x50], ['history_2x200', runBulkHistory2x200],
    ['catchup_250', () => runBulkCatchup(250)], ['catchup_1000', () => runBulkCatchup(1000)],
  ] as const) {
    for (let w = 0; w < bulkWarmup; w++) { fn(); await releaseCores() }
    const samples: number[] = []
    for (let r = 0; r < bulkReps; r++) { samples.push(fn()); await releaseCores() }
    emit({ type: 'bulk_receipt', arm, core: coreKind, round, subCase, repetitions: bulkReps, unit: 'ms', samples, ...summarizeSamples(samples) })
  }

  // 5. Receive-path split (#727 A1/A2), report-only. Runs last so every section above keeps its #487 conditions.
  // Both arms use production core-values; uninstrumented (plain) and instrumented (probed) trials alternate.
  const receiveProbe = (await import(pathToFileURL(resolve(webDir, 'scripts/receive-probe-core.ts')).href)) as typeof import('./receive-probe-core.ts')
  const variant = async <T>(path: string, name: 'prod' | 'probe') => (await import(`${pathToFileURL(resolve(webDir, path)).href}?${name}`)) as T
  const createProdCore = (await variant<{ createCore: (selfId: string) => SyncCore }>('src/core-wasm.ts', 'prod')).createCore
  const timedProbe = <T>(acc: { ms: number }, fn: () => T): T => {
    receiveProbe.probe.armed = true
    const t0 = performance.now(), r = fn(); acc.ms += performance.now() - t0
    receiveProbe.probe.armed = false
    return r
  }
  type CoreFactory = (selfId: string) => SyncCore
  const a1Cases = [
    ['history_8x50', (create: CoreFactory, time: BulkTimer) => runBulkHistory8x50(create, time)],
    ['history_2x200', (create: CoreFactory, time: BulkTimer) => runBulkHistory2x200(create, time)],
    ['catchup_250', (create: CoreFactory, time: BulkTimer) => runBulkCatchup(250, create, time)],
    ['catchup_1000', (create: CoreFactory, time: BulkTimer) => runBulkCatchup(1000, create, time)],
  ] as const
  for (const [subCase, fn] of a1Cases) {
    const plain: number[] = [], probed: Array<{ total: number; input: number; wasm: number; output: number; steps: number }> = []
    for (let r = 0; r < bulkWarmup + bulkReps; r++) {
      const plainMs = fn(createProdCore, timedPlain); await releaseCores()
      receiveProbe.resetParts()
      const total = fn(receiveProbe.createCore, timedProbe), { input, wasm, output, steps } = receiveProbe.parts
      await releaseCores()
      if (steps === 0) throw new Error(`A1 ${subCase}: no probed step`)
      if (r >= bulkWarmup) { plain.push(plainMs); probed.push({ total, input, wasm, output, steps }) }
    }
    emit({ type: 'receive_a1', arm, core: coreKind, round, subCase, repetitions: bulkReps, unit: 'ms', plain, probed })
  }

  type RealtimeHandlers = { onReady(): void; onEvent(event: unknown): void; onClose(code: number): void }
  type ReplaySocket = { send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number }) => void) | null }
  type ReplaySyncFn = (opts: {
    selfId: string; newId?: () => string
    api: Parameters<CreateSyncFn>[0]['api'] & { listChannelEvents(ch: string, q: unknown): Promise<OkResult<components['schemas']['ChannelEventPage']>> }
    connect(h: RealtimeHandlers): { send(message: unknown): void; close(): void }
  }) => Omit<SyncInstance, 'getTimeline'> & { getTimeline(ch: string): { subscribe(listener: () => void): () => void } }
  const { connectRealtime } = (await import(pathToFileURL(resolve(webDir, 'src/realtime.ts')).href)) as {
    connectRealtime(handlers: RealtimeHandlers, open: () => ReplaySocket): { send(message: unknown): void; close(): void }
  }
  const createProdSync = (await variant<{ createSync: ReplaySyncFn }>('src/sync.ts', 'prod')).createSync
  const createProbeSync = (await variant<{ createSync: ReplaySyncFn }>('src/sync.ts', 'probe')).createSync
  const realParse = JSON.parse
  type ReplayParts = { total: number; parse: number; validate: number; stepInput: number; wasm: number; output: number; controller: number; steps: number }
  // One trial: the Channel's base page, then `frameCount` replayed Create frames and `subscribed`, in the S3 order.
  async function runReplay(frameCount: 250 | 1000, probed: boolean): Promise<ReplayParts | number> {
    const ch = fixtureUuid('replay-C0'), baseSeq = 100, generation = '00000000-0000-4000-8000-000000000515'
    let socket: ReplaySocket | undefined, sendSeq = 0, tEvent = 0, events = 0
    const sent: string[] = []
    const sync = (probed ? createProbeSync : createProdSync)({
      selfId: SELF_UUID, newId: () => fixtureUuid(`replay-cid-${++sendSeq}`),
      api: {
        async listChannelEvents() { return { ok: true, data: { history_generation: generation, events: [], has_more: false } } },
        async listMessages() { return { ok: true, data: { history_generation: generation, as_of_seq: baseSeq, messages: Array.from({ length: baseSeq }, (_, m) => makeMessage(m + 1, ch)), has_more: false } } },
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
    frames.push(JSON.stringify({ history_generation: generation, type: 'subscribed', channel_id: ch, caught_up_seq: baseSeq + frameCount }))
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
    const t0 = performance.now()
    try {
      for (const data of frames) {
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
    assertG3Step(sync.get()); g3CompletionAssertions++
    if (notifications === 0 || total <= 0) throw new Error('A2: no view notification')
    if (probed && events !== frames.length) throw new Error(`A2: ${events} events reached the controller, expected ${frames.length}`)
    const { input: stepInput, wasm, output, steps } = receiveProbe.parts
    unsubscribe(); await sync.close()
    if (!probed) return total
    return { total, parse, validate, stepInput, wasm, output, controller: total - parse - validate - stepInput - wasm - output, steps }
  }
  for (const frameCount of [250, 1000] as const) {
    const plain: number[] = [], probed: ReplayParts[] = []
    for (let r = 0; r < bulkWarmup + bulkReps; r++) {
      const plainMs = await runReplay(frameCount, false); await releaseCores()
      const parts = await runReplay(frameCount, true); await releaseCores()
      if (typeof plainMs !== 'number' || typeof parts === 'number') throw new Error('A2: trial kind mismatch')
      if (r >= bulkWarmup) { plain.push(plainMs); probed.push(parts) }
    }
    emit({ type: 'receive_a2', arm, core: coreKind, round, frames: frameCount, repetitions: bulkReps, unit: 'ms', plain, probed })
  }

  {
    emit({ type: 'g3_integrity', arm, core: coreKind, round, passed: true, totalStepAssertions: g3StepAssertions, totalRunCompletionAssertions: g3CompletionAssertions })
    writeFileSync(outFile, jsonLines.join('\n') + '\n')

    console.log(JSON.stringify({
      arm, core: coreKind, round, smoke, outFile, stepUs: combinedSum,
      sustainedMs: { p50: sustainedRes.p50, p95: sustainedRes.p95, p99: sustainedRes.p99, finalQueue: sustainedRes.finalQueue },
      maxSustainableRateMsgPerSec: maxSustainableRate,
      memory: {
        steadyMiB: Number((memory.steadyMedianBytes / 1024 ** 2).toFixed(2)),
        peakMiB: Number((memory.peakMaxBytes / 1024 ** 2).toFixed(2)),
        wasmKiB: Number((memory.wasmPeakBytes / 1024).toFixed(1)),
        olsSlopeBytesPerMsg: Number(memory.slope.toFixed(2)),
        wasmPagesAddedPostWarmup: memory.wasmPagesAddedPostWarmup,
      },
      g3: { passed: true, stepAssertions: g3StepAssertions, completionAssertions: g3CompletionAssertions },
    }))
  }
}

await main()
