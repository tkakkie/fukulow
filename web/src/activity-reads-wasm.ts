import { ActivityReadEffectCode as EffectCode, ActivityReadInputCode as InputCode, WasmActivityReads } from '../wasm/fukulow_client_core'
import type { FencedInvalidation, Invalidation, ReadReason } from './activity-target'

export { EffectCode, InputCode }

type ActivityReadTicket = { generation: number; epoch: number | null }
type ActivityReadDemand = { reasons: ReadReason[]; servingNotice: boolean }
type ActivityReadInput =
  | { type: InputCode.DemandCoverage | InputCode.ReadyReplacement | InputCode.Fence | InputCode.Ensure
    | InputCode.FlushQueued | InputCode.RetryNow | InputCode.Run | InputCode.Stop | InputCode.Suspend | InputCode.Close }
  | { type: InputCode.Invalidate; reason: Invalidation; delay: number }
  | { type: InputCode.Demand; delay: number }
  | { type: InputCode.Ready; epoch: number | null }
  | { type: InputCode.Refresh; reason: ReadReason }
  | { type: InputCode.Start; epoch: number | null }
  | { type: InputCode.Deadline; generation: number }
  | { type: InputCode.ReadCompleted; cancelled: boolean }
  | (ActivityReadDemand & { type: InputCode.Success; read: ActivityReadTicket })
  | (ActivityReadDemand & { type: InputCode.Coverage; covered: boolean })
  | { type: InputCode.Accept; read: ActivityReadTicket; covered: boolean }
  | { type: InputCode.AfterAccept; covered: boolean }
  | { type: InputCode.Failure; read: ActivityReadTicket }
  | { type: InputCode.CheckTerminal; read: ActivityReadTicket }
  | (ActivityReadDemand & {
    type: InputCode.RetryFailure
    read: ActivityReadTicket
    failure: { network: boolean; status?: number; retryAfter?: number }
  })
  | { type: InputCode.RetryDelay; cap: number; retryAfter: number; draw: number }

type ActivityReadEffect =
  | { type: EffectCode.Run | EffectCode.Join | EffectCode.CheckCanLoad | EffectCode.CancelTimer | EffectCode.Abort
    | EffectCode.InvalidateForReady | EffectCode.ReadyCovered | EffectCode.ClearFailure
    | EffectCode.CheckCoverage | EffectCode.Error | EffectCode.CheckTerminal | EffectCode.Return | EffectCode.ReturnIfCurrent }
  | { type: EffectCode.Start; read: ActivityReadTicket; reasons: ReadReason[] }
  | { type: EffectCode.Schedule; generation: number; delay: number }
  | { type: EffectCode.Hide; reason: FencedInvalidation; demand: number | null }
  | { type: EffectCode.Finish; servingNotice: boolean }
  | { type: EffectCode.PrepareAccept | EffectCode.Accept; covered: boolean }
  | { type: EffectCode.Backoff; cap: number; retryAfter: number }

// Reason codes match the Rust table. The order of the reasons within a read is preserved.
const reasons = ['initial', 'notice', 'access', 'reconcile', 'periodic'] as const
const reasonCode = (reason: ReadReason) => reasons.indexOf(reason)
const ticket = (read: ActivityReadTicket) => [read.generation, read.epoch ?? NaN]

function fields(input: ActivityReadInput): number[] {
  switch (input.type) {
    case InputCode.Invalidate: return [reasonCode(input.reason), input.delay]
    case InputCode.Demand: return [input.delay]
    case InputCode.Ready:
    case InputCode.Start: return [input.epoch ?? NaN]
    case InputCode.Refresh: return [reasonCode(input.reason)]
    case InputCode.Deadline: return [input.generation]
    case InputCode.ReadCompleted: return [Number(input.cancelled)]
    case InputCode.Success: return [...ticket(input.read), Number(input.servingNotice), ...input.reasons.map(reasonCode)]
    case InputCode.Coverage: return [Number(input.servingNotice), Number(input.covered), ...input.reasons.map(reasonCode)]
    case InputCode.Accept: return [...ticket(input.read), Number(input.covered)]
    case InputCode.AfterAccept: return [Number(input.covered)]
    case InputCode.Failure:
    case InputCode.CheckTerminal: return ticket(input.read)
    case InputCode.RetryFailure: {
      const { network, status, retryAfter } = input.failure
      return [...ticket(input.read), Number(input.servingNotice), Number(network), status ?? NaN, retryAfter ?? NaN,
        ...input.reasons.map(reasonCode)]
    }
    case InputCode.RetryDelay: return [input.cap, input.retryAfter, input.draw]
    default: return []
  }
}

const optional = (value: number) => Number.isNaN(value) ? null : value

// Effects are concatenated in dispatch order. Start prefixes the ordered reasons with their count.
function decode(encoded: Float64Array): ActivityReadEffect[] {
  const effects: ActivityReadEffect[] = []
  for (let i = 0; i < encoded.length;) {
    const type = encoded[i++] as EffectCode
    switch (type) {
      case EffectCode.Start: {
        const read = { generation: encoded[i++], epoch: optional(encoded[i++]) }
        const length = encoded[i++]
        const demand = Array.from(encoded.subarray(i, i + length), code => reasons[code])
        i += length
        effects.push({ type, read, reasons: demand })
        break
      }
      case EffectCode.Schedule: effects.push({ type, generation: encoded[i++], delay: encoded[i++] }); break
      case EffectCode.Hide: {
        const reason = reasons[encoded[i++] as 2 | 3 | 4]
        effects.push({ type, reason, demand: optional(encoded[i++]) })
        break
      }
      case EffectCode.Finish: effects.push({ type, servingNotice: !!encoded[i++] }); break
      case EffectCode.PrepareAccept:
      case EffectCode.Accept: effects.push({ type, covered: !!encoded[i++] }); break
      case EffectCode.Backoff: effects.push({ type, cap: encoded[i++], retryAfter: encoded[i++] }); break
      default: effects.push({ type })
    }
  }
  return effects
}

export function createActivityReadsCore(options: { manualRetry?: boolean; retryQueuedTerminal?: boolean; acceptBelowFloor?: boolean }) {
  const core = new WasmActivityReads(!!options.manualRetry, !!options.retryQueuedTerminal, !!options.acceptBelowFloor)
  return {
    step(input: ActivityReadInput, now: number): ActivityReadEffect[] {
      return decode(core.step(input.type, now, fields(input)))
    },
    isCurrent: (generation: number) => core.isCurrent(generation),
    inFlight: () => core.inFlight(),
    idle: () => core.idle(),
    pendingNotice: () => core.pendingNotice(),
  }
}
