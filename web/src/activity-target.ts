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
  const random = options.random ?? Math.random
  const deadlines = createRequestDeadlines()
  let generation = 0, closed = false, dirty = false, inFlight = false, queued = false, attempt = 0, belowFloor = 0
  let inFlightEpoch: number | null = null, inFlightGen = -1, acceptedEpoch: number | null = null
  let readyReplacementGen = -1
  let noticePending = false, servingNotice = false
  const pendingReasons = new Set<ReadReason>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = false, due = 0, stopped = false
  let failure: Exclude<Result<T>, { ok: true }> | undefined
  let completion: (() => void) | undefined
  let controller: AbortController | undefined
  let running: Promise<ActivityRead<T> | undefined> | undefined
  function schedule(ms: number) {
    if (timer !== undefined || closed) return
    due = Date.now() + ms
    const own = generation
    timer = setTimeout(() => { timer = undefined; if (closed || own !== generation) return; retry = false; void run() }, ms)
  }
  function scheduleRetry(retryAfterMs = 0) {
    retry = true
    const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5))
    schedule(Math.max(retryAfterMs, cap / 2 + random() * cap / 2))
  }
  // ensure() joins the load in flight instead of settling before it.
  function run() {
    const started = !inFlight, pending = execute()
    if (started && inFlight) {
      running = pending
      // Callers observe the rejection on pending itself; the bookkeeping chain must not add another.
      void pending.finally(() => { if (running === pending) running = undefined }).catch(() => {})
    }
    return pending
  }
  function replaceFencedRead() {
    if (!dirty || retry) return
    if (readyReplacementGen === generation) void run()
    else schedule(200)
  }
  async function execute() {
    if (closed || !dirty) return
    if (inFlight) { queued = true; return }
    if (retry || options.canLoad?.() === false) return
    inFlight = true; queued = false; failure = undefined
    servingNotice = noticePending; noticePending = false
    const reasons = [...pendingReasons]; pendingReasons.clear()
    const own = generation
    const epoch = options.connectionEpoch?.() ?? null
    inFlightEpoch = epoch; inFlightGen = own
    const startedAt = options.stampRead?.() ?? 0
    const request = new AbortController()
    controller = request
    let cancelled = false
    let pending: Promise<Result<T>>
    try { pending = options.load(request.signal, reasons).catch((): Result<T> => ({ ok: false, kind: 'network' })) }
    catch { pending = Promise.resolve({ ok: false, kind: 'network' }) }
    const networkFailure: Result<T> = { ok: false, kind: 'network' }
    completion = () => { cancelled = true; request.abort(); deadlines.cancel() }
    const result = await deadlines.wait(pending, networkFailure, {
      timeoutMs: options.timeoutMs ?? 10_000,
      onTimeout: () => { request.abort(); return networkFailure },
    })
    completion = undefined
    if (controller === request) controller = undefined
    const wasServingNotice = servingNotice
    inFlight = false; inFlightEpoch = null; inFlightGen = -1
    servingNotice = false
    if (closed) return
    if (cancelled) { if (dirty) schedule(0); return }
    try { if (result.ok) {
      if (own !== generation) {
        if (wasServingNotice) noticePending = true
        if (dirty) for (const r of reasons) pendingReasons.add(r)
        replaceFencedRead()
        return
      }
      const covered = options.covers?.(result.data) !== false
      if (!covered) {
        // A below-floor snapshot never satisfies the notice, even when acceptBelowFloor applies its data.
        if (wasServingNotice) noticePending = true
        for (const r of reasons) pendingReasons.add(r)
        if (++belowFloor >= 3) scheduleRetry()
        else schedule(200)
        if (!options.acceptBelowFloor) return
      } else {
        dirty = queued; attempt = 0; belowFloor = 0
      }
      failure = undefined; stopped = false; acceptedEpoch = epoch
      if (options.stampRead) options.accept(result.data, startedAt)
      else options.accept(result.data)
      if (covered && dirty) schedule(200)
    } else {
      if (own === generation) { belowFloor = 0; acceptedEpoch = null; failure = result; options.error?.(result) }
      if (own === generation && options.terminal?.(result)) { dirty = false; queued = false; noticePending = false; pendingReasons.clear(); stopped = true; return { startedAt, result } }
      if (options.manualRetry) { dirty = false; queued = false; noticePending = false; pendingReasons.clear(); return }
      if (result.kind === 'network' || result.status === 429 || result.status >= 500) {
        if (wasServingNotice) noticePending = true
        for (const r of reasons) pendingReasons.add(r)
        scheduleRetry(result.retryAfterMs ?? 0)
      } else if (own !== generation) {
        if (wasServingNotice) noticePending = true
        if (dirty) for (const r of reasons) pendingReasons.add(r)
        replaceFencedRead()
      } else if (queued && options.retryQueuedTerminal) {
        if (wasServingNotice) noticePending = true
        schedule(200)
      } else { dirty = false; queued = false; noticePending = false; pendingReasons.clear(); stopped = true }
    }
    if (own === generation) return { startedAt, result }
    } finally { options.settled?.() }
  }
  function fence() {
    generation++
    inFlightEpoch = null; inFlightGen = -1; acceptedEpoch = null
    if (timer === undefined) return
    const remaining = Math.max(0, due - Date.now())
    clearTimeout(timer); timer = undefined; schedule(remaining)
  }
  function invalidate(reason: Invalidation = 'notice', delay = 200) {
    if (closed) return
    pendingReasons.add(reason)
    if (reason !== 'notice') { fence(); options.hide?.(reason) }
    else noticePending = true
    stopped = false; failure = undefined; dirty = true
    if (inFlight) { queued = true; return }
    // Multi-lane admission may make other work eligible before a retained retry deadline.
    if (options.manualRetry && timer !== undefined && Date.now() + delay < due) { clearTimeout(timer); timer = undefined }
    schedule(delay)
  }
  return {
    invalidate,
    fence,
    ready() {
      const epoch = options.connectionEpoch?.() ?? null
      if (closed || epoch === null) return false
      if (inFlight && inFlightGen === generation) {
        if (inFlightEpoch === epoch) {
          options.hide?.('reconcile')
          return true
        }
        if (inFlightEpoch === null) {
          invalidate('reconcile')
          readyReplacementGen = generation
          return true
        }
      }
      if (acceptedEpoch === epoch) {
        options.onReadyCovered?.()
        return true
      }
      return false
    },
    // An in-flight snapshot can cover a newer notice if it passes covers().
    demandCoverage() { if (belowFloor < 3) belowFloor = 0; if (!inFlight) invalidate() },
    failure: () => failure,
    inFlight: () => inFlight,
    idle: () => !closed && !inFlight && !dirty && !retry && !stopped,
    pendingNotice: () => !closed && (servingNotice || (noticePending && dirty)),
    ensure() {
      if (inFlight) return running
      if (!closed && !stopped && !dirty && timer === undefined && !retry) {
        if (pendingReasons.size === 0) pendingReasons.add('initial')
        dirty = true; return run()
      }
    },
    refresh(reason: ReadReason = 'reconcile') {
      if (closed) return
      pendingReasons.add(reason)
      stopped = false; dirty = true
      if (inFlight) { queued = true; return running }
      if (!retry) { clearTimeout(timer); timer = undefined; return run() }
    },
    flushQueued() {
      if (closed) return
      if (inFlight) return running
      if (dirty && !retry && timer !== undefined) { clearTimeout(timer); timer = undefined; return run() }
    },
    retryNow() { clearTimeout(timer); timer = undefined; retry = false; stopped = false; failure = undefined; belowFloor = 0; dirty = true; return run() },
    suspend() { generation++; inFlightEpoch = null; inFlightGen = -1; acceptedEpoch = null; dirty = false; queued = false; noticePending = false; servingNotice = false; pendingReasons.clear(); retry = false; belowFloor = 0; clearTimeout(timer); timer = undefined; completion?.(); controller?.abort() },
    close() { closed = true; generation++; inFlightEpoch = null; inFlightGen = -1; acceptedEpoch = null; noticePending = false; servingNotice = false; pendingReasons.clear(); clearTimeout(timer); completion?.(); controller?.abort(); timer = undefined },
  }
}
