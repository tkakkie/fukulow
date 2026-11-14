import { identityOrder, rememberIdentityResponse } from './identity-order'
import type { Message } from './api'
import { lookupAuthors, isOrganizationUnavailable, type DisplayIdentity, type Member } from './api'

export function senderName(identity: DisplayIdentity | undefined): string {
  return identity ? `${identity.name}${identity.deactivated ? '（無効）' : ''}` : 'メンバー'
}

/** One Organization selection owns this cache; list reloads replace every cached identity. */
export function createAuthors(
  organizationId: string,
  onEnded: () => void,
  onUnavailable: () => void,
  lookup = lookupAuthors,
) {
  let identities: ReadonlyMap<string, DisplayIdentity> = new Map()
  let observed = new Set<string>()
  let attempted = new Set<string>()
  let pending = new Set<string>()
  let generation = 0
  let closed = false
  let unavailable = false
  let queued = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())

  function schedule() {
    if (closed || unavailable || queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (!closed && !unavailable) void request() })
  }
  async function request() {
    const current = generation
    const ids = [...observed].filter(id => !identities.has(id) && !attempted.has(id))
    ids.forEach(id => { attempted.add(id); pending.add(id) })
    await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, async (_, index) => {
      const batch = ids.slice(index * 100, (index + 1) * 100)
      try {
        const result = await lookup(organizationId, { ids: batch })
        // A late 401 still belongs to the Account Session owner.
        if (!result.ok && result.kind === 'http' && result.status === 401) { onEnded(); return }
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
          if (requested.has(identity.id)) { rememberIdentityResponse(identity); next.set(identity.id, identity) }
        }
        identities = next
      } finally {
        if (!closed && current === generation) {
          batch.forEach(id => pending.delete(id))
          notify()
        }
      }
    }))
  }
  function stop() { unavailable = true; generation++; pending.clear(); notify() }
  return {
    get: () => identities,
    mentionName(id: string, fallback: string, mentions: Message['mentions']) {
      const identity = identities.get(id)
      return identity && identityOrder(identity) >= identityOrder(mentions) ? identity.name : fallback
    },
    // An unattempted id is pending even before watch() queues its first request.
    isPending: (id: string) => !closed && !unavailable && !identities.has(id) && (!attempted.has(id) || pending.has(id)),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** #315 can refetch the Member list via load(); every success calls this hook. */
    replaceMembers(members: Member[]) {
      if (closed || unavailable) return
      generation++
      identities = new Map(members.map(member => [member.id, { id: member.id, name: member.name, deactivated: false }]))
      for (const identity of identities.values()) rememberIdentityResponse(identity)
      attempted = new Set()
      pending = new Set()
      notify()
      schedule()
    },
    watch(ids: Iterable<string>) { observed = new Set(ids); schedule() },
    /** Channel selection and reconnect retry unresolved ids, keeping known identities. */
    retry() { if (!closed && !unavailable) { generation++; attempted = new Set(); pending = new Set(); notify(); schedule() } },
    unavailable: stop,
    close() { closed = true; generation++; identities = new Map(); observed.clear(); pending.clear(); listeners.clear() },
  }
}
