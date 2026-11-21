<script lang="ts">
  import type { Channel, DmDiscovery, Member, Message } from './api'
  import DmSendStatus from './DmSendStatus.svelte'
  import type { MentionName } from './mentions'
  import type { RepliesAdapter } from './replies.svelte'
  import type { SearchState, SearchTarget } from './search'
  import type { SearchPresentation } from './search-anchor.svelte'
  import SearchBar from './SearchBar.svelte'
  import SearchResults from './SearchResults.svelte'
  import type { ChannelSync } from './sync.svelte'
  import Timeline from './Timeline.svelte'
  import type { TopicsAdapter } from './topics.svelte'
  import TopicView from './TopicView.svelte'
  import type { UnreadAdapter } from './unread.svelte'
  import Button from './ui/Button.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    searchState,
    searchOpen = false,
    searchDisabled = false,
    selected,
    conversationName = '',
    currentChannel = null,
    currentLive = false,
    currentTimelineUnavailable = false,
    currentTopics = null,
    currentReplies = null,
    currentUnread = null,
    activeTopicId = null,
    resolvedTopicName = '',
    topicStatus = 'idle',
    search,
    organizationName,
    selfId = '',
    canRenewDm = false,
    dmLapsed = false,
    dmBusy = false,
    selectedArchived = false,
    archiveStatePending = false,
    sendDisabled = false,
    organizationUnavailable = false,
    reconnecting = false,
    channelListStatus,
    panelOpen = false,
    mainViewSelected = true,
    members = [],
    resolveSenderName,
    resolveMentionName,
    searchInputRef = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    searchResultsHeadingRef = $bindable<HTMLElement | null>(null),
    mainHeadingRef = $bindable<HTMLElement | null>(null),
    panelToggleBtn = $bindable<HTMLButtonElement | null>(null),
    composerRef = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    topicInputRef = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    onsearchinput,
    onsearchsubmit,
    onclosesearch,
    onopensearchresult,
    onloadmoresearch,
    onretrysearch,
    onbacktochannels,
    onbacktochannel,
    ontogglepanel,
    onrenewdm,
    onmentionrequest,
    onopentopic,
    onopenreplies,
    onretrytopicmeta,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
  }: {
    searchState?: SearchState
    searchOpen?: boolean
    searchDisabled?: boolean
    selected?: Channel | DmDiscovery
    conversationName?: string
    currentChannel?: ChannelSync | null
    currentLive?: boolean
    currentTimelineUnavailable?: boolean
    currentTopics?: TopicsAdapter | null
    currentReplies?: RepliesAdapter | null
    currentUnread?: UnreadAdapter | null
    activeTopicId?: string | null
    resolvedTopicName?: string
    topicStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    search?: SearchPresentation
    organizationName?: string
    selfId?: string
    canRenewDm?: boolean
    dmLapsed?: boolean
    dmBusy?: boolean
    selectedArchived?: boolean
    archiveStatePending?: boolean
    sendDisabled?: boolean
    organizationUnavailable?: boolean
    reconnecting?: boolean
    channelListStatus: 'loading' | 'ready' | 'error'
    panelOpen?: boolean
    mainViewSelected?: boolean
    members?: readonly Member[]
    resolveSenderName?: (senderId: string) => string
    resolveMentionName?: MentionName
    searchInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    searchResultsHeadingRef?: HTMLElement | null
    mainHeadingRef?: HTMLElement | null
    panelToggleBtn?: HTMLButtonElement | null
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    topicInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    onsearchinput?: (value: string) => void
    onsearchsubmit?: (value: string) => void
    onclosesearch?: () => void
    onopensearchresult?: (target: SearchTarget) => void
    onloadmoresearch?: () => void
    onretrysearch?: () => void
    onbacktochannels?: () => void
    onbacktochannel?: () => void
    ontogglepanel?: () => void
    onrenewdm?: () => void
    onmentionrequest?: () => void
    onopentopic?: (topicId: string) => void
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    onretrytopicmeta?: () => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()
</script>

<header class="main-card__header">
  {#if searchState && onsearchinput && onsearchsubmit}
    <div class="main-card__search">
      <SearchBar
        value={searchState.input}
        open={searchOpen}
        disabled={searchDisabled}
        bind:inputRef={searchInputRef}
        oninput={onsearchinput}
        onsubmit={onsearchsubmit}
      />
    </div>
  {/if}
  <div class="main-card__header-row">
    <div class="main-card__title-group">
      {#if searchOpen && searchState}
        <Button variant="quiet" onclick={onclosesearch}>
          <span aria-hidden="true">‹</span>
          <span>戻る</span>
        </Button>
        <h1
          class="main-card__title"
          tabindex="-1"
          bind:this={searchResultsHeadingRef}
        >
          検索結果
        </h1>
      {:else}
        <span class="mobile-only">
          <Button
            variant="icon"
            ariaLabel="チャンネル一覧へ戻る"
            onclick={onbacktochannels}
          >
            ‹
          </Button>
        </span>
        {#if selected && currentChannel}
          {#if activeTopicId}
            <Button
              variant="quiet"
              onclick={onbacktochannel}
            >
              <span aria-hidden="true">‹</span>
              <span>チャンネルへ戻る</span>
            </Button>
            <span class="main-card__crumb"># {conversationName} ›</span>
          {/if}
          <h1 class="main-card__title" tabindex="-1" bind:this={mainHeadingRef}>
            {activeTopicId ? (resolvedTopicName || 'トピック') : conversationName}
          </h1>
        {:else if organizationUnavailable}
          <h1 class="main-card__title">{organizationName ?? 'fukulow'}</h1>
        {:else if channelListStatus === 'ready'}
          <h1 class="main-card__title">チャンネル</h1>
        {:else}
          <h1 class="main-card__title">fukulow</h1>
        {/if}
      {/if}
    </div>
    <div class="main-card__header-actions">
      {#if !searchOpen && selected && currentChannel}
        <small class="live-status" data-testid="live-status" data-live={currentLive}>
          {currentLive ? 'リアルタイム接続済み' : 'リアルタイムに接続中…'}
        </small>
        {#if selected.kind !== 'dm' || panelOpen}
          <Button
            bind:buttonRef={panelToggleBtn}
            variant="icon"
            ariaLabel={panelOpen ? 'パネルを閉じる(⌘.)' : 'パネルを開く(⌘.)'}
            ariaExpanded={panelOpen}
            onclick={ontogglepanel}
          >
            ☰
          </Button>
        {/if}
      {/if}
    </div>
  </div>
</header>

{#if searchOpen && searchState && onopensearchresult && onloadmoresearch && onretrysearch}
  <div class="main-card__body">
    <SearchResults
      state={searchState}
      onopenresult={onopensearchresult}
      onloadmore={onloadmoresearch}
      onretry={onretrysearch}
    />
  </div>
{:else if selected && currentChannel}
  <div class="main-card__body">
    {#if selected.kind === 'dm'}
      <div class="main-card__notice">
        <DmSendStatus
          peer={selected.peer}
          lapsed={dmLapsed}
          canRenew={canRenewDm}
          busy={dmBusy}
          onrenew={() => onrenewdm?.()}
        />
      </div>
    {:else if (selectedArchived || archiveStatePending) && !organizationUnavailable && !currentTimelineUnavailable}
      <div class="main-card__notice">
        <StatusBanner message={selectedArchived
          ? 'このチャンネルはアーカイブされています。メッセージを送信できませんが、履歴は引き続き閲覧できます。'
          : 'チャンネルの状態を確認しています。確認が終わるまでメッセージを送信できません。'} />
      </div>
    {/if}
    <div class="main-card__timeline">
      {#if activeTopicId && currentTopics}
        {#key `${selected.id}:${activeTopicId}`}
          <TopicView
            channel={currentChannel}
            topics={currentTopics}
            replies={currentReplies}
            unread={currentUnread}
            channelId={selected.id}
            topicId={activeTopicId}
            topicName={resolvedTopicName}
            {topicStatus}
            {search}
            {selfId}
            viewSelected={mainViewSelected}
            {organizationUnavailable}
            {sendDisabled}
            {reconnecting}
            {resolveSenderName}
            {resolveMentionName}
            {members}
            {onmentionrequest}
            bind:composerRef={composerRef}
            {onopenreplies}
            {onretrytopicmeta}
            {ongoToChannelList}
            {onrecheckmembership}
            {onswitchorganization}
          />
        {/key}
      {:else}
        {#key selected.id}
          <Timeline
            channel={currentChannel}
            topics={currentTopics}
            replies={currentReplies}
            unread={currentUnread}
            channelId={selected.id}
            {sendDisabled}
            {search}
            {selfId}
            viewSelected={mainViewSelected}
            {organizationUnavailable}
            {reconnecting}
            {resolveSenderName}
            {resolveMentionName}
            {members}
            {onmentionrequest}
            bind:composerRef={composerRef}
            bind:topicInputRef={topicInputRef}
            {onopentopic}
            {onopenreplies}
            {ongoToChannelList}
            {onrecheckmembership}
            {onswitchorganization}
          />
        {/key}
      {/if}
    </div>
  </div>
{:else if organizationUnavailable}
  <div class="main-card__empty">
    <StatusBanner
      tone="danger"
      role="alert"
      message="この組織は利用できません。"
      detail="この組織へのアクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。"
      actionLabel={onrecheckmembership ? 'メンバー資格を再確認' : undefined}
      onaction={onrecheckmembership}
      secondaryActionLabel={onswitchorganization ? '組織を切り替える' : undefined}
      onsecondaryaction={onswitchorganization}
    />
  </div>
{:else if channelListStatus === 'ready'}
  <div class="main-card__empty">
    <EmptyState
      title="チャンネルがありません。"
      description="チャンネル一覧から作成してください。"
      actionLabel="チャンネル一覧へ"
      onaction={ongoToChannelList}
    />
  </div>
{:else}
  <div class="main-card__empty">
    <Skeleton rows={4} label="読み込み中" />
  </div>
{/if}

<style>
  .main-card__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-12) var(--space-16);
    min-width: 0;
  }

  /* Before the title row in DOM, Tab and visual order; shares its line when wide so the timeline keeps its height. */
  .main-card__search {
    display: flex;
    flex: 1 1 240px;
    max-width: 360px;
    min-width: 0;
  }

  @media (max-width: 599px) {
    .main-card__search {
      max-width: none;
    }
  }

  .main-card__header-row {
    display: flex;
    flex: 999 1 auto;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-width: 0;
  }

  .main-card__title-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .main-card__crumb {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main-card__title {
    margin: 0;
    font-size: var(--font-size-17);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main-card__header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    flex-shrink: 0;
    min-width: 0;
  }

  .live-status {
    font-size: var(--font-size-12);
    color: var(--muted);
  }

  .main-card__body {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .main-card__notice {
    flex-shrink: 0;
    padding: 0 var(--space-16) var(--space-8);
    min-width: 0;
  }

  .main-card__timeline {
    flex: 1 1 0;
    min-height: 0;
    min-width: 0;
  }

  .main-card__empty {
    padding: var(--space-16);
    min-width: 0;
  }

  .mobile-only {
    display: none;
  }

  @media (max-width: 599px) {
    .mobile-only {
      display: inline-flex;
    }
  }
</style>
