<script lang="ts">
  import { tick } from 'svelte'
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
    measureTimelineItems,
    type ScrollAction,
    type ScrollAnchor,
  } from './timeline-scroll'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  // Renders one Reply chain's paged history and own Composer in the right-side panel without owning I/O or sync rules.
  let {
    channel,
    replies,
    channelId,
    anchorMessageId,
    resolvedAnchor = null,
    replyTargetStatus = 'idle',
    selfId = '',
    organizationUnavailable = false,
    composerRef = $bindable(null),
    resolveSenderName,
    onopenreplies,
    onretrytarget,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
  }: {
    channel: ChannelSync
    replies: RepliesAdapter
    channelId: string
    anchorMessageId: string
    resolvedAnchor?: Message | null
    replyTargetStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    selfId?: string
    organizationUnavailable?: boolean
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    resolveSenderName?: (senderId: string) => string
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    onretrytarget?: () => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()

  const s = $derived(channel.timeline)
  const rState = $derived(replies.state)

  let retained = $state<{
    key: string
    rootId: string | null
    topicId: string | null
    messages: Message[]
  }>({ key: '', rootId: null, topicId: null, messages: [] })

  const currentKey = $derived(`${channelId}:${anchorMessageId}`)
  const matchedAnchor = $derived(
    resolvedAnchor && resolvedAnchor.channel_id === channelId
      ? resolvedAnchor
      : rState.anchor?.id === anchorMessageId
        ? rState.anchor
        : (rState.messages.find((m) => m.id === anchorMessageId) ?? null),
  )
  const targetRootId = $derived(
    matchedAnchor
      ? (matchedAnchor.reply_root_id ?? matchedAnchor.id)
      : rState.rootId === anchorMessageId
        ? rState.rootId
        : null,
  )
  const isCurrentAnchor = $derived(
    Boolean(rState.rootId && targetRootId && rState.rootId === targetRootId),
  )

  $effect(() => {
    const key = currentKey
    if (isCurrentAnchor && rState.messages.length > 0) {
      retained = {
        key,
        rootId: rState.rootId,
        topicId: rState.topicId,
        messages: rState.messages,
      }
    } else if (
      retained.key !== key &&
      !rState.unavailable &&
      s.status !== 'unavailable' &&
      !organizationUnavailable
    ) {
      retained = { key, rootId: null, topicId: null, messages: [] }
    }
  })

  const isTargetResolved = $derived(
    Boolean(
      isCurrentAnchor ||
        matchedAnchor ||
        (retained.key === currentKey && retained.rootId !== null),
    ),
  )
  const effectiveRootId = $derived(
    (isCurrentAnchor ? rState.rootId : null) ??
      (matchedAnchor ? (matchedAnchor.reply_root_id ?? matchedAnchor.id) : null) ??
      (retained.key === currentKey ? retained.rootId : null) ??
      anchorMessageId,
  )
  const effectiveTopicId = $derived(
    (isCurrentAnchor ? rState.topicId : null) ??
      (matchedAnchor ? matchedAnchor.topic_id : null) ??
      (retained.key === currentKey ? retained.topicId : null),
  )
  const visibleMessages = $derived(
    isCurrentAnchor && rState.messages.length > 0
      ? rState.messages
      : retained.key === currentKey
        ? retained.messages
        : [],
  )
  const replyCounts = $derived(
    countRepliesByMessageId([s.messages, rState.messages, visibleMessages]),
  )
  const chainMessageIds = $derived(
    new Set([anchorMessageId, effectiveRootId, ...visibleMessages.map((m) => m.id)]),
  )
  const pending = $derived(
    s.pending.filter((p) => p.replyTo !== undefined && (p.replyRootId === effectiveRootId || chainMessageIds.has(p.replyTo))),
  )

  const channelUnavailable = $derived(s.status === 'unavailable' || rState.unavailable)
  const replyNotFound = $derived(
    !organizationUnavailable && !channelUnavailable && replyTargetStatus === 'unavailable',
  )
  const targetUnavailable = $derived(
    organizationUnavailable || channelUnavailable || replyNotFound,
  )
  const rc = $derived(channel.reply(effectiveRootId, effectiveTopicId))
  const composerState = $derived(rc.composer)

  $effect(() => {
    if (!isTargetResolved) return
    rc.migrateDraftFrom(anchorMessageId, null)
  })

  const canSendReply = $derived(!targetUnavailable && isCurrentAnchor)

  const scrollController = createTimelineScrollController()
  const subscribeScroll = createSubscriber((update) => scrollController.subscribe(update))
  const scrollView = $derived.by(() => {
    subscribeScroll()
    return scrollController.get()
  })

  $effect(() => () => scrollController.destroy())

  const hasError = $derived(
    !targetUnavailable &&
      ((isCurrentAnchor && rState.error) ||
        (!isCurrentAnchor && replyTargetStatus === 'error') ||
        scrollView.loadingTimedOut),
  )
  const isLoading = $derived(
    !targetUnavailable && !hasError && (!isCurrentAnchor || rState.loading),
  )
  const chainInitialLoading = $derived(
    !targetUnavailable && !hasError && (!isCurrentAnchor || (rState.loading && visibleMessages.length <= 1)),
  )
  const effectiveScrollStatus = $derived<'loading' | 'ready' | 'unavailable' | 'error'>(
    targetUnavailable
      ? 'unavailable'
      : hasError && visibleMessages.length === 0
        ? 'error'
        : chainInitialLoading
          ? 'loading'
          : 'ready',
  )

  let rowWindow = $state<{ reveal(id: string, focus?: boolean, align?: 'start' | 'end'): Promise<void> } | null>(null)
  let scrollEl = $state<HTMLElement | null>(null)
  let confirmReplaceId = $state<string | null>(null)
  let activeRowId = $state<string | null>(null)
  const focusableMessageIds = $derived(visibleMessages.map((m) => m.id))
  let mountedIds = $state<string[]>([])
  const rovingRowId = $derived(resolveRovingMessageId(focusableMessageIds.filter(id => mountedIds.includes(id)), activeRowId))

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
    replies.setPinned(scrollController.get().pinned)
  }

  function applyScrollAction(action: ScrollAction, anchor: ScrollAnchor | null) {
    applyTimelineScrollAction(scrollEl, scrollController, action, anchor)
  }

  async function jumpToBottom() {
    if (rState.hasNewer) { await replies.loadLatest(); await tick() }
    const action = scrollController.jumpToBottom()
    applyScrollAction(action, null)
  }

  $effect(() => {
    const syncMessages = chainInitialLoading ? [] : visibleMessages
    const pendingIds = chainInitialLoading ? [] : pending.map((p) => p.clientMessageId)
    const { action, anchor } = scrollController.sync({
      channelId: `${channelId}/reply:${effectiveRootId}`,
      status: effectiveScrollStatus,
      messages: syncMessages,
      pendingIds,
      selfId,
    })
    if (action !== 'none') {
      applyScrollAction(action, anchor)
      void tick().then(() => {
        applyScrollAction(action, anchor)
      })
    } else {
      captureCurrentAnchor()
      void tick().then(() => {
        captureCurrentAnchor()
      })
    }
  })

  function handleRetryLoad() {
    scrollController.resetLoadingTimeout()
    if (isCurrentAnchor) {
      void replies.loadMore()
    } else {
      onretrytarget?.()
    }
  }

  async function loadOlder() {
    await replies.loadOlder()
    await tick()
    if (rState.rootId) await rowWindow?.reveal(rState.rootId)
  }

  function handleRestoreRequest(clientMessageId: string) {
    const decision = decideEditAndResend(clientMessageId, composerState.draft)
    if (decision.action === 'restore_now') {
      if (rc.restore(clientMessageId)) {
        focusTarget(composerRef)
      }
      return
    }
    confirmReplaceId = decision.clientMessageId
  }

  function handleConfirmReplace() {
    const id = confirmReplaceId
    confirmReplaceId = null
    if (!id) return
    const canRestore = pending.some(
      (entry) => entry.clientMessageId === id && entry.status === 'failed' && !entry.retryable,
    )
    confirmReplaceDraftWithFailedSend(
      id,
      composerState.draft,
      canRestore,
      (d) => rc.setDraft(d),
      (targetId) => rc.restore(targetId),
      composerRef,
    )
  }

  function handleCancelReplace() {
    confirmReplaceId = null
  }

  function handleDiscard(clientMessageId: string) {
    discardAndFocusComposer(clientMessageId, (id) => channel.discard(id), composerRef)
  }

  async function handleSubmit(): Promise<boolean> {
    if (!canSendReply) return false
    const ok = await rc.submit(anchorMessageId)
    if (!ok) return false
    if (rState.hasNewer) await replies.loadLatest()
    const action = scrollController.onUserSubmit()
    applyScrollAction(action, null)
    void tick().then(() => {
      applyScrollAction(action, null)
    })
    return true
  }

