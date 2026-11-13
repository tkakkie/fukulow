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
  let readGeneration = 0
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(l => l()) }
  async function run<T>(blocked: T, action: (current: () => boolean, generation: number) => Promise<{ value: T; read?: Promise<void> }>): Promise<T> {
    if (state.busy) return blocked
    const generation = account.generation()
    readGeneration++
    set({ busy: true, error: '' })
    let completion
    try { completion = await action(() => generation === account.generation(), generation) }
    finally { set({ busy: false }) }
    // Start the Account transition under the guard, but never hold it for its reads.
    await completion.read
    return completion.value
  }
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
    clearError() { set({ error: '' }) },
    async load() {
      if (state.busy) return
      const read = ++readGeneration, generation = account.generation()
      set({ error: '' })
      account.loading()
      const next = await deps.restore()
      if (read === readGeneration && generation === account.generation()) await account.show(next)
    },
    submitSetup: (req: Parameters<typeof setupAndSignIn>[0]) => run(false, async current => {
      const result = await deps.setupAndSignIn(req)
      if (!current()) return { value: false }
      if ('error' in result) { set({ error: result.error }); return { value: false } }
      return { value: true, read: account.show(result.state) }
    }),
    submitSignIn: (email: string, password: string) => run(false, async current => {
      const result = await deps.signIn(email, password)
      if (!current()) return { value: false }
      if (!result.ok) { set({ error: errorMessage(result, 'signin') }); return { value: false } }
      return { value: true, read: account.show({ screen: 'app', identity: result.data.identity }) }
    }),
    signOut: ({ reportError = true } = {}) => run(false, async current => {
      const selection = account.selection()
      const ok = await deps.signOut()
      if (!current()) return { value: false }
      if (!ok) {
        if (reportError && selection === account.selection()) set({ error: errorMessage({ ok: false, kind: 'network' }, 'signin') })
        return { value: false }
      }
      return { value: true, read: account.show({ screen: 'signin' }) }
    }),
    signOutAndContinue: (model: Invitation) => run(undefined, async current => {
      const ok = await model.signOutAndContinue(deps.signOut, current)
      return { value: undefined, read: ok && current() ? account.show({ screen: 'signin' }) : undefined }
    }),
    acceptInvitation: (model: Invitation, input: Omit<AcceptInviteRequest, 'token'>) => run(undefined, async (current, generation) => {
      const identity = await model.accept(input, () => account.ended(generation), current)
      return { value: undefined, read: identity && current() ? account.accepted(identity) : undefined }
    }),
  }
}
