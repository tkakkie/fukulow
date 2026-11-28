import init, { WasmActivityRouting, WasmCore } from '../wasm/fukulow_client_core'
import { createValues } from './core-values'
import { identityOrder, rememberIdentityResponse } from './identity-order'
import type { Channel, Message } from './api'
import type { ActivityNotice, Invalidation } from './activity-target'
import type { AccessEndpoint, AccessLifetime, AccessOutcome, ChannelState, CoreResult, Failure, Input, Pending, Purpose, State, SyncCore, SyncView } from './protocol-types'

// A Node micro-benchmark on a 200-Message Channel had find and Map break even at ~4 inserts and Map
// clearly ahead at 8 (5.75 µs vs 2.38 µs); a single append pays ~1.7 µs more with the Map (#488).
const PRIOR_MAP_MIN_INSERTS = 8

let ready: Promise<void> | undefined
/** Starts loading once; every caller shares the same outcome, so a failed load is never retried behind the error. */
export function initCore(): Promise<void> {
  return ready ??= init().then(() => undefined)
}

export function syncDelay(purpose: Purpose, attempt: number, drawOrMs = 0): number {
  return WasmCore.syncDelay(purpose, attempt, drawOrMs)
}

export function accessOutcome(endpoint: AccessEndpoint, lifetime: AccessLifetime, failure: { status: Failure; error?: string }): AccessOutcome {
  const status = typeof failure.status === 'number' ? failure.status : undefined
  return JSON.parse(WasmCore.accessOutcome(endpoint, lifetime, status, failure.error)) as AccessOutcome
}

export function isGenerationConflict(failure: { status: Failure; error?: string }): boolean {
  const status = typeof failure.status === 'number' ? failure.status : undefined
  return WasmCore.isGenerationConflict(status, failure.error)
}

export type ActivityFacts = {
  kind?: Channel['kind'] | 'dm'
  hasKindLookup?: boolean
  watched?: boolean
  listCovered?: boolean
  projectionCovered?: boolean
  afterLists?: boolean
  asOfSeq?: number
  mainReadSeq?: number
  topicReadSeq?: number
}
type ActivityEpoch = { connection?: number; current_connection?: number | null }
type ActivityInput =
  | ({ type: 'notice'; event: ActivityNotice; facts?: ActivityFacts } & ActivityEpoch)
  | ({ type: 'tick'; generation: number } & ActivityEpoch)
  | { type: 'disconnected' | 'close' | 'invalidate_member_lists' }
type ActivityDelay = 'first' | 'periodic' | 'reset'
type ActivityTarget =
  | 'channels' | 'archived-channels' | 'open-channel' | 'dms' | 'sections' | 'capabilities'
  | 'channel-members' | 'main' | 'topic'
type ActivityEffect =
  | { type: 'inspect' | 'ready_targets' | 'observe_read' | 'inspect_read_projection' | 'notify_sections' | 'revoke' | 'retire_channel_members' | 'gain' }
  | { type: 'invalidate'; target: ActivityTarget; reason: Invalidation; debounce: number; discovery: boolean | null }
  | { type: 'invalidate_member_lists'; key: string; prefix: string; reason: Invalidation; debounce: number }
  | { type: 'reconcile'; reason: Invalidation; first: string; ready: boolean; debounce: number; jitter: ActivityDelay | null }
  | { type: 'arm'; generation: number; timing: ActivityDelay }
  | { type: 'cancel' | 'disconnect_targets' | 'close_targets' }

export function createActivityRoutingCore() {
  const core = new WasmActivityRouting()
  return {
    step(input: ActivityInput, lifetime: AccessLifetime): ActivityEffect[] {
      let encoded: unknown = input.type
      if (input.type === 'notice') {
        const { type, event, ...context } = input
        const notice = event.type === 'channel_activity' ? { channel_activity: event.seq }
          : event.type === 'read_position_changed' ? { read_position_changed: { read_seq: event.read_seq, topic: event.topic_id !== null } }
            : event.type
        encoded = { [type]: { ...context, event: notice } }
      } else if (input.type === 'tick') {
        const { type, ...tick } = input
        encoded = { [type]: tick }
      }
      return JSON.parse(core.step(JSON.stringify(encoded), lifetime)) as ActivityEffect[]
    },
    delay: (timing: ActivityDelay, period: number | undefined, draw: number) => WasmActivityRouting.delay(timing, period, draw),
  }
}

type Interned<T> = Omit<T, 'body'> & { body?: number }
type Send = Extract<CoreResult['effects'][number], { type: 'send' }>
type Splice = { start: number; delete: number; insert: Interned<Message>[] }
type ChannelPatch = {
  metadata: Omit<ChannelState, 'messages' | 'pending' | 'advancing'>
  splices?: Splice[]
  pending?: (Interned<Pending> | number)[]
  advancing?: ChannelState['advancing']
}
type Session = Omit<State, 'channels' | 'requests' | 'timers'>
type Delta = Omit<CoreResult, 'changedChannels' | 'records' | 'effects'> & {
  changedChannels: string[]
  records: [string, Interned<Message>[]][]
  effects: (Exclude<CoreResult['effects'][number], Send> | Interned<Send>)[]
  channels: Record<string, ChannelPatch | null>
  session?: Session
  bodies: string[]
}
function expandBody<T extends { body?: string }>(value: Interned<T>, bodies: string[]): T {
  const decoded = value as unknown as T
  if (value.body !== undefined) decoded.body = bodies[value.body]
  return decoded
}
const sameFields = (a: object, b: object) => {
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  return [...Object.keys(a), ...Object.keys(b)].every(key => left[key] === right[key])
}
const sameMessage = (a: Message, b: Message) => a.history_generation === b.history_generation && a.id === b.id && a.channel_id === b.channel_id && a.created_seq === b.created_seq && a.version === b.version && a.deleted === b.deleted &&
  a.client_message_id === b.client_message_id && a.sender === b.sender && a.body === b.body && a.created_at === b.created_at &&
  (!a.deleted || (!('body' in a) && !('mentions' in a))) && a.topic_id === b.topic_id && a.reply_to === b.reply_to && a.reply_root_id === b.reply_root_id &&
  (a.mentions ?? []).length === (b.mentions ?? []).length && (a.mentions ?? []).every((m, i) => m.member_id === b.mentions![i].member_id && m.name === b.mentions![i].name)

