import { acceptInvite, isSessionEnded, type AcceptInviteRequest, type Identity, type Result } from './api'
import { memberError } from './member-errors'

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
          const sessionRejected = isSessionEnded(r)
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
