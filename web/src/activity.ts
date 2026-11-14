import type { Result, ServerEvent } from './api'

export type ActivityNotice = Exclude<ServerEvent, { type: 'message' | 'subscribed' | 'channel_access_lost' | 'error' }>
export type Invalidation = 'notice' | 'access' | 'reconcile'
export type ActivityTarget = { held?(): void; invalidate(reason?: Invalidation, delay?: number): void; suspend?(): void; close(): void }

/** Shared bounds for every held REST target; late completions never regain authority. */
export function createActivityTarget<T>(options: {
  load(signal: AbortSignal): Promise<Result<T>>
  accept(value: T): void
  hide?(): void
  error?(result: Exclude<Result<T>, { ok: true }>): void
  terminal?(result: Result<T>): boolean
  random?: () => number
  timeoutMs?: number
}) {
  const random = options.random ?? Math.random
  let generation = 0, closed = false, dirty = false, inFlight = false, queued = false, attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = false, due = 0, stopped = false
  let failure: Exclude<Result<T>, { ok: true }> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let completion: (() => void) | undefined
  let controller: AbortController | undefined
  function schedule(ms: number) {
    if (timer !== undefined || closed) return
    due = Date.now() + ms
    const own = generation
    timer = setTimeout(() => { timer = undefined; if (closed || own !== generation) return; retry = false; void run() }, ms)
  }
  async function run() {
    if (closed || !dirty) return
    if (inFlight) { queued = true; return }
    if (retry) return
    inFlight = true; queued = false
    const own = generation
    const request = new AbortController()
    controller = request
    let cancelled = false
    let pending: Promise<Result<T>>
    try { pending = options.load(request.signal).catch((): Result<T> => ({ ok: false, kind: 'network' })) }
    catch { pending = Promise.resolve({ ok: false, kind: 'network' }) }
    const result = await Promise.race([pending, new Promise<Result<T>>(resolve => {
      completion = () => { cancelled = true; request.abort(); resolve({ ok: false, kind: 'network' }) }
      deadline = setTimeout(() => { request.abort(); resolve({ ok: false, kind: 'network' }) }, options.timeoutMs ?? 10_000)
    })])
    clearTimeout(deadline); deadline = undefined; completion = undefined
    if (controller === request) controller = undefined
    inFlight = false
    if (closed) return
    if (cancelled) { if (dirty) schedule(0); return }
    if (result.ok) {
      if (own !== generation) { if (dirty && !retry) schedule(200); return }
      failure = undefined; stopped = false; options.accept(result.data); attempt = 0
      dirty = queued
      if (dirty) schedule(200)
    } else {
      if (own === generation) { failure = result; options.error?.(result) }
      if (own === generation && options.terminal?.(result)) { dirty = false; queued = false; stopped = true; return }
      if (result.kind === 'network' || result.status === 429 || result.status >= 500) {
        retry = true
        const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5))
        schedule(Math.max(result.retryAfterMs ?? 0, cap / 2 + random() * cap / 2))
      } else if (own !== generation) { if (dirty) schedule(200) }
      else { dirty = false; queued = false; stopped = true }
    }
  }
  return {
    invalidate(reason: Invalidation = 'notice', delay = 200) {
      if (closed) return
      if (reason !== 'notice') {
        generation++; options.hide?.()
        if (timer !== undefined) { const remaining = Math.max(0, due - Date.now()); clearTimeout(timer); timer = undefined; schedule(remaining) }
      }
      stopped = false; failure = undefined; dirty = true
      if (inFlight) { queued = true; return }
      schedule(delay)
    },
    failure: () => failure,
    ensure() { if (!closed && !stopped && !dirty && !inFlight && timer === undefined && !retry) { dirty = true; return run() } },
    refresh() { if (closed) return; stopped = false; dirty = true; if (inFlight) { queued = true; return }; if (!retry) { clearTimeout(timer); timer = undefined; return run() } },
    retryNow() { clearTimeout(timer); timer = undefined; retry = false; stopped = false; failure = undefined; dirty = true; return run() },
    suspend() { generation++; dirty = false; queued = false; retry = false; clearTimeout(timer); timer = undefined; completion?.(); controller?.abort() },
    close() { closed = true; generation++; clearTimeout(timer); clearTimeout(deadline); completion?.(); controller?.abort(); timer = undefined },
  }
}

/** Notice routing owns no counts, cursors, Message records or pending sends. */
export function createActivity(options: {
  watched(channel: string): boolean
  covered?(notice: ActivityNotice, target?: string): boolean
  revoke?(channel: string): void
  access?(channel: string): void
  reconcile?(): void
  random?: () => number
  periodMs?: number
}) {
  const targets = new Map<string, ActivityTarget>()
  const random = options.random ?? Math.random, period = options.periodMs ?? 30_000
  let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, closed = false
  const retire = (target: ActivityTarget | undefined) => { if (target?.suspend) target.suspend(); else target?.close() }
  const invalidate = (key: string, reason: Invalidation = 'notice', delay = 200) => targets.get(key)?.invalidate(reason, delay)
  const directories = (delay = 200) => { for (const [key] of targets) if (key === 'members' || key.startsWith('channel-members:')) invalidate(key, 'access', delay) }
  function all(delay: number) {
    options.reconcile?.()
    for (const target of targets.values()) target.invalidate('reconcile', delay)
  }
  function periodic(own: number, first: boolean) {
    timer = setTimeout(() => {
      if (closed || generation !== own) return
      all(200)
      periodic(own, false)
    }, first ? random() * period : period + random() * 2000)
  }
  return {
    hold(key: string, target: ActivityTarget) { target.held?.(); if (targets.get(key) !== target) retire(targets.get(key)); targets.set(key, target); return () => { if (targets.get(key) === target) { retire(target); targets.delete(key) } } },
    notice(event: ActivityNotice) {
      if (closed) return
      switch (event.type) {
        case 'activity_ready':
          clearTimeout(timer); periodic(++generation, true); all(200); break
        case 'activity_reset': all(random() * 2000); break
        case 'channel_activity':
          if (!options.watched(event.channel_id) && !options.covered?.(event, 'channels')) invalidate('channels')
          break
        case 'read_position_changed':
          if (!options.covered?.(event, 'channels')) invalidate('channels')
          if (options.watched(event.channel_id)) {
            const key = event.topic_id === null ? `main:${event.channel_id}` : `topic:${event.channel_id}:${event.topic_id}`
            if (!options.covered?.(event, key)) invalidate(key)
          }
          break
        case 'channel_access_revoked':
          options.revoke?.(event.channel_id); retire(targets.get(`channel-members:${event.channel_id}`)); targets.delete(`channel-members:${event.channel_id}`)
          invalidate('channels', 'access'); directories(); break
        case 'channel_access_gained': options.access?.(event.channel_id); invalidate('channels', 'access'); directories(); break
        case 'channel_list_changed': invalidate('channels', 'access'); break
        case 'channel_members_changed': invalidate(`channel-members:${event.channel_id}`, 'access'); break
        case 'members_changed': directories(); invalidate('capabilities', 'access'); break
      }
    },
    disconnected() { clearTimeout(timer); generation++ },
    close() { closed = true; clearTimeout(timer); generation++; targets.forEach(target => target.close()); targets.clear() },
  }
}
export type Activity = ReturnType<typeof createActivity>
