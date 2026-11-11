<script lang="ts">
  export type BadgeKind = 'unread' | 'mention'

  let {
    kind = 'unread',
    count,
    label,
  }: {
    kind?: BadgeKind
    count?: number
    label?: string
  } = $props()

  const text = $derived(
    label !== undefined
      ? label
      : kind === 'mention'
        ? count && count > 1
          ? `@${count}`
          : '@'
        : String(count ?? 0),
  )

  const accessibleLabel = $derived(
    kind === 'mention'
      ? count && count > 1
        ? `メンション ${count}件`
        : 'メンションあり'
      : `未読 ${count ?? 0}件`,
  )
</script>

<span class="ui-badge ui-badge--{kind}" aria-label={accessibleLabel}>
  {text}
</span>

<style>
  .ui-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 var(--space-8);
    border-radius: var(--radius-10);
    font-size: var(--font-size-12);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-base);
    transition: transform var(--duration-fast) var(--ease-out);
    flex-shrink: 0;
  }

  .ui-badge--unread {
    background-color: var(--primary);
    color: var(--on-primary);
  }

  .ui-badge--mention {
    background-color: var(--amber);
    color: var(--on-amber);
  }
</style>
