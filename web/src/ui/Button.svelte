<script lang="ts">
  import type { Snippet } from 'svelte'

  export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'icon'

  let {
    variant = 'secondary',
    type = 'button',
    disabled = false,
    ariaLabel,
    ariaCurrent,
    ariaExpanded,
    ariaControls,
    ariaPressed,
    tabindex,
    testid,
    buttonRef = $bindable(null),
    onclick,
    onkeydown,
    children,
  }: {
    variant?: ButtonVariant
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    ariaLabel?: string
    ariaCurrent?: 'page' | 'step' | 'location' | 'date' | 'time' | 'true' | 'false'
    ariaExpanded?: boolean
    ariaControls?: string
    ariaPressed?: boolean
    tabindex?: number
    testid?: string
    buttonRef?: HTMLButtonElement | null
    onclick?: (e: MouseEvent) => void
    onkeydown?: (e: KeyboardEvent) => void
    children?: Snippet
  } = $props()
</script>

<button
  bind:this={buttonRef}
  class="ui-button ui-button--{variant}"
  {type}
  {disabled}
  aria-label={ariaLabel}
  aria-current={ariaCurrent}
  aria-expanded={ariaExpanded}
  aria-controls={ariaControls}
  aria-pressed={ariaPressed}
  {tabindex}
  data-testid={testid}
  {onclick}
  {onkeydown}
>
  {#if children}
    {@render children()}
  {/if}
</button>

<style>
  .ui-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-8);
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-12);
    border-radius: var(--radius-10);
    font-family: var(--font-sans);
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-base);
    cursor: pointer;
    border: 1px solid transparent;
    transition:
      background-color var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out);
    min-width: 0;
    max-width: 100%;
  }

  .ui-button--primary {
    background-color: var(--primary);
    color: var(--on-primary);
  }

  .ui-button--secondary {
    background-color: var(--surface);
    color: var(--text);
    border-color: var(--border-input);
  }

  .ui-button--secondary:hover:not(:disabled) {
    background-color: var(--hover);
  }

  .ui-button--quiet {
    background-color: transparent;
    color: var(--text2);
  }

  .ui-button--quiet:hover:not(:disabled) {
    background-color: var(--hover);
    color: var(--text);
  }

  .ui-button--icon {
    background-color: transparent;
    color: var(--text2);
    min-width: var(--touch-target);
    padding: var(--space-4);
  }

  .ui-button--icon:hover:not(:disabled) {
    background-color: var(--hover);
    color: var(--text);
  }

  .ui-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
