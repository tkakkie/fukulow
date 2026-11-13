<script lang="ts">
  import type { SecurityAction } from './account-security'
  import type { accountSecurityAdapter } from './account-security.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let { model, onclose, onannounce }: {
    model: ReturnType<typeof accountSecurityAdapter>
    onclose: () => void
    onannounce: (message: string) => void
  } = $props()
  const s = $derived(model.state)
  let action = $state<SecurityAction | null>(null)
  let confirming = $state(false)
  let currentPassword = $state('')
  let newPassword = $state('')
  const title = $derived(action === 'password' ? 'パスワードを変更' : '他のセッションをログアウト')
  const error = $derived(s.error === 'incorrect' ? '現在のパスワードが正しくありません。もう一度入力してください。'
    : s.error === 'invalid' ? '入力内容を確認してください。新しいパスワードは12文字以上、1024バイト以内で入力してください。'
    : s.error === 'throttled' ? '試行回数が多すぎます。しばらく待ってからもう一度お試しください。'
    : s.error === 'unconfirmed' ? '処理の結果を確認できませんでした。通信状況を確認して、もう一度お試しください。' : '')

  function choose(next: SecurityAction) {
    model.reset()
    action = next
  }
  function back() {
    if (s.busy) return
    currentPassword = ''; newPassword = ''; confirming = false; action = null
    model.reset()
  }
  async function confirm() {
    if (s.busy || !action) return
    const operation = action
    const current_password = currentPassword
    const new_password = newPassword
    currentPassword = ''; newPassword = ''
    const ok = operation === 'password'
      ? await model.changePassword({ current_password, new_password })
      : await model.revokeOthers({ current_password })
    confirming = false
    if (ok) {
      onannounce(operation === 'password' ? 'パスワードを変更し、他のセッションをログアウトしました。' : '他のセッションをログアウトしました。')
      onclose()
    }
  }
</script>

<Dialog open={action === null} title="設定" oncancel={onclose} cancelLabel="閉じる">
  <div class="account-settings">
    <h3>アカウント</h3>
    <Button variant="secondary" disabled={s.busy} onclick={() => choose('password')}>パスワードを変更</Button>
    <Button variant="secondary" disabled={s.busy} onclick={() => choose('sessions')}>他のセッションをログアウト</Button>
  </div>
</Dialog>
<Dialog open={action !== null && !confirming} {title} oncancel={back}>
  <form class="account-settings" onsubmit={(event) => { event.preventDefault(); confirming = true }}>
    <Input label="現在のパスワード" type="password" autocomplete="current-password" required bind:value={currentPassword} disabled={s.busy} />
    {#if action === 'password'}
      <Input label="新しいパスワード" type="password" autocomplete="new-password" required minlength={12} bind:value={newPassword} disabled={s.busy} hint="12文字以上、1024バイト以内で入力してください。" />
    {/if}
    {#if error}<StatusBanner tone="danger" role="alert" message={error} />{/if}
    <Button type="submit" disabled={s.busy}>変更内容を確認</Button>
  </form>
</Dialog>
<Dialog open={confirming} busy={s.busy} title={`${title}しますか？`} oncancel={() => { confirming = false }} cancelLabel="戻る"
  description={action === 'password'
    ? 'パスワードを変更し、すべての組織で他のセッションをログアウトします。このセッションは引き続き利用できます。'
    : 'すべての組織で他のセッションをログアウトします。このセッションは引き続き利用できます。'}>
  <div class="account-settings" aria-busy={s.busy}>
    <Button disabled={s.busy} onclick={() => void confirm()}>{title}</Button>
  </div>
</Dialog>

<style>
  .account-settings { display: grid; gap: var(--space-12); min-width: 0; }
  h3 { margin: 0; font-size: var(--font-size-15); font-weight: var(--font-weight-semibold); }
</style>
