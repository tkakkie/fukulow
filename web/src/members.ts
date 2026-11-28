import { createInvites } from './invites'
import { memberError } from './member-errors'
import { createActivityTarget, type Invalidation } from './activity'
import { listMembers, changeRole, deactivateMember, createInvite, isOrganizationUnavailable, isSessionEnded, type Identity, type Member, type Role, type Result } from './api'

import { createAuthors } from './authors'
import type { lookupAuthors } from './api'
import type { createChannels } from './channels'
import type { createSync } from './sync'

type WatchMemberAccessOptions = {
  skipConnectRefresh?: boolean
  memberListAccess?: () => MemberListAccess
  onDirectoryLoad?: (listener: () => void) => () => void
}

/** Follow access changes for this Organization selection; panel opens call load directly. */
export function watchMemberAccess(
  channels: Pick<ReturnType<typeof createChannels>, 'get' | 'subscribe'>,
  sync: Pick<ReturnType<typeof createSync>, 'get' | 'subscribe'>,
  refresh: (reason: 'access' | 'refresh') => void,
  options?: WatchMemberAccessOptions,
) {
  let listReady = channels.get().status === 'ready'
  let channelIds = new Set(channels.get().channels.map(c => c.id))
  let loadedChannelIds: Set<string> | null = null
  const stopDirectoryLoad = options?.onDirectoryLoad?.(() => {
    loadedChannelIds = new Set(channels.get().channels.map(c => c.id))
  })
  let connection = sync.get().connected ? sync.get().connection : null
  let lost = new Set<string>()
  const stopChannels = channels.subscribe(() => {
    const state = channels.get()
    const ids = new Set(state.channels.map(c => c.id))
    if (!listReady) {
      if (state.status !== 'ready') return
      listReady = true
      const added = [...ids].some(id => !channelIds.has(id))
      channelIds = ids
      if (!options?.onDirectoryLoad) {
        if (added) refresh('refresh')
        return
      }
      // Only a Guest's directory is scoped by Channel grants; non-Guests already list all active Members.
      if ((options.memberListAccess?.() ?? 'guest') === 'guest' && loadedChannelIds !== null && [...ids].some(id => !loadedChannelIds!.has(id))) {
        refresh('refresh')
      }
      return
    }
    const removed = [...channelIds].some(id => !ids.has(id))
    const added = [...ids].some(id => !channelIds.has(id))
    channelIds = ids
    if (removed) refresh('access')
    else if (added) refresh('refresh')
  })
  const stopSync = sync.subscribe(() => {
    const state = sync.get()
    if (state.organization === 'unavailable') return
    const next = new Set(Object.keys(state.channels).filter(id => state.channels[id].state === 'unavailable'))
    const accessLost = [...next].some(id => !lost.has(id))
    lost = next
    const reconnected = state.connected && state.connection !== connection
    if (state.connected) connection = state.connection
    if (accessLost) refresh('access')
    else if (reconnected && !options?.skipConnectRefresh) refresh('refresh')
  })
  return () => { stopChannels(); stopSync(); stopDirectoryLoad?.() }
}

export const roleNames: Record<Role, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー', guest: 'ゲスト' }
export const roles = Object.keys(roleNames) as Role[]

export function canDeactivateMember(identity: Identity, target: Member): boolean {
  return identity.organization.capabilities.can_deactivate_members.allowed &&
    target.id !== identity.member.id &&
    (identity.member.role === 'owner' || target.role !== 'owner')
}

type MembersDeps = { listMembers: typeof listMembers; changeRole: typeof changeRole; deactivateMember: typeof deactivateMember; createInvite: typeof createInvite; lookupAuthors?: typeof lookupAuthors; firstDisplayTimeoutMs?: number; baseUrl(): string }
const defaults: MembersDeps = { listMembers, changeRole, deactivateMember, createInvite, baseUrl: () => `${location.origin}${location.pathname}` }
// Only a previously verified non-Guest can retain rows during revalidation.
export type MemberListAccess = Role | 'revalidating' | null
export const canLoadMemberList = (access: MemberListAccess) => access !== null && access !== 'revalidating'