</script>

<div class="reply-panel">
  {#if organizationUnavailable}
    <div class="reply-panel__banner">
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
    <div class="reply-panel__banner">
      <StatusBanner
        tone="danger"
        role="alert"
        message="このチャンネルは利用できません。"
        detail="チャンネルが削除されたか、アクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。"
        actionLabel={ongoToChannelList ? 'チャンネル一覧へ' : undefined}
        onaction={ongoToChannelList}
      />
    </div>
  {:else if hasError}
    <div class="reply-panel__banner">
      <StatusBanner
        tone="danger"
        role="alert"
        message="返信のつながりを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
        actionLabel="再試行"
        onaction={handleRetryLoad}
      />
    </div>
  {/if}

  <div class="reply-panel__scroll" bind:this={scrollEl} onscroll={handleScroll}>
    {#if replyNotFound && visibleMessages.length === 0 && pending.length === 0}
      <EmptyState title="この返信のつながりは利用できません。" />
    {:else if isLoading && !scrollView.loadingTimedOut && visibleMessages.length === 0 && pending.length === 0}
      <Skeleton rows={3} label="返信のつながりを読み込み中" />
    {:else}
      {#if replyNotFound}
        <EmptyState title="この返信のつながりは利用できません。" />
      {/if}

      {#if rState.hasOlder && !targetUnavailable}
        <Button variant="secondary" onclick={loadOlder}>以前の返信を読み込む</Button>
      {/if}
      {#if visibleMessages.length > 0 || pending.length > 0}
        <VirtualRows
        class="reply-panel__list"
        bind:this={rowWindow}
        items={visibleMessages}
        rowId={(m) => m.id}
        pendingItems={pending}
        pendingId={(p) => p.clientMessageId}
        pendingStatus={(p) => p.status}
        pendingClass="reply-panel__item"
        itemClass={(m) => m.id === effectiveRootId ? 'reply-panel__item reply-panel__item--root' : 'reply-panel__item'}
        container={scrollEl}
        label="返信のつながりのメッセージ一覧"
        followBottom={scrollView.pinned}
        onmounted={(ids) => { mountedIds = ids }}
        onfocuslost={() => focusTarget(composerRef)}
      >
        {#snippet children(m)}

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
                onrowkeydown={handleRowKeydown}
              />

          {/snippet}
        {#snippet pendingRow(p)}
          <MessageRow
            body={p.body}
            pendingStatus={p.status}
            retryable={p.retryable}
            {targetUnavailable}
            onretry={() => void rc.retry(p.clientMessageId)}
            onrestore={() => handleRestoreRequest(p.clientMessageId)}
            ondiscard={() => handleDiscard(p.clientMessageId)}
          />
        {/snippet}
        </VirtualRows>
      {/if}

      {#if isLoading && visibleMessages.length > 0}
        <Skeleton rows={2} label="返信のつながりを読み込み中" />
      {/if}

      {#if !targetUnavailable && isCurrentAnchor && rState.hasMore && !rState.error && !(rState.loading && visibleMessages.length <= 1)}
        <div class="reply-panel__more">
          <Button variant="secondary" disabled={rState.loading} onclick={() => void replies.loadMore()}>
            さらに返信を読み込む
          </Button>
        </div>
      {/if}
    {/if}
  </div>

  {#if !scrollView.pinned && (scrollView.belowCount > 0 || rState.newerCount > 0)}
    <div class="reply-panel__new-below">
      <Button variant="primary" onclick={jumpToBottom}>
        新着 {Math.max(scrollView.belowCount, rState.newerCount)}件 ↓
      </Button>
    </div>
  {/if}

  <div class="reply-panel__composer">
    <Composer
      bind:textareaRef={composerRef}
      placeholder="返信を入力"
      value={composerState.draft}
      error={composerState.composerError}
      disabled={targetUnavailable}
      submitDisabled={!canSendReply}
      oninput={(b) => rc.setDraft(b)}
      onsubmit={handleSubmit}
      onarrowupempty={() => void focusMessage(focusableMessageIds.at(-1))}
    />
  </div>

  <Dialog
    open={confirmReplaceId !== null}
    title="入力中の下書きを置き換えますか？"
    description="失敗したメッセージを編集欄に戻すと、現在入力中の下書きは上書きされます。"
    confirmLabel="置き換える"
    cancelLabel="キャンセル"
    returnFocusFallback={composerRef}
    onconfirm={handleConfirmReplace}
    oncancel={handleCancelReplace}
  />
</div>

<style>
  .reply-panel {
    position: relative;
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .reply-panel__banner {
    padding: var(--space-8) var(--space-12) 0;
    min-width: 0;
  }

  .reply-panel__scroll {
    grid-row: 2;
    overflow-y: auto;
    overflow-anchor: none;
    padding: var(--space-12);
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    min-height: 0;
    min-width: 0;
  }

  :global(.reply-panel__item--root) {
    padding-bottom: var(--space-8);
    border-bottom: 1px solid var(--border);
  }


  .reply-panel__more {
    display: flex;
    justify-content: flex-start;
    min-width: 0;
  }

  .reply-panel__new-below {
    position: absolute;
    bottom: calc(var(--space-24) * 4);
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
  }

  .reply-panel__composer {
    grid-row: 3;
    padding: var(--space-8) var(--space-12) var(--space-12);
    min-width: 0;
  }
</style>
