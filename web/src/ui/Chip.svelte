<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    selected = false,
    disabled = false,
    ariaLabel,
    onclick,
    children,
  }: {
    selected?: boolean
    disabled?: boolean
    ariaLabel?: string
    onclick?: (e: MouseEvent) => void
    children?: Snippet
  } = $props()
</script>

{#if onclick}
  <button
    type="button"
    class="ui-chip"
    class:ui-chip--selected={selected}
    {disabled}
    aria-label={ariaLabel}
    aria-pressed={selected}
    {onclick}
  >
    {#if children}{@render children()}{/if}
  </button>
{:else}
  <span class="ui-chip" class:ui-chip--selected={selected} aria-label={ariaLabel}>
    {#if children}{@render children()}{/if}
  </span>
{/if}

<style>
  .ui-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-8);
    background-color: var(--bg);
    color: var(--text2);
    border: 1px solid transparent;
    border-radius: var(--radius-10);
    font-family: var(--font-sans);
    font-size: var(--font-size-12);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-base);
    min-width: 0;
  }

  button.ui-chip {
    cursor: pointer;
    min-height: var(--touch-target);
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  button.ui-chip:hover:not(:disabled) {
    background-color: var(--hover);
    color: var(--text);
  }

  .ui-chip--selected {
    background-color: var(--tint);
    color: var(--on-tint);
  }
</style>
