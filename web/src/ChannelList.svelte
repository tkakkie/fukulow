<script lang="ts">
  import type { Channel } from './channels.svelte'
  import type { TopicLine } from './topic-selectors'
  import Button from './ui/Button.svelte'
  import ListRow from './ui/ListRow.svelte'

  /** Maximum number of recent Topics shown under the open Channel (`docs/ui.md` §3). */
  const RECENT_TOPICS_MAX = 5

  let {
    channels,
    selectedId,
    activeTopicId = null,
    topics = [],
    allTopicsKnown = false,
    channelUnreadCount,
    topicUnreadCounts = {},
    onselect,
    onselecttopic,
    onopenalltopics,
  }: {
    channels: Channel[]
    selectedId: string | null
    activeTopicId?: string | null
    topics?: readonly TopicLine[]
    allTopicsKnown?: boolean
    channelUnreadCount?: (channelId: string) => number | null
    topicUnreadCounts?: Readonly<Record<string, { readonly unreadCount: number | null }>>
    onselect: (id: string) => void
    onselecttopic?: (topicId: string) => void
    onopenalltopics?: (opener: HTMLElement | null) => void
  } = $props()

  const recentTopics = $derived([...topics].reverse().slice(0, RECENT_TOPICS_MAX))
  const allTopicsLabel = $derived(
    allTopicsKnown ? `すべてのトピック(${topics.length})›` : 'すべてのトピック›',
  )
  let allTopicsBtn = $state<HTMLButtonElement | null>(null)
</script>

<ul class="channel-list">
  {#each channels as c (c.id)}
    {@const isExpanded = c.id === selectedId && recentTopics.length > 0}
    {@const channelUnread = channelUnreadCount?.(c.id) ?? null}
    <li class="channel-list__item">
      <ListRow
        kind="channel"
        prefix={c.visibility === 'private' ? '🔒' : '#'}
        name={c.name}
        selected={c.id === selectedId && !activeTopicId}
        unreadCount={channelUnread !== null && channelUnread > 0 ? channelUnread : 0}
        expanded={isExpanded ? true : undefined}
        onclick={() => onselect(c.id)}
      >
        {#snippet children()}
          {#each recentTopics as t (t.topicId)}
            {@const topicUnread = topicUnreadCounts[t.topicId]?.unreadCount ?? null}
            <ListRow
              kind="topic"
              name={t.baseline?.summary.name ?? 'トピック'}
              selected={activeTopicId === t.topicId}
              unreadCount={topicUnread !== null && topicUnread > 0 ? topicUnread : 0}
              onclick={() => onselecttopic?.(t.topicId)}
            />
          {/each}
          {#if onopenalltopics}
            <div class="channel-list__all-topics">
              <Button
                bind:buttonRef={allTopicsBtn}
                variant="quiet"
                onclick={() => onopenalltopics(allTopicsBtn)}
              >
                {allTopicsLabel}
              </Button>
            </div>
          {/if}
        {/snippet}
      </ListRow>
    </li>
  {/each}
</ul>

<style>
  .channel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .channel-list__item {
    min-width: 0;
  }

  .channel-list__all-topics {
    padding-left: var(--space-16);
    min-width: 0;
  }
</style>
