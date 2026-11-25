import type { Result, ServerEvent } from './api'
import { createRequestDeadlines } from './request-deadlines'

export type ActivityNotice = Exclude<ServerEvent, { type: 'message' | 'subscribed' | 'channel_access_lost' | 'error' }>
export type Invalidation = 'notice' | 'access' | 'reconcile' | 'periodic'
export type FencedInvalidation = Exclude<Invalidation, 'notice'>
export type ActivityTarget = { held?(): void; invalidate(reason?: Invalidation, delay?: number): void; disconnected?(): void; suspend?(): void; close(): void; notice?(event: ActivityNotice): void }

/** Shared bounds for every held REST target; late completions never regain authority. */
export function createActivityTarget<T>(options: {
  canLoad?(): boolean
  load(signal: AbortSignal): Promise<Result<T>>
  accept(value: T): void
  covers?(value: T): boolean
  hide?(reason: FencedInvalidation): void
  error?(result: Exclude<Result<T>, { ok: true }>): void
  terminal?(result: Result<T>): boolean
  random?: () => number
  timeoutMs?: number
  /** A bounded multi-lane target owns retry admission; deadlines remain shared here. */
  manualRetry?: boolean
  settled?(): void
}) {
  const random = options.random ?? Math.random
  const deadlines = createRequestDeadlines()
  let generation = 0, closed = false, dirty = false, inFlight = false, queued = false, attempt = 0, belowFloor = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = false, due = 0, stopped = false
  let failure: Exclude<Result<T>, { ok: true }> | undefined
  let completion: (() => void) | undefined
  let controller: AbortController | undefined
  let running: Promise<void> | undefined
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
  async function execute() {
    if (closed || !dirty) return
    if (inFlight) { queued = true; return }
    if (retry || options.canLoad?.() === false) return
    inFlight = true; queued = false; failure = undefined
    const own = generation
    const request = new AbortController()
    controller = request
    let cancelled = false
    let pending: Promise<Result<T>>
    try { pending = options.load(request.signal).catch((): Result<T> => ({ ok: false, kind: 'network' })) }
    catch { pending = Promise.resolve({ ok: false, kind: 'network' }) }
    const networkFailure: Result<T> = { ok: false, kind: 'network' }
    completion = () => { cancelled = true; request.abort(); deadlines.cancel() }
    const result = await deadlines.wait(pending, networkFailure, {
      timeoutMs: options.timeoutMs ?? 10_000,
      onTimeout: () => { request.abort(); return networkFailure },
    })
    completion = undefined
    if (controller === request) controller = undefined
    inFlight = false
    if (closed) return
    if (cancelled) { if (dirty) schedule(0); return }
    try { if (result.ok) {
      if (own !== generation) { if (dirty && !retry) schedule(200); return }
      if (options.covers?.(result.data) === false) {
        if (++belowFloor >= 3) scheduleRetry()
        else schedule(200)
        return
      }
      dirty = queued
      failure = undefined; stopped = false; attempt = 0; belowFloor = 0; options.accept(result.data)
      if (dirty) schedule(200)
    } else {
      if (own === generation) { belowFloor = 0; failure = result; options.error?.(result) }
      if (own === generation && options.terminal?.(result)) { dirty = false; queued = false; stopped = true; return }
      if (options.manualRetry) { dirty = false; queued = false; return }
      if (result.kind === 'network' || result.status === 429 || result.status >= 500) {
        scheduleRetry(result.retryAfterMs ?? 0)
      } else if (own !== generation) { if (dirty) schedule(200) }
      else { dirty = false; queued = false; stopped = true }
    } } finally { options.settled?.() }
  }
  function fence() {
    generation++
    if (timer === undefined) return
    const remaining = Math.max(0, due - Date.now())
    clearTimeout(timer); timer = undefined; schedule(remaining)
  }
  function invalidate(reason: Invalidation = 'notice', delay = 200) {
    if (closed) return
    if (reason !== 'notice') { fence(); options.hide?.(reason) }
    stopped = false; failure = undefined; dirty = true
    if (inFlight) { queued = true; return }
    // Multi-lane admission may make other work eligible before a retained retry deadline.
    if (options.manualRetry && timer !== undefined && Date.now() + delay < due) { clearTimeout(timer); timer = undefined }
    schedule(delay)
  }
  return {
    invalidate,
    fence,
    // An in-flight snapshot can cover a newer notice if it passes covers().
    demandCoverage() { if (belowFloor < 3) belowFloor = 0; if (!inFlight) invalidate() },
    failure: () => failure,
    ensure() {
      if (inFlight) return running
      if (!closed && !stopped && !dirty && timer === undefined && !retry) { dirty = true; return run() }
    },
    refresh() {
      if (closed) return
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
    suspend() { generation++; dirty = false; queued = false; retry = false; belowFloor = 0; clearTimeout(timer); timer = undefined; completion?.(); controller?.abort() },
    close() { closed = true; generation++; clearTimeout(timer); completion?.(); controller?.abort(); timer = undefined },
  }
}

/** Notice routing owns no counts, cursors, Message records or pending sends. */
export function createActivity(options: {
  watched(channel: string): boolean
  covered?(notice: ActivityNotice, target?: string): boolean
  revoke?(channel: string): void
  access?(channel: string): void
  reconcile?(): void
  kind?(channel: string): 'dm' | 'channel' | undefined
  random?: () => number
  periodMs?: number
}) {
  const targets = new Map<string, ActivityTarget>()
  const random = options.random ?? Math.random, period = options.periodMs ?? 30_000
  let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, closed = false
  const retire = (target: ActivityTarget | undefined) => { if (target?.suspend) target.suspend(); else target?.close() }
  const invalidate = (key: string, reason: Invalidation = 'notice', delay = 200) => targets.get(key)?.invalidate(reason, delay)
  const invalidateMemberLists = () => { for (const [key] of targets) if (key === 'members' || key.startsWith('channel-members:')) invalidate(key, 'access') }
  function all(delay: number, reason: Invalidation = 'reconcile') {
    options.reconcile?.()
    // Identity authority must be invalidated before the Member lists decide what to retain.
    invalidate('capabilities', reason, delay)
    for (const [key, target] of targets) if (key !== 'capabilities') target.invalidate(reason, delay)
  }
  function periodic(own: number, first: boolean) {
    timer = setTimeout(() => {
      if (closed || generation !== own) return
      all(200, 'periodic')
      periodic(own, false)
    }, first ? random() * period : period + (random() * 2 - 1) * period / 10)
  }
  const channelLists = (reason: Invalidation) => {
    if (reason === 'access') invalidate('sections', reason)
    invalidate('channels', reason)
    invalidate('archived-channels', reason)
  }
  const lists = (kind: 'dm' | 'channel' | undefined, reason: Invalidation = 'notice') => {
    if (kind !== 'dm') channelLists(reason)
    if (kind !== 'channel') invalidate('dms', reason)
  }
  return {
    hold(key: string, target: ActivityTarget) { target.held?.(); if (targets.get(key) !== target) retire(targets.get(key)); targets.set(key, target); return () => { if (targets.get(key) === target) { retire(target); targets.delete(key) } } },
    invalidate,
    invalidateMemberLists,
    notice(event: ActivityNotice) {
      if (closed) return
      switch (event.type) {
        case 'activity_ready':
          clearTimeout(timer); periodic(++generation, true); all(200); break
        case 'activity_reset': all(random() * 2000); break
        case 'sections_changed': targets.get('sections')?.notice?.(event); break
        case 'channel_activity': {
          const kind = options.kind?.(event.channel_id)
          if ((options.kind && kind === undefined) || (!options.watched(event.channel_id) && !options.covered?.(event, kind === 'dm' ? 'dms' : 'channels'))) lists(kind)
          break
        }
        case 'read_position_changed': {
          const kind = options.kind?.(event.channel_id)
          if ((options.kind && kind === undefined) || !options.covered?.(event, kind === 'dm' ? 'dms' : 'channels')) lists(kind)
          if (options.watched(event.channel_id)) {
            const key = event.topic_id === null ? `main:${event.channel_id}` : `topic:${event.channel_id}:${event.topic_id}`
            if (!options.covered?.(event, key)) invalidate(key)
          }
          break
        }
        case 'channel_access_revoked':
        case 'channel_access_gained': {
          const id = event.channel_id, kind = options.kind?.(id)
          if (event.type === 'channel_access_revoked') {
            options.revoke?.(id); retire(targets.get(`channel-members:${id}`)); targets.delete(`channel-members:${id}`)
          } else options.access?.(id)
          lists(kind, 'access')
          if (kind !== 'dm') invalidate('open-channel', 'access')
          invalidateMemberLists()
          break
        }
        case 'dm_list_changed': invalidate('dms', 'access'); break
        case 'channel_list_changed': channelLists('access'); invalidate('open-channel', 'access'); break
        case 'channel_members_changed': invalidate(`channel-members:${event.channel_id}`, 'access'); break
        case 'members_changed': invalidate('capabilities', 'access'); invalidateMemberLists(); break
      }
    },
    disconnected() { clearTimeout(timer); generation++; targets.forEach(target => target.disconnected?.()) },
    close() { closed = true; clearTimeout(timer); generation++; targets.forEach(target => target.close()); targets.clear() },
  }
}
export type Activity = ReturnType<typeof createActivity>
