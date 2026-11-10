<script lang="ts">
  import type { Snippet } from 'svelte'
  import { shouldCloseOnEscape } from '../composer-keys'
  import Button from './Button.svelte'

  let {
    open = false,
    title,
    description,
    confirmLabel,
    cancelLabel = 'キャンセル',
    onconfirm,
    oncancel,
    children,
  }: {
    open?: boolean
    title: string
    description?: string
    confirmLabel?: string
    cancelLabel?: string
    onconfirm?: () => void
    oncancel?: () => void
    children?: Snippet
  } = $props()

  function handleKeydown(e: KeyboardEvent) {
    if (open && shouldCloseOnEscape(e)) {
      e.preventDefault()
      oncancel?.()
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="ui-dialog-backdrop">
    <div
      class="ui-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header class="ui-dialog__header">
        <h2 class="ui-dialog__title">{title}</h2>
      </header>
      {#if description}
        <p class="ui-dialog__description">{description}</p>
      {/if}
      {#if children}
        <div class="ui-dialog__body">
          {@render children()}
        </div>
      {/if}
      {#if onconfirm || oncancel}
        <footer class="ui-dialog__actions">
          {#if oncancel}
            <Button variant="secondary" onclick={oncancel}>{cancelLabel}</Button>
          {/if}
          {#if onconfirm && confirmLabel}
            <Button variant="primary" onclick={onconfirm}>{confirmLabel}</Button>
          {/if}
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ui-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 900;
    display: grid;
    place-items: center;
    padding: var(--space-16);
  }

  .ui-dialog {
    display: grid;
    gap: var(--space-12);
    width: 100%;
    max-width: 24rem;
    min-width: 0;
    padding: var(--space-16) var(--space-24);
    background-color: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-16);
  }

  .ui-dialog__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-width: 0;
  }

  .ui-dialog__title {
    margin: 0;
    font-size: var(--font-size-17);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .ui-dialog__description {
    margin: 0;
    font-size: var(--font-size-14);
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .ui-dialog__body {
    min-width: 0;
  }

  .ui-dialog__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-8);
  }
</style>
