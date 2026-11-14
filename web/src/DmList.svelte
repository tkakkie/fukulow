<script lang="ts">
  import type { DmRow } from './dm-list'
  import Button from './ui/Button.svelte'
  import ListRow from './ui/ListRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  let { rows, selectedId, loading = false, error = false, more = true, busy = false, canOpen = false, message = '', unread, onselect, onmore, onretry }: {
    rows: DmRow[]; selectedId: string | null; loading?: boolean; error?: boolean; more?: boolean; busy?: boolean; canOpen?: boolean; message?: string
    unread?(id: string): number | null
    onselect(id: string): void; onmore(): void; onretry(): void
  } = $props()
</script>

<section aria-labelledby="dm-list-heading">
  <h2 id="dm-list-heading">ダイレクトメッセージ</h2>
  {#if loading && !rows.length}<Skeleton rows={2} label="ダイレクトメッセージを読み込み中" />{/if}
  {#if message || error}
    <StatusBanner tone="danger" role="alert" message={message || 'ダイレクトメッセージを読み込めませんでした。'} actionLabel="再試行" onaction={onretry} />
  {/if}
  {#if !loading && !error && !message && !rows.length}
    <EmptyState title="表示できるダイレクトメッセージはありません。"
      description={canOpen ? 'メンバーからダイレクトメッセージを開いてください。' : '相手が開くとここに表示されます。'} />
  {/if}
  <ul>
    {#each rows as row (row.identity.id)}
      <li>
        <ListRow prefix="💬" name={`${row.identity.peer.name}${row.identity.peer.active ? '' : '（無効）'}`}
          selected={selectedId === row.identity.id}
          unreadCount={row.baseline ? (unread?.(row.identity.id) ?? row.baseline.unread_count) : 0}
          mentioned={(row.baseline?.mention_unread_count ?? 0) > 0}
          onclick={() => onselect(row.identity.id)} />
        {#if !row.baseline}<span class="dm-list__unknown">未読を確認中</span>{/if}
      </li>
    {/each}
  </ul>
  {#if more}<Button variant="quiet" disabled={busy} onclick={onmore}>さらに表示</Button>{/if}
</section>

<style>
  section { min-width: 0; padding-top: var(--space-12); }
  h2 { margin: 0; padding: var(--space-8); font-size: var(--font-size-14); font-weight: var(--font-weight-semibold); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-4); }
  li { min-width: 0; }
  .dm-list__unknown { color: var(--text2); font-size: var(--font-size-12); padding: var(--space-8); }
</style>
