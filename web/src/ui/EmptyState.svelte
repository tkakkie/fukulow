<script lang="ts">
  import Button from './Button.svelte'

  let {
    title,
    description,
    actionLabel,
    onaction,
  }: {
    title: string
    description?: string
    actionLabel?: string
    onaction?: () => void
  } = $props()
</script>

<div class="ui-empty-state">
  <p class="ui-empty-state__title">{title}</p>
  {#if description}
    <p class="ui-empty-state__description">{description}</p>
  {/if}
  {#if actionLabel && onaction}
    <div class="ui-empty-state__action">
      <Button variant="secondary" onclick={onaction}>{actionLabel}</Button>
    </div>
  {/if}
</div>

<style>
  .ui-empty-state {
    display: grid;
    gap: var(--space-8);
    padding: var(--space-24) var(--space-16);
    background-color: var(--bg);
    border-radius: var(--radius-12);
    text-align: center;
    min-width: 0;
  }

  .ui-empty-state__title {
    margin: 0;
    font-size: var(--font-size-15);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .ui-empty-state__description {
    margin: 0;
    font-size: var(--font-size-13);
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .ui-empty-state__action {
    display: flex;
    justify-content: center;
    padding-top: var(--space-4);
  }
</style>
