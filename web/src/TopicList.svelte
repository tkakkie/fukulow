<script lang="ts">
  import type { TopicsAdapter } from './topics.svelte'
  import Button from './ui/Button.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'
  import TopicSummaryLine from './ui/TopicSummaryLine.svelte'

  let {
    topics,
    channelId,
    activeTopicId = null,
    unavailable = false,
    onselecttopic,
    onstartnewtopic,
  }: {
    topics: TopicsAdapter
    channelId: string
    activeTopicId?: string | null
    unavailable?: boolean
    onselecttopic: (topicId: string) => void
    onstartnewtopic?: () => void
  } = $props()

  const state = $derived(topics.state)
  const orderedTopics = $derived([...state.topics].reverse())
  let lastSummaryChannel = ''
  const requestedSummaries = new Set<string>()

  $effect(() => {
    if (channelId !== lastSummaryChannel) {
      lastSummaryChannel = channelId
      requestedSummaries.clear()
    }
    if (unavailable || state.unavailable) return
    if (state.list.asOfSeq === undefined && !state.list.loading && !state.list.error) {
      void topics.loadList()
    }
    for (const topic of state.topics) {
      if (topic.baseline === null && !requestedSummaries.has(topic.topicId)) {
        requestedSummaries.add(topic.topicId)
        void topics.loadSummary(topic.topicId)
      }
    }
  })
</script>

<div class="topic-list-panel">
  {#if unavailable || state.unavailable}
    <StatusBanner tone="danger" role="alert" message="このチャンネルは利用できません。" />
  {:else if state.list.loading && orderedTopics.length === 0}
    <Skeleton rows={3} label="トピックを読み込み中" />
  {:else if state.list.error && orderedTopics.length === 0}
    <StatusBanner
      tone="danger"
      role="alert"
      message="トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
      actionLabel="再試行"
      onaction={() => void topics.loadList()}
    />
  {:else if orderedTopics.length === 0}
    <EmptyState
      title="まだトピックがありません。"
      description="メッセージ入力欄でトピック名を指定して最初のメッセージを送信すると、トピックが作成されます。"
      actionLabel={onstartnewtopic ? '新しいトピックを作成' : undefined}
      onaction={onstartnewtopic}
    />
  {:else}
    {#if onstartnewtopic}
      <div class="topic-list-panel__actions">
        <Button variant="secondary" onclick={onstartnewtopic}>＋ 新しいトピック</Button>
      </div>
    {/if}

    <ul class="topic-list-panel__list" aria-label="トピック一覧">
      {#each orderedTopics as t (t.topicId)}
        <li
          class="topic-list-panel__item"
          class:topic-list-panel__item--active={activeTopicId === t.topicId}
        >
          <TopicSummaryLine
            name={t.baseline?.summary.name ?? 'トピック'}
            messageCount={t.messageCount ?? undefined}
            latestBody={t.latestMessage.body}
            onclick={() => onselecttopic(t.topicId)}
          />
        </li>
      {/each}
    </ul>

    {#if state.list.asOfSeq !== undefined && state.list.hasMore}
      <div class="topic-list-panel__older">
        <Button variant="secondary" disabled={state.list.loading} onclick={() => void topics.loadList()}>
          以前のトピックを読み込む
        </Button>
        {#if state.list.error}
          <StatusBanner
            tone="danger"
            role="alert"
            message="以前のトピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
            actionLabel="再試行"
            onaction={() => void topics.loadList()}
          />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .topic-list-panel {
    display: grid;
    gap: var(--space-12);
    min-width: 0;
  }

  .topic-list-panel__actions {
    display: flex;
    justify-content: flex-start;
    min-width: 0;
  }

  .topic-list-panel__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .topic-list-panel__item {
    min-width: 0;
  }

  .topic-list-panel__item--active {
    border-radius: var(--radius-10);
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  .topic-list-panel__older {
    display: grid;
    justify-items: start;
    gap: var(--space-8);
    min-width: 0;
  }
</style>
