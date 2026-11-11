<script lang="ts">
  let {
    rows = 3,
    label = '読み込み中',
  }: {
    rows?: number
    label?: string
  } = $props()

  const indices = $derived(Array.from({ length: rows }, (_, i) => i))
</script>

<div class="ui-skeleton" aria-busy="true" aria-label={label}>
  {#each indices as idx (idx)}
    <div class="ui-skeleton__row" class:ui-skeleton__row--short={idx % 2 === 1}></div>
  {/each}
</div>

<style>
  .ui-skeleton {
    display: grid;
    gap: var(--space-8);
    padding: var(--space-12) 0;
    min-width: 0;
  }

  .ui-skeleton__row {
    height: var(--space-24);
    width: 100%;
    background-color: var(--hover);
    border-radius: var(--radius-8);
  }

  .ui-skeleton__row--short {
    width: 72%;
  }
</style>
