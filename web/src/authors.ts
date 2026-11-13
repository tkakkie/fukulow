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
  let generation = 0
  let closed = false
  let queued = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())

  function schedule() {
    if (closed || queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (!closed) void request() })
  }
  async function request() {
    const current = generation
    const ids = [...observed].filter(id => !identities.has(id) && !attempted.has(id))
    ids.forEach(id => attempted.add(id))
    await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, async (_, index) => {
      const batch = ids.slice(index * 100, (index + 1) * 100)
      const result = await lookup(organizationId, { ids: batch })
      // A late 401 still belongs to the Account Session owner.
      if (!result.ok && result.kind === 'http' && result.status === 401) { onEnded(); return }
      if (closed || current !== generation) return
      if (!result.ok) {
        if (isOrganizationUnavailable(result)) onUnavailable()
        return
      }
      const next = new Map(identities)
      const requested = new Set(batch)
      for (const identity of result.data.identities) {
        if (requested.has(identity.id)) next.set(identity.id, identity)
      }
      identities = next
      notify()
    }))
  }
  return {
    get: () => identities,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** #315 can refetch the Member list via load(); every success calls this hook. */
    replaceMembers(members: Member[]) {
      if (closed) return
      generation++
      identities = new Map(members.map(member => [member.id, { id: member.id, name: member.name, deactivated: false }]))
      attempted = new Set()
      notify()
      schedule()
    },
    watch(ids: Iterable<string>) { observed = new Set(ids); schedule() },
    /** Channel selection and reconnect retry unresolved ids, keeping known identities. */
    retry() { if (!closed) { generation++; attempted = new Set(); schedule() } },
    close() { closed = true; generation++; identities = new Map(); observed.clear(); listeners.clear() },
  }
}