export function createMembers(organizationId: string, onEnded: () => void, onUnavailable: () => void,
  deps: MembersDeps = defaults, memberListAccess: () => MemberListAccess = () => 'guest') {
  let state = { members: [] as Member[], loading: true, busy: false, error: '', retryable: false, inviteLink: '' }
  let closed = false
  let loadSequence = 0
  // Standalone loads keep sequence fencing; held UI loads share the reconciliation queue.
  let activityManaged = false
  // Defer directory reads until first use or the first-display milestone (#954 R1).
  let activated = false
  let hasLoaded = false
  let activateTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const loadListeners = new Set<() => void>()
  const notifyLoad = () => { hasLoaded = true; loadListeners.forEach(l => l()) }
  const invites = createInvites(organizationId, onEnded, membershipLost)
  const authors = createAuthors(organizationId, onEnded, membershipLost, deps.lookupAuthors, deps.firstDisplayTimeoutMs)
  const set = (patch: Partial<typeof state>) => { if (!closed) { state = { ...state, ...patch }; listeners.forEach(l => l()) } }
  function clearActivateTimer() {
    if (activateTimer !== undefined) { clearTimeout(activateTimer); activateTimer = undefined }
  }
  function unavailable() {
    if (closed) return
    closed = true; loadSequence++; clearActivateTimer(); activityTarget.close(); invites.close(); authors.unavailable(); loadListeners.clear()
    state = { ...state, members: [], loading: false, error: '', retryable: false }
    listeners.forEach(l => l())
  }
  function membershipLost() {
    if (closed) return
    unavailable()
    onUnavailable()
  }
  function failed(r: Exclude<Result<unknown>, { ok: true }>) {
    if (isSessionEnded(r)) onEnded()
    else if (isOrganizationUnavailable(r)) membershipLost()
    set({ error: memberError(r), retryable: false })
  }
  function listFailed(r: Exclude<Result<unknown>, { ok: true }>) {
    set({ members: [], loading: false, error: memberError(r), retryable: r.kind === 'network' || r.status === 429 || r.status >= 500 })
  }
  const activityTarget = createActivityTarget({
    canLoad: () => activated && canLoadMemberList(memberListAccess()),
    async load(signal) {
      const sequence = ++loadSequence
      notifyLoad()
      const r = await deps.listMembers(organizationId, undefined, signal)
      // Account rejection and current-selection Membership loss outlive freshness fences.
      if (!r.ok && (isSessionEnded(r) || !closed && isOrganizationUnavailable(r))) failed(r)
      return r.ok ? { ok: true as const, data: { members: r.data.members, sequence } } : r
    },
    accept: data => {
      if (closed || data.sequence !== loadSequence) return
      authors.replaceMembers(data.members)
      set({ members: data.members, loading: false, error: '', retryable: false })
    },
    hide: () => {
      loadSequence++
      const access = memberListAccess()
      if (access === null || access === 'guest') set({ members: [], loading: true })
    },
    error: listFailed,
    terminal: r => !r.ok && r.kind === 'http' && (isSessionEnded(r) || isOrganizationUnavailable(r)),
  })
  async function load() {
    if (closed) return
    clearActivateTimer()
    activated = true
    if (activityManaged) { await activityTarget.refresh(); return }
    if (!canLoadMemberList(memberListAccess())) return
    const sequence = ++loadSequence
    notifyLoad()
    const r = await deps.listMembers(organizationId)
    if (!r.ok && isSessionEnded(r)) { failed(r); return }
    if (closed) return
    // Freshness changes cannot invalidate Membership loss within this selection.
    if (!r.ok && isOrganizationUnavailable(r)) { failed(r); return }
    // Only the latest started load can replace the scoped directory and names.
    if (sequence !== loadSequence || !canLoadMemberList(memberListAccess())) return
    if (!r.ok) listFailed(r)
    else {
      authors.replaceMembers(r.data.members)
      set({ members: r.data.members, loading: false, error: '', retryable: false })
    }
  }
  function activate() {
    if (closed || activated) return
    clearActivateTimer()
    void load()
  }
  function scheduleActivate() {
    if (closed || activated || activateTimer !== undefined) return
    activateTimer = setTimeout(() => {
      activateTimer = undefined
      activate()
    }, 0)
  }
  function refreshIfActive() {
    if (closed || !activated) return
    if (activityManaged) { activityTarget.invalidate('notice'); return }
    return load()
  }
  const managedActivityTarget = {
    ...activityTarget,
    held() { activityManaged = true },
    invalidate(reason?: Invalidation, delay?: number) {
      if (!activated || closed) return
      activityTarget.invalidate(reason, delay)
    },
    refresh() {
      if (closed) return
      clearActivateTimer()
      activated = true
      return activityTarget.refresh()
    },
    retryNow() {
      if (closed) return
      clearActivateTimer()
      activated = true
      return activityTarget.retryNow()
    },
  }
  return {
    activityTarget: managedActivityTarget,
    authors, invites,
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    onLoad(l: () => void) {
      if (closed) return () => {}
      loadListeners.add(l)
      if (hasLoaded) l()
      return () => loadListeners.delete(l)
    },
    unavailable,
    close() { invites.close(); closed = true; clearActivateTimer(); activityTarget.close(); authors.close(); state = { ...state, inviteLink: '' }; listeners.clear(); loadListeners.clear() },
    load,
    activate,
    scheduleActivate,
    refreshIfActive,
    async retry() {
      if (closed) return
      clearActivateTimer()
      activated = true
      await (activityManaged ? activityTarget.retryNow() : load())
    },
    async invite(email: string, role: Role) {
      if (closed || state.busy) return
      set({ busy: true, error: '', inviteLink: '' })
      const r = await deps.createInvite(organizationId, { email, role })
      if (!r.ok) failed(r)
      else {
        set({ inviteLink: `${deps.baseUrl()}#invite=${encodeURIComponent(r.data.organization_id)}:${encodeURIComponent(r.data.token)}` })
        void invites.refreshIfLoaded()
      }
      set({ busy: false })
    },
    async deactivate(id: string) {
      if (closed || state.busy) return false
      set({ busy: true, error: '' })
      const r = await deps.deactivateMember(organizationId, id)
      if (!r.ok) {
        failed(r)
        if (r.kind === 'http' && r.error === 'last_owner') set({ error: '最後のオーナーは無効化できません。別のオーナーを追加してください。' })
        if (r.kind === 'http' && r.error === 'last_channel_manager') set({ error: 'チャンネル管理者がいなくなるため、無効化できません。先に別のチャンネル管理者を追加してください。' })
        if (r.kind === 'http' && r.error === 'member_not_found') set({ error: 'このメンバーは利用できません。メンバー一覧を開き直してください。' })
      } else if (!closed) {
        loadSequence++
        if (activityManaged) activityTarget.invalidate()
        const members = state.members.filter(m => m.id !== id)
        authors.replaceMembers(members)
        set({ members })
      }
      set({ busy: false })
      return r.ok && !closed
    },
    async role(id: string, role: Role) {
      if (closed || state.busy) return
      set({ busy: true, error: '' })
      const r = await deps.changeRole(organizationId, id, role)
      if (!r.ok) failed(r)
      else if (!closed) {
        loadSequence++
        if (activityManaged) activityTarget.invalidate()
        const members = state.members.map(m => m.id === id ? r.data : m)
        authors.replaceMembers(members)
        set({ members })
      }
      set({ busy: false })
      return r.ok && !closed
    },
  }
}
