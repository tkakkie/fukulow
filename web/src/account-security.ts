import { putPassword, revokeOtherSessions, type ChangePasswordRequest, type RevokeOtherSessionsRequest, type Result } from './api'

export type SecurityAction = 'password' | 'sessions'
export type SecurityError = 'incorrect' | 'invalid_new' | 'invalid' | 'throttled' | 'unconfirmed' | null
export type SecurityState = { busy: boolean; error: SecurityError; success: SecurityAction | null }
type Dependencies = { putPassword: typeof putPassword; revokeOtherSessions: typeof revokeOtherSessions }

export function createAccountSecurity(onEnded: () => void, deps: Dependencies = { putPassword, revokeOtherSessions }) {
  let state: SecurityState = { busy: false, error: null, success: null }
  let closed = false
  const listeners = new Set<() => void>()
  function update(next: SecurityState) {
    state = next
    for (const listener of listeners) listener()
  }
  async function run(action: SecurityAction, call: () => Promise<Result<undefined>>) {
    if (closed || state.busy) return false
    update({ busy: true, error: null, success: null })
    const result = await call()
    if (closed) return false
    if (!result.ok && result.kind === 'http' && result.status === 401) {
      update({ busy: false, error: null, success: null })
      onEnded()
      return false
    }
    const error: SecurityError = result.ok ? null
      : result.kind === 'http' && result.status === 403 && result.error === 'current_password_incorrect' ? 'incorrect'
      : result.kind === 'http' && result.status === 400 && result.error === 'invalid_new_password' ? 'invalid_new'
      : result.kind === 'http' && result.status === 400 ? 'invalid'
      : result.kind === 'http' && result.status === 429 ? 'throttled' : 'unconfirmed'
    update({ busy: false, error, success: result.ok ? action : null })
    return result.ok
  }
  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    changePassword: (body: ChangePasswordRequest) => run('password', () => deps.putPassword(body)),
    revokeOthers: (body: RevokeOtherSessionsRequest) => run('sessions', () => deps.revokeOtherSessions(body)),
    reset() { if (!closed && !state.busy) update({ busy: false, error: null, success: null }) },
    close() { closed = true; listeners.clear() },
  }
}
