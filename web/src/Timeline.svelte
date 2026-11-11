<script lang="ts">
  import { tick } from 'svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import Composer from './Composer.svelte'
  import {
    confirmReplaceDraftWithFailedSend,
    decideEditAndResend,
    discardAndFocusComposer,
    focusTarget,
  } from './focus-management'
  import type { ChannelSync } from './sync.svelte'
  import {
    computeAnchoredScrollTop,
    createTimelineScrollController,
    type ItemRect,
    type ScrollAnchor,
  } from './timeline-scroll'
  import { linePosition, type MainTimelineLine } from './topic-selectors'
  import type { TopicsAdapter } from './topics.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'
  import TopicSummaryLine from './ui/TopicSummaryLine.svelte'

  // The session owns the sync controller and outlives this component; this only displays its state.
  let {
    channel,
    topics = null,
    channelId = '',
    selfId = '',
    organizationUnavailable = false,
    reconnecting = false,
    composerRef = $bindable(null),
    topicInputRef = $bindable(null),
    onopentopic,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
  }: {
    channel: ChannelSync
    topics?: TopicsAdapter | null
    channelId?: string
    selfId?: string
    organizationUnavailable?: boolean
    reconnecting?: boolean
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    topicInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    onopentopic?: (topicId: string) => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()

  const s = $derived(channel.timeline)
  const tState = $derived(topics ? topics.state : null)
  const targetUnavailable = $derived(
    s.status === 'unavailable' || Boolean(tState?.unavailable) || organizationUnavailable,
  )
  const lines = $derived<MainTimelineLine[]>(
    tState ? tState.lines : s.messages.map((message) => ({ kind: 'message', message })),
  )
  const mainPending = $derived(s.pending.filter((p) => !p.replyTo && !p.topicId))
  const effectiveStatus = $derived<'loading' | 'ready' | 'unavailable' | 'error'>(
    targetUnavailable
      ? 'unavailable'
      : s.status === 'error' || Boolean(tState && s.status === 'ready' && tState.main.asOfSeq === undefined && tState.main.error)
        ? 'error'
        : s.status === 'loading' || Boolean(tState && s.status === 'ready' && tState.main.asOfSeq === undefined && tState.main.loading)
          ? 'loading'
          : 'ready',
  )
  const hasOlder = $derived(tState ? tState.main.asOfSeq !== undefined && tState.main.hasMore : s.hasOlder)
  const loadingOlder = $derived(tState ? tState.main.asOfSeq !== undefined && tState.main.loading : s.loadingOlder)
  const olderError = $derived(tState ? tState.main.asOfSeq !== undefined && tState.main.error : s.olderError)

  const scrollController = createTimelineScrollController()
  const subscribeScroll = createSubscriber((update) => scrollController.subscribe(update))
  const scrollView = $derived.by(() => {
    subscribeScroll()
    return scrollController.get()
  })

  let scrollEl = $state<HTMLElement | null>(null)
  let confirmReplaceId = $state<string | null>(null)

  function measureItems(container: HTMLElement): ItemRect[] {
    const cRect = container.getBoundingClientRect()
    const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]')
    const items: ItemRect[] = []
    for (const node of nodes) {
      const id = node.getAttribute('data-message-id')
      if (!id) continue
      const r = node.getBoundingClientRect()
      items.push({ id, top: r.top - cRect.top, bottom: r.bottom - cRect.top })
    }
    return items
  }

  function captureCurrentAnchor() {
    if (!scrollEl) return
    scrollController.captureAnchor(measureItems(scrollEl))
  }

  function handleScroll() {
    if (!scrollEl) return
    scrollController.onScroll(
      {
        scrollTop: scrollEl.scrollTop,
        scrollHeight: scrollEl.scrollHeight,
        clientHeight: scrollEl.clientHeight,
      },
      measureItems(scrollEl),
    )
  }

  function applyScrollAction(action: 'none' | 'scroll_bottom' | 'preserve_anchor', anchor: ScrollAnchor | null) {
    if (!scrollEl || action === 'none') return
    if (action === 'scroll_bottom') {
      scrollEl.scrollTop = scrollEl.scrollHeight
      captureCurrentAnchor()
      return
    }
    if (action === 'preserve_anchor' && anchor) {
      const el = scrollEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.messageId)}"]`)
      if (el) {
        const cRect = scrollEl.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        scrollEl.scrollTop = computeAnchoredScrollTop(scrollEl.scrollTop, anchor, r.top - cRect.top, 0)
      }
      captureCurrentAnchor()
    }
  }

  function jumpToBottom() {
    const action = scrollController.jumpToBottom()
    applyScrollAction(action, null)
  }

  function loadOlderWithAnchor() {
    captureCurrentAnchor()
    if (topics) void topics.loadMain()
    else void channel.loadOlder()
  }

  function retryInitialLoad() {
    scrollController.resetLoadingTimeout()
    if (topics && s.status === 'ready') void topics.loadMain()
    else void channel.loadLatest()
  }

  let lastSummaryChannel = ''
  const requestedSummaries = new Set<string>()
  let requestedMainFor = ''

  $effect(() => () => scrollController.destroy())

  $effect(() => {
    if (channelId !== lastSummaryChannel) {
      lastSummaryChannel = channelId
      requestedSummaries.clear()
      requestedMainFor = ''
    }
    if (!topics || !tState || targetUnavailable || s.status !== 'ready') return
    if (
      tState.main.asOfSeq === undefined &&
      !tState.main.loading &&
      !tState.main.error &&
      requestedMainFor !== channelId
    ) {
      requestedMainFor = channelId
      void topics.loadMain()
    }
    for (const topic of tState.topics) {
      if (topic.baseline === null && !requestedSummaries.has(topic.topicId)) {
        requestedSummaries.add(topic.topicId)
        void topics.loadSummary(topic.topicId)
      }
    }
  })

  // Keep scroll state, anchor preservation and 10 s loading timeout synchronized with timeline changes (docs/ui.md §5, §8)
  $effect(() => {
    const syncMessages = lines.map((line) =>
      line.kind === 'message'
        ? { id: line.message.id, seq: line.message.seq, sender: line.message.sender }
        : {
            id: `topic:${line.topicId}:${line.position}`,
            seq: linePosition(line),
            sender: line.latestMessage.sender,
          },
    )
    const pendingIds = mainPending.map((p) => p.clientMessageId)
    const status = effectiveStatus
    const { action, anchor } = scrollController.sync({
      channelId,
      status,
      messages: syncMessages,
      pendingIds,
      selfId,
    })
    if (action !== 'none') {
      void tick().then(() => {
        applyScrollAction(action, anchor)
      })
    } else {
      void tick().then(() => {
        captureCurrentAnchor()
      })
    }
  })

  function handleDiscard(clientMessageId: string) {
    discardAndFocusComposer(clientMessageId, (id) => channel.discard(id), composerRef)
  }

  function handleRestoreRequest(clientMessageId: string) {
    const decision = decideEditAndResend(clientMessageId, s.draft)
    if (decision.action === 'restore_now') {
      if (channel.restore(clientMessageId)) {
        focusTarget(composerRef)
      }
    } else {
      confirmReplaceId = decision.clientMessageId
    }
  }

  function handleConfirmReplace() {
    const id = confirmReplaceId
    confirmReplaceId = null
    if (!id) return
    const target = mainPending.find((p) => p.clientMessageId === id && p.status === 'failed')
    const canRestore = !targetUnavailable && Boolean(target)
    if (canRestore && target?.topicName) channel.setTopicDraft('')
    confirmReplaceDraftWithFailedSend(
      id,
      s.draft,
      canRestore,
      (draft) => channel.setDraft(draft),
      (targetId) => channel.restore(targetId),
      composerRef,
    )
  }

  function handleCancelReplace() {
    confirmReplaceId = null
  }

  async function handleSubmit(): Promise<boolean> {
    const ok = await channel.submit()
    if (!ok) return false
    const action = scrollController.onUserSubmit()
    void tick().then(() => {
      applyScrollAction(action, null)
    })
    return true
  }
