<script lang="ts">
  import { createAuth } from './auth.svelte'
  import Workspace from './Workspace.svelte'

  const auth = createAuth()
  auth.load()

  let organizationName = $state('')
  let name = $state('')
  let email = $state('')
  let password = $state('')
  let setupToken = $state('')

  function clearSecrets() {
    password = ''
    setupToken = '' // not needed once setup has finished or been abandoned
  }

  async function submitSetup(e: Event) {
    e.preventDefault()
    const moved = await auth.submitSetup({
      organization_name: organizationName,
      name,
      email,
      password,
      setup_token: setupToken || null,
    })
    if (moved) clearSecrets()
  }

  async function submitSignIn(e: Event) {
    e.preventDefault()
    if (await auth.submitSignIn(email, password)) clearSecrets()
  }

  async function doSignOut() {
    if (await auth.signOut()) clearSecrets()
  }
</script>

<main>
  <h1>fukulow</h1>

  {#if auth.view.screen === 'loading'}
    <p>読み込み中…</p>
  {:else if auth.view.screen === 'error'}
    <p role="alert">サーバーに接続できません。</p>
    <button onclick={() => auth.load()}>再試行</button>
  {:else if auth.view.screen === 'setup'}
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
      {#if auth.error}<p role="alert">{auth.error}</p>{/if}
      <button type="submit" disabled={auth.busy}>セットアップして開始</button>
    </form>
  {:else if auth.view.screen === 'signin'}
    <h2>ログイン</h2>
    <form onsubmit={submitSignIn}>
      {#if auth.view.notice}<p role="status">{auth.view.notice}</p>{/if}
      <label>メールアドレス <input name="email" type="email" required bind:value={email} autocomplete="username" /></label>
      <label>パスワード
        <input name="password" type="password" required bind:value={password} autocomplete="current-password" />
      </label>
      {#if auth.error}<p role="alert">{auth.error}</p>{/if}
      <button type="submit" disabled={auth.busy}>ログイン</button>
    </form>
  {:else if auth.view.screen === 'app'}
    {@const identity = auth.view.identity}
    {@const session = auth.session}
    {@const organization = auth.organization}
    {#if identity.organizations.length > 1}
      <label>組織
        <select value={auth.selectedOrganizationId} onchange={e => auth.selectOrganization(e.currentTarget.value)}>
          {#each identity.organizations as org}<option value={org.organization_id}>{org.name}</option>{/each}
        </select>
      </label>
    {/if}
    {#if auth.organizationStatus === 'unavailable'}
      <p role="alert">この組織は利用できません。</p>
    {:else if auth.organizationStatus === 'error'}
      <p role="alert">サーバーに接続できません。</p>
      <button onclick={() => auth.selectOrganization(auth.selectedOrganizationId)}>再試行</button>
    {:else if session && organization}
      {#key session}<Workspace {session} />{/key}
      <p>{organization.organization.name} / {organization.member.name} さん</p>
    {:else if identity.organizations.length === 0}
      <p>利用できる組織がありません。</p>
    {:else}
      <p>読み込み中…</p>
    {/if}
    {#if auth.error}<p role="alert">{auth.error}</p>{/if}
    <button onclick={doSignOut} disabled={auth.busy}>ログアウト</button>
  {/if}
</main>
