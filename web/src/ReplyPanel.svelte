<script lang="ts">
  import type { Member } from './api'
  import type { MentionName } from './mentions'
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
  import type { MoveDestination, MoveResult } from './move-chain'
  import { type RepliesAdapter } from './replies.svelte'
  import { topicNameError, type ChannelSync } from './sync.svelte'
  import {
    applyTimelineScrollAction,
    createTimelineScrollController,
    handleTimelineContainerScroll,
    measureTimelineItems,
    type ScrollAction,
    type ScrollAnchor,
  } from './timeline-scroll'
  import type { TopicsAdapter } from './topics.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Input from './ui/Input.svelte'
  import MessageRow from './ui/MessageRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  // Renders one Reply chain's paged history and own Composer in the right-side panel without owning I/O or sync rules.
  let {
    channel,
    replies,
    topics = null,
    moveChain,
    onannounce,
    channelId,
    anchorMessageId,
    resolvedAnchor = null,
    replyTargetStatus = 'idle',
    selfId = '',
    organizationUnavailable = false,
    sendDisabled = false,
    archived = false,
    composerRef = $bindable(null),
    resolveSenderName,
    resolveMentionName,
    members = [],
    onmentionrequest,
    onopenreplies,
    onretrytarget,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
  }: {
    channel: ChannelSync
    replies: RepliesAdapter
    topics?: TopicsAdapter | null
    moveChain?: (channel: string, anchor: string, destination: MoveDestination) => Promise<MoveResult>
    onannounce?: (message: string) => void
    channelId: string
    anchorMessageId: string
    resolvedAnchor?: Message | null
    replyTargetStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    selfId?: string
    organizationUnavailable?: boolean
    sendDisabled?: boolean
    archived?: boolean
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    resolveSenderName?: (senderId: string) => string
    resolveMentionName?: MentionName
    members?: readonly Member[]
    onmentionrequest?: () => void
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    onretrytarget?: () => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()

  const s = $derived(channel.timeline)
  const rState = $derived(replies.state)
  const tState = $derived(topics ? topics.state : null)
  const orderedTopics = $derived(tState ? [...tState.topics].reverse() : [])

  let moveDialogOpen = $state(false)
  let moveButtonRef = $state<HTMLButtonElement | null>(null)
  let moveSelectRef = $state<HTMLSelectElement | null>(null)
  let moveTopicNameRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let moveNewRadioRef = $state<HTMLInputElement | null>(null)
  let moveMode = $state<'existing' | 'new'>('new')
  let moveTopic = $state.raw<(typeof orderedTopics)[number] | null>(null)
  let moveTopicName = $state('')
  let moveBusy = $state(false)
  let moveError = $state<string | null>(null)
  let moveNotice = $state<string | null>(null)
  let moveRetry = $state<{ destination: MoveDestination; retry: () => Promise<MoveResult> } | null>(null)
  let moveRefreshFailed = $state(false)
  let moveGeneration = 0
  let moveDialogOpening = 0

  const moveTopicId = $derived(moveTopic?.topicId ?? '')
  const moveListSettled = $derived(
    tState !== null && tState.list.asOfSeq !== undefined && !tState.list.loading && !tState.list.error,
  )
  const moveDestination: MoveDestination = $derived(
    moveMode === 'existing' ? { topicId: moveTopicId } : { topicName: moveTopicName },
  )
  const displayedMoveRetry = $derived(
    moveRetry &&
      moveRetry.destination.topicId === moveDestination.topicId &&
      moveRetry.destination.topicName === moveDestination.topicName
      ? moveRetry
      : null,
  )
  const selectableTopics = $derived(
    orderedTopics.filter((t) => !(tState && !tState.unavailable && tState.topic(t.topicId).notFound)),
  )
  const moveSelectedInList = $derived(
    moveTopicId !== '' && selectableTopics.some((t) => t.topicId === moveTopicId),
  )
  const moveListComplete = $derived(
    moveListSettled && tState !== null && !tState.unavailable && !tState.list.hasMore,
  )
  const moveTopicGone = $derived(
    moveMode === 'existing' &&
      moveTopic !== null &&
      ((moveListComplete && !moveSelectedInList) ||
        Boolean(tState && !tState.unavailable && tState.topic(moveTopic.topicId).notFound)),
  )
  const moveDestinationUnavailable = $derived(moveTopicGone && displayedMoveRetry === null)
  const moveOptions = $derived(
    moveMode === 'existing' && moveTopic && !moveSelectedInList && !moveDestinationUnavailable
      ? [...selectableTopics, moveTopic]
      : selectableTopics,
  )

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
      : rState.rootId && (rState.rootId === anchorMessageId || rState.anchorId === anchorMessageId)
        ? rState.rootId
        : null,
  )
  const isCurrentAnchor = $derived(
    Boolean(rState.rootId && targetRootId && rState.rootId === targetRootId),
  )
  const isMoveInvalidated = $derived(isCurrentAnchor && rState.moveInvalidated)

  $effect(() => {
    const key = currentKey
    if (isCurrentAnchor && !rState.moveInvalidated && rState.messages.length > 0) {
      retained = {
        key,
        rootId: rState.rootId,
        topicId: rState.topicId,
        messages: rState.messages,
      }
    } else if (
      isMoveInvalidated ||
      (retained.key !== key &&
        !rState.unavailable &&
        s.status !== 'unavailable' &&
        !organizationUnavailable)
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
    isMoveInvalidated
      ? null
      : (isCurrentAnchor ? rState.topicId : null) ??
          (matchedAnchor ? matchedAnchor.topic_id : null) ??
          (retained.key === currentKey ? retained.topicId : null),
  )
  const historyMessages = $derived(
    isMoveInvalidated
      ? []
      : isCurrentAnchor && rState.messages.length > 0
        ? rState.messages
        : retained.key === currentKey
          ? retained.messages
          : [],
  )
  // The active navigation anchor is retained separately from the bounded history.
  const visibleMessages = $derived(
    !isMoveInvalidated && isCurrentAnchor && rState.anchor?.id === anchorMessageId && !historyMessages.some(m => m.id === anchorMessageId)
      ? [...historyMessages, rState.anchor].sort((a, b) => a.created_seq - b.created_seq)
      : historyMessages,
  )
  const replyCounts = $derived(replies.counts ?? {})
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
  let draftTarget = $state.raw<{ channelId: string; rootId: string; topicId: string | null } | null>(null)
  const previousDraftTarget = $derived(
    draftTarget?.channelId === channelId && draftTarget.rootId === effectiveRootId ? draftTarget : null,
  )
  const draftTopicId = $derived(isMoveInvalidated ? previousDraftTarget?.topicId ?? null : effectiveTopicId)
  const rc = $derived(channel.reply(effectiveRootId, draftTopicId))
  const composerState = $derived(rc.composer)

  $effect(() => {
    if (!isTargetResolved) return
    rc.migrateDraftFrom(anchorMessageId, null)
    if (!isCurrentAnchor || rState.chainVersion === undefined) return
    if (previousDraftTarget && previousDraftTarget.topicId !== draftTopicId) {
      rc.migrateDraftFrom(effectiveRootId, previousDraftTarget.topicId)
    }
    rc.reconcileDrafts()
    if (!previousDraftTarget || previousDraftTarget.topicId !== draftTopicId) {
      draftTarget = { channelId, rootId: effectiveRootId, topicId: draftTopicId }
    }
  })

  const canSendReply = $derived(!targetUnavailable && isCurrentAnchor)
  const canMoveChain = $derived(
    !targetUnavailable && isCurrentAnchor && (rState.chainVersion !== undefined || displayedMoveRetry !== null),
  )
  const currentTopicName = $derived(
    effectiveTopicId
      ? (tState?.topics.find((t) => t.topicId === effectiveTopicId)?.baseline?.summary.name ?? 'トピック')
      : null,
  )
  const moveSubmitDisabled = $derived(
    moveBusy ||
      !canMoveChain ||
      (moveMode === 'existing' ? moveTopicId === '' || moveDestinationUnavailable : moveTopicName === ''),
  )

  let lastMoveKey = ''
  $effect(() => {
    const key = `${channelId}:${effectiveRootId}`
    if (key !== lastMoveKey) {
      lastMoveKey = key
      moveGeneration++
      moveDialogOpening++
      moveDialogOpen = false
      moveBusy = false
      moveError = null
      moveNotice = null
      moveRetry = null
      moveRefreshFailed = false
    }
  })

  $effect(() => {
    if (!moveDialogOpen || !topics || !tState || targetUnavailable || tState.unavailable) return
    if (tState.list.asOfSeq === undefined && !tState.list.loading && !tState.list.error) {
      void topics.loadList().catch(console.error)
    }
    for (const topic of tState.topics) {
      if (topic.baseline === null && topic.summaryError === null) {
        void topics.ensureSummary(topic.topicId).catch(console.error)
      }
    }
  })

  $effect(() => {
    if (!moveDialogOpen || moveMode !== 'existing' || !moveTopic) return
    const current = orderedTopics.find((t) => t.topicId === moveTopic!.topicId)
    if (current) {
      moveTopic = current
    }
  })

  $effect(() => {
    if (moveRetry && !displayedMoveRetry) moveRetry = null
  })

  function openMoveDialog() {
    if (!topics || targetUnavailable) return
    moveDialogOpening++
    moveError = null
    moveNotice = null
    moveRetry = null
    moveRefreshFailed = false
    moveTopic = selectableTopics.find((t) => t.topicId !== effectiveTopicId) ?? selectableTopics[0] ?? null
    moveMode = moveTopic ? 'existing' : 'new'
    moveTopicName = ''
    moveDialogOpen = true
  }

  function closeMoveDialog() {
    if (moveBusy) return
    moveDialogOpening++
    moveDialogOpen = false
    moveError = null
    moveRetry = null
    moveRefreshFailed = false
  }

  function formatMoveFailure(result: Exclude<MoveResult, { kind: 'moved' }>): string {
    switch (result.kind) {
      case 'unknown':
        return '移動を確認できませんでした。通信状況を確認して、もう一度お試しください。'
      case 'conflict':
        return result.refreshed
          ? '返信のつながりが更新されました。最新の状態を読み込みましたので、もう一度お試しください。'
          : '返信のつながりが更新されましたが、最新の状態を読み込めませんでした。通信状況を確認して、再読み込みしてください。'
      case 'too_large':
        return 'メッセージが1,000件を超える返信のつながりは移動できません。'
      case 'archived':
        return result.message
      case 'denied':
        return 'この返信のつながりをトピックに移動する権限がありません。'
      case 'not_found':
        return '移動対象の返信のつながりまたは移動先のトピックが見つかりません。'
      case 'snapshot_expired':
        return '表示していた情報が古くなりました。もう一度お試しください。'
      case 'history_generation_changed':
        return '履歴が更新されました。読み込み直してから、もう一度お試しください。'
      case 'baseline_unavailable':
        return '返信のつながりを読み込んでから、もう一度お試しください。'
      case 'superseded':
        return '移動対象が変更されたため、移動を中断しました。もう一度お試しください。'
      case 'failed':
        return 'トピックに移動できませんでした。入力内容を確認して、もう一度お試しください。'
    }
  }

  async function runMoveAttempt(destination: MoveDestination, action: () => Promise<MoveResult>) {
    if (moveBusy) return
    const gen = ++moveGeneration
    moveBusy = true
    moveError = null
    moveRefreshFailed = false
    try {
      const result = await action()
      if (gen !== moveGeneration) return
      if (result.kind === 'moved') {
        moveDialogOpening++
        moveRetry = null
        moveRefreshFailed = false
        moveDialogOpen = false
        moveNotice = 'トピックに移動しました。'
        onannounce?.('トピックに移動しました。')
        return
      }
      moveRetry = result.kind === 'unknown' ? { destination, retry: result.retry } : null
      moveRefreshFailed = result.kind === 'conflict' && !result.refreshed
      moveError = formatMoveFailure(result)
    } catch (err) {
      console.error(err)
      if (gen !== moveGeneration) return
      moveError = '移動を確認できませんでした。通信状況を確認して、もう一度お試しください。'
    } finally {
      if (gen === moveGeneration) moveBusy = false
    }
  }

  async function handleSubmitMove() {
    if (moveSubmitDisabled) return
    if (displayedMoveRetry) {
      await handleRetryMove()
      return
    }
    const destination = moveDestination
    if (destination.topicName !== undefined) {
      const nameError = topicNameError(destination.topicName)
      if (nameError !== null) {
        moveError = nameError
        return
      }
    }
    await runMoveAttempt(destination, () =>
      moveChain ? moveChain(channelId, anchorMessageId, destination) : replies.move(anchorMessageId, destination),
    )
  }

  async function handleRetryMove() {
    const retry = displayedMoveRetry
    if (!retry || moveBusy) return
    await runMoveAttempt(retry.destination, retry.retry)
  }

  async function handleReloadChainForMove() {
    if (moveBusy || rState.loading || targetUnavailable) return
    scrollController.resetLoadingTimeout()
    if (!isCurrentAnchor) {
      onretrytarget?.()
      return
    }
    const gen = moveGeneration
    await replies.loadMore().catch(console.error)
    if (gen !== moveGeneration || !moveRefreshFailed || rState.chainVersion === undefined) return
    moveError = null
    moveRefreshFailed = false
  }

  function focusStableMoveDialogControl(): boolean {
    return (
      (moveMode === 'existing' && focusTarget(moveSelectRef)) ||
      (moveMode === 'new' && focusTarget(moveTopicNameRef)) ||
      focusTarget(moveSelectRef) ||
      focusTarget(moveTopicNameRef) ||
      focusTarget(moveNewRadioRef)
    )
  }

  async function handleLoadMoreTopics() {
    if (!topics || moveBusy || tState?.list.loading) return
    const gen = moveGeneration
    const opening = moveDialogOpening
    focusStableMoveDialogControl()
    await topics.loadList().catch(console.error)
    await tick()
    if (gen !== moveGeneration || opening !== moveDialogOpening || !moveDialogOpen) return
    const active = typeof document !== 'undefined' ? document.activeElement : null
    const focusLost =
      !active ||
      active === document.body ||
      active === document.documentElement ||
      (active instanceof HTMLElement &&
        (!active.isConnected || ('disabled' in active && Boolean((active as HTMLButtonElement).disabled))))
    if (!focusLost) return
    focusStableMoveDialogControl()
  }

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
  const chainLoadError = '返信のつながりを読み込めませんでした。通信状況を確認して、もう一度お試しください。'
  const moveChainReadFailed = $derived(
    !targetUnavailable && !rState.loading && (!isCurrentAnchor || rState.chainVersion === undefined) && hasError,
  )
  const canReloadMoveChain = $derived(!moveBusy && moveChainReadFailed)
  const isLoading = $derived(
    !targetUnavailable && !hasError && (!isCurrentAnchor || rState.loading || isMoveInvalidated),
  )
  const chainInitialLoading = $derived(
    !targetUnavailable && !hasError && (!isCurrentAnchor || isMoveInvalidated || (rState.loading && visibleMessages.length <= 1)),
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
    void focusMessage(focusableMessageIds[next]).catch(console.error)
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
      }).catch(console.error)
    } else {
      captureCurrentAnchor()
      void tick().then(() => {
        captureCurrentAnchor()
      }).catch(console.error)
    }
  })

  function handleRetryLoad() {
    scrollController.resetLoadingTimeout()
    if (isCurrentAnchor) {
      void replies.loadMore().catch(console.error)
    } else {
      onretrytarget?.()
    }
  }

  async function loadOlder() {
    await replies.loadOlder()
    await tick()
    if (rState.rootId) await rowWindow?.reveal(rState.rootId)
  }

  let previousAnchorKey = ''
  let previousRootId: string | null = null
  let revealAnchorKey = $state('')
  $effect(() => {
    const key = currentKey, root = targetRootId
    if (!root) return
    if (previousAnchorKey !== key) revealAnchorKey = previousRootId === root || matchedAnchor?.reply_root_id ? key : ''
    previousAnchorKey = key
    previousRootId = root
  })
  $effect(() => {
    const key = currentKey, id = anchorMessageId
    if (revealAnchorKey !== key || !isCurrentAnchor || chainInitialLoading || !rowWindow ||
      !visibleMessages.some(m => m.id === id)) return
    revealAnchorKey = ''
    void tick().then(async () => {
      if (currentKey !== key) return
      const row = scrollEl?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
      const rect = row?.getBoundingClientRect(), viewport = scrollEl?.getBoundingClientRect()
      if (!rect || !viewport || rect.top < viewport.top || rect.bottom > viewport.bottom) await rowWindow?.reveal(id)
      handleScroll()
    }).catch(console.error)
  })

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
    }).catch(console.error)
    return true
  }

