import { createActivityRoutingCore, type ActivityFacts } from './core-wasm'
import type { AccessLifetime } from './protocol-types'
import type { ActivityNotice, ActivityTarget, Invalidation } from './activity-target'

export * from './activity-target'

export function createActivity(options: {
  watched(channel: string): boolean
  covered?(notice: ActivityNotice, target?: string): boolean
  watermark?(channel: string): number | undefined
  mainReadSeq?(channel: string): number
  topicReadSeq?(channel: string, topic: string): number
  connectionEpoch?(): number | null
  lifetime?(): AccessLifetime
  ready?(): void
  read?(notice: Extract<ActivityNotice, { type: 'read_position_changed' }>): void
  revoke?(channel: string): void
  access?(channel: string): void
  reconcile?(): void
  kind?(channel: string): 'dm' | 'channel' | undefined
  random?: () => number
  periodMs?: number
}) {
  const core = createActivityRoutingCore()
  const targets = new Map<string, ActivityTarget>()
  const random = options.random ?? Math.random
  let timer: ReturnType<typeof setTimeout> | undefined
  const retire = (target: ActivityTarget | undefined) => { if (target?.suspend) target.suspend(); else target?.close() }
  const invalidate = (key: string, reason: Invalidation = 'notice', delay = 200, discovery?: boolean) => targets.get(key)?.invalidate(reason, delay, discovery)
  const memberKey = (id: string) => `channel-members:${id}`
  const readKey = (id: string, topic: string | null) => topic === null ? `main:${id}` : `topic:${id}:${topic}`

  function facts(event: ActivityNotice): ActivityFacts {
    if (!('channel_id' in event)) return {}
    const id = event.channel_id
    const kind = options.kind?.(id)
    const list = kind === 'dm' ? 'dms' : 'channels'
    const hasKindLookup = options.kind !== undefined
    if (event.type === 'channel_activity') {
      return { kind, hasKindLookup, watched: options.watched(id),
        listCovered: options.covered?.(event, list), asOfSeq: options.watermark?.(id) }
    }
    if (event.type === 'read_position_changed') {
      return { kind, hasKindLookup, listCovered: options.covered?.(event, list),
        mainReadSeq: event.topic_id === null ? options.mainReadSeq?.(id) : undefined }
    }
    return { kind }
  }

  function readProjectionFacts(event: Extract<ActivityNotice, { type: 'read_position_changed' }>): ActivityFacts {
    const { channel_id: id, topic_id: topic } = event
    const watched = options.watched(id)
    return { afterLists: true, watched,
      projectionCovered: watched ? options.covered?.(event, readKey(id, topic)) : undefined,
      topicReadSeq: watched && topic !== null ? options.topicReadSeq?.(id, topic) : undefined,
    }
  }

  function dispatch(input: Parameters<typeof core.step>[0]) {
    const event = input.type === 'notice' ? input.event : undefined
    const id = event && 'channel_id' in event ? event.channel_id : undefined
    const connection = 'connection' in input ? input.connection : undefined
    // Read observation can change coverage. Both callbacks can retire the current scope.
    function continueNotice() {
      if (input.type === 'notice') notice(input.event, input.connection, facts(input.event))
    }
    for (const effect of core.step(input, options.lifetime?.() ?? 'current')) {
      switch (effect.type) {
        case 'inspect': continueNotice(); break
        case 'ready_targets': options.ready?.(); continueNotice(); break
        case 'observe_read':
          if (event?.type === 'read_position_changed') options.read?.(event)
          continueNotice()
          break
        case 'inspect_read_projection':
          // List invalidation can synchronously notify subscribers before the watched check.
          if (event?.type === 'read_position_changed') notice(event, connection, readProjectionFacts(event))
          break
        case 'notify_sections': if (event) targets.get('sections')?.notice?.(event); break
        case 'revoke': if (id !== undefined) options.revoke?.(id); break
        case 'gain': if (id !== undefined) options.access?.(id); break
        case 'retire_channel_members':
          if (id !== undefined) { const key = memberKey(id); retire(targets.get(key)); targets.delete(key) }
          break
        case 'invalidate': {
          let key: string = effect.target
          if (effect.target === 'channel-members' && id !== undefined) key = memberKey(id)
          if (effect.target === 'main' && id !== undefined) key = readKey(id, null)
          if (effect.target === 'topic' && event?.type === 'read_position_changed') key = readKey(event.channel_id, event.topic_id)
          invalidate(key, effect.reason, effect.debounce, effect.discovery ?? undefined)
          break
        }
        case 'invalidate_member_lists':
          for (const key of targets.keys()) if (key === effect.key || key.startsWith(effect.prefix)) invalidate(key, effect.reason, effect.debounce)
          break
        case 'reconcile': {
          const delay = effect.jitter === null ? effect.debounce : core.delay(effect.jitter, options.periodMs, random())
          options.reconcile?.()
          invalidate(effect.first, effect.reason, delay)
          for (const [key, target] of targets) {
            if (key === effect.first || (effect.ready && target.ready?.())) continue
            target.invalidate(effect.reason, delay)
          }
          break
        }
        case 'arm': {
          const tick = () => dispatch({ type: 'tick', generation: effect.generation, connection, current_connection: options.connectionEpoch?.() })
          timer = setTimeout(tick, core.delay(effect.timing, options.periodMs, random()))
          break
        }
        case 'cancel': clearTimeout(timer); break
        case 'disconnect_targets': targets.forEach(target => target.disconnected?.()); break
        case 'close_targets': targets.forEach(target => target.close()); targets.clear(); break
      }
    }
  }
  function notice(event: ActivityNotice, connection?: number, routingFacts?: ActivityFacts) {
    dispatch({ type: 'notice', event, connection, current_connection: options.connectionEpoch?.(), facts: routingFacts })
  }
  return {
    hold(key: string, target: ActivityTarget) { target.held?.(); if (targets.get(key) !== target) retire(targets.get(key)); targets.set(key, target); return () => { if (targets.get(key) === target) { retire(target); targets.delete(key) } } },
    invalidate,
    invalidateMemberLists: () => dispatch({ type: 'invalidate_member_lists' }),
    notice: (event: ActivityNotice, connection?: number) => notice(event, connection),
    disconnected: () => dispatch({ type: 'disconnected' }),
    close: () => dispatch({ type: 'close' }),
  }
}
export type Activity = ReturnType<typeof createActivity>
