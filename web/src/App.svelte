<script lang="ts">
  import { LOADING_TIMEOUT_MS } from './announcements'
  import { createAuth } from './auth.svelte'
  import Button from './ui/Button.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Input from './ui/Input.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'
  import Workspace from './Workspace.svelte'

  const auth = createAuth()
  void auth.load()

  let organizationName = $state('')
  let name = $state('')
  let email = $state('')
  let password = $state('')
  let setupToken = $state('')
  let pageAnnouncement = $state('')
  let loadingTimedOut = $state(false)

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

  // 10 s loading timeout -> retryable error (docs/ui.md §5)
  $effect(() => {
    const isLoading =
      auth.view.screen === 'loading' ||
      (auth.view.screen === 'app' && auth.organizationStatus === 'loading' && !auth.session)
    if (!isLoading) {
      loadingTimedOut = false
      return
    }
    const timer = setTimeout(() => {
      loadingTimedOut = true
    }, LOADING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  })

  // Announce sign-in notice through the single page role="status" region (docs/ui.md §6)
  $effect(() => {
    if (auth.view.screen === 'signin' && auth.view.notice) {
      pageAnnouncement = auth.view.notice
    }
  })
</script>

<a class="skip-link" href="#main-content">メッセージへ移動</a>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{pageAnnouncement}</div>

{#if auth.view.screen === 'app'}
  {@const identity = auth.view.identity}
  {@const session = auth.session}
  {@const organization = auth.organization}
  {@const otherOrg = identity.organizations.find((o) => o.organization_id !== auth.selectedOrganizationId)}

  {#if session && organization && auth.organizationStatus !== 'unavailable' && auth.organizationStatus !== 'error'}
    {#key session}
      <Workspace
        {session}
        {organization}
        organizations={identity.organizations}
        selectedOrganizationId={auth.selectedOrganizationId}
        busy={auth.busy}
        authError={auth.error}
        onselectorganization={(id) => void auth.selectOrganization(id)}
        onsignout={doSignOut}
        onannounce={(msg) => {
          pageAnnouncement = msg
        }}
      />
    {/key}
  {:else}
    <div class="app-fallback">
      <nav class="app-fallback__rail" aria-label="メインナビゲーション">
        <div class="app-fallback__logo" aria-hidden="true">🦉</div>
        <Button variant="quiet" disabled={auth.busy} onclick={doSignOut}>ログアウト</Button>
      </nav>
      <main id="main-content" class="app-fallback__main">
        <header class="app-fallback__header">
          <h1 class="app-fallback__title">{organization?.organization.name ?? 'fukulow'}</h1>
          {#if identity.organizations.length > 1}
            <label class="app-fallback__org-switcher">
              <span class="app-fallback__org-label">組織</span>
              <select
                class="app-fallback__org-select"
                value={auth.selectedOrganizationId}
                onchange={(e) => void auth.selectOrganization(e.currentTarget.value)}
              >
                {#each identity.organizations as org (org.organization_id)}
                  <option value={org.organization_id}>{org.name}</option>
                {/each}
              </select>
            </label>
          {/if}
        </header>

        {#if auth.organizationStatus === 'unavailable'}
          <StatusBanner
            tone="danger"
            role="alert"
            message="この組織は利用できません。"
            detail="この組織へのアクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。"
            actionLabel={otherOrg ? '組織を切り替える' : undefined}
            onaction={otherOrg ? () => void auth.selectOrganization(otherOrg.organization_id) : undefined}
          />
        {:else if auth.organizationStatus === 'error' || loadingTimedOut}
          <StatusBanner
            tone="danger"
            role="alert"
            message="サーバーに接続できません。"
            detail="通信状況を確認して、もう一度お試しください。"
            actionLabel="再試行"
            onaction={() => {
              loadingTimedOut = false
              void auth.selectOrganization(auth.selectedOrganizationId)
            }}
          />
        {:else if identity.organizations.length === 0}
          <EmptyState
            title="利用できる組織がありません。"
            description="招待を受けるか、別のアカウントでログインしてください。"
          />
        {:else}
          <Skeleton rows={3} label="組織を読み込み中" />
        {/if}

        {#if auth.error}
          <StatusBanner tone="danger" role="alert" message={auth.error} />
        {/if}
      </main>
    </div>
  {/if}
{:else}
  <main id="main-content" class="auth-shell">
    <div class="auth-card">
      <div class="auth-card__brand">
        <span class="auth-card__logo" aria-hidden="true">🦉</span>
        <span class="auth-card__name">fukulow</span>
      </div>

      {#if auth.view.screen === 'loading' && !loadingTimedOut}
        <h1 class="auth-card__title">fukulow</h1>
        <Skeleton rows={3} label="読み込み中" />
      {:else if auth.view.screen === 'error' || (auth.view.screen === 'loading' && loadingTimedOut)}
        <h1 class="auth-card__title">fukulow</h1>
        <StatusBanner
          tone="danger"
          role="alert"
          message="サーバーに接続できません。"
          detail="通信状況を確認して、もう一度お試しください。"
          actionLabel="再試行"
          onaction={() => {
            loadingTimedOut = false
            void auth.load()
          }}
        />
      {:else if auth.view.screen === 'setup'}
        <h1 class="auth-card__title">初期セットアップ</h1>
        <form class="auth-form" onsubmit={submitSetup}>
          <Input label="組織名" name="organization_name" required bind:value={organizationName} />
          <Input label="オーナーの名前" name="name" required autocomplete="name" bind:value={name} />
          <Input
            label="メールアドレス"
            name="email"
            type="email"
            required
            autocomplete="username"
            bind:value={email}
          />
          <Input
            label="パスワード（12文字以上）"
            name="password"
            type="password"
            required
            minlength={12}
            autocomplete="new-password"
            bind:value={password}
          />
          <Input
            label="セットアップトークン（任意）"
            name="setup_token"
            type="password"
            autocomplete="off"
            hint="設定されている場合は、管理者から受け取ったトークンが必要です。"
            bind:value={setupToken}
          />
          {#if auth.error}
            <StatusBanner tone="danger" role="alert" message={auth.error} />
          {/if}
          <Button variant="primary" type="submit" disabled={auth.busy}>セットアップして開始</Button>
        </form>
      {:else if auth.view.screen === 'signin'}
        <h1 class="auth-card__title">ログイン</h1>
        <form class="auth-form" onsubmit={submitSignIn}>
          {#if auth.view.notice}
            <StatusBanner tone="info" role={null} message={auth.view.notice} />
          {/if}
          <Input
            label="メールアドレス"
            name="email"
            type="email"
            required
            autocomplete="username"
            bind:value={email}
          />
          <Input
            label="パスワード"
            name="password"
            type="password"
            required
            autocomplete="current-password"
            bind:value={password}
          />
          {#if auth.error}
            <StatusBanner tone="danger" role="alert" message={auth.error} />
          {/if}
          <Button variant="primary" type="submit" disabled={auth.busy}>ログイン</Button>
        </form>
      {/if}
    </div>
  </main>
{/if}

<style>
  .auth-shell {
    height: 100%;
    overflow-y: auto;
    display: grid;
    place-items: center;
    padding: var(--space-16);
    background-color: var(--app);
    min-width: 0;
  }

  .auth-card {
    display: grid;
    gap: var(--space-16);
    width: 100%;
    max-width: 24rem;
    min-width: 0;
    padding: var(--space-24);
    background-color: var(--surface);
    color: var(--text);
    border-radius: var(--radius-16);
  }

  .auth-card__brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-8);
  }

  .auth-card__logo {
    display: grid;
    place-items: center;
    width: var(--touch-target);
    height: var(--touch-target);
    background-color: var(--amber);
    color: var(--on-amber);
    border-radius: var(--radius-10);
    font-size: var(--font-size-17);
  }

  .auth-card__name {
    font-size: var(--font-size-15);
    font-weight: var(--font-weight-semibold);
    color: var(--text2);
  }

  .auth-card__title {
    margin: 0;
    font-size: var(--font-size-20);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
  }

  .auth-form {
    display: grid;
    gap: var(--space-12);
    width: 100%;
    min-width: 0;
  }

  .app-fallback {
    display: grid;
    grid-template-columns: var(--rail-width) minmax(0, 1fr);
    gap: var(--region-gap);
    height: 100%;
    padding: var(--space-8);
    background-color: var(--app);
    min-width: 0;
  }

  .app-fallback__rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-8) var(--space-4);
    background-color: var(--navbox);
    border-radius: var(--radius-16);
    min-width: 0;
  }

  .app-fallback__logo {
    display: grid;
    place-items: center;
    width: var(--touch-target);
    height: var(--touch-target);
    background-color: var(--amber);
    color: var(--on-amber);
    border-radius: var(--radius-10);
    font-size: var(--font-size-17);
  }

  .app-fallback__main {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    padding: var(--space-24);
    background-color: var(--surface);
    border-radius: var(--radius-16);
    overflow-y: auto;
    min-width: 0;
  }

  .app-fallback__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-12);
    min-width: 0;
  }

  .app-fallback__title {
    margin: 0;
    font-size: var(--font-size-20);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
  }

  .app-fallback__org-switcher {
    display: inline-flex;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .app-fallback__org-label {
    font-size: var(--font-size-13);
    color: var(--text2);
  }

  .app-fallback__org-select {
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    background-color: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-14);
  }

  @media (max-width: 599px) {
    .app-fallback {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 1fr auto;
      padding: var(--space-4);
    }

    .app-fallback__rail {
      grid-row: 2;
      flex-direction: row;
      padding: var(--space-4) var(--space-12);
    }
  }
</style>
