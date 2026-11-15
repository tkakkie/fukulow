<script lang="ts">
  import type { Member, OutstandingInvite } from './api'
  import type { invitesAdapter } from './invites.svelte'
  import { roleNames } from './members'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let { model, members }: { model: ReturnType<typeof invitesAdapter>; members: Member[] } = $props()
  const s = $derived(model.state)
  let target = $state<OutstandingInvite | null>(null)
  let heading = $state<HTMLElement | null>(null)
</script>

<section class="invites" aria-label="未承諾の招待">
  <h2 bind:this={heading} tabindex="-1">未承諾の招待</h2>
  <div class="invites__body">
    {#if s.error}
      <StatusBanner tone="danger" role="alert" message={s.error} />
      {#if s.retryable}<Button onclick={() => model.retry()}>再試行</Button>{/if}
    {/if}
    <ul class="invites__items">
      {#each s.invites as invite (invite.id)}
        <li class="invites__item">
          <span>{invite.email}（{roleNames[invite.role]}）</span>
          <span class="invites__meta">招待者: {members.find(m => m.id === invite.created_by)?.name ?? 'メンバー'}</span>
          <span class="invites__meta">有効期限: {new Date(invite.expires_at).toLocaleString('ja-JP')}</span>
          <Button disabled={s.busy || s.loading} onclick={() => target = invite}>{invite.email}への招待を取り消す</Button>
        </li>
      {/each}
    </ul>
    {#if s.loading}<Skeleton label="招待を読み込み中" />
    {:else if s.loaded && !s.error && s.invites.length === 0}
      <EmptyState title="未承諾の招待はありません" description="メンバーを招待してリンクを共有してください。" />
    {/if}
    {#if s.nextCursor}
      <Button disabled={s.loading || s.busy} onclick={() => model.more()}>さらに招待を読み込む</Button>
    {/if}
    <Button disabled={s.loading || s.busy} onclick={() => model.load()}>招待一覧を更新</Button>
  </div>
</section>

<Dialog open={target !== null} busy={s.busy} title="招待を取り消しますか？"
  description={`${target?.email ?? ''}への招待リンクは使えなくなります。この操作は元に戻せません。`}
  confirmLabel="招待を取り消す" returnFocusFallback={heading}
  oncancel={() => target = null}
  onconfirm={() => { const invite = target; if (invite) void model.revoke(invite.id).then(ok => { target = null; if (ok) heading?.focus() }) }} />

<style>
  .invites { min-width: 0; }
  h2 { margin: 0; padding: var(--space-8) 0; font-size: var(--font-size-14); font-weight: var(--font-weight-semibold); }
  .invites__body, .invites__items, .invites__item { display: grid; gap: var(--space-8); min-width: 0; }
  .invites__items { list-style: none; margin: 0; padding: 0; }
  .invites__item { background: var(--bg); padding: var(--space-8); border-radius: var(--radius-8); overflow-wrap: anywhere; font-size: var(--font-size-13); }
  .invites__meta { color: var(--text2); font-size: var(--font-size-12); }
</style>
