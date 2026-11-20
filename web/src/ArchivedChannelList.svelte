<script lang="ts">
  import type { Channel } from './channels.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import ListRow from './ui/ListRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    list,
    selectedId,
    disabled = false,
    onhold,
    onretry,
    onselect,
  }: {
    list: { status: 'loading' | 'ready' | 'error'; channels: Channel[] } | undefined
    selectedId: string | null
    disabled?: boolean
    onhold: () => () => void
    onretry: () => void
    onselect: (id: string) => void
  } = $props()

  const uid = $props.id()
  const listId = `${uid}-archived-channels`
  let open = $state(false)
  const channels = $derived((list?.channels ?? []).filter((c) => c.kind === 'channel'))

  $effect(() => {
    if (!open || disabled) return
    return onhold()
  })
</script>

<section class="archived-list" aria-label="アーカイブ済みチャンネル">
  <button
    type="button"
    class="archived-list__toggle"
    aria-expanded={open}
    aria-controls={listId}
    {disabled}
    onclick={() => { open = !open }}
  >
    <span aria-hidden="true">{open ? '▾' : '▸'}</span>
    <span>アーカイブ済みチャンネル</span>
  </button>

  {#if open && !disabled}
    <div id={listId} class="archived-list__body">
      {#if list?.status === 'error'}
        <StatusBanner
          tone="danger"
          role="alert"
          message="アーカイブ済みチャンネルを読み込めませんでした。"
          detail="通信状況を確認して、もう一度お試しください。"
          actionLabel="再試行"
          onaction={onretry}
        />
      {:else if !list || (list.status === 'loading' && channels.length === 0)}
        <Skeleton rows={2} label="アーカイブ済みチャンネルを読み込み中" />
      {:else if channels.length === 0}
        <EmptyState title="アーカイブ済みのチャンネルはありません。" />
      {:else}
        <ul class="archived-list__items" aria-label="アーカイブ済みチャンネル">
          {#each channels as c (c.id)}
            <li class="archived-list__item">
              <ListRow
                kind="channel"
                prefix={c.visibility === 'private' ? '🔒' : '#'}
                name={c.name}
                selected={c.id === selectedId}
                unreadCount={0}
                mentionUnreadCount={0}
                onclick={() => onselect(c.id)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .archived-list {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .archived-list__toggle {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    background-color: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-semibold);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  .archived-list__toggle:hover:not(:disabled) {
    background-color: var(--hover);
  }

  .archived-list__toggle:disabled {
    color: var(--muted);
    cursor: not-allowed;
  }

  .archived-list__body {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .archived-list__items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .archived-list__item {
    min-width: 0;
  }
</style>
