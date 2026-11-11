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
  import { foldTopicName, type ChannelSync } from './sync.svelte'
  import {
    computeAnchoredScrollTop,
    createTimelineScrollController,
    type ItemRect,
    type ScrollAnchor,
  } from './timeline-scroll'
  import type { TopicsAdapter } from './topics.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  // Renders one Topic's filtered history window and own Composer without owning I/O or sync state.
  // Leaves row/header room for future Unread badges (#143) and Reply chains (#140).
  let {
    channel,
    topics,
    channelId,
    topicId,
    topicName,
    topicStatus = 'idle',
    selfId = '',
    organizationUnavailable = false,
    reconnecting = false,
    composerRef = $bindable(null),
    onretrytopicmeta,
  }: {
    channel: ChannelSync
    topics: TopicsAdapter
    channelId: string
    topicId: string
    topicName: string
    topicStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    selfId?: string
    organizationUnavailable?: boolean
    reconnecting?: boolean
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    onretrytopicmeta?: () => void
  } = $props()

  const s = $derived(channel.timeline)
  const tc = $derived(channel.topic(topicId))
  const composerState = $derived(tc.composer)
  const tState = $derived(topics.state)
  const view = $derived(tState.topic(topicId))
  const topicUnavailable = $derived(topicStatus === 'unavailable' || view.notFound)
  const targetUnavailable = $derived(
    organizationUnavailable || s.status === 'unavailable' || tState.unavailable || topicUnavailable,
  )
  const pending = $derived(
    s.pending.filter(
      (p) =>
        !p.replyTo &&
        (p.topicId === topicId ||
          (!p.topicId &&
            p.topicName !== undefined &&
            topicName !== '' &&
            foldTopicName(p.topicName) === foldTopicName(topicName))),
    ),
  )

  const scrollController = createTimelineScrollController()
  const subscribeScroll = createSubscriber((update) => scrollController.subscribe(update))
  const scrollView = $derived.by(() => {
    subscribeScroll()
    return scrollController.get()
  })

  let scrollEl = $state<HTMLElement | null>(null)
  let confirmReplaceId = $state<string | null>(null)
  let requestedSummaryFor = ''
  let requestedHistoryFor = ''

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
    void topics.loadTopic(topicId)
  }

  function retryInitial() {
    scrollController.resetLoadingTimeout()
    if (topicStatus === 'error') onretrytopicmeta?.()
    requestedSummaryFor = ''
    requestedHistoryFor = ''
    void topics.loadSummary(topicId)
    void topics.loadTopic(topicId)
  }

  $effect(() => () => scrollController.destroy())

  $effect(() => {
    const key = `${channelId}:${topicId}`
    if (targetUnavailable || s.status === 'loading') return
    const hasBaseline = tState.topics.some((t) => t.topicId === topicId && t.baseline !== null)
    if (!hasBaseline && requestedSummaryFor !== key) {
      requestedSummaryFor = key
      void topics.loadSummary(topicId)
    }
    if (!view.initialized && view.hasMore && !view.loading && !view.error && requestedHistoryFor !== key) {
      requestedHistoryFor = key
      void topics.loadTopic(topicId)
    }
  })

  const effectiveStatus = $derived<'loading' | 'ready' | 'unavailable' | 'error'>(
    targetUnavailable
      ? 'unavailable'
      : topicStatus === 'error' || (view.error && view.messages.length === 0)
        ? 'error'
        : (topicStatus === 'loading' || view.loading) && view.messages.length === 0
          ? 'loading'
          : 'ready',
  )

  $effect(() => {
    const messages = view.messages
    const pendingIds = pending.map((p) => p.clientMessageId)
    const { action, anchor } = scrollController.sync({
      channelId: `${channelId}/${topicId}`,
      status: effectiveStatus,
      messages,
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
    const decision = decideEditAndResend(clientMessageId, composerState.draft)
    if (decision.action === 'restore_now') {
      if (tc.restore(clientMessageId)) {
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
    const canRestore = !targetUnavailable && pending.some((p) => p.clientMessageId === id && p.status === 'failed')
    confirmReplaceDraftWithFailedSend(
      id,
      composerState.draft,
      canRestore,
      (draft) => tc.setDraft(draft),
      (targetId) => tc.restore(targetId),
      composerRef,
    )
  }

  function handleCancelReplace() {
    confirmReplaceId = null
  }

  async function handleSubmit(): Promise<boolean> {
    if (!topicName) return false
    const ok = await tc.submit(topicName)
    if (!ok) return false
    const action = scrollController.onUserSubmit()
    void tick().then(() => {
      applyScrollAction(action, null)
    })
    return true
  }
</script>

<section class="topic-view" aria-label="トピックタイムライン">
  {#if reconnecting && !targetUnavailable && s.status === 'ready'}
    <div class="topic-view__banner">
      <StatusBanner tone="info" role={null} message="再接続しています…" />
    </div>
  {/if}

  {#if !targetUnavailable && (effectiveStatus === 'error' || (effectiveStatus === 'loading' && scrollView.loadingTimedOut))}
    <div class="topic-view__banner">
      <StatusBanner
        tone="danger"
        role="alert"
        message="トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
        actionLabel="再試行"
        onaction={retryInitial}
      />
    </div>
  {/if}

  <div class="topic-view__scroll" bind:this={scrollEl} onscroll={handleScroll}>
    {#if topicUnavailable}
      <EmptyState
        title="このトピックは利用できません。"
        description="削除されたか、URLが正しくない可能性があります。"
      />
    {:else if effectiveStatus === 'loading' && !scrollView.loadingTimedOut && view.messages.length === 0 && pending.length === 0}
      <Skeleton rows={4} label="トピックを読み込み中" />
    {:else}
      {#if view.initialized && view.hasMore && !targetUnavailable}
        <div class="topic-view__older">
          <Button variant="secondary" disabled={view.loading} onclick={loadOlderWithAnchor}>
            以前のメッセージを読み込む
          </Button>
          {#if view.error}
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

      {#if view.messages.length > 0 || pending.length > 0}
        <ul class="topic-view__list" aria-label="メッセージ一覧">
          {#each view.messages as m (m.id)}
            <li class="topic-view__item" data-message-id={m.id}>
              <MessageRow createdAt={m.created_at} body={m.body} />
            </li>
          {/each}
          {#each pending as p (p.clientMessageId)}
            <li class="topic-view__item" data-status={p.status}>
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
      {:else if effectiveStatus === 'ready'}
        <EmptyState
          title="まだメッセージがありません。"
          description="下の入力欄からメッセージを送信できます。"
        />
      {/if}
    {/if}
  </div>

  {#if !scrollView.pinned && scrollView.belowCount > 0}
    <div class="topic-view__new-below">
      <Button variant="primary" onclick={jumpToBottom}>
        新着 {scrollView.belowCount}件 ↓
      </Button>
    </div>
  {/if}

  <div class="topic-view__composer">
    <Composer
      bind:textareaRef={composerRef}
      placeholder="トピックにメッセージを入力"
      value={composerState.draft}
      error={composerState.composerError}
      disabled={targetUnavailable}
      submitDisabled={!topicName}
      oninput={(b) => tc.setDraft(b)}
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
  .topic-view {
    position: relative;
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-height: 0;
    min-width: 0;
    gap: var(--space-8);
  }

  .topic-view__banner {
    padding: 0 var(--space-16);
    min-width: 0;
  }

  .topic-view__scroll {
    grid-row: 2;
    overflow-y: auto;
    padding: var(--space-8) var(--space-16);
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    min-height: 0;
    min-width: 0;
  }

  .topic-view__older {
    display: grid;
    justify-items: start;
    gap: var(--space-8);
    min-width: 0;
  }

  .topic-view__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .topic-view__item {
    min-width: 0;
  }

  .topic-view__new-below {
    position: absolute;
    bottom: calc(var(--space-24) * 4);
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
  }

  .topic-view__composer {
    grid-row: 3;
    padding: 0 var(--space-12) var(--space-12);
    min-width: 0;
  }
</style>
