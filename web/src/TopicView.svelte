<script lang="ts">
  import type { Member } from './api'
  import type { MentionName } from './mentions'
  import { onMount, tick, untrack } from 'svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import type { Message } from './api'
  import { resolveRovingMessageId } from './composer-keys'
  import Composer from './Composer.svelte'
  import VirtualRows from './ui/VirtualRows.svelte'
  import { focusTarget } from './focus-management'
  import { type RepliesAdapter } from './replies.svelte'
  import { foldTopicName, type ChannelSync } from './sync.svelte'
  import { createTimelineDraftController } from './timeline-draft'
  import {
    applyTimelineScrollAction,
    createTimelineScrollController,
    handleTimelineContainerScroll,
    isTimelineDisplayed,
    type ScrollAction,
    type ScrollAnchor,
  } from './timeline-scroll'
  import { isDocumentVisible } from './timeline-presentation'
  import { createTimelineViewController, type TimelineRowWindow } from './timeline-view'
  import type { TopicsAdapter } from './topics.svelte'
  import type { SearchPresentation } from './search-anchor.svelte'
  import type { UnreadAdapter } from './unread.svelte'
  import TimelineFrame from './TimelineFrame.svelte'
  import SearchAnchorStatus from './ui/SearchAnchorStatus.svelte'
  import Button from './ui/Button.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import ReadMarker from './ui/ReadMarker.svelte'
  import Skeleton from './ui/Skeleton.svelte'

  // Renders one Topic's filtered history window and own Composer without owning I/O or sync state.
  // Leaves row/header room for future Unread badges (#143) and Reply chains (#140).
  let {
    channel,
    topics,
    replies = null,
    unread = null,
    channelId,
    topicId,
    topicName,
    topicStatus = 'idle',
    selfId = '',
    viewSelected = true,
    awaitingInitialSenders = false,
    organizationUnavailable = false,
    sendDisabled = false,
    reconnecting = false,
    resolveSenderName,
    resolveMentionName,
    members = [],
    onmentionrequest,
    composerRef = $bindable(null),
    onopenreplies,
    onretrytopicmeta,
    search,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
    onpositioningchange,
  }: {
    channel: ChannelSync
    topics: TopicsAdapter
    replies?: RepliesAdapter | null
    unread?: UnreadAdapter | null
    channelId: string
    topicId: string
    topicName: string
    topicStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    selfId?: string
    viewSelected?: boolean
    awaitingInitialSenders?: boolean
    organizationUnavailable?: boolean
    sendDisabled?: boolean
    reconnecting?: boolean
    resolveSenderName?: (senderId: string) => string
    resolveMentionName?: MentionName
    members?: readonly Member[]
    onmentionrequest?: () => void
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    onretrytopicmeta?: () => void
    search?: SearchPresentation
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
    onpositioningchange?: (positioning: boolean) => void
  } = $props()

  const currentChannelId = $derived(channelId)
  const currentTopicId = $derived(topicId)
  const s = $derived(channel.timeline)
  const tc = $derived(channel.topic(currentTopicId))
  const composerState = $derived(tc.composer)
  const tState = $derived(topics.state)
  const rState = $derived(replies ? replies.state : null)
  const searchId = $derived(search?.target.messageId)
  const searchVisit = $derived(search?.view?.visit)
  const uState = $derived(unread ? unread.state : null)
  const topicView = $derived(tState.topic(currentTopicId))
  const view = $derived(search ? {
    ...topicView, messages: search.view?.messages ?? [], initialized: search.view?.status === 'ready',
    hasMore: search.view?.hasOlder ?? false, hasNewer: false, newerCount: 0,
    loading: search.view?.paging ?? false, error: search.view?.pageError === 'older', notFound: false,
  } : topicView)
  let skipUnreadVisit = $state(false)
  // The visit stops waiting for its entry position (loading timeout or own send) and opens at the bottom, as after a failed boundary.
  let entryPositionAbandoned = $state(false)
  let scrolledFirstUnreadId = $state<string | null>(null)
  const entry = $derived(uState?.entry?.scope.topicId === currentTopicId ? uState.entry : null)
  const uGeneration = $derived(uState?.generation ?? null)
  const entryId = $derived(entry?.id ?? null)
  const hasFirstUnreadInView = $derived(
    Boolean(entry?.firstUnread && view.messages.some((m) => m.id === entry.firstUnread!.id)),
  )
  const needsOlderUnreadPage = $derived(
    Boolean(
      entry &&
        scrolledFirstUnreadId === null &&
        (entry.unreadAtEntry ?? 0) > 0 &&
        (entry.needsOlder || (entry.firstUnread !== null && !hasFirstUnreadInView && scrolledFirstUnreadId !== entry.firstUnread.id)),
    ),
  )
  const firstUnreadMessageId = $derived(
    !search && !skipUnreadVisit && !entryPositionAbandoned && entry &&
      entry.boundary !== null &&
      (entry.unreadAtEntry ?? 0) > 0 &&
      !needsOlderUnreadPage &&
      (entry.firstUnread || scrolledFirstUnreadId)
      ? (scrolledFirstUnreadId ?? entry.firstUnread?.id ?? null)
      : null,
  )
  const replyCounts = $derived(replies?.counts ?? {})
  const channelUnavailable = $derived(s.status === 'unavailable' || tState.unavailable)
  const topicUnavailable = $derived(
    !organizationUnavailable && !channelUnavailable && (!search && (topicStatus === 'unavailable' || view.notFound)),
  )
  const targetUnavailable = $derived(
    organizationUnavailable || channelUnavailable || topicUnavailable,
  )
  const topicScope = $derived(uState?.topics[currentTopicId] ?? null)
  const awaitingEntryBoundary = $derived(
    Boolean(
      unread &&
        !targetUnavailable &&
        !uState?.stopped &&
        !uState?.error &&
        !topicScope?.stopped &&
        !topicScope?.error &&
        (entry === null || entry.boundary === null),
    ),
  )
  const awaitingEntryPosition = $derived(
    !search && !skipUnreadVisit && !entryPositionAbandoned &&
      (awaitingEntryBoundary || Boolean(needsOlderUnreadPage && view.hasMore && !view.error)),
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

  let rowWindow = $state<TimelineRowWindow | null>(null)
  let scrollEl = $state<HTMLElement | null>(null)
  let confirmReplaceId = $state<string | null>(null)
  let activeRowId = $state<string | null>(null)
  let requestedHistoryFor = ''
  let initialScrollApplied = $state(false)
  let pendingScrollAction: { action: ScrollAction; anchor: ScrollAnchor | null } | null = null
  let lastScrollScopeKey = ''
  let lastScrollEntryId: symbol | null = null
  let currentVisitId: symbol | undefined
  let enteredTarget = false
  const topicStopped = $derived(Boolean(uState?.stopped || topicScope?.stopped))
  const focusableMessageIds = $derived(view.messages.map((m) => m.id))
  let mountedIds = $state<string[]>([])
  const rovingRowId = $derived(resolveRovingMessageId(focusableMessageIds.filter(id => mountedIds.includes(id)), activeRowId))

  const {
    reportPresented,
    focusMessage,
    handleRowKeydown,
    revealScrollTarget,
    captureCurrentAnchor,
    applyScrollAction,
    jumpToBottom,
    loadOlderWithAnchor,
  } = createTimelineViewController({
    scrollController,
    getScrollEl: () => scrollEl,
    getRowWindow: () => rowWindow,
    getFocusableMessageIds: () => focusableMessageIds,
    setActiveRowId: (id) => {
      activeRowId = id
    },
    afterUpdate: tick,
    isPositioning: () => positioning,
    presentation: {
      isEnabled: () => Boolean(unread),
      isAwaitingInitialSenders: () => awaitingInitialSenders,
      isViewSelected: () => viewSelected,
      isTargetUnavailable: () => targetUnavailable,
      getExpectedTopicId: () => topicId,
      getEntry: () => uState?.entry ?? null,
      isSearchActive: () => Boolean(search),
      isSearchReady: () => search?.view?.status === 'ready',
      isInitialScrollApplied: () => initialScrollApplied,
      isSkipUnreadVisit: () => skipUnreadVisit,
      needsOlderUnreadPage: () => needsOlderUnreadPage,
      isEntryPositionAbandoned: () => entryPositionAbandoned,
      getFirstUnreadMessageId: () => firstUnreadMessageId,
      getScrolledFirstUnreadId: () => scrolledFirstUnreadId,
      onPresented: (visitId, seqs) => unread?.presented(visitId, seqs),
    },
    search: {
      isActive: () => Boolean(search),
      jumpToLatest: () => {
        skipUnreadVisit = true
        search?.latest()
      },
      loadOlder: () => {
        void search?.loadOlder()
      },
    },
    hasNewer: () => Boolean(view.hasNewer),
    loadLatest: () => topics.loadTopicLatest(topicId),
    loadOlder: () => {
      void topics.loadTopic(topicId).catch(console.error)
    },
  })

  function handleScroll() {
    if (awaitingInitialSenders) return
    handleTimelineContainerScroll(scrollEl, scrollController)
    topics.setTopicPinned(topicId, scrollController.get().pinned)
    reportPresented()
  }

  function retryInitial() {
    scrollController.resetLoadingTimeout()
    if (topicStatus === 'error') onretrytopicmeta?.()
    requestedHistoryFor = ''
    void topics.retrySummary(topicId).catch(console.error)
    void topics.loadTopic(topicId).catch(console.error)
  }

  $effect(() => {
    onpositioningchange?.(positioning)
  })

  $effect(() => () => scrollController.destroy())
  onMount(() => {
    const id = topicId, release = topics.releaseTopic
    return () => release(id)
  })
  $effect(() => {
    if (!searchId) return
    requestedHistoryFor = ''
    untrack(() => topics.releaseTopic(topicId))
  })

  $effect(() => {
    const u = unread
    const id = currentChannelId
    const tId = currentTopicId
    const active = !targetUnavailable
    if (!u || !id || !tId || !active) return
    return () => {
      enteredTarget = false
      const vid =
        currentVisitId ??
        untrack(() => (u.state.entry?.scope.topicId === tId ? u.state.entry.id : undefined))
      currentVisitId = undefined
      if (vid) u.leave(vid)
    }
  })

  $effect(() => {
    const u = unread
    const id = currentChannelId
    const tId = currentTopicId
    const active = !targetUnavailable
    const generation = uGeneration
    const currentEntryId = entryId
    const stopped = topicStopped
    if (!u || !id || !tId || !active || !generation) return
    if (currentEntryId) {
      enteredTarget = true
      currentVisitId = currentEntryId
      return
    }
    if (enteredTarget && stopped) return
    let cancelled = false
    u.visibility(isDocumentVisible())
    const promise = u.enter(tId)
    const syncVid = untrack(() =>
      u.state.entry?.scope.topicId === tId ? u.state.entry.id : undefined,
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
    }).catch(console.error)
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
    const tId = currentTopicId
    const key = `${currentChannelId}:${tId}:${tState.generation}`
    if (search || targetUnavailable || s.status === 'loading') return
    const hasBaseline = tState.topics.some((t) => t.topicId === tId && t.baseline !== null)
    if (!hasBaseline && view.summaryError === null) {
      void topics.ensureSummary(tId).catch(console.error)
    }
    if (!view.initialized && view.hasMore && !view.loading && !view.error && requestedHistoryFor !== key) {
      requestedHistoryFor = key
      void topics.loadTopic(tId).catch(console.error)
    }
  })

  $effect(() => {
    // A visit that opened at the bottom no longer positions at the first Unread, so it pages no older history toward it.
    if (search || skipUnreadVisit || entryPositionAbandoned || !needsOlderUnreadPage || !view.initialized || !view.hasMore || view.loading || view.error || targetUnavailable) {
      return
    }
    if (effectiveStatus !== 'ready') return
    loadOlderWithAnchor()
  })

  const effectiveStatus = $derived<'loading' | 'ready' | 'unavailable' | 'error'>(
    targetUnavailable
      ? 'unavailable'
      : search ? (!search.view || search.view.status === 'loading' ? 'loading' : 'ready')
      : topicStatus === 'error' || (view.error && view.messages.length === 0)
        ? 'error'
        : ((topicStatus === 'loading' || view.loading) && view.messages.length === 0) || awaitingInitialSenders
          ? 'loading'
          : 'ready',
  )
  const loadFailed = $derived(effectiveStatus === 'error' || (effectiveStatus === 'loading' && scrollView.loadingTimedOut))
  const canPosition = $derived(!targetUnavailable && !loadFailed)
  // Keep rows mounted for positioning. Error and unavailable states show the loaded rows (§5, §8).
  const positioning = $derived(canPosition && !initialScrollApplied && (awaitingEntryPosition || firstUnreadMessageId !== null))

  $effect(() => {
    const scopeKey = `${currentChannelId}/${currentTopicId}${searchId ? ':search' : ''}`
    const currentEntryId = searchId ? searchVisit ?? null : entryId
    if (
      scopeKey !== lastScrollScopeKey ||
      (currentEntryId !== null && currentEntryId !== lastScrollEntryId)
    ) {
      if (searchId) skipUnreadVisit = false
      lastScrollScopeKey = scopeKey
      lastScrollEntryId = currentEntryId
      initialScrollApplied = false
      scrolledFirstUnreadId = null
      entryPositionAbandoned = false
      pendingScrollAction = null
    }
    const displayed = !awaitingInitialSenders && isTimelineDisplayed(scrollEl, viewSelected)
    const messages = view.messages
    const pendingIds = pending.map((p) => p.clientMessageId)
    // Positioning counts as loading so the controller's loading timeout bounds it; a hidden view defers positioning
    // to its display (`docs/ui.md` §8), so its wait starts only once displayed.
    const status = positioning && displayed && effectiveStatus === 'ready' ? 'loading' : effectiveStatus
    const targetFirstUnreadId = canPosition ? firstUnreadMessageId : null
    const awaitingFirstUnread = canPosition && awaitingEntryPosition
    const { action, anchor } = scrollController.sync({
      channelId: scopeKey,
      visitId: currentEntryId,
      displayed,
      status,
      messages,
      pendingIds,
      selfId,
      firstUnreadMessageId: targetFirstUnreadId,
      awaitingFirstUnread,
      searchAnchorId: searchId,
      searchAsOfSeq: search?.view?.asOfSeq,
    })
    if (action !== 'none') {
      pendingScrollAction = { action, anchor }
    }
    const revealVisit = searchVisit
    void tick().then(() => {
      if (searchVisit !== revealVisit) return
      if (awaitingInitialSenders || !isTimelineDisplayed(scrollEl, viewSelected)) {
        if (
          !initialScrollApplied &&
          pendingScrollAction &&
          (pendingScrollAction.action === 'scroll_bottom' ||
            pendingScrollAction.action === 'scroll_first_unread' ||
            pendingScrollAction.action === 'scroll_search_anchor')
        ) {
          pendingScrollAction = null
          scrollController.resetInitialScroll()
        }
        return
      }
      if (pendingScrollAction) {
        const deferred = pendingScrollAction
        pendingScrollAction = null
        if (deferred.action === 'scroll_search_anchor') {
          void revealScrollTarget(deferred.action, null, searchId).then(() => {
            if (searchVisit !== revealVisit || !isTimelineDisplayed(scrollEl, viewSelected)) return
            applyTimelineScrollAction(scrollEl, scrollController, deferred.action, null, searchId)
            initialScrollApplied = true
            reportPresented()
          }).catch(console.error)
          return
        }
        applyScrollAction(deferred.action, deferred.anchor, targetFirstUnreadId)
        if (deferred.action === 'scroll_first_unread' && targetFirstUnreadId) {
          scrolledFirstUnreadId = targetFirstUnreadId
        }
        if (deferred.action === 'scroll_bottom' || deferred.action === 'scroll_first_unread') {
          // Opening at the bottom ends this visit's wait, so a boundary resolving later neither marks nor moves it (`docs/ui.md` §8).
          if (deferred.action === 'scroll_bottom' && !initialScrollApplied && !search) entryPositionAbandoned = true
          initialScrollApplied = true
        }
      } else {
        captureCurrentAnchor()
        if (!search && status === 'ready' && !awaitingFirstUnread && !targetFirstUnreadId) {
          initialScrollApplied = true
        }
      }
      reportPresented()
    }).catch(console.error)
  })

  $effect(() => {
    // An initial history read that times out shows the retryable error instead; `再試行` restarts the same wait.
    if (positioning && scrollView.loadingTimedOut && effectiveStatus === 'ready') entryPositionAbandoned = true
  })

  $effect(() => {
    if (!unread || !viewSelected || targetUnavailable) return
    if (entry?.boundary === null || needsOlderUnreadPage) return
    void tick().then(() => {
      reportPresented()
    }).catch(console.error)
  })


  const {
    handleDiscard,
    handleRestoreRequest,
    handleConfirmReplace,
    handleCancelReplace,
  } = createTimelineDraftController({
    getDraft: () => composerState.draft,
    setDraft: (draft) => tc.setDraft(draft),
    discard: (id) => channel.discard(id),
    restore: (id) => tc.restore(id),
    canRestore: (id) =>
      !targetUnavailable && pending.some((p) => p.clientMessageId === id && p.status === 'failed'),
    getComposerRef: () => composerRef,
    getConfirmReplaceId: () => confirmReplaceId,
    setConfirmReplaceId: (id) => {
      confirmReplaceId = id
    },
    afterUpdate: tick,
  })

  const topicUnavailableEmpty = $derived(
    topicUnavailable && view.messages.length === 0 && pending.length === 0,
  )
  const showInitialSkeleton = $derived(
    !topicUnavailableEmpty &&
      !positioning &&
      effectiveStatus === 'loading' &&
      !scrollView.loadingTimedOut &&
      (awaitingInitialSenders || (view.messages.length === 0 && pending.length === 0)),
  )
  const showTopicBody = $derived(!topicUnavailableEmpty && !showInitialSkeleton)

  async function handleSubmit(): Promise<boolean> {
    if (!topicName) return false
    const ok = await tc.submit(topicName)
    if (!ok) return false
    if (search) { await jumpToBottom(); return true }
    if (view.hasNewer) await topics.loadTopicLatest(topicId)
    if (positioning) entryPositionAbandoned = true
    const action = scrollController.onUserSubmit()
    void tick().then(() => {
      applyScrollAction(action, null)
    }).catch(console.error)
    return true
  }
