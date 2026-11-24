<script lang="ts">
  import { tick, type Snippet } from 'svelte'
  import { isImeComposing, shouldCloseOnEscape } from '../composer-keys'
  import {
    focusDialogOnOpen,
    restoreFocusAfterDialogClose,
    stepDialogTab,
    type FocusableTarget,
  } from '../focus-management'
  import Button from './Button.svelte'

  const FOCUSABLE_SELECTOR =
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

  const NON_TEXT_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ])

  function isTextInputTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement) || target.tagName !== 'INPUT') return false
    const type = (target.getAttribute('type') ?? 'text').toLowerCase()
    return !NON_TEXT_INPUT_TYPES.has(type)
  }

  let {
    open = false,
    busy = false,
    form = false,
    title,
    description,
    confirmLabel,
    cancelLabel = 'キャンセル',
    returnFocusFallback = null,
    onconfirm,
    oncancel,
    children,
  }: {
    open?: boolean
    busy?: boolean
    form?: boolean
    title: string
    description?: string
    confirmLabel?: string
    cancelLabel?: string
    returnFocusFallback?: FocusableTarget | null
    onconfirm?: () => void
    oncancel?: () => void
    children?: Snippet
  } = $props()

  let dialogEl = $state<HTMLElement | null>(null)
  let wasOpen = false
  let openerEl: FocusableTarget | null = null

  function getFocusableControls(): HTMLElement[] {
    if (!dialogEl) return []
    return Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  }

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true
      const active = typeof document !== 'undefined' ? document.activeElement : null
      openerEl = active instanceof HTMLElement ? active : null
      void tick().then(() => {
        if (!open || !dialogEl) return
        focusDialogOnOpen(getFocusableControls(), dialogEl)
      })
    } else if (!open && wasOpen) {
      wasOpen = false
      const opener = openerEl
      openerEl = null
      void tick().then(() => {
        const active = typeof document !== 'undefined' ? document.activeElement : null
        const focusResetToBody = !active || active === document.body
        if (focusResetToBody || (opener && 'isConnected' in opener && opener.isConnected === false)) {
          restoreFocusAfterDialogClose(opener, returnFocusFallback)
        }
      })
    }
  })

  function handleDialogKeydown(e: KeyboardEvent) {
    if (!open) return
    if (shouldCloseOnEscape(e)) {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) oncancel?.()
      return
    }
    if (e.key === 'Tab' && !isImeComposing(e) && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      const active = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      stepDialogTab(getFocusableControls(), active, e.shiftKey, dialogEl)
      return
    }
    if (form && e.key === 'Enter') {
      if (isImeComposing(e)) {
        e.preventDefault()
        return
      }
      if ((e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) && isTextInputTarget(e.target)) {
        e.preventDefault()
      }
    }
  }

  function handleFormSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (!open || busy) return
    onconfirm?.()
  }
</script>

{#snippet dialogContent()}
  {#if children}
    <div class="ui-dialog__body">
      {@render children()}
    </div>
  {/if}
  {#if onconfirm || oncancel}
    <footer class="ui-dialog__actions">
      {#if oncancel}
        <Button variant="secondary" disabled={busy} onclick={oncancel}>{cancelLabel}</Button>
      {/if}
      {#if onconfirm && confirmLabel}
        {#if form}
          <Button variant="primary" type="submit" disabled={busy}>{confirmLabel}</Button>
        {:else}
          <Button variant="primary" disabled={busy} onclick={onconfirm}>{confirmLabel}</Button>
        {/if}
      {/if}
    </footer>
  {/if}
{/snippet}

{#if open}
  <div class="ui-dialog-backdrop">
    <div
      bind:this={dialogEl}
      class="ui-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      onkeydown={handleDialogKeydown}
    >
      <header class="ui-dialog__header">
        <h2 class="ui-dialog__title">{title}</h2>
      </header>
      {#if description}
        <p class="ui-dialog__description">{description}</p>
      {/if}
      {#if form}
        <form class="ui-dialog__form" onsubmit={handleFormSubmit}>
          {@render dialogContent()}
        </form>
      {:else}
        {@render dialogContent()}
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
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    width: 100%;
    max-width: 24rem;
    max-height: calc(100vh - 2 * var(--space-16));
    max-height: calc(100dvh - 2 * var(--space-16));
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
    flex-shrink: 0;
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
    flex-shrink: 0;
    font-size: var(--font-size-14);
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .ui-dialog__form {
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .ui-dialog__body {
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: var(--space-4);
    margin: calc(-1 * var(--space-4));
  }

  .ui-dialog__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-8);
    flex-shrink: 0;
  }
</style>
