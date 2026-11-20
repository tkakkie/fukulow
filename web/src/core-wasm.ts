import init, { WasmCore } from '../wasm/fukulow_client_core'
import { createValues } from './core-values'
import { identityOrder, rememberIdentityResponse } from './identity-order'
import type { Message } from './api'
import type { ChannelState, CoreResult, Input, Pending, State, SyncCore, SyncView } from './protocol-types'

let ready: Promise<void> | undefined
/** Starts loading once; every caller shares the same outcome, so a failed load is never retried behind the error. */
export function initCore(): Promise<void> {
  return ready ??= init().then(() => undefined)
}

type Delta = Omit<CoreResult, 'changedChannels' | 'records'> & {
  changedChannels: string[]
  records: [string, Message[]][]
  channels: Record<string, (Omit<Partial<ChannelState>, 'messages' | 'pending'> & {
    messages?: (Message | number)[]; pending?: (Pending | number)[]
  }) | null>
  session: Omit<State, 'channels' | 'requests' | 'timers'>
  bodies: string[]
}
function expandBodies(value: unknown, bodies: string[]): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'body' && typeof child === 'number') (value as Record<string, unknown>)[key] = bodies[child]
    else expandBodies(child, bodies)
  }
}
const sameFields = (a: object, b: object) => {
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  return [...Object.keys(a), ...Object.keys(b)].every(key => left[key] === right[key])
}
const sameMessage = (a: Message, b: Message) => a.history_generation === b.history_generation && a.id === b.id && a.channel_id === b.channel_id && a.created_seq === b.created_seq && a.version === b.version && a.deleted === b.deleted &&
  a.client_message_id === b.client_message_id && a.sender === b.sender && a.body === b.body && a.created_at === b.created_at &&
  (!a.deleted || (!('body' in a) && !('mentions' in a))) && a.topic_id === b.topic_id && a.reply_to === b.reply_to && a.reply_root_id === b.reply_root_id &&
  (a.mentions ?? []).length === (b.mentions ?? []).length && (a.mentions ?? []).every((m, i) => m.member_id === b.mentions![i].member_id && m.name === b.mentions![i].name)

export function createCore(selfId: string): SyncCore {
  const { coreId, coreInput, coreOutput } = createValues()
  const read = <T>(json: string): T => coreOutput(JSON.parse(json)) as T
  const core = new WasmCore(coreId(selfId))
  let view: SyncView = { ...read<Delta['session']>(core.session()), channels: {} }
  return {
    get: () => view,
    request: id => read<ReturnType<SyncCore['request']>>(core.request(id)) ?? undefined,
    timer: id => read<ReturnType<SyncCore['timer']>>(core.timer(id)) ?? undefined,
    hasPending: () => core.hasPending(),
    step(input: Input): CoreResult {
      const out = read<Delta>(core.step(JSON.stringify(coreInput(input))))
      expandBodies(out, out.bodies)
      const incoming = input.type === 'event' && input.event.type === 'message' && 'message' in input.event ? [input.event.message]
        : input.type === 'ack' ? [input.message] : input.type === 'history_result' ? input.page.messages : input.type === 'events_result' ? input.page.events.flatMap(e => e.type === 'message' && 'message' in e ? [e.message] : []) : []
      const originals = new Map(incoming.map(m => [m.id, m]))
      const channelViews = out.changedChannels.length ? { ...view.channels } : view.channels
      const records = new Map(out.records.map(([id, messages]) => [id, messages.map(m => {
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
          ...patch,
          messages: patch.messages ?? before?.messages ?? [],
          pending: patch.pending ?? before?.pending ?? [],
          advancing: patch.advancing ?? before?.advancing ?? [],
        } as ChannelState
        if (before?.subscription && next.subscription && sameFields(before.subscription, next.subscription)) next.subscription = before.subscription
        if (patch.pending) {
          next.pending = patch.pending.map(p => typeof p === 'number' ? before.pending[p]
            : { retryWait: undefined, failureCode: undefined, ...p })
        }
        if (patch.messages) {
          const observed = new Map(records.get(id)?.map(m => [m.id, m]))
          next.messages = patch.messages.map(m => {
            if (typeof m === 'number') return before.messages[m]
            const prior = before?.messages.find(old => old.id === m.id)
            const record = observed.get(m.id)
            if (prior && sameMessage(prior, m) && !(input.refreshMentionNames && record)) return prior
            if (record && sameMessage(record, m)) return record
            return m
          })
        }
        channelViews[id] = next
      }
      if (out.stateChanged) view = { ...out.session, channels: out.changedChannels.length ? channelViews : view.channels }
      return { effects: out.effects, changedChannels: new Set(out.changedChannels), records,
        ...(out.moves ? { moves: out.moves } : {}), stateChanged: out.stateChanged }
    },
  }
}

export { createReplyCountCore } from './reply-count-core-wasm'
