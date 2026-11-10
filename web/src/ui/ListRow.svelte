<script lang="ts">
  import type { Snippet } from 'svelte'
  import Badge from './Badge.svelte'

  export type ListRowKind = 'channel' | 'topic'

  let {
    kind = 'channel',
    name,
    prefix,
    selected = false,
    unreadCount = 0,
    mentioned = false,
    expanded,
    onclick,
    children,
  }: {
    kind?: ListRowKind
    name: string
    prefix?: string
    selected?: boolean
    unreadCount?: number
    mentioned?: boolean
    expanded?: boolean
    onclick?: () => void
    children?: Snippet
  } = $props()

  const marker = $derived(prefix ?? (kind === 'channel' ? '#' : '💬'))
</script>

<div class="ui-list-row-group" class:ui-list-row-group--topic={kind === 'topic'}>
  <button
    type="button"
    class="ui-list-row"
    class:ui-list-row--selected={selected}
    aria-current={selected ? 'true' : undefined}
    aria-expanded={expanded}
    {onclick}
  >
    <span class="ui-list-row__label">
      {marker} {name}
    </span>
    {#if mentioned || unreadCount > 0}
      <span class="ui-list-row__badges">
        {#if mentioned}
          <Badge kind="mention" />
        {/if}
        {#if unreadCount > 0}
          <Badge kind="unread" count={unreadCount} />
        {/if}
      </span>
    {/if}
  </button>
  {#if children && expanded}
    <div class="ui-list-row__children">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .ui-list-row-group {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .ui-list-row-group--topic {
    padding-left: var(--space-16);
  }

  .ui-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-8) var(--space-12);
    background-color: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-regular);
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out);
  }

  .ui-list-row:hover {
    background-color: var(--hover);
  }

  .ui-list-row--selected,
  .ui-list-row[aria-current='true'] {
    background-color: var(--tint);
    color: var(--on-tint);
    font-weight: var(--font-weight-semibold);
  }

  .ui-list-row__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ui-list-row__badges {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    flex-shrink: 0;
  }

  .ui-list-row__children {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }
</style>
