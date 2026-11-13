<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import type { Message } from './api'
  import { resolveRovingMessageId, stepMessageRowIndex } from './composer-keys'
  import Composer from './Composer.svelte'
  import VirtualRows from './ui/VirtualRows.svelte'
  import {
    confirmReplaceDraftWithFailedSend,
    decideEditAndResend,
    discardAndFocusComposer,
    focusTarget,
  } from './focus-management'
  import { countRepliesByMessageId, type RepliesAdapter } from './replies.svelte'
  import type { ChannelSync } from './sync.svelte'
  import {
    applyTimelineScrollAction,
    createTimelineScrollController,
    handleTimelineContainerScroll,
    isTimelineDisplayed,
    measureTimelineItems,
    measureVisibleConfirmedSeqs,
    type ScrollAction,
    type ScrollAnchor,
  } from './timeline-scroll'
  import { linePosition, type MainTimelineLine } from './topic-selectors'
  import type { TopicsAdapter } from './topics.svelte'
  import type { UnreadAdapter } from './unread.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import ReadMarker from './ui/ReadMarker.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'
  import TopicSummaryLine from './ui/TopicSummaryLine.svelte'

  // The session owns the sync controller and outlives this component; this only displays its state.
  let {
    channel,
    topics = null,
    replies = null,
    unread = null,
    channelId = '',
    selfId = '',
    viewSelected = true,
    organizationUnavailable = false,
    reconnecting = false,
    resolveSenderName,
    composerRef = $bindable(null),
    topicInputRef = $bindable(null),
    onopentopic,
    onopenreplies,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
  }: {
    channel: ChannelSync
    topics?: TopicsAdapter | null
    replies?: RepliesAdapter | null
    unread?: UnreadAdapter | null
    channelId?: string
    selfId?: string
    viewSelected?: boolean
    organizationUnavailable?: boolean
    reconnecting?: boolean
    resolveSenderName?: (senderId: string) => string
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    topicInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    onopentopic?: (topicId: string) => void
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()

  const currentChannelId = $derived(channelId)
  const s = $derived(channel.timeline)
  const cState = $derived(channel.composer)
  const tState = $derived(topics ? topics.state : null)
  const rState = $derived(replies ? replies.state : null)
  const uState = $derived(unread ? unread.state : null)
  const targetUnavailable = $derived(
    s.status === 'unavailable' || Boolean(tState?.unavailable) || organizationUnavailable,
  )
  const lines = $derived<MainTimelineLine[]>(
    tState ? tState.lines : s.messages.map((message) => ({ kind: 'message', message })),
  )
  let scrolledFirstUnreadId = $state<string | null>(null)
  const entry = $derived(uState?.entry?.scope.topicId === null ? uState.entry : null)
  const uGeneration = $derived(uState?.generation ?? null)
  const entryId = $derived(entry?.id ?? null)
  const hasFirstUnreadInView = $derived(
    Boolean(
      entry?.firstUnread &&
        lines.some((l) => l.kind === 'message' && l.message.id === entry.firstUnread!.id),
    ),
  )
  const needsOlderUnreadPage = $derived(
    Boolean(
      entry &&
        scrolledFirstUnreadId === null &&
        (entry.unreadAtEntry ?? 0) > 0 &&
        (entry.needsOlder || (entry.firstUnread !== null && !hasFirstUnreadInView && scrolledFirstUnreadId !== entry.firstUnread.id)),
    ),
  )
  const awaitingEntryBoundary = $derived(
    Boolean(
      unread &&
        !targetUnavailable &&
        !uState?.stopped &&
        !uState?.error &&
        !uState?.main.stopped &&
        !uState?.main.error &&
        (entry === null || entry.boundary === null),
    ),
  )
  const firstUnreadMessageId = $derived(
    entry &&
      entry.boundary !== null &&
      (entry.unreadAtEntry ?? 0) > 0 &&
      !needsOlderUnreadPage &&
      (entry.firstUnread || scrolledFirstUnreadId)
      ? (scrolledFirstUnreadId ?? entry.firstUnread?.id ?? null)
      : null,
  )
  const replyCounts = $derived(
    countRepliesByMessageId([
      s.messages,
      lines.flatMap((l) => (l.kind === 'message' ? [l.message] : [])),
      rState?.messages ?? [],
    ]),
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

  let rowWindow = $state<{ reveal(id: string, focus?: boolean, align?: 'start' | 'end'): Promise<void> } | null>(null)
  let scrollEl = $state<HTMLElement | null>(null)
  let confirmReplaceId = $state<string | null>(null)
  let activeRowId = $state<string | null>(null)
  let initialScrollApplied = $state(false)
  let pendingScrollAction: { action: ScrollAction; anchor: ScrollAnchor | null } | null = null
  let lastScrollScopeKey = ''
  let lastScrollEntryId: symbol | null = null
  const mainStopped = $derived(Boolean(uState?.stopped || uState?.main.stopped))
  const focusableMessageIds = $derived(
    lines.flatMap((l) => (l.kind === 'message' ? [l.message.id] : [])),
  )
  let mountedIds = $state<string[]>([])
  const rovingRowId = $derived(resolveRovingMessageId(focusableMessageIds.filter(id => mountedIds.includes(id)), activeRowId))

  function isDocumentVisible(): boolean {
    if (typeof document === 'undefined') return true
    return (document.visibilityState ?? 'visible') === 'visible'
  }

  function reportPresented() {
    if (!unread || !isTimelineDisplayed(scrollEl, viewSelected) || targetUnavailable) return
    if (!isDocumentVisible()) return
    const currentEntry = uState?.entry
    if (!currentEntry || currentEntry.scope.topicId !== null) return
    if (currentEntry.boundary === null || needsOlderUnreadPage) return
    if ((currentEntry.unreadAtEntry ?? 0) > 0) {
      if (!firstUnreadMessageId || scrolledFirstUnreadId !== firstUnreadMessageId) return
    } else if (!initialScrollApplied) {
      return
    }
    const seqs = measureVisibleConfirmedSeqs(scrollEl!)
    if (seqs.length > 0) {
      unread.presented(currentEntry.id, seqs)
    }
  }

  async function focusMessage(id: string | undefined) {
    if (!id) return
    activeRowId = id
    await rowWindow?.reveal(id, true)
  }
  function handleRowKeydown(e: KeyboardEvent) {
    const id = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-message-id]')?.getAttribute('data-message-id')
    const next = stepMessageRowIndex(focusableMessageIds.indexOf(id ?? ''), focusableMessageIds.length, e)
    if (next === null) return
    e.preventDefault()
    void focusMessage(focusableMessageIds[next])
  }
  async function revealScrollTarget(action: ScrollAction, anchor: ScrollAnchor | null, unreadId?: string | null) {
    const id = action === 'scroll_first_unread' ? unreadId : action === 'preserve_anchor' ? anchor?.messageId : null
    if (id && !scrollEl?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)) await rowWindow?.reveal(id)
  }

  function captureCurrentAnchor() {
    if (!scrollEl) return
    scrollController.captureAnchor(measureTimelineItems(scrollEl))
  }

  function handleScroll() {
    handleTimelineContainerScroll(scrollEl, scrollController)
    topics?.setMainPinned(scrollController.get().pinned)
    reportPresented()
  }

  function applyScrollAction(
    action: ScrollAction,
    anchor: ScrollAnchor | null,
    firstUnreadId?: string | null,
  ) {
    const id = action === 'scroll_first_unread' ? firstUnreadId : action === 'preserve_anchor' ? anchor?.messageId : null
    if (id && !scrollEl?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)) {
      void revealScrollTarget(action, anchor, firstUnreadId).then(() => {
        applyTimelineScrollAction(scrollEl, scrollController, action, anchor, firstUnreadId)
        reportPresented()
      })
    } else applyTimelineScrollAction(scrollEl, scrollController, action, anchor, firstUnreadId)
  }

  async function jumpToBottom() {
    if (tState?.main.hasNewer) { await topics?.loadMainLatest(); await tick() }
    const action = scrollController.jumpToBottom()
    applyScrollAction(action, null)
    reportPresented()
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

  let requestedMainFor = ''
  let currentVisitId: symbol | undefined
  let enteredTarget = false

  $effect(() => () => scrollController.destroy())

  $effect(() => {
    const u = unread
    const id = currentChannelId
    const active = !targetUnavailable
    if (!u || !id || !active) return
    return () => {
      enteredTarget = false
      const vid =
        currentVisitId ??
        untrack(() => (u.state.entry?.scope.topicId === null ? u.state.entry.id : undefined))
      currentVisitId = undefined
      if (vid) u.leave(vid)
    }
  })

  $effect(() => {
    const u = unread
    const id = currentChannelId
    const active = !targetUnavailable
    const generation = uGeneration
    const currentEntryId = entryId
    const stopped = mainStopped
    if (!u || !id || !active || !generation) return
    if (currentEntryId) {
      enteredTarget = true
      currentVisitId = currentEntryId
      return
    }
    if (enteredTarget && stopped) return
    let cancelled = false
    u.visibility(isDocumentVisible())
    const promise = u.enter(null)
    const syncVid = untrack(() =>
      u.state.entry?.scope.topicId === null ? u.state.entry.id : undefined,
    )
    if (syncVid) {
      enteredTarget = true
      currentVisitId = syncVid
    }
    void promise.then((vid) => {
      if (cancelled) return
      if (vid) {
        enteredTarget = true
        currentVisitId = vid
      }
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const u = unread
    const doc = typeof document !== 'undefined' ? document : null
    if (!u || !doc) return
    const syncVisibility = () => {
      const vis = (doc.visibilityState ?? 'visible') === 'visible'
      u.visibility(vis)
      if (vis) reportPresented()
    }
    syncVisibility()
    doc.addEventListener('visibilitychange', syncVisibility)
    return () => doc.removeEventListener('visibilitychange', syncVisibility)
  })

  $effect(() => {
    if (!topics || !tState || targetUnavailable || s.status !== 'ready') return
    const mainKey = `${currentChannelId}:${tState.generation}`
    if (
      tState.main.asOfSeq === undefined &&
      !tState.main.loading &&
      !tState.main.error &&
      requestedMainFor !== mainKey
    ) {
      requestedMainFor = mainKey
      void topics.loadMain()
    }
    for (const topic of tState.topics) {
      if ((topic.baseline === null || topic.latestMessage.seq < topic.position) && topic.summaryError === null) {
        void topics.ensureSummary(topic.topicId)
      }
    }
  })

  $effect(() => {
    if (!needsOlderUnreadPage || !hasOlder || loadingOlder || olderError || targetUnavailable) return
    if (effectiveStatus !== 'ready') return
    loadOlderWithAnchor()
  })

  // Keep scroll state, anchor preservation and 10 s loading timeout synchronized with timeline changes (docs/ui.md §5, §8)
  $effect(() => {
    const id = currentChannelId
    const currentEntryId = entryId
    if (
      id !== lastScrollScopeKey ||
      (currentEntryId !== null && currentEntryId !== lastScrollEntryId)
    ) {
      lastScrollScopeKey = id
      lastScrollEntryId = currentEntryId
      initialScrollApplied = false
      scrolledFirstUnreadId = null
      pendingScrollAction = null
    }
    const displayed = isTimelineDisplayed(scrollEl, viewSelected)
    const syncMessages = lines.map((line) =>
      line.kind === 'message'
        ? { id: line.message.id, seq: line.message.seq, sender: line.message.sender }
        : {
            id: `topic:${line.topicId}`,
            seq: linePosition(line),
            sender: line.latestMessage.sender,
          },
    )
    const pendingIds = mainPending.map((p) => p.clientMessageId)
    const status = effectiveStatus
    const targetFirstUnreadId = firstUnreadMessageId
    const awaitingFirstUnread =
      awaitingEntryBoundary || Boolean(needsOlderUnreadPage && hasOlder && !olderError)
    const { action, anchor } = scrollController.sync({
      channelId: id,
      visitId: currentEntryId,
      displayed,
      status,
      messages: syncMessages,
      pendingIds,
      selfId,
      firstUnreadMessageId: targetFirstUnreadId,
      awaitingFirstUnread,
    })
    if (action !== 'none') {
      pendingScrollAction = { action, anchor }
    }
    void tick().then(() => {
      if (!isTimelineDisplayed(scrollEl, viewSelected)) {
        if (
          !initialScrollApplied &&
          pendingScrollAction &&
          (pendingScrollAction.action === 'scroll_bottom' ||
            pendingScrollAction.action === 'scroll_first_unread')
        ) {
          pendingScrollAction = null
          scrollController.resetInitialScroll()
        }
        return
      }
      if (pendingScrollAction) {
        const deferred = pendingScrollAction
        pendingScrollAction = null
        applyScrollAction(deferred.action, deferred.anchor, targetFirstUnreadId)
        if (deferred.action === 'scroll_first_unread' && targetFirstUnreadId) {
          scrolledFirstUnreadId = targetFirstUnreadId
        }
        if (deferred.action === 'scroll_bottom' || deferred.action === 'scroll_first_unread') {
          initialScrollApplied = true
        }
      } else {
        captureCurrentAnchor()
        if (status === 'ready' && !awaitingFirstUnread && !targetFirstUnreadId) {
          initialScrollApplied = true
        }
      }
      reportPresented()
    })
  })

  $effect(() => {
    if (!unread || !viewSelected || targetUnavailable) return
    if (entry?.boundary === null || needsOlderUnreadPage) return
    void tick().then(() => {
      reportPresented()
    })
  })


  function handleDiscard(clientMessageId: string) {
    discardAndFocusComposer(clientMessageId, (id) => channel.discard(id), composerRef)
  }

  function handleRestoreRequest(clientMessageId: string) {
    const decision = decideEditAndResend(clientMessageId, cState.draft, cState.topicDraft)
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
    confirmReplaceDraftWithFailedSend(
      id,
      cState.draft,
      canRestore,
      (draft) => channel.setDraft(draft),
      (targetId) => channel.restore(targetId),
      composerRef,
      {
        currentTopicDraft: cState.topicDraft,
        setTopicDraft: (topicDraft) => channel.setTopicDraft(topicDraft),
      },
    )
  }

  function handleCancelReplace() {
    confirmReplaceId = null
  }

  async function handleSubmit(): Promise<boolean> {
    const ok = await channel.submit()
    if (!ok) return false
    if (tState?.main.hasNewer) await topics?.loadMainLatest()
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
      <VirtualRows
        class="timeline-list"
        bind:this={rowWindow}
        items={lines}
        rowId={(line) => line.kind === 'message' ? line.message.id : `topic:${line.topicId}`}
        confirmedSeq={(line) => line.kind === 'message' ? line.message.seq : null}
        pendingItems={mainPending}
        pendingId={(p) => p.clientMessageId}
        pendingStatus={(p) => p.status}
        pendingClass="timeline-list__item"
        itemClass="timeline-list__item"
        container={scrollEl}
        label="メッセージ一覧"
        followBottom={scrollView.pinned && initialScrollApplied}
        onmounted={(ids) => { mountedIds = ids }}
        onvisible={reportPresented}
        onfocuslost={() => focusTarget(composerRef)}
      >
        {#snippet children(line)}
          {#if line.kind === 'message'}
              {#if firstUnreadMessageId === line.message.id}
                <ReadMarker />
              {/if}
              <MessageRow
                senderName={resolveSenderName ? resolveSenderName(line.message.sender) : undefined}
                createdAt={line.message.created_at}
                body={line.message.body}
                replyCount={replyCounts.get(line.message.id) ?? 0}
                focusable
                rovingTabindex={rovingRowId === line.message.id ? 0 : -1}
                onopenreplies={onopenreplies && !targetUnavailable
                  ? (opener) => onopenreplies(line.message, opener)
                  : undefined}
                onrowfocus={() => {
                  activeRowId = line.message.id
                }}
                onrowkeydown={handleRowKeydown}
              />
          {:else}
            {@const topicUnread = uState?.topics[line.topicId]?.unreadCount ?? null}
              <TopicSummaryLine
                topicId={line.topicId}
                name={line.baseline?.summary.name ?? 'トピック'}
                messageCount={line.messageCount ?? undefined}
                latestBody={line.latestMessage.body}
                unreadCount={topicUnread !== null && topicUnread > 0 ? topicUnread : 0}
                onclick={() => onopentopic?.(line.topicId)}
                onretry={!targetUnavailable && line.summaryError === 'retryable' && topics
                  ? () => void topics.retrySummary(line.topicId)
                  : undefined}
              />
          {/if}

          {/snippet}
        {#snippet pendingRow(p)}
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
        {/snippet}
        </VirtualRows>
    {:else if effectiveStatus === 'ready' && !organizationUnavailable}
      <EmptyState
        title="まだメッセージがありません。"
        description="下の入力欄から最初のメッセージを送信できます。"
      />
    {/if}
    {#if tState?.main.hasNewer && !targetUnavailable && topics}
      <Button variant="secondary" onclick={jumpToBottom}>最新のメッセージを読み込む</Button>
    {/if}

  </div>

  {#if !scrollView.pinned && (scrollView.belowCount > 0 || (tState?.main.newerCount ?? 0) > 0)}
    <div class="timeline-new-below">
      <Button variant="primary" onclick={jumpToBottom}>
        新着 {Math.max(scrollView.belowCount, tState?.main.newerCount ?? 0)}件 ↓
      </Button>
    </div>
  {/if}

  <div class="timeline-composer">
    <Composer
      bind:textareaRef={composerRef}
      bind:topicInputRef
      allowTopicName={Boolean(topics)}
      value={cState.draft}
      topicValue={cState.topicDraft}
      error={cState.composerError}
      disabled={targetUnavailable}
      oninput={(b) => channel.setDraft(b)}
      ontopicinput={(t) => channel.setTopicDraft(t)}
      onsubmit={handleSubmit}
      onarrowupempty={() => void focusMessage(focusableMessageIds.at(-1))}
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
    overflow-anchor: none;
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
