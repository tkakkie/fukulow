import { errorMessage, type AuthState, type restore, type setupAndSignIn, type signIn, type signOut } from './auth'
import type { AcceptInviteRequest, Identity } from './api'
import type { createInviteAcceptance } from './members'

type Invitation = Pick<ReturnType<typeof createInviteAcceptance>, 'accept' | 'signOutAndContinue'>
type Dependencies = {
  restore: typeof restore
  setupAndSignIn: typeof setupAndSignIn
  signIn: typeof signIn
  signOut: typeof signOut
}
type AccountLifecycle = {
  generation(): number
  selection(): number
  loading(): void
  show(state: AuthState): Promise<void>
  ended(generation: number): void
  accepted(identity: Identity): Promise<void>
}

/** Cookie mutations must never overlap: ignoring a late result cannot undo Set-Cookie. */
export function createAuthOperations(deps: Dependencies, account: AccountLifecycle) {
  let state = { busy: false, error: '' }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(l => l()) }
  async function run<T>(blocked: T, action: (current: () => boolean, generation: number) => Promise<T>): Promise<T> {
    if (state.busy) return blocked
    const generation = account.generation()
    set({ busy: true, error: '' })
    try { return await action(() => generation === account.generation(), generation) }
    finally { set({ busy: false }) }
  }
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
    clearError() { set({ error: '' }) },
    load: () => run(undefined, async current => {
      account.loading()
      const next = await deps.restore()
      if (current()) await account.show(next)
    }),
    submitSetup: (req: Parameters<typeof setupAndSignIn>[0]) => run(false, async current => {
      const result = await deps.setupAndSignIn(req)
      if (!current()) return false
      if ('error' in result) { set({ error: result.error }); return false }
      await account.show(result.state)
      return true
    }),
    submitSignIn: (email: string, password: string) => run(false, async current => {
      const result = await deps.signIn(email, password)
      if (!current()) return false
      if (!result.ok) { set({ error: errorMessage(result, 'signin') }); return false }
      await account.show({ screen: 'app', identity: result.data.identity })
      return true
    }),
    signOut: ({ reportError = true } = {}) => run(false, async current => {
      const selection = account.selection()
      const ok = await deps.signOut()
      if (!current()) return false
      if (!ok) {
        if (reportError && selection === account.selection()) set({ error: errorMessage({ ok: false, kind: 'network' }, 'signin') })
        return false
      }
      await account.show({ screen: 'signin' })
      return true
    }),
    signOutAndContinue: (model: Invitation) => run(undefined, async current => {
      const ok = await model.signOutAndContinue(deps.signOut, current)
      if (ok && current()) await account.show({ screen: 'signin' })
    }),
    acceptInvitation: (model: Invitation, input: Omit<AcceptInviteRequest, 'token'>) => run(undefined, async (current, generation) => {
      const identity = await model.accept(input, () => account.ended(generation), current)
      if (identity && current()) await account.accepted(identity)
    }),
  }
}