</script>

<TimelineFrame
  ariaLabel="トピックタイムライン"
  classes={{
    root: 'topic-view',
    banner: 'topic-view__banner',
    positioning: 'topic-view__positioning',
    scroll: 'topic-view__scroll',
    scrollPositioning: 'topic-view__scroll--positioning',
    older: 'topic-view__older',
    newBelow: 'topic-view__new-below',
    composer: 'topic-view__composer',
  }}
  reconnecting={reconnecting && !targetUnavailable && s.status === 'ready'}
  {organizationUnavailable}
  {channelUnavailable}
  loadErrorMessage={!search && !targetUnavailable && loadFailed
    ? 'トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。'
    : null}
  onretry={retryInitial}
  {ongoToChannelList}
  {onrecheckmembership}
  {onswitchorganization}
  {positioning}
  positioningLabel="トピックを読み込み中"
  bind:scrollEl
  onscroll={handleScroll}
  showOlder={showTopicBody && view.initialized && view.hasMore && !targetUnavailable}
  olderDisabled={view.loading}
  olderError={view.error}
  onloadolder={loadOlderWithAnchor}
  pinned={scrollView.pinned}
  newerCount={Math.max(scrollView.belowCount, view.newerCount ?? 0)}
  onjumptobottom={() => void jumpToBottom().catch(console.error)}
  {confirmReplaceId}
  returnFocusFallback={composerRef}
  onconfirmreplace={handleConfirmReplace}
  oncancelreplace={handleCancelReplace}
