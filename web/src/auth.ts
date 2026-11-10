import {
  deleteSession,
  getMe,
  getSetupStatus,
  postSession,
  postSetup,
  type AccountIdentity,
  type Result,
  type SetupRequest,
} from './api'

export type AuthState =
  | { screen: 'loading' }
  | { screen: 'error' } // retryable: network failure or 5xx
  | { screen: 'setup' }
  | { screen: 'signin'; notice?: string }
  | { screen: 'app'; identity: AccountIdentity }

type Fetch = typeof fetch

/** Japanese message for a failed call; `context` selects the wording per screen. */
export function errorMessage(r: Extract<Result<unknown>, { ok: false }>, context: 'setup' | 'signin'): string {
  if (r.kind === 'network') return 'サーバーに接続できません。しばらくしてからもう一度お試しください。'
  switch (r.status) {
    case 400:
      return context === 'setup'
        ? '入力内容を確認してください。パスワードは12文字以上で入力してください。'
        : 'メールアドレスとパスワードの入力内容を確認してください。'
    case 401:
      return context === 'setup'
        ? 'セットアップトークンが正しくありません。管理者から受け取ったトークンを入力してください。'
        : 'メールアドレスまたはパスワードが正しくありません。'
    case 409:
      return 'セットアップはすでに完了しています。ログインしてください。'
    case 429:
      return context === 'setup'
        ? '試行回数が多すぎます。しばらく待ってからもう一度お試しください。'
        : 'ログインの試行が多すぎます。しばらく待ってからもう一度お試しください。'
    default:
      return 'エラーが発生しました。もう一度お試しください。'
  }
}

/** First load: /me decides. 401 = signed out (then setup status picks the screen). */
export async function restore(f?: Fetch): Promise<AuthState> {
  const me = await getMe(f)
  if (me.ok) return { screen: 'app', identity: me.data }
  if (me.kind === 'network' || me.status !== 401) return { screen: 'error' }
  const setup = await getSetupStatus(f)
  if (!setup.ok) return { screen: 'error' }
  return { screen: setup.data.setup_required ? 'setup' : 'signin' }
}

/** Sign in; on success returns the app state, otherwise the failure. */
export async function signIn(email: string, password: string, f?: Fetch) {
  return postSession({ email, password }, f)
}

/**
 * Run setup, then sign in automatically (setup returns 201 without a session).
 * If sign-in fails after a successful setup, go to Sign in; never re-run setup.
 */
export async function setupAndSignIn(
  req: SetupRequest,
  f?: Fetch,
): Promise<{ state: AuthState } | { error: string }> {
  const setup = await postSetup(req, f)
  if (!setup.ok) {
    if (setup.kind === 'http' && setup.status === 409) {
      return { state: { screen: 'signin', notice: errorMessage(setup, 'setup') } }
    }
    return { error: errorMessage(setup, 'setup') }
  }
  const session = await signIn(req.email, req.password, f)
  if (session.ok) return { state: { screen: 'app', identity: session.data.identity } }
  return {
    state: {
      screen: 'signin',
      notice: 'セットアップは完了しました。自動ログインに失敗したため、ログインしてください。',
    },
  }
}

/** Sign out; 401 means already signed out. Network/5xx keeps the user signed in. */
export async function signOut(f?: Fetch): Promise<boolean> {
  const r = await deleteSession(f)
  return r.ok || (r.kind === 'http' && r.status === 401)
}
