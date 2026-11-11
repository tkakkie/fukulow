<script lang="ts">
  let {
    label = '未読',
  }: {
    label?: string
  } = $props()
</script>

<div class="read-marker" data-read-marker="true">
  <span class="read-marker__line" aria-hidden="true"></span>
  <span class="read-marker__label">{label}</span>
  <span class="read-marker__line" aria-hidden="true"></span>
</div>

<style>
  .read-marker {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-4) var(--space-12);
    min-width: 0;
  }

  .read-marker__line {
    flex: 1;
    height: 1px;
    background: var(--primary);
  }

  .read-marker__label {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--space-8);
    border-radius: var(--radius-full);
    background: var(--primary);
    color: var(--on-primary);
    font-size: var(--font-size-12);
    line-height: var(--line-height-12);
    font-weight: var(--font-weight-semibold);
    white-space: nowrap;
  }
</style>
