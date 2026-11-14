<script lang="ts">
  import type { AcceptInviteRequest } from './api'
  import type { inviteAcceptanceAdapter } from './members.svelte'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    model,
    signedIn,
    busy,
    accept,
    signOut,
  }: {
    model: ReturnType<typeof inviteAcceptanceAdapter>
    signedIn: boolean
    busy: boolean
    accept(input: Omit<AcceptInviteRequest, 'token'>): Promise<void>
    signOut(): Promise<void>
  } = $props()

  let email = $state('')
  let name = $state('')
  let password = $state('')
  const s = $derived(model.state)
  const needsSignOut = $derived(s.sessionRejected && !signedIn)

  async function submit(e: Event) {
    e.preventDefault()
    if (busy || s.busy || needsSignOut) return
    await accept({ email, name, password: signedIn ? null : password })
    password = ''
  }
</script>

{#if s.available}
  <section class="invite-accept" aria-label="招待を受ける">
    <h2 class="invite-accept__title">組織への招待</h2>
    <p class="invite-accept__desc">
      アカウントをお持ちの方は、招待先のアドレスでログインしてから招待を受けてください。
    </p>
    <form class="invite-accept__form" onsubmit={submit}>
      <Input
        label="招待先のメールアドレス"
        type="email"
        required
        autocomplete="username"
        bind:value={email}
      />
      <Input label="組織での名前" required maxlength={200} autocomplete="name" bind:value={name} />
      {#if !signedIn}
        <Input
          label="新しいアカウントのパスワード（12文字以上）"
          type="password"
          minlength={12}
          required
          autocomplete="new-password"
          bind:value={password}
        />
      {/if}
      {#if s.error}
        <StatusBanner tone="danger" role="alert" message={s.error} />
      {/if}
      {#if needsSignOut}
        <Button disabled={busy || s.busy} onclick={signOut}>ログアウトして続ける</Button>
      {/if}
      <Button variant="primary" type="submit" disabled={busy || s.busy || needsSignOut}>招待を受ける</Button>
    </form>
  </section>
{:else if s.accepted && !signedIn}
  <StatusBanner tone="info" role={null} message="招待を受けました。ログインしてください。" />
{/if}

<style>
  .invite-accept {
    display: grid;
    gap: var(--space-12);
    padding: var(--space-16);
    background-color: var(--bg);
    border-radius: var(--radius-12);
    min-width: 0;
  }

  .invite-accept__title {
    margin: 0;
    font-size: var(--font-size-17);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
  }

  .invite-accept__desc {
    margin: 0;
    font-size: var(--font-size-13);
    color: var(--text2);
  }

  .invite-accept__form {
    display: grid;
    gap: var(--space-12);
    min-width: 0;
  }
</style>