</script>

<div class="reply-panel">
  <div class="reply-panel__header">
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
          message={chainLoadError}
          actionLabel="再試行"
          onaction={handleRetryLoad}
        />
      </div>
    {/if}

    <div class="reply-panel__actions">
      {#if currentTopicName}
        <span class="reply-panel__topic-label">トピック: {currentTopicName}</span>
      {/if}
      {#if topics}
        <Button
          bind:buttonRef={moveButtonRef}
          variant="secondary"
          disabled={targetUnavailable || moveBusy}
          onclick={openMoveDialog}
        >
          トピックに移動
        </Button>
      {/if}
    </div>

    {#if moveNotice}
      <div class="reply-panel__banner">
        <StatusBanner tone="info" role={null} message={moveNotice} />
      </div>
    {/if}
  </div>

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
        <Button variant="secondary" onclick={() => void loadOlder().catch(console.error)}>以前の返信を読み込む</Button>
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
            retryable={p.retryable}
            failedReason={p.failureCode === 'dm_peer_deactivated' ? 'このメンバーは無効化されています。履歴は引き続き閲覧できます。' : p.failureCode === 'dm_peer_access_lapsed' ? 'このダイレクトメッセージには現在送信できません。' : undefined}
            {targetUnavailable}
            onretry={() => void rc.retry(p.clientMessageId).catch(console.error)}
            onrestore={sendDisabled ? undefined : () => handleRestoreRequest(p.clientMessageId)}
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
          <Button variant="secondary" disabled={rState.loading} onclick={() => void replies.loadMore().catch(console.error)}>
            さらに返信を読み込む
          </Button>
        </div>
      {/if}
    {/if}
  </div>

  {#if !scrollView.pinned && (scrollView.belowCount > 0 || rState.newerCount > 0)}
    <div class="reply-panel__new-below">
      <Button variant="primary" onclick={() => void jumpToBottom().catch(console.error)}>
        新着 {Math.max(scrollView.belowCount, rState.newerCount)}件 ↓
      </Button>
    </div>
  {/if}

  <div class="reply-panel__composer">
    {#if archived && !targetUnavailable}
      <StatusBanner message="このチャンネルはアーカイブされています。メッセージを送信できませんが、履歴は引き続き閲覧できます。" />
    {/if}
    <Composer
      {members}
      {onmentionrequest}
      bind:textareaRef={composerRef}
      placeholder="返信を入力"
      value={composerState.draft}
      error={composerState.composerError}
      disabled={targetUnavailable || sendDisabled}
      submitDisabled={!canSendReply}
      oninput={(b) => rc.setDraft(b)}
      onsubmit={handleSubmit}
      onarrowupempty={() => void focusMessage(focusableMessageIds.at(-1)).catch(console.error)}
    />
  </div>

  <Dialog
    open={moveDialogOpen}
    busy={moveBusy}
    title="トピックに移動"
    description="この返信のつながり全体を移動先のトピックに移します。"
    cancelLabel="キャンセル"
    returnFocusFallback={moveButtonRef ?? composerRef}
    oncancel={closeMoveDialog}
  >
    <form
      class="reply-panel__move-form"
      onsubmit={(e) => {
        e.preventDefault()
        void handleSubmitMove()
      }}
    >
      {#if !canMoveChain && !moveChainReadFailed && !targetUnavailable}
        <p class="reply-panel__move-status">返信のつながりを読み込んでいます…</p>
      {/if}
      {#if topics && tState && tState.list.asOfSeq === undefined && tState.list.error && !targetUnavailable && !tState.unavailable}
        <StatusBanner
          tone="danger"
          role="alert"
          message="トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
          actionLabel="再試行"
          actionAriaLabel="トピック一覧の読み込みを再試行"
          actionDisabled={tState.list.loading || moveBusy}
          onaction={() => void handleLoadMoreTopics()}
        />
      {/if}
      <fieldset class="reply-panel__move-fieldset" disabled={moveBusy}>
        <legend class="reply-panel__move-legend">移動先</legend>
        {#if moveOptions.length > 0 || moveDestinationUnavailable}
          <label class="reply-panel__move-choice">
            <input
              type="radio"
              name="move_destination_mode"
              value="existing"
              checked={moveMode === 'existing'}
              onchange={() => {
                moveMode = 'existing'
                moveError = null
                moveRetry = null
                moveRefreshFailed = false
                moveTopic = selectableTopics.find((t) => t.topicId === moveTopicId) ?? selectableTopics[0] ?? null
              }}
            />
            <span>既存のトピック</span>
          </label>
        {/if}
        <label class="reply-panel__move-choice">
          <input
            bind:this={moveNewRadioRef}
            type="radio"
            name="move_destination_mode"
            value="new"
            checked={moveMode === 'new'}
            onchange={() => {
              moveMode = 'new'
              moveError = null
              moveRetry = null
              moveRefreshFailed = false
            }}
          />
          <span>新しいトピック</span>
        </label>
      </fieldset>

      {#if moveMode === 'existing' && (moveOptions.length > 0 || moveDestinationUnavailable)}
        <label class="reply-panel__move-field">
          <span class="reply-panel__move-label">移動先のトピック</span>
          <select
            bind:this={moveSelectRef}
            class="reply-panel__move-select"
            aria-label="移動先のトピック"
            value={moveDestinationUnavailable ? '' : moveTopicId}
            disabled={moveBusy}
            onchange={(e) => {
              const selected = moveOptions.find((t) => t.topicId === e.currentTarget.value)
              if (selected) moveTopic = selected
              moveError = null
              moveRetry = null
              moveRefreshFailed = false
            }}
          >
            {#if moveDestinationUnavailable}
              <option value="" disabled>移動先のトピックを選択してください</option>
            {/if}
            {#each moveOptions as t (t.topicId)}
              <option value={t.topicId}>{t.baseline?.summary.name ?? 'トピック'}</option>
            {/each}
          </select>
        </label>
        {#if moveDestinationUnavailable}
          <StatusBanner
            tone="danger"
            role="alert"
            message="選択中のトピックは利用できなくなりました。別のトピックを選択してください。"
          />
        {/if}
        {#if topics && tState && !targetUnavailable && !tState.unavailable && ((tState.list.asOfSeq !== undefined && tState.list.hasMore) || tState.list.loading)}
          <div class="reply-panel__move-older" aria-busy={tState.list.loading}>
            {#if tState.list.asOfSeq !== undefined && tState.list.hasMore}
              <div class="reply-panel__move-older-action">
                <Button
                  variant="secondary"
                  disabled={tState.list.loading || moveBusy}
                  onclick={() => void handleLoadMoreTopics()}
                >
                  以前のトピックを読み込む
                </Button>
              </div>
            {/if}
            {#if tState.list.loading}
              <Skeleton rows={2} label="以前のトピックを読み込み中" />
            {/if}
            {#if tState.list.error}
              <StatusBanner
                tone="danger"
                role="alert"
                message="以前のトピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
                actionLabel="読み込みを再試行"
                actionAriaLabel="以前のトピックの読み込みを再試行"
                actionDisabled={tState.list.loading || moveBusy}
                onaction={() => void handleLoadMoreTopics()}
              />
            {/if}
          </div>
        {/if}
      {:else}
        <Input
          bind:inputRef={moveTopicNameRef}
          label="新しいトピック名"
          name="move_topic_name"
          required
          disabled={moveBusy}
          bind:value={moveTopicName}
          oninput={() => {
            moveError = null
            moveRetry = null
            moveRefreshFailed = false
          }}
        />
      {/if}

      {#if moveError || moveChainReadFailed}
        <StatusBanner
          tone="danger"
          role="alert"
          message={moveError ?? chainLoadError}
          actionLabel={!moveBusy && displayedMoveRetry ? '再試行' : canReloadMoveChain ? '再読み込み' : undefined}
          actionAriaLabel={!moveBusy && displayedMoveRetry ? '移動を再試行' : undefined}
          onaction={!moveBusy && displayedMoveRetry ? () => void handleRetryMove() : canReloadMoveChain ? () => void handleReloadChainForMove() : undefined}
          secondaryActionLabel={displayedMoveRetry && canReloadMoveChain ? '再読み込み' : undefined}
          onsecondaryaction={displayedMoveRetry && canReloadMoveChain ? () => void handleReloadChainForMove() : undefined}
        />
      {/if}

      <div class="reply-panel__move-actions">
        <Button variant="primary" type="submit" disabled={moveSubmitDisabled}>トピックに移動</Button>
      </div>
    </form>
  </Dialog>

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

  .reply-panel__header {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .reply-panel__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-8) var(--space-12) 0;
    min-width: 0;
  }

  .reply-panel__topic-label {
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-panel__banner {
    padding: var(--space-8) var(--space-12) 0;
    min-width: 0;
  }

  .reply-panel__move-form {
    display: grid;
    gap: var(--space-12);
    min-width: 0;
  }

  .reply-panel__move-status {
    margin: 0;
    font-size: var(--font-size-13);
    color: var(--text2);
  }

  .reply-panel__move-fieldset {
    display: grid;
    gap: var(--space-8);
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .reply-panel__move-legend {
    margin: 0;
    padding: 0;
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    color: var(--text);
  }

  .reply-panel__move-choice {
    display: inline-flex;
    align-items: center;
    gap: var(--space-8);
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    font-size: var(--font-size-14);
    color: var(--text);
    cursor: pointer;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .reply-panel__move-choice input {
    margin: 0;
    accent-color: var(--primary);
  }

  .reply-panel__move-field {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .reply-panel__move-label {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    color: var(--text);
  }

  .reply-panel__move-select {
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    background-color: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-14);
  }

  .reply-panel__move-older {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .reply-panel__move-older-action {
    justify-self: start;
  }

  .reply-panel__move-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-8);
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
    display: grid;
    gap: var(--space-8);
    padding: var(--space-8) var(--space-12) var(--space-12);
    min-width: 0;
  }
</style>
