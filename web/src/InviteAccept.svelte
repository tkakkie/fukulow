<script lang="ts">
  import type { AcceptInviteRequest } from './api'
  import type { inviteAcceptanceAdapter } from './members.svelte'
  let { model, signedIn, accept }: { model: ReturnType<typeof inviteAcceptanceAdapter>; signedIn: boolean; accept(input: Omit<AcceptInviteRequest, 'token'>): Promise<void> } = $props()
  let email = $state(''), name = $state(''), password = $state('')
  const s = $derived(model.state)
  async function submit(e: Event) {
    e.preventDefault()
    await accept({ email, name, password: signedIn ? null : password })
    password = ''
  }
</script>

{#if s.available}
  <section aria-label="招待を受ける">
    <h2>組織への招待</h2>
    <p>アカウントをお持ちの方は、招待先のアドレスでログインしてから招待を受けてください。</p>
    <form onsubmit={submit}>
      <label>招待先のメールアドレス <input type="email" required bind:value={email} autocomplete="username" /></label>
      <label>組織での名前 <input required maxlength="200" bind:value={name} autocomplete="name" /></label>
      {#if !signedIn}
        <label>新しいアカウントのパスワード（12文字以上）<input type="password" minlength="12" required bind:value={password} autocomplete="new-password" /></label>
      {/if}
      {#if s.error}<p role="alert">{s.error}</p>{/if}
      <button disabled={s.busy}>招待を受ける</button>
    </form>
  </section>
{:else if s.accepted && !signedIn}
  <p role="status">招待を受けました。ログインしてください。</p>
{/if}
