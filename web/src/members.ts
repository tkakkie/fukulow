import { createActivityTarget } from './activity'
import { listMembers, changeRole, deactivateMember, createInvite, acceptInvite, isOrganizationUnavailable, type Identity, type Member, type Role, type Result, type AcceptInviteRequest } from './api'

export const roleNames: Record<Role, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー', guest: 'ゲスト' }
export const roles = Object.keys(roleNames) as Role[]
export function memberError(r: Exclude<Result<unknown>, { ok: true }>): string {
  if (r.kind === 'network') return 'サーバーに接続できません。もう一度お試しください。'
  if (r.error === 'last_owner') return '最後のオーナーのロールは変更できません。'
  if (r.error === 'last_channel_manager') return 'チャンネルの管理者がいなくなるため、ロールを変更できません。先に別のオーナーまたは管理者を追加してください。'
  if (r.error === 'invite_sign_in_required') return 'このアドレスのアカウントでログインしてから招待を受けてください。'
  if (r.error === 'invite_account_mismatch') return '招待先のアカウントでログインしてください。'
  if (r.error === 'invite_issuer_unauthorized') return '招待したメンバーの権限が変更されています。組織の管理者に新しい招待を依頼してください。'
  if (r.error === 'member_already_active') return 'すでにこの組織のメンバーです。'
  if (r.error === 'invite_unavailable') return 'この招待は利用できません。招待先アドレスと有効期限を確認してください。'
  if (r.status === 401) return 'セッションが終了しました。もう一度ログインしてください。'
  if (r.status === 403) return 'この操作の権限がありません。'
  return '入力内容と権限を確認してください。'
}

type MembersDeps = { listMembers: typeof listMembers; changeRole: typeof changeRole; deactivateMember: typeof deactivateMember; createInvite: typeof createInvite; baseUrl(): string }
const defaults: MembersDeps = { listMembers, changeRole, deactivateMember, createInvite, baseUrl: () => `${location.origin}${location.pathname}` }
export function createMembers(organizationId: string, onEnded: () => void, onUnavailable: () => void, deps: MembersDeps = defaults) {
  let state = { members: [] as Member[], loading: true, busy: false, error: '', inviteLink: '' }
  let closed = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { if (!closed) { state = { ...state, ...patch }; listeners.forEach(l => l()) } }
  function failed(r: Exclude<Result<unknown>, { ok: true }>) {
    if (r.kind === 'http' && r.status === 401) onEnded()
    else if (!closed && isOrganizationUnavailable(r)) onUnavailable()
    set({ error: memberError(r) })
  }
  const activityTarget = createActivityTarget({
    load: () => deps.listMembers(organizationId).then(r => { if (!r.ok && r.kind === 'http' && r.status === 401) onEnded(); return r }),
    accept: data => set({ members: data.members, loading: false, error: '' }),
    hide: () => set({ members: [], loading: true }),
    error: r => { failed(r); set({ loading: false }) },
    terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || isOrganizationUnavailable(r)),
  })
  return {
    activityTarget,
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    close() { closed = true; activityTarget.close(); state = { ...state, inviteLink: '' }; listeners.clear() },
    async load() { await activityTarget.refresh() },
    async invite(email: string, role: Role) {
      if (closed || state.busy) return
      set({ busy: true, error: '', inviteLink: '' })
      const r = await deps.createInvite(organizationId, { email, role })
      if (!r.ok) failed(r)
      else set({ inviteLink: `${deps.baseUrl()}#invite=${encodeURIComponent(r.data.organization_id)}:${encodeURIComponent(r.data.token)}` })
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
      } else set({ members: state.members.filter(m => m.id !== id) })
      set({ busy: false })
      return r.ok && !closed
    },
    async role(id: string, role: Role) {
      if (closed || state.busy) return
      set({ busy: true, error: '' })
      const r = await deps.changeRole(organizationId, id, role)
      if (!r.ok) failed(r)
      else set({ members: state.members.map(m => m.id === id ? r.data : m) })
      set({ busy: false })
      return r.ok && !closed
    },
  }
}

/** The token travels only in a fragment and POST body, and is removed from browser history immediately. */
export function takeInvite(url = new URL(location.href), replace: (path: string) => void = path => history.replaceState(null, '', path)) {
  if (!url.hash.startsWith('#invite=')) return null
  const value = url.hash.slice('#invite='.length).split(':')
  replace(`${url.pathname}${url.search}`)
  if (value.length !== 2) return null
  try {
    const organizationId = decodeURIComponent(value[0]), token = decodeURIComponent(value[1])
    if (!/^[0-9a-f-]{36}$/i.test(organizationId) || !/^[0-9a-f]{64}$/.test(token)) return null
    return { organizationId, token }
  } catch { return null }
}
export function createInviteAcceptance(invite: ReturnType<typeof takeInvite>, api = acceptInvite) {
  let state = { available: invite !== null, busy: false, error: '', accepted: false, sessionRejected: false }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(l => l()) }
  async function signOutAndContinue(signOut: () => Promise<boolean>, isCurrent: () => boolean = () => true) {
    if (!invite || !state.sessionRejected || state.busy) return false
    set({ busy: true })
    try {
      const ok = await signOut().catch(() => false)
      if (!isCurrent()) return false
      set(ok
        ? { sessionRejected: false, error: '' }
        : { error: 'ログアウトできませんでした。通信状況を確認して、もう一度お試しください。' })
      return ok
    } finally { set({ busy: false }) }
  }
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    signOutAndContinue,
    async accept(input: Omit<AcceptInviteRequest, 'token'>, onEnded: () => void = () => {}, isCurrent: () => boolean = () => true): Promise<Identity | null> {
      if (!invite || state.busy) return null
      set({ busy: true, error: '', sessionRejected: false })
      try {
        const r = await api(invite.organizationId, { ...input, token: invite.token })
          .catch((): Result<Identity> => ({ ok: false, kind: 'network' }))
        if (!isCurrent()) return null
        if (!r.ok) {
          const sessionRejected = r.kind === 'http' && r.status === 401
          if (sessionRejected) onEnded()
          set({ error: memberError(r), sessionRejected })
          return null
        }
        invite = null
        set({ accepted: true, available: false })
        return r.data
      } finally { set({ busy: false }) }
    },
  }
}

export const inviteFromLocation = () => createInviteAcceptance(takeInvite())
