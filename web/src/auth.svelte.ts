import { errorMessage, restore, setupAndSignIn, signIn, signOut, type AuthState } from './auth'
import { channelsAdapter, type ChannelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { syncAdapter, type SyncAdapter } from './sync.svelte'

export type { AuthState } from './auth'

/** What the Workspace shows: one signed-in session's adapters. `close` ends the session's controllers. */
export type SessionModel = { channels: ChannelsAdapter; sync: SyncAdapter; close(): void }

export type AuthDeps = {
  restore: typeof restore
  signIn: typeof signIn
  setupAndSignIn: typeof setupAndSignIn
  signOut: typeof signOut
  /** Starts the controllers of a new session; `onEnded` is called when the server ends it (401, 4001). */
  openSession(selfId: string, onEnded: () => void): SessionModel
}

const defaults: AuthDeps = {
  restore,
  signIn,
  setupAndSignIn,
  signOut,
  openSession(selfId, onEnded) {
    const session = createSession({ selfId, onEnded })
    return { channels: channelsAdapter(session.channels), sync: syncAdapter(session.sync), close: session.close }
  },
}

const sessionEndedNotice = 'セッションが終了しました。もう一度ログインしてください。'

/**
 * Sign in / sign-out screens and the signed-in session's lifetime. A session's controllers are opened when the
 * screen becomes `app` and closed when it changes to anything else (sign-out, 4001, 401, or a new session), never by
 * a component unmounting. Sync decisions stay in the controller; this only maps and forwards.
 */
export function createAuth(deps: AuthDeps = defaults) {
  let view = $state<AuthState>({ screen: 'loading' })
  let error = $state('')
  let busy = $state(false)
  // The session is a plain object with closures, not state; `changes` tells readers that it was replaced.
  let session: SessionModel | null = null
  let changes = $state(0)

  function show(next: AuthState) {
    session?.close()
    session = null
    if (next.screen === 'app') {
      const mine: SessionModel = deps.openSession(next.identity.member.id, () => {
        if (session === mine) show({ screen: 'signin', notice: sessionEndedNotice })
      })
      session = mine
    }
    changes++
    error = ''
    view = next
  }

  return {
    get view() { return view },
    get error() { return error },
    get busy() { return busy },
    get session() {
      void changes
      return session
    },
    async load() {
      view = { screen: 'loading' }
      show(await deps.restore())
    },
    /** True when the screen changed (the caller may clear secrets it holds). */
    async submitSetup(req: Parameters<typeof setupAndSignIn>[0]): Promise<boolean> {
      busy = true
      error = ''
      const r = await deps.setupAndSignIn(req)
      busy = false
      if ('error' in r) {
        error = r.error
        return false
      }
      show(r.state)
      return true
    },
    async submitSignIn(email: string, password: string): Promise<boolean> {
      busy = true
      error = ''
      const r = await deps.signIn(email, password)
      busy = false
      if (!r.ok) {
        error = errorMessage(r, 'signin')
        return false
      }
      show({ screen: 'app', identity: r.data.identity })
      return true
    },
    async signOut(): Promise<boolean> {
      busy = true
      const ok = await deps.signOut()
      busy = false
      if (!ok) {
        error = errorMessage({ ok: false, kind: 'network' }, 'signin')
        return false
      }
      show({ screen: 'signin' })
      return true
    },
  }
}