</script>

<section class="timeline-section" aria-label="タイムライン">
  {#if reconnecting && !organizationUnavailable && effectiveStatus === 'ready'}
    <div class="timeline-section__banner">
      <StatusBanner tone="info" role={null} message="再接続しています…" />
    </div>
  {/if}

  {#if organizationUnavailable}
    <div class="timeline-section__banner">
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
  {:else if s.status === 'unavailable'}
    <div class="timeline-section__banner">
      <StatusBanner
        tone="danger"
        role="alert"
        message="このチャンネルは利用できません。"
        detail="アクセス権がないか、削除された可能性があります。"
        actionLabel={ongoToChannelList ? 'チャンネル一覧へ' : undefined}
        onaction={ongoToChannelList}
      />
    </div>
  {:else if effectiveStatus === 'error' || (effectiveStatus === 'loading' && scrollView.loadingTimedOut)}
    <div class="timeline-section__banner">
      <StatusBanner
        tone="danger"
        role="alert"
        message="メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
        actionLabel="再試行"
        onaction={retryInitialLoad}
      />
    </div>
  {/if}

  <div class="timeline-scroll" bind:this={scrollEl} onscroll={handleScroll}>
    {#if !organizationUnavailable && effectiveStatus === 'loading' && !scrollView.loadingTimedOut && lines.length === 0 && mainPending.length === 0}
      <Skeleton rows={4} label="メッセージを読み込み中" />
    {/if}

    {#if hasOlder && !targetUnavailable}
      <div class="timeline-older">
        <Button variant="secondary" disabled={loadingOlder} onclick={loadOlderWithAnchor}>
          以前のメッセージを読み込む
        </Button>
        {#if olderError}
          <StatusBanner
            tone="danger"
            role="alert"
            message="以前のメッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
            actionLabel="再試行"
            onaction={loadOlderWithAnchor}
          />
        {/if}
      </div>
    {/if}

    {#if lines.length > 0 || mainPending.length > 0}
      <ul class="timeline-list" aria-label="メッセージ一覧">
        {#each lines as line (line.kind === 'message' ? line.message.id : `topic:${line.topicId}`)}
          {#if line.kind === 'message'}
            <li class="timeline-list__item" data-message-id={line.message.id}>
              <MessageRow createdAt={line.message.created_at} body={line.message.body} />
            </li>
          {:else}
            <li class="timeline-list__item" data-message-id={`topic:${line.topicId}:${line.position}`}>
              <TopicSummaryLine
                topicId={line.topicId}
                name={line.baseline?.summary.name ?? 'トピック'}
                messageCount={line.messageCount ?? undefined}
                latestBody={line.latestMessage.body}
                onclick={() => onopentopic?.(line.topicId)}
              />
            </li>
          {/if}
        {/each}
        {#each mainPending as p (p.clientMessageId)}
          <li class="timeline-list__item" data-status={p.status}>
            {#if p.topicName}
              <p class="timeline-list__pending-topic">トピック: {p.topicName}</p>
            {/if}
            <MessageRow
              body={p.body}
              pendingStatus={p.status}
              retryable={p.retryable}
              {targetUnavailable}
              onretry={() => void channel.retry(p.clientMessageId)}
              onrestore={() => handleRestoreRequest(p.clientMessageId)}
              ondiscard={() => handleDiscard(p.clientMessageId)}
            />
          </li>
        {/each}
      </ul>
    {:else if effectiveStatus === 'ready' && !organizationUnavailable}
      <EmptyState
        title="まだメッセージがありません。"
        description="下の入力欄から最初のメッセージを送信できます。"
      />
    {/if}
  </div>

  {#if !scrollView.pinned && scrollView.belowCount > 0}
    <div class="timeline-new-below">
      <Button variant="primary" onclick={jumpToBottom}>
        新着 {scrollView.belowCount}件 ↓
      </Button>
    </div>
  {/if}

  <div class="timeline-composer">
    <Composer
      bind:textareaRef={composerRef}
      bind:topicInputRef
      allowTopicName={Boolean(topics)}
      value={s.draft}
      topicValue={s.topicDraft}
      error={s.composerError}
      disabled={targetUnavailable}
      oninput={(b) => channel.setDraft(b)}
      ontopicinput={(t) => channel.setTopicDraft(t)}
      onsubmit={handleSubmit}
    />
  </div>

  <Dialog
    open={confirmReplaceId !== null}
    title="入力中の下書きを置き換えますか？"
    description="入力中の下書きを破棄して、送信できなかったメッセージを入力欄に戻します。"
    confirmLabel="置き換える"
    cancelLabel="キャンセル"
    returnFocusFallback={composerRef}
    onconfirm={handleConfirmReplace}
    oncancel={handleCancelReplace}
  />
</section>

<style>
  .timeline-section {
    position: relative;
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-height: 0;
    min-width: 0;
    gap: var(--space-8);
  }

  .timeline-section__banner {
    padding: 0 var(--space-16);
    min-width: 0;
  }

  .timeline-scroll {
    grid-row: 2;
    overflow-y: auto;
    padding: var(--space-8) var(--space-16);
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    min-height: 0;
    min-width: 0;
  }

  .timeline-older {
    display: grid;
    justify-items: start;
    gap: var(--space-8);
    min-width: 0;
  }

  .timeline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .timeline-list__item {
    min-width: 0;
  }

  .timeline-list__pending-topic {
    margin: 0;
    padding: var(--space-4) var(--space-8) 0;
    font-size: var(--font-size-12);
    font-weight: var(--font-weight-semibold);
    color: var(--text2);
  }

  .timeline-new-below {
    position: absolute;
    bottom: calc(var(--space-24) * 4);
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
  }

  .timeline-composer {
    grid-row: 3;
    padding: 0 var(--space-12) var(--space-12);
    min-width: 0;
  }
</style>
