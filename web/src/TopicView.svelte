<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import type { Message } from './api'
  import { resolveRovingMessageId, stepMessageRowIndex } from './composer-keys'
  import Composer from './Composer.svelte'
  import {
    confirmReplaceDraftWithFailedSend,
    decideEditAndResend,
    discardAndFocusComposer,
    focusTarget,
  } from './focus-management'
  import { countRepliesByMessageId, type RepliesAdapter } from './replies.svelte'
  import { foldTopicName, type ChannelSync } from './sync.svelte'
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
  import type { TopicsAdapter } from './topics.svelte'
  import type { UnreadAdapter } from './unread.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import ReadMarker from './ui/ReadMarker.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

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
    organizationUnavailable = false,
    reconnecting = false,
    resolveSenderName,
    composerRef = $bindable(null),
    onopenreplies,
    onretrytopicmeta,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
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
    organizationUnavailable?: boolean
    reconnecting?: boolean
    resolveSenderName?: (senderId: string) => string
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    onretrytopicmeta?: () => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()

  const s = $derived(channel.timeline)
  const tc = $derived(channel.topic(topicId))
  const composerState = $derived(tc.composer)
  const tState = $derived(topics.state)
  const rState = $derived(replies ? replies.state : null)
  const uState = $derived(unread ? unread.state : null)
  const view = $derived(tState.topic(topicId))
  const entry = $derived(uState?.entry?.scope.topicId === topicId ? uState.entry : null)
  const uGeneration = $derived(uState?.generation ?? null)
  const entryId = $derived(entry?.id ?? null)
  const hasFirstUnreadInView = $derived(
    Boolean(entry?.firstUnread && view.messages.some((m) => m.id === entry.firstUnread!.id)),
  )
  const needsOlderUnreadPage = $derived(
    Boolean(
      entry &&
        (entry.unreadAtEntry ?? 0) > 0 &&
        (entry.needsOlder || (entry.firstUnread !== null && !hasFirstUnreadInView)),
    ),
  )
  const firstUnreadMessageId = $derived(
    entry &&
      entry.boundary !== null &&
      (entry.unreadAtEntry ?? 0) > 0 &&
      !needsOlderUnreadPage &&
      entry.firstUnread
      ? entry.firstUnread.id
      : null,
  )
  const replyCounts = $derived(
    countRepliesByMessageId([s.messages, view.messages, rState?.messages ?? []]),
  )
  const channelUnavailable = $derived(s.status === 'unavailable' || tState.unavailable)
  const topicUnavailable = $derived(
    !organizationUnavailable && !channelUnavailable && (topicStatus === 'unavailable' || view.notFound),
  )
  const targetUnavailable = $derived(
    organizationUnavailable || channelUnavailable || topicUnavailable,
  )
  const topicScope = $derived(uState?.topics[topicId] ?? null)
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
  let activeRowId = $state<string | null>(null)
  let requestedHistoryFor = ''
  let initialScrollApplied = false
  let scrolledFirstUnreadId: string | null = null
  let lastScrollScopeKey = ''
  let lastScrollEntryId: symbol | null = null
  let currentVisitId: symbol | undefined
  let enteredTarget = false
  const topicStopped = $derived(Boolean(uState?.stopped || topicScope?.stopped))
  const focusableMessageIds = $derived(view.messages.map((m) => m.id))
  const rovingRowId = $derived(resolveRovingMessageId(focusableMessageIds, activeRowId))

  function isDocumentVisible(): boolean {
    if (typeof document === 'undefined') return true
    return (document.visibilityState ?? 'visible') === 'visible'
  }

  function reportPresented() {
    if (!unread || !isTimelineDisplayed(scrollEl, viewSelected) || targetUnavailable) return
    if (!isDocumentVisible()) return
    const currentEntry = uState?.entry
    if (!currentEntry || currentEntry.scope.topicId !== topicId) return
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

  function captureCurrentAnchor() {
    if (!scrollEl) return
    scrollController.captureAnchor(measureTimelineItems(scrollEl))
  }

  function handleScroll() {
    handleTimelineContainerScroll(scrollEl, scrollController)
    reportPresented()
  }

  function applyScrollAction(
    action: ScrollAction,
    anchor: ScrollAnchor | null,
    firstUnreadId?: string | null,
  ) {
    applyTimelineScrollAction(scrollEl, scrollController, action, anchor, firstUnreadId)
  }

  function jumpToBottom() {
    const action = scrollController.jumpToBottom()
    applyScrollAction(action, null)
    reportPresented()
  }

  function loadOlderWithAnchor() {
    captureCurrentAnchor()
    void topics.loadTopic(topicId)
  }

  function retryInitial() {
    scrollController.resetLoadingTimeout()
    if (topicStatus === 'error') onretrytopicmeta?.()
    requestedHistoryFor = ''
    void topics.retrySummary(topicId)
    void topics.loadTopic(topicId)
  }

  $effect(() => () => scrollController.destroy())

  $effect(() => {
    const u = unread
    const id = channelId
    const tId = topicId
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
    const id = channelId
    const tId = topicId
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
    const key = `${channelId}:${topicId}:${tState.generation}`
    if (targetUnavailable || s.status === 'loading') return
    const hasBaseline = tState.topics.some((t) => t.topicId === topicId && t.baseline !== null)
    if (!hasBaseline && view.summaryError === null) {
      void topics.ensureSummary(topicId)
    }
    if (!view.initialized && view.hasMore && !view.loading && !view.error && requestedHistoryFor !== key) {
      requestedHistoryFor = key
      void topics.loadTopic(topicId)
    }
  })

  $effect(() => {
    if (!needsOlderUnreadPage || !view.initialized || !view.hasMore || view.loading || view.error || targetUnavailable) {
      return
    }
    if (effectiveStatus !== 'ready') return
    loadOlderWithAnchor()
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
    const scopeKey = `${channelId}/${topicId}`
    const currentEntryId = entryId
    if (
      scopeKey !== lastScrollScopeKey ||
      (currentEntryId !== null && currentEntryId !== lastScrollEntryId)
    ) {
      lastScrollScopeKey = scopeKey
      lastScrollEntryId = currentEntryId
      initialScrollApplied = false
      scrolledFirstUnreadId = null
    }
    const displayed = isTimelineDisplayed(scrollEl, viewSelected)
    const messages = view.messages
    const pendingIds = pending.map((p) => p.clientMessageId)
    const status = effectiveStatus
    const targetFirstUnreadId = firstUnreadMessageId
    const awaitingFirstUnread =
      awaitingEntryBoundary || Boolean(needsOlderUnreadPage && view.hasMore && !view.error)
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
    })
    if (action !== 'none') {
      void tick().then(() => {
        if (!isTimelineDisplayed(scrollEl, viewSelected)) {
          if (action === 'scroll_bottom' || action === 'scroll_first_unread') {
            scrollController.resetInitialScroll()
          }
          return
        }
        applyScrollAction(action, anchor, targetFirstUnreadId)
        if (action === 'scroll_first_unread' && targetFirstUnreadId) {
          scrolledFirstUnreadId = targetFirstUnreadId
        }
        if (action === 'scroll_bottom' || action === 'scroll_first_unread') {
          initialScrollApplied = true
        }
        reportPresented()
      })
    } else {
      void tick().then(() => {
        if (!isTimelineDisplayed(scrollEl, viewSelected)) return
        captureCurrentAnchor()
        if (status === 'ready' && !awaitingFirstUnread && !targetFirstUnreadId) {
          initialScrollApplied = true
        }
        reportPresented()
      })
    }
  })

  $effect(() => {
    if (!unread || !viewSelected || targetUnavailable) return
    if (entry?.boundary === null || needsOlderUnreadPage) return
    void tick().then(() => {
      reportPresented()
    })
  })

  $effect(() => {
    const container = scrollEl
    const u = unread
    if (!container || !u || typeof IntersectionObserver === 'undefined') return
    void view.messages
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          reportPresented()
        }
      },
      { root: container, threshold: 0 },
    )
    for (const node of container.querySelectorAll<HTMLElement>('[data-confirmed-seq]')) {
      observer.observe(node)
    }
    return () => observer.disconnect()
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

  {#if organizationUnavailable}
    <div class="topic-view__banner">
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
  {:else if channelUnavailable}
    <div class="topic-view__banner">
      <StatusBanner
        tone="danger"
        role="alert"
        message="このチャンネルは利用できません。"
        detail="アクセス権がないか、削除された可能性があります。"
        actionLabel={ongoToChannelList ? 'チャンネル一覧へ' : undefined}
        onaction={ongoToChannelList}
      />
    </div>
  {:else if !targetUnavailable && (effectiveStatus === 'error' || (effectiveStatus === 'loading' && scrollView.loadingTimedOut))}
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
    {#if topicUnavailable && view.messages.length === 0 && pending.length === 0}
      <EmptyState
        title="このトピックは利用できません。"
        description="削除されたか、URLが正しくない可能性があります。"
      />
    {:else if effectiveStatus === 'loading' && !scrollView.loadingTimedOut && view.messages.length === 0 && pending.length === 0}
      <Skeleton rows={4} label="トピックを読み込み中" />
    {:else}
      {#if topicUnavailable}
        <EmptyState
          title="このトピックは利用できません。"
          description="削除されたか、URLが正しくない可能性があります。"
        />
      {/if}
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
            <li
              class="topic-view__item"
              data-message-id={m.id}
              data-confirmed-seq={m.seq}
            >
              {#if firstUnreadMessageId === m.id}
                <ReadMarker />
              {/if}
              <MessageRow
                senderName={resolveSenderName ? resolveSenderName(m.sender) : undefined}
                createdAt={m.created_at}
                body={m.body}
                replyCount={replyCounts.get(m.id) ?? 0}
                focusable
                rovingTabindex={rovingRowId === m.id ? 0 : -1}
                onopenreplies={onopenreplies && !targetUnavailable
                  ? (opener) => onopenreplies(m, opener)
                  : undefined}
                onrowfocus={() => {
                  activeRowId = m.id
                }}
                onrowkeydown={(e) => {
                  if (!scrollEl) return
                  const rows = Array.from(scrollEl.querySelectorAll<HTMLElement>('.ui-message-row[data-focusable="true"]'))
                  const idx = rows.indexOf(e.currentTarget as HTMLElement)
                  const nextIdx = stepMessageRowIndex(idx, rows.length, e)
                  if (nextIdx !== null) {
                    e.preventDefault()
                    const nextId = focusableMessageIds[nextIdx]
                    if (nextId) activeRowId = nextId
                    focusTarget(rows[nextIdx])
                  }
                }}
              />
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
      onarrowupempty={() => {
        if (!scrollEl) return
        const rows = scrollEl.querySelectorAll<HTMLElement>('.ui-message-row[data-focusable="true"]')
        if (rows.length > 0) {
          const lastId = focusableMessageIds.at(-1)
          if (lastId) activeRowId = lastId
          focusTarget(rows[rows.length - 1])
        }
      }}
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
