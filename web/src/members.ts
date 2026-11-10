import { listMembers, changeRole, createInvite, acceptInvite, isOrganizationUnavailable, type Identity, type Member, type Role, type Result, type AcceptInviteRequest } from './api'

export const roleNames: Record<Role, string> = { owner: 'オーナー', admin: '管理者', member: 'メンバー', guest: 'ゲスト' }
export const roles = Object.keys(roleNames) as Role[]
export function memberError(r: Exclude<Result<unknown>, { ok: true }>): string {
  if (r.kind === 'network') return 'サーバーに接続できません。もう一度お試しください。'
  if (r.error === 'last_owner') return '最後のオーナーのロールは変更できません。'
  if (r.error === 'invite_sign_in_required') return 'このアドレスのアカウントでログインしてから招待を受けてください。'
  if (r.error === 'invite_account_mismatch') return '招待先のアカウントでログインしてください。'
  if (r.error === 'member_already_active') return 'すでにこの組織のメンバーです。'
  if (r.error === 'invite_unavailable') return 'この招待は利用できません。招待先アドレスと有効期限を確認してください。'
  if (r.status === 401) return 'セッションが終了しました。もう一度ログインしてください。'
  if (r.status === 403) return 'この操作の権限がありません。'
  return '入力内容と権限を確認してください。'
}

type MembersDeps = { listMembers: typeof listMembers; changeRole: typeof changeRole; createInvite: typeof createInvite; baseUrl(): string }
const defaults: MembersDeps = { listMembers, changeRole, createInvite, baseUrl: () => `${location.origin}${location.pathname}` }
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
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    close() { closed = true; state = { ...state, inviteLink: '' }; listeners.clear() },
    async load() {
      const r = await deps.listMembers(organizationId)
      if (!r.ok) failed(r)
      else set({ members: r.data.members })
      set({ loading: false })
    },
    async invite(email: string, role: Role) {
      if (closed || state.busy) return
      set({ busy: true, error: '', inviteLink: '' })
      const r = await deps.createInvite(organizationId, { email, role })
      if (!r.ok) failed(r)
      else set({ inviteLink: `${deps.baseUrl()}#invite=${encodeURIComponent(r.data.organization_id)}:${encodeURIComponent(r.data.token)}` })
      set({ busy: false })
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
  let state = { available: invite !== null, busy: false, error: '', accepted: false }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(l => l()) }
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    async accept(input: Omit<AcceptInviteRequest, 'token'>, onEnded: () => void = () => {}): Promise<Identity | null> {
      if (!invite || state.busy) return null
      set({ busy: true, error: '' })
      const r = await api(invite.organizationId, { ...input, token: invite.token })
      if (!r.ok) { if (r.kind === 'http' && r.status === 401) onEnded(); set({ busy: false, error: memberError(r) }); return null }
      invite = null
      set({ busy: false, accepted: true, available: false })
      return r.data
    },
  }
}

export const inviteFromLocation = () => createInviteAcceptance(takeInvite())
