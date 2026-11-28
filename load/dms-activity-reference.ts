// Slice E activity router. The k6 runtime has no WebAssembly, so the DM workload
// retains this scheduling model. Vitest compares its effects with the Rust router.
import type { ActivityNotice, ActivityTarget, Invalidation } from '../web/src/activity-target.ts'

export function createActivityReference(options: {
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
  const invalidate = (key: string, reason: Invalidation = 'notice', delay = 200, discovery?: boolean) => targets.get(key)?.invalidate(reason, delay, discovery)
  const invalidateMemberLists = () => { for (const [key] of targets) if (key === 'members' || key.startsWith('channel-members:')) invalidate(key, 'access') }
  function all(delay: number, reason: Invalidation = 'reconcile', ready = false) {
    options.reconcile?.()
    // Identity authority must be invalidated before the Member lists decide what to retain.
    invalidate('capabilities', reason, delay)
    for (const [key, target] of targets) {
      if (key === 'capabilities') continue
      if (ready && target.ready?.()) continue
      target.invalidate(reason, delay)
    }
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
    // Only access changes and unknown kinds can reveal a DM the list has not discovered (P-D5 notice delta).
    if (kind !== 'channel') invalidate('dms', reason, 200, reason === 'access' || kind === undefined)
  }
  return {
    hold(key: string, target: ActivityTarget) { target.held?.(); if (targets.get(key) !== target) retire(targets.get(key)); targets.set(key, target); return () => { if (targets.get(key) === target) { retire(target); targets.delete(key) } } },
    invalidate,
    invalidateMemberLists,
    notice(event: ActivityNotice) {
      if (closed) return
      switch (event.type) {
        case 'activity_ready':
          clearTimeout(timer); periodic(++generation, true); all(200, 'reconcile', true); break
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
        case 'dm_list_changed': invalidate('dms', 'access', 200, true); break
        case 'channel_list_changed': channelLists('access'); invalidate('open-channel', 'access'); break
        case 'channel_members_changed': invalidate(`channel-members:${event.channel_id}`, 'access'); break
        case 'members_changed': invalidate('capabilities', 'access'); invalidateMemberLists(); break
      }
    },
    disconnected() { clearTimeout(timer); generation++; targets.forEach(target => target.disconnected?.()) },
    close() { closed = true; clearTimeout(timer); generation++; targets.forEach(target => target.close()); targets.clear() },
  }
}