>
  {#snippet beforeOlder()}
    {#if topicUnavailableEmpty}
      <EmptyState
        title="このトピックは利用できません。"
        description="削除されたか、URLが正しくない可能性があります。"
      />
    {:else if showInitialSkeleton}
      <Skeleton rows={4} label="トピックを読み込み中" />
    {:else if topicUnavailable}
      <EmptyState
        title="このトピックは利用できません。"
        description="削除されたか、URLが正しくない可能性があります。"
      />
    {/if}
  {/snippet}

  {#if showTopicBody}
    {#if view.messages.length > 0 || pending.length > 0}
      <VirtualRows
        class="topic-view__list"
        bind:this={rowWindow}
        items={view.messages}
        rowId={(m) => m.id}
        confirmedSeq={(m) => m.created_seq}
        pendingItems={pending}
        pendingId={(p) => p.clientMessageId}
        pendingStatus={(p) => p.status}
        pendingClass="topic-view__item"
        itemClass="topic-view__item"
        container={scrollEl}
        label="メッセージ一覧"
        followBottom={scrollView.pinned && initialScrollApplied}
        onmounted={(ids) => { mountedIds = ids }}
        onvisible={reportPresented}
        onfocuslost={() => focusTarget(composerRef)}
      >
        {#snippet children(m)}
          {#if firstUnreadMessageId === m.id}
            <ReadMarker />
          {/if}
          <MessageRow
            senderName={resolveSenderName ? resolveSenderName(m.sender) : undefined}
            createdAt={m.created_at}
            searchMatch={searchId === m.id}
            body={m.body ?? ''}
            mentions={m.mentions}
            {resolveMentionName}
            {selfId}
            replyCount={replyCounts[m.reply_root_id ?? m.id] ?? null}
            focusable
            rovingTabindex={rovingRowId === m.id ? 0 : -1}
            onopenreplies={onopenreplies && !targetUnavailable
              ? (opener) => onopenreplies(m, opener)
              : undefined}
            onrowfocus={() => {
              activeRowId = m.id
            }}
            onrowkeydown={handleRowKeydown}
          />
        {/snippet}
        {#snippet pendingRow(p)}
          <MessageRow
            body={p.body}
            pendingStatus={p.status}
            failureCode={p.failureCode}
            retryable={p.retryable}
            {targetUnavailable}
            onretry={() => void channel.retry(p.clientMessageId).catch(console.error)}
            onrestore={sendDisabled ? undefined : () => handleRestoreRequest(p.clientMessageId)}
            ondiscard={() => handleDiscard(p.clientMessageId)}
          />
        {/snippet}
      </VirtualRows>
    {:else if !search && effectiveStatus === 'ready'}
      <EmptyState
        title="まだメッセージがありません。"
        description="下の入力欄からメッセージを送信できます。"
      />
    {/if}
  {/if}
  {#if view.hasNewer && !targetUnavailable}
    <Button variant="secondary" onclick={() => void jumpToBottom().catch(console.error)}>最新のメッセージを読み込む</Button>
  {/if}

  {#if search && !targetUnavailable}
    <SearchAnchorStatus {search} onlatest={() => void jumpToBottom().catch(console.error)} />
  {/if}

  {#snippet composer()}
    <Composer
      {members}
      {onmentionrequest}
      bind:textareaRef={composerRef}
      placeholder="トピックにメッセージを入力"
      value={composerState.draft}
      error={composerState.composerError}
      disabled={targetUnavailable || sendDisabled}
      submitDisabled={!topicName}
      oninput={(b) => tc.setDraft(b)}
      onsubmit={handleSubmit}
      onarrowupempty={() => void focusMessage(focusableMessageIds.at(-1)).catch(console.error)}
    />
  {/snippet}
</TimelineFrame>
