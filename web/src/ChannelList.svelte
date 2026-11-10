<script lang="ts">
  import type { Channel } from './channels.svelte'
  import ListRow from './ui/ListRow.svelte'

  let {
    channels,
    selectedId,
    onselect,
  }: {
    channels: Channel[]
    selectedId: string | null
    onselect: (id: string) => void
  } = $props()
</script>

<ul class="channel-list">
  {#each channels as c (c.id)}
    <li class="channel-list__item">
      <ListRow
        kind="channel"
        prefix={c.visibility === 'private' ? '🔒' : '#'}
        name={c.name}
        selected={c.id === selectedId}
        onclick={() => onselect(c.id)}
      />
    </li>
  {/each}
</ul>

<style>
  .channel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .channel-list__item {
    min-width: 0;
  }
</style>
