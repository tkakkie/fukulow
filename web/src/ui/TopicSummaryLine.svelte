<script lang="ts">
  import Badge from './Badge.svelte'

  let {
    name,
    topicId,
    messageCount,
    latestBody,
    unreadCount = 0,
    onclick,
  }: {
    name: string
    topicId?: string
    messageCount?: number
    latestBody?: string
    unreadCount?: number
    onclick?: () => void
  } = $props()
</script>

<button type="button" data-topic-id={topicId} class="ui-topic-summary" {onclick}>
  <span class="ui-topic-summary__header">
    <span class="ui-topic-summary__title">トピック: {name}</span>
    {#if messageCount !== undefined}
      <span class="ui-topic-summary__count">{messageCount}件›</span>
    {/if}
    {#if unreadCount > 0}
      <Badge kind="unread" count={unreadCount} />
    {/if}
  </span>
  {#if latestBody}
    <span class="ui-topic-summary__preview">{latestBody}</span>
  {/if}
</button>

<style>
  .ui-topic-summary {
    display: grid;
    gap: var(--space-4);
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-8) var(--space-12);
    background-color: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-10);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  .ui-topic-summary:hover {
    background-color: var(--hover);
  }

  .ui-topic-summary__header {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .ui-topic-summary__title {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ui-topic-summary__count {
    font-size: var(--font-size-12);
    color: var(--text2);
    flex-shrink: 0;
  }

  .ui-topic-summary__preview {
    font-size: var(--font-size-13);
    color: var(--text2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
