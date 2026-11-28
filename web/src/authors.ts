import { identityOrder, rememberIdentityResponse } from './identity-order'
import type { Message } from './api'
import { lookupAuthors, isOrganizationUnavailable, isSessionEnded, type DisplayIdentity, type Member } from './api'

export const FIRST_DISPLAY_AUTHORS_TIMEOUT_MS = 1_500

export function senderName(identity: DisplayIdentity | undefined): string {
  return identity ? `${identity.name}${identity.deactivated ? '（無効）' : ''}` : 'メンバー'
}

/** One Organization selection owns this cache; list reloads replace every cached identity. */
export function createAuthors(
  organizationId: string,
  onEnded: () => void,
  onUnavailable: () => void,
  lookup = lookupAuthors,
  firstDisplayTimeoutMs = FIRST_DISPLAY_AUTHORS_TIMEOUT_MS,
) {
  let identities: ReadonlyMap<string, DisplayIdentity> = new Map()
  let observed = new Set<string>()
  let observedChannel: string | undefined
  let attempted = new Set<string>()
  const pending = new Set<string>()
  const retryAfterConfirmation = new Set<string>()
  // Retained deactivated identities stay visible across directory loads while eligible for refresh.
  let stale = new Set<string>()
  let generation = 0
  let closed = false
  let unavailable = false
  let queued = false
  let gateKey = ''
  let gateTimedOut = false
  let gateTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  function clearGateTimer() {
    if (gateTimer !== undefined) { clearTimeout(gateTimer); gateTimer = undefined }
  }

  function schedule() {
    if (closed || unavailable || queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (!closed && !unavailable) void request() })
  }
  async function request() {
    const current = generation
    const ids = [...observed].filter(id => (!identities.has(id) || stale.has(id)) && !attempted.has(id))
    ids.forEach(id => { attempted.add(id); pending.add(id) })
    await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, async (_, index) => {
      const batch = ids.slice(index * 100, (index + 1) * 100)
      try {
        const result = await lookup(organizationId, { ids: batch })
        // A late 401 still belongs to the Account Session owner.
        if (isSessionEnded(result)) { onEnded(); return }
        if (closed || unavailable) return
        // Freshness changes cannot invalidate Membership loss within this selection.
        if (!result.ok) {
          if (isOrganizationUnavailable(result)) { stop(); onUnavailable() }
          return
        }
        if (current !== generation) return
        const next = new Map(identities)
        const requested = new Set(batch)
        for (const identity of result.data.identities) {
          if (requested.has(identity.id)) {
            rememberIdentityResponse(identity)
            next.set(identity.id, identity)
            stale.delete(identity.id)
          }
        }
        identities = next
      } finally {
        if (!closed && current === generation) {
          for (const id of batch) {
            pending.delete(id)
            if (retryAfterConfirmation.delete(id) && (!identities.has(id) || stale.has(id))) {
              attempted.delete(id)
              schedule()
            }
          }
          notify()
        }
      }
    }))
  }
  function fence() { generation++; pending.clear(); retryAfterConfirmation.clear() }
  function stop() { unavailable = true; fence(); clearGateTimer(); notify() }
  /** Channel selection and resubscription retry unresolved ids, keeping known identities. */
  function retry() { if (!closed && !unavailable) { fence(); attempted.clear(); notify(); schedule() } }
  return {
    get: () => identities,
    mentionName(id: string, fallback: string, mentions: Message['mentions']) {
      const identity = identities.get(id)
      return identity && identityOrder(identity) >= identityOrder(mentions ?? {}) ? identity.name : fallback
    },
    // An unattempted id is pending even before watch() queues its first request.
    isPending: (id: string) => !closed && !unavailable && !identities.has(id) && (!attempted.has(id) || pending.has(id)),
    isInitialDisplayTimedOut: (key: string) => closed || unavailable || (gateKey === key && gateTimedOut),
    syncInitialDisplay(key: string, waiting: boolean) {
      if (closed || unavailable) { clearGateTimer(); return }
      if (key !== gateKey) {
        clearGateTimer()
        gateKey = key
        gateTimedOut = false
      }
      if (!waiting) { clearGateTimer(); return }
      if (!gateTimedOut && gateTimer === undefined) {
        const ownKey = key
        gateTimer = setTimeout(() => {
          gateTimer = undefined
          if (closed || unavailable || gateKey !== ownKey) return
          gateTimedOut = true
          notify()
        }, firstDisplayTimeoutMs)
      }
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    seed(seeds: DisplayIdentity[]) {
      if (closed || unavailable || seeds.length === 0) return
      const next = new Map(identities)
      for (const identity of seeds) {
        if (!next.has(identity.id)) next.set(identity.id, identity)
      }
      identities = next
      notify()
    },
    /** #315 can refetch the Member list via load(); every success calls this hook. */
    replaceMembers(members: Member[]) {
      if (closed || unavailable) return
      fence()
      const next = new Map<string, DisplayIdentity>(members.map(member => {
        rememberIdentityResponse(member)
        const identity = { id: member.id, name: member.name, deactivated: false }
        rememberIdentityResponse(identity, identityOrder(member))
        return [member.id, identity]
      }))
      stale = new Set()
      for (const [id, existing] of identities) {
        if (existing.deactivated && observed.has(id) && !next.has(id)) {
          next.set(id, existing)
          stale.add(id)
        }
      }
      identities = next
      attempted.clear()
      notify()
      schedule()
    },
    watch(ids: Iterable<string>, channel?: string) {
      observed = new Set(ids)
      observedChannel = channel
      schedule()
    },
    selectChannel(channel: string | null) {
      if (channel !== observedChannel) observed.clear()
      retry()
    },
    /** Initial confirmation retries omissions without replacing requests already in flight. */
    confirmInitialSubscription() {
      if (closed || unavailable) return
      attempted = new Set(pending)
      pending.forEach(id => retryAfterConfirmation.add(id))
      notify()
      schedule()
    },
    invalidate() { if (!closed && !unavailable) { fence(); notify() } },
    retry,
    unavailable: stop,
    close() { closed = true; fence(); clearGateTimer(); identities = new Map(); observed.clear(); stale.clear(); listeners.clear() },
  }
}