export function inputMessages(input: Input): Message[] {
  return (input.type === 'event' || input.type === 'socket_frame') && input.event.type === 'message' && 'message' in input.event ? [input.event.message]
    : input.type === 'ack' ? [input.message]
    : input.type === 'history_result' ? input.page.messages
    : input.type === 'events_result' ? input.page.events.flatMap(e => e.type === 'message' && 'message' in e ? [e.message] : [])
    : []
}

export function createCore(selfId: string): SyncCore {
  const { coreId, coreInput, coreOutput } = createValues()
  const read = <T>(json: string): T => coreOutput(JSON.parse(json)) as T
  const core = new WasmCore(coreId(selfId))
  let view: SyncView = { ...read<Session>(core.session()), channels: {} }
  return {
    get: () => view,
    request: id => read<ReturnType<SyncCore['request']>>(core.request(id)) ?? undefined,
    timer: id => read<ReturnType<SyncCore['timer']>>(core.timer(id)) ?? undefined,
    hasPending: () => core.hasPending(),
    historyIssue: () => core.historyIssue(),
    subscribeIssued: (connection, channel, id) => core.subscribeIssued(connection, coreId(channel), id),
    step(input: Input): CoreResult {
      const out = read<Delta>(core.step(JSON.stringify(coreInput(input))))
      const { bodies } = out
      const originals = new Map(inputMessages(input).map(m => [m.id, m]))
      const channelViews = out.changedChannels.length ? { ...view.channels } : view.channels
      const records = new Map(out.records.map(([id, messages]) => [id, messages.map(encoded => {
        const m = expandBody<Message>(encoded, bodies)
        const original = originals.get(m.id)
        if (original && sameMessage(original, m)) return original
        rememberIdentityResponse(m, original ? identityOrder(original) : undefined)
        return m
      })]))
      for (const id of out.changedChannels) {
        const patch = out.channels[id]
        if (!patch) { delete channelViews[id]; continue }
        const before = view.channels[id]
        const next = { retiredThrough: undefined, heldThrough: undefined, forgottenThrough: undefined, lastUsed: undefined, retainedCount: undefined,
          streamBase: undefined, snapshotSeq: undefined, moveSeq: undefined, moveEpoch: undefined, latest: undefined, older: undefined, fill: undefined, wait: undefined, subscription: undefined,
          ...patch.metadata,
          messages: before?.messages ?? [],
          pending: before?.pending ?? [],
          advancing: patch.advancing ?? before?.advancing ?? [],
        } as ChannelState
        if (before?.subscription && next.subscription && sameFields(before.subscription, next.subscription)) next.subscription = before.subscription
        if (patch.pending) {
          next.pending = patch.pending.map(p => typeof p === 'number' ? before.pending[p]
            : { retryWait: undefined, failureCode: undefined, ...expandBody<Pending>(p, bodies) })
        }
        if (patch.splices) {
          const observed = new Map(records.get(id)?.map(m => [m.id, m]))
          let insertCount = 0
          for (const op of patch.splices) insertCount += op.insert.length
          let priorById: Map<string, Message> | undefined
          if (insertCount >= PRIOR_MAP_MIN_INSERTS && before?.messages.length) {
            priorById = new Map()
            for (const old of before.messages) {
              if (!priorById.has(old.id)) priorById.set(old.id, old)
            }
          }
          const restore = (encoded: Interned<Message>) => {
            const m = expandBody<Message>(encoded, bodies)
            const prior = priorById ? priorById.get(m.id) : before?.messages.find(old => old.id === m.id)
            const record = observed.get(m.id)
            if (prior && sameMessage(prior, m) && !(input.refreshMentionNames && record)) return prior
            if (record && sameMessage(record, m)) return record
            return m
          }
          next.messages = next.messages.slice()
          // Offsets are relative to the previous window.
          for (let i = patch.splices.length - 1; i >= 0; i--) {
            const op = patch.splices[i]
            next.messages.splice(op.start, op.delete, ...op.insert.map(restore))
          }
        }
        channelViews[id] = next
      }
      if (out.stateChanged) {
        // A new Session snapshot can also remove optional fields.
        view = { ...(out.session ?? view), channels: channelViews }
      }
      const effects = out.effects.map(e => e.type === 'send' ? expandBody<Send>(e, bodies) : e)
      return { effects, changedChannels: new Set(out.changedChannels), records,
        ...(out.moves ? { moves: out.moves } : {}),
        ...(out.socketDelivery ? { socketDelivery: out.socketDelivery } : {}),
        ...(out.historyObservation ? { historyObservation: out.historyObservation } : {}), stateChanged: out.stateChanged }
    },
  }
}

export { createReplyCountCore } from './reply-count-core-wasm'
