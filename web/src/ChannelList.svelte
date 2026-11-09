<script lang="ts">
  import type { Channel } from './channels.svelte'
  let { channels, selectedId, onselect }: { channels: Channel[]; selectedId: string | null; onselect: (id: string) => void } = $props()
</script>

<nav aria-label="チャンネル">
  <ul>
    {#each channels as c (c.id)}
      <li>
        <button type="button" aria-current={c.id === selectedId ? 'true' : undefined} onclick={() => onselect(c.id)}>
          {c.visibility === 'private' ? '🔒' : '#'} {c.name}
        </button>
      </li>
    {/each}
  </ul>
</nav>
