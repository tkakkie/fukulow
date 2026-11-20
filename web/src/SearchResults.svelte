<script lang="ts">
  import type { SearchState, SearchTarget } from './search'
  import type { SearchResultItem } from './search-source'
  import Button from './ui/Button.svelte'
  import Chip from './ui/Chip.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    state,
    onopenresult,
    onloadmore,
    onretry,
  }: {
    state: SearchState
    onopenresult: (target: SearchTarget) => void
    onloadmore: () => void
    onretry: () => void
  } = $props()

  function formatTimestamp(iso: string): string {
    const parsed = new Date(iso)
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString('ja-JP')
  }

  function formatRangeStart(iso: string): string {
    const parsed = new Date(iso)
    return Number.isNaN(parsed.getTime())
      ? iso
      : parsed.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' })
  }

  function formatContext(item: SearchResultItem): string {
    if (item.context.kind === 'dm') {
      const peer = `${item.context.peerName}${item.context.peerActive ? '' : '（無効）'}`
      return `ダイレクトメッセージ: ${peer}`
    }
    const base = `# ${item.context.channelName}`
    return item.context.topicName ? `${base} › ${item.context.topicName}` : base
  }

  function formatAuthor(item: SearchResultItem): string {
    if (!item.authorName) return 'メンバー'
    return item.authorActive ? item.authorName : `${item.authorName}（無効）`
  }

  function handleOpen(item: SearchResultItem) {
    onopenresult({
      channelId: item.channelId,
      topicId: item.topicId,
      replyRootId: item.replyRootId,
      messageId: item.messageId,
    })
  }

  const rangeNote = $derived(
    state.rangeStart
      ? `直近${state.rangeDays}日間（${formatRangeStart(state.rangeStart)} 以降）のメッセージのみ検索対象です。これより前のメッセージは検索されません。`
      : `直近${state.rangeDays}日間のメッセージのみ検索対象です。これより前のメッセージは検索されません。`,
  )
</script>

<section class="search-results" aria-label="検索結果">
  {#if state.status !== 'unavailable'}
    <p class="search-results__range" data-testid="search-range-note">{rangeNote}</p>
  {/if}

  {#if state.openNotice}
    <div data-testid="search-open-notice">
      <StatusBanner tone="info" message={state.openNotice} />
    </div>
  {/if}

  {#if state.status === 'loading'}
    <Skeleton rows={4} label="検索結果を読み込み中" />
  {:else if state.status === 'unavailable'}
    <EmptyState
      title="メッセージ検索は現在準備中です。"
      description="検索機能が利用できるようになり次第、お使いいただけます。"
    />
  {:else if state.status === 'too-short'}
    <StatusBanner
      tone="danger"
      role="alert"
      message="検索キーワードが短すぎます。"
      detail={state.minLength
        ? `${state.minLength}文字以上で入力してください。`
        : 'もう少し長いキーワードを入力してください。'}
    />
  {:else if state.status === 'timeout'}
    <StatusBanner
      tone="danger"
      role="alert"
      message="検索がタイムアウトしました。"
      detail="キーワードを絞り込むか、もう一度お試しください。"
      actionLabel="再試行"
      onaction={onretry}
    />
  {:else if state.status === 'error'}
    <StatusBanner
      tone="danger"
      role="alert"
      message="検索に失敗しました。"
      detail="通信状況を確認して、もう一度お試しください。"
      actionLabel={state.retryable ? '再試行' : undefined}
      onaction={state.retryable ? onretry : undefined}
    />
  {:else if state.status === 'empty'}
    <EmptyState
      title="一致するメッセージが見つかりませんでした。"
      description="別のキーワードでお試しください。"
    />
  {:else if state.items.length > 0}
    <ol class="search-results__list" aria-label="検索結果一覧">
      {#each state.items as item (item.messageId)}
        <li class="search-results__item">
          <article class="search-result">
            <button
              type="button"
              class="search-result__button"
              onclick={() => handleOpen(item)}
            >
              <span class="search-result__context-row">
                <span class="search-result__context">{formatContext(item)}</span>
                {#if item.replyRootId}
                  <Chip>返信のつながり</Chip>
                {/if}
              </span>
              <span class="search-result__meta">
                <span class="search-result__author">{formatAuthor(item)}</span>
                <time class="search-result__time" datetime={item.createdAt}>
                  {formatTimestamp(item.createdAt)}
                </time>
              </span>
              <span class="search-result__excerpt">{item.excerpt}</span>
            </button>
          </article>
        </li>
      {/each}
    </ol>

    {#if state.loadMoreError === 'timeout'}
      <StatusBanner
        tone="danger"
        role="alert"
        message="追加の検索結果の読み込みがタイムアウトしました。"
        detail="もう一度お試しください。"
        actionLabel="再試行"
        onaction={onloadmore}
      />
    {:else if state.loadMoreError === 'error'}
      <StatusBanner
        tone="danger"
        role="alert"
        message="追加の検索結果を読み込めませんでした。"
        detail="通信状況を確認して、もう一度お試しください。"
        actionLabel={state.retryable ? '再試行' : undefined}
        onaction={state.retryable ? onloadmore : undefined}
      />
    {/if}

    {#if state.status === 'loading-more'}
      <Skeleton rows={2} label="さらに検索結果を読み込み中" />
    {/if}

    {#if state.nextCursor !== null}
      <div class="search-results__more">
        <Button
          variant="secondary"
          disabled={state.status === 'loading-more'}
          onclick={onloadmore}
        >
          さらに読み込む
        </Button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .search-results {
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    padding: var(--space-12) var(--space-16) var(--space-24);
  }

  .search-results__range {
    margin: 0;
    padding: var(--space-8) var(--space-12);
    border-radius: var(--radius-10);
    background-color: var(--info-bg);
    color: var(--on-info);
    font-size: var(--font-size-13);
    overflow-wrap: anywhere;
  }

  .search-results__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .search-results__item {
    min-width: 0;
  }

  .search-result {
    min-width: 0;
  }

  .search-result__button {
    display: grid;
    gap: var(--space-4);
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-12);
    border: 1px solid var(--border);
    border-radius: var(--radius-12);
    background-color: var(--bg);
    color: var(--text);
    text-align: left;
    font-family: var(--font-sans);
    font-size: var(--font-size-15);
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  .search-result__button:hover {
    background-color: var(--hover);
  }

  .search-result__context-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .search-result__context {
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-semibold);
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .search-result__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-8);
    min-width: 0;
  }

  .search-result__author {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
  }

  .search-result__time {
    font-size: var(--font-size-12);
    color: var(--muted);
  }

  .search-result__excerpt {
    font-size: var(--font-size-15);
    line-height: var(--line-height-message);
    color: var(--text);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .search-results__more {
    display: flex;
    justify-content: center;
    padding-top: var(--space-8);
  }
</style>
