<script lang="ts">
  import type { Message } from './api'
  import { stepMessageRowIndex } from './composer-keys'
  import Composer from './Composer.svelte'
  import {
    confirmReplaceDraftWithFailedSend,
    decideEditAndResend,
    discardAndFocusComposer,
    focusTarget,
  } from './focus-management'
  import type { RepliesAdapter } from './replies.svelte'
  import type { ChannelSync } from './sync.svelte'
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
    replyTargetStatus = 'idle',
    organizationUnavailable = false,
    composerRef = $bindable(null),
    resolveSenderName,
    onretrytarget,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
  }: {
    channel: ChannelSync
    replies: RepliesAdapter
    channelId: string
    anchorMessageId: string
    replyTargetStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    organizationUnavailable?: boolean
    composerRef?: HTMLInputElement | HTMLTextAreaElement | null
    resolveSenderName?: (senderId: string) => string
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

  $effect(() => {
    const key = `${channelId}:${anchorMessageId}`
    if (rState.anchor?.id === anchorMessageId && rState.messages.length > 0) {
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

  const currentKey = $derived(`${channelId}:${anchorMessageId}`)
  const isCurrentAnchor = $derived(rState.anchor?.id === anchorMessageId)
  const effectiveRootId = $derived(
    (isCurrentAnchor ? rState.rootId : null) ??
      (retained.key === currentKey ? retained.rootId : null) ??
      anchorMessageId,
  )
  const effectiveTopicId = $derived(
    (isCurrentAnchor ? rState.topicId : null) ??
      (retained.key === currentKey ? retained.topicId : null) ??
      null,
  )
  const visibleMessages = $derived(
    isCurrentAnchor && rState.messages.length > 0
      ? rState.messages
      : retained.key === currentKey
        ? retained.messages
        : [],
  )
  const chainMessageIds = $derived(
    new Set([anchorMessageId, effectiveRootId, ...visibleMessages.map((m) => m.id)]),
  )
  const pending = $derived(
    s.pending.filter((p) => p.replyTo !== undefined && chainMessageIds.has(p.replyTo)),
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
  const canSendReply = $derived(!targetUnavailable && isCurrentAnchor)
  const isLoading = $derived(
    !targetUnavailable &&
      ((isCurrentAnchor && rState.loading) || (!isCurrentAnchor && replyTargetStatus === 'loading')),
  )
  const hasError = $derived(
    !targetUnavailable &&
      ((isCurrentAnchor && rState.error) || (!isCurrentAnchor && replyTargetStatus === 'error')),
  )

  let scrollEl = $state<HTMLElement | null>(null)
  let confirmReplaceId = $state<string | null>(null)

  function handleRetryLoad() {
    if (isCurrentAnchor) {
      void replies.loadMore()
    } else {
      onretrytarget?.()
    }
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
    return rc.submit(rState.anchor?.id ?? effectiveRootId)
  }

  function focusLatestMessageRow() {
    if (!scrollEl) return
    const rows = scrollEl.querySelectorAll<HTMLElement>('.ui-message-row[data-focusable="true"]')
    if (rows.length > 0) focusTarget(rows[rows.length - 1])
  }

  function handleMessageRowKeydown(e: KeyboardEvent) {
    if (!scrollEl) return
    const rows = Array.from(scrollEl.querySelectorAll<HTMLElement>('.ui-message-row[data-focusable="true"]'))
    const idx = rows.indexOf(e.currentTarget as HTMLElement)
    const nextIdx = stepMessageRowIndex(idx, rows.length, e)
    if (nextIdx !== null) {
      e.preventDefault()
      focusTarget(rows[nextIdx])
    }
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

  <div class="reply-panel__scroll" bind:this={scrollEl}>
    {#if replyNotFound && visibleMessages.length === 0 && pending.length === 0}
      <EmptyState title="この返信のつながりは利用できません。" />
    {:else if isLoading && visibleMessages.length === 0 && pending.length === 0}
      <Skeleton rows={3} label="返信のつながりを読み込み中" />
    {:else}
      {#if replyNotFound}
        <EmptyState title="この返信のつながりは利用できません。" />
      {/if}

      {#if visibleMessages.length > 0 || pending.length > 0}
        <ul class="reply-panel__list" aria-label="返信のつながりのメッセージ一覧">
          {#each visibleMessages as m, idx (m.id)}
            <li
              class="reply-panel__item"
              class:reply-panel__item--root={idx === 0 && m.id === effectiveRootId}
              data-message-id={m.id}
            >
              <MessageRow
                senderName={resolveSenderName ? resolveSenderName(m.sender) : undefined}
                createdAt={m.created_at}
                body={m.body}
                focusable
                onrowkeydown={handleMessageRowKeydown}
              />
            </li>
          {/each}
          {#each pending as p (p.clientMessageId)}
            <li class="reply-panel__item" data-status={p.status}>
              <MessageRow
                body={p.body}
                pendingStatus={p.status}
                retryable={p.retryable}
                {targetUnavailable}
                onretry={() => void replies.retry(p.clientMessageId)}
                onrestore={() => handleRestoreRequest(p.clientMessageId)}
                ondiscard={() => handleDiscard(p.clientMessageId)}
              />
            </li>
          {/each}
        </ul>
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
      onarrowupempty={focusLatestMessageRow}
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
    overflow-y: auto;
    padding: var(--space-12);
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    min-height: 0;
    min-width: 0;
  }

  .reply-panel__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .reply-panel__item {
    min-width: 0;
  }

  .reply-panel__item--root {
    padding-bottom: var(--space-8);
    border-bottom: 1px solid var(--border);
  }

  .reply-panel__more {
    display: flex;
    justify-content: flex-start;
    min-width: 0;
  }

  .reply-panel__composer {
    padding: var(--space-8) var(--space-12) var(--space-12);
    min-width: 0;
  }
</style>
