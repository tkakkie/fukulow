<script lang="ts">
  import Button from './Button.svelte'

  export type StatusBannerTone = 'info' | 'danger'

  let {
    tone = 'info',
    role = null,
    message,
    detail,
    actionLabel,
    onaction,
  }: {
    tone?: StatusBannerTone
    /** Visual only by default (`docs/ui.md` §5, §6); set `'alert'` only for errors that need action. */
    role?: 'alert' | null
    message: string
    detail?: string
    actionLabel?: string
    onaction?: () => void
  } = $props()
</script>

<div class="ui-status-banner ui-status-banner--{tone}">
  <div class="ui-status-banner__text">
    <p class="ui-status-banner__message" role={role ?? undefined}>{message}</p>
    {#if detail}
      <p class="ui-status-banner__detail">{detail}</p>
    {/if}
  </div>
  {#if actionLabel && onaction}
    <div class="ui-status-banner__action">
      <Button variant="secondary" onclick={onaction}>{actionLabel}</Button>
    </div>
  {/if}
</div>

<style>
  .ui-status-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-12);
    padding: var(--space-8) var(--space-12);
    border-radius: var(--radius-10);
    min-width: 0;
  }

  .ui-status-banner--info {
    background-color: var(--info-bg);
    color: var(--on-info);
  }

  .ui-status-banner--danger {
    background-color: var(--danger-bg);
    color: var(--danger);
  }

  .ui-status-banner__text {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
    flex: 1 1 12rem;
  }

  .ui-status-banner__message {
    margin: 0;
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .ui-status-banner__detail {
    margin: 0;
    font-size: var(--font-size-13);
    overflow-wrap: anywhere;
  }

  .ui-status-banner__action {
    flex-shrink: 0;
  }
</style>
