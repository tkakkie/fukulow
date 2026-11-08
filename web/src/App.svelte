<script lang="ts">
  import { restore, setupAndSignIn, signIn, signOut, errorMessage, type AuthState } from './auth'

  let view = $state<AuthState>({ screen: 'loading' })
  let error = $state('')
  let busy = $state(false)

  let organizationName = $state('')
  let name = $state('')
  let email = $state('')
  let password = $state('')
  let setupToken = $state('')

  async function load() {
    view = { screen: 'loading' }
    view = await restore()
  }
  load()

  function go(next: AuthState) {
    error = ''
    password = ''
    setupToken = '' // not needed once setup has finished or been abandoned
    view = next
  }

  async function submitSetup(e: Event) {
    e.preventDefault()
    busy = true
    error = ''
    const r = await setupAndSignIn({
      organization_name: organizationName,
      name,
      email,
      password,
      setup_token: setupToken || null,
    })
    busy = false
    if ('error' in r) error = r.error
    else go(r.state)
  }

  async function submitSignIn(e: Event) {
    e.preventDefault()
    busy = true
    error = ''
    const r = await signIn(email, password)
    busy = false
    if (r.ok) go({ screen: 'app', identity: r.data.identity })
    else error = errorMessage(r, 'signin')
  }

  async function doSignOut() {
    busy = true
    const ok = await signOut()
    busy = false
    if (ok) go({ screen: 'signin' })
    else error = errorMessage({ ok: false, kind: 'network' }, 'signin')
  }
</script>

<main>
  <h1>fukulow</h1>

  {#if view.screen === 'loading'}
    <p>読み込み中…</p>
  {:else if view.screen === 'error'}
    <p role="alert">サーバーに接続できません。</p>
    <button onclick={load}>再試行</button>
  {:else if view.screen === 'setup'}
    <h2>初期セットアップ</h2>
    <form onsubmit={submitSetup}>
      <label>組織名 <input name="organization_name" required bind:value={organizationName} /></label>
      <label>オーナーの名前 <input name="name" required bind:value={name} autocomplete="name" /></label>
      <label>メールアドレス <input name="email" type="email" required bind:value={email} autocomplete="username" /></label>
      <label>パスワード（12文字以上）
        <input name="password" type="password" required minlength="12" bind:value={password} autocomplete="new-password" />
      </label>
      <label>セットアップトークン（任意）
        <input name="setup_token" type="password" bind:value={setupToken} autocomplete="off" />
        <small>設定されている場合は、管理者から受け取ったトークンが必要です。</small>
      </label>
      {#if error}<p role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>セットアップして開始</button>
    </form>
  {:else if view.screen === 'signin'}
    <h2>ログイン</h2>
    <form onsubmit={submitSignIn}>
      {#if view.notice}<p role="status">{view.notice}</p>{/if}
      <label>メールアドレス <input name="email" type="email" required bind:value={email} autocomplete="username" /></label>
      <label>パスワード
        <input name="password" type="password" required bind:value={password} autocomplete="current-password" />
      </label>
      {#if error}<p role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>ログイン</button>
    </form>
  {:else}
    <p>{view.identity.organization.name} / {view.identity.member.name} さん</p>
    {#if error}<p role="alert">{error}</p>{/if}
    <button onclick={doSignOut} disabled={busy}>ログアウト</button>
  {/if}
</main>
