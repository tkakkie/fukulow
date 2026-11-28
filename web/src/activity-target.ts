import { createActivityReadsCore, EffectCode, InputCode } from './activity-reads-wasm'
import type { Result, ServerEvent } from './api'
import { createRequestDeadlines } from './request-deadlines.ts'

export type ActivityRead<T> = { startedAt: number; result: Result<T> }
export type ActivityNotice = Exclude<ServerEvent, { type: 'message' | 'subscribed' | 'channel_access_lost' | 'error' }>
export type Invalidation = 'notice' | 'access' | 'reconcile' | 'periodic'
export type ReadReason = 'initial' | Invalidation
export type FencedInvalidation = Exclude<Invalidation, 'notice'>
export type ActivityTarget = { held?(): void; invalidate(reason?: Invalidation, delay?: number, discovery?: boolean): void; ready?(): boolean; disconnected?(): void; suspend?(): void; close(): void; notice?(event: ActivityNotice): void }

/** Shared bounds for every held REST target; late completions never regain authority. */
export function createActivityTarget<T>(options: {
  canLoad?(): boolean
  load(signal: AbortSignal, reasons: readonly ReadReason[]): Promise<Result<T>>
  retryQueuedTerminal?: boolean
  covers?(value: T): boolean
  /** A snapshot can carry authoritative data even when a derived baseline needs a follow-up. */
  acceptBelowFloor?: boolean
  /** Current active connection epoch, or null while disconnected. */
  connectionEpoch?(): number | null
  /** Re-applies already-accepted current-connection state after reconcile clears derived baselines. */
  onReadyCovered?(): void
  hide?(reason: FencedInvalidation): void
  error?(result: Exclude<Result<T>, { ok: true }>): void
  terminal?(result: Result<T>): boolean
  random?: () => number
  timeoutMs?: number
  /** A bounded multi-lane target owns retry admission; deadlines remain shared here. */
  manualRetry?: boolean
  settled?(): void
} & (
  { stampRead?: never; accept(value: T): void } |
  { stampRead(): number; accept(value: T, startedAt: number): void }
)) {
  const core = createActivityReadsCore(options)
  const random = options.random ?? Math.random
  const deadlines = createRequestDeadlines()
  let timer: ReturnType<typeof setTimeout> | undefined
  let failure: Exclude<Result<T>, { ok: true }> | undefined
  let completion: (() => void) | undefined
  let controller: AbortController | undefined
  let running: Promise<ActivityRead<T> | undefined> | undefined

  type Input = Parameters<typeof core.step>[0]
  type Effect = ReturnType<typeof core.step>[number]
  type Start = Extract<Effect, { type: EffectCode.Start }>
  type Completion = { start: Start; startedAt: number; result: Result<T> }
  const step = (input: Input) => core.step(input, Date.now())

  function apply(effect: Effect) {
    switch (effect.type) {
      case EffectCode.Run: return run()
      case EffectCode.Join: return running
      case EffectCode.ClearFailure: failure = undefined; break
      case EffectCode.CancelTimer: clearTimeout(timer); timer = undefined; break
      case EffectCode.Schedule:
        timer = setTimeout(() => {
          timer = undefined
          dispatch({ type: InputCode.Deadline, generation: effect.generation })
        }, effect.delay)
        break
      case EffectCode.Abort: completion?.(); controller?.abort(); break
      case EffectCode.Hide:
        options.hide?.(effect.reason)
        if (effect.demand !== null) dispatch({ type: InputCode.Demand, delay: effect.demand })
        break
      case EffectCode.Backoff:
        dispatch({ type: InputCode.RetryDelay, cap: effect.cap, retryAfter: effect.retryAfter, draw: random() })
        break
    }
  }

  function dispatch(input: Input) {
    let pending: Promise<ActivityRead<T> | undefined> | undefined
    for (const effect of step(input)) pending = apply(effect) ?? pending
    return pending
  }

  // ensure() joins the load in flight instead of settling before it.
  function run() {
    const started = !core.inFlight(), pending = execute()
    if (started && core.inFlight()) {
      running = pending
      // Callers observe the rejection on pending itself; the bookkeeping chain must not add another.
      void pending.finally(() => { if (running === pending) running = undefined }).catch(() => {})
    }
    return pending
  }

  async function execute() {
    for (const effect of step({ type: InputCode.Run })) {
      if (effect.type !== EffectCode.CheckCanLoad || options.canLoad?.() === false) continue
      for (const start of step({ type: InputCode.Start, epoch: options.connectionEpoch?.() ?? null })) {
        if (start.type === EffectCode.Start) {
          // Await in this function so joining adds no promise turn.
          const startedAt = options.stampRead?.() ?? 0
          const request = new AbortController()
          controller = request
          let cancelled = false
          let pending: Promise<Result<T>>
          try { pending = options.load(request.signal, start.reasons).catch((): Result<T> => ({ ok: false, kind: 'network' })) }
          catch { pending = Promise.resolve({ ok: false, kind: 'network' }) }
          const networkFailure: Result<T> = { ok: false, kind: 'network' }
          completion = () => { cancelled = true; request.abort(); deadlines.cancel() }
          const result = await deadlines.wait(pending, networkFailure, {
            timeoutMs: options.timeoutMs ?? 10_000,
            onTimeout: () => { request.abort(); return networkFailure },
          })
          completion = undefined
          if (controller === request) controller = undefined
          for (const effect of step({ type: InputCode.ReadCompleted, cancelled })) {
            if (effect.type === EffectCode.Finish) return finish({ start, startedAt, result }, effect.servingNotice)
            apply(effect)
          }
        } else apply(start)
      }
    }
  }

  function finish({ start, startedAt, result }: Completion, servingNotice: boolean) {
    const { read, reasons } = start
    const demand = { reasons, servingNotice }
    try {
      if (result.ok) {
        for (const effect of step({ type: InputCode.Success, read, ...demand })) {
          if (effect.type !== EffectCode.CheckCoverage) { apply(effect); continue }
          const covered = options.covers?.(result.data) !== false
          for (const coverage of step({ type: InputCode.Coverage, ...demand, covered })) {
            if (coverage.type !== EffectCode.PrepareAccept) { apply(coverage); continue }
            for (const accept of step({ type: InputCode.Accept, read, covered: coverage.covered })) {
              if (accept.type !== EffectCode.Accept) { apply(accept); continue }
              if (options.stampRead) options.accept(result.data, startedAt)
              else options.accept(result.data)
              dispatch({ type: InputCode.AfterAccept, covered: accept.covered })
              if (core.isCurrent(read.generation)) return { startedAt, result }
            }
          }
        }
      } else {
        for (const effect of step({ type: InputCode.Failure, read })) {
          if (effect.type === EffectCode.Error) { failure = result; options.error?.(result) }
        }
        const terminal = step({ type: InputCode.CheckTerminal, read }).some(effect => effect.type === EffectCode.CheckTerminal) && options.terminal?.(result)
        const input: Input = terminal ? { type: InputCode.Stop } : { type: InputCode.RetryFailure,
          read, ...demand,
          failure: { network: result.kind === 'network', status: 'status' in result ? result.status : undefined, retryAfter: result.retryAfterMs },
        }
        for (const effect of step(input)) {
          if (effect.type === EffectCode.Return || (effect.type === EffectCode.ReturnIfCurrent && core.isCurrent(read.generation))) return { startedAt, result }
          apply(effect)
        }
      }
    } finally { options.settled?.() }
  }

  function invalidate(reason: Invalidation = 'notice', delay = 200) {
    dispatch({ type: InputCode.Invalidate, reason, delay })
  }
  return {
    invalidate,
    fence: () => { dispatch({ type: InputCode.Fence }) },
    ready() {
      for (const effect of step({ type: InputCode.Ready, epoch: options.connectionEpoch?.() ?? null })) {
        switch (effect.type) {
          case EffectCode.InvalidateForReady: invalidate('reconcile'); dispatch({ type: InputCode.ReadyReplacement }); return true
          case EffectCode.ReadyCovered: options.onReadyCovered?.(); break
          case EffectCode.Return: return true
          default: apply(effect)
        }
      }
      return false
    },
    demandCoverage: () => { dispatch({ type: InputCode.DemandCoverage }) },
    failure: () => failure,
    inFlight: core.inFlight,
    idle: core.idle,
    pendingNotice: core.pendingNotice,
    ensure: () => dispatch({ type: InputCode.Ensure }),
    refresh: (reason: ReadReason = 'reconcile') => dispatch({ type: InputCode.Refresh, reason }),
    flushQueued: () => dispatch({ type: InputCode.FlushQueued }),
    retryNow: () => dispatch({ type: InputCode.RetryNow }),
    suspend: () => { dispatch({ type: InputCode.Suspend }) },
    close: () => { dispatch({ type: InputCode.Close }) },
  }
}
