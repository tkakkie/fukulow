<script lang="ts">
  import { shouldOpenRepliesFromRowKey } from '../composer-keys'
  import Button from './Button.svelte'
  import type { Message } from '../api'
  import { mentionText, type MentionName } from '../mentions'

  let {
    body,
    mentions = [],
    resolveMentionName,
    selfId = '',
    createdAt,
    senderName,
    mentioned = false,
    pendingStatus,
    retryable = false,
    targetUnavailable = false,
    failedReason = '送信できませんでした。内容を確認してください。',
    replyCount = 0,
    focusable = false,
    rovingTabindex = -1,
    rowRef = $bindable(null),
    onretry,
    onrestore,
    ondiscard,
    onopenreplies,
    onrowfocus,
    onrowkeydown,
  }: {
    body: string
    mentions?: Message['mentions']
    resolveMentionName?: MentionName
    selfId?: string
    createdAt?: string
    senderName?: string
    mentioned?: boolean
    pendingStatus?: 'sending' | 'throttled' | 'failed'
    retryable?: boolean
    targetUnavailable?: boolean
    failedReason?: string
    replyCount?: number
    focusable?: boolean
    rovingTabindex?: 0 | -1
    rowRef?: HTMLElement | null
    onretry?: () => void
    onrestore?: () => void
    ondiscard?: () => void
    onopenreplies?: (opener?: HTMLElement | null) => void
    onrowfocus?: () => void
    onrowkeydown?: (e: KeyboardEvent) => void
  } = $props()

  let replyBtnRef = $state<HTMLButtonElement | null>(null)
  const isRowFocusable = $derived(!pendingStatus && (focusable || Boolean(onopenreplies)))

  const formattedTime = $derived(
    createdAt ? new Date(createdAt).toLocaleString('ja-JP') : '',
  )

  function handleFocus(e: FocusEvent) {
    if (e.target !== e.currentTarget) return
    onrowfocus?.()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return
    if (onopenreplies && shouldOpenRepliesFromRowKey(e)) {
      e.preventDefault()
      onopenreplies(rowRef)
      return
    }
    onrowkeydown?.(e)
  }

  $effect(() => {
    const el = rowRef
    if (!el) return
    el.tabIndex = isRowFocusable ? rovingTabindex : -1
    if (!isRowFocusable) return
    el.addEventListener('focus', handleFocus)
    el.addEventListener('keydown', handleKeydown)
    return () => {
      el.removeEventListener('focus', handleFocus)
      el.removeEventListener('keydown', handleKeydown)
    }
  })
</script>

<article
  bind:this={rowRef}
  class="ui-message-row"
  class:ui-message-row--mentioned={mentioned || (!pendingStatus && mentions.some(target => target.member_id === selfId))}
  class:ui-message-row--sending={pendingStatus === 'sending'}
  class:ui-message-row--failed={pendingStatus === 'failed'}
  tabindex="-1"
  data-focusable={isRowFocusable ? 'true' : undefined}
>
  {#if senderName || createdAt}
    <header class="ui-message-row__meta">
      {#if senderName}
        <span class="ui-message-row__sender">{senderName}</span>
      {/if}
      {#if createdAt}
        <time class="ui-message-row__time" datetime={createdAt}>{formattedTime}</time>
      {/if}
    </header>
  {/if}

  <div class="ui-message-row__content">
    <span class="body">{pendingStatus ? body : mentionText(body, mentions, resolveMentionName)}</span>
  </div>

  {#if pendingStatus === 'sending'}
    <footer class="ui-message-row__footer">
      <small class="ui-message-row__sending">送信中…</small>
    </footer>
  {:else if pendingStatus === 'throttled'}
    <footer class="ui-message-row__footer">
      <small class="ui-message-row__sending">送信が混み合っています。しばらくしてから自動で再送します。</small>
      {#if ondiscard}
        <Button variant="secondary" onclick={ondiscard}>破棄</Button>
      {/if}
    </footer>
  {:else if pendingStatus === 'failed'}
    <footer class="ui-message-row__footer ui-message-row__footer--failed">
      {#if targetUnavailable}
        <div class="ui-message-row__actions">
          {#if ondiscard}
            <Button variant="secondary" onclick={ondiscard}>破棄</Button>
          {/if}
        </div>
      {:else if retryable}
        <small role="alert" class="ui-message-row__error">送信を確認できませんでした。</small>
        <div class="ui-message-row__actions">
          {#if onretry}
            <Button variant="primary" onclick={onretry}>再送する</Button>
          {/if}
          {#if ondiscard}
            <Button variant="secondary" onclick={ondiscard}>破棄</Button>
          {/if}
        </div>
      {:else}
        <small role="alert" class="ui-message-row__error">{failedReason}</small>
        <div class="ui-message-row__actions">
          {#if onrestore}
            <Button variant="primary" onclick={onrestore}>編集して送り直す</Button>
          {/if}
          {#if ondiscard}
            <Button variant="secondary" onclick={ondiscard}>破棄</Button>
          {/if}
        </div>
      {/if}
    </footer>
  {:else if onopenreplies}
    <footer class="ui-message-row__footer">
      <Button
        variant="quiet"
        tabindex={-1}
        bind:buttonRef={replyBtnRef}
        onclick={() => onopenreplies(replyBtnRef)}
      >
        {replyCount > 0 ? `返信 ${replyCount}件›` : '返信'}
      </Button>
    </footer>
  {/if}
</article>

<style>
  .ui-message-row {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-8) var(--space-12);
    border-radius: var(--radius-10);
    background-color: transparent;
    color: var(--text);
    min-width: 0;
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  .ui-message-row:hover {
    background-color: var(--hover);
  }

  .ui-message-row--mentioned {
    background-color: var(--mention);
    color: var(--on-mention);
  }

  .ui-message-row--mentioned:hover {
    background-color: var(--mention);
  }

  .ui-message-row--failed {
    background-color: var(--danger-bg);
    border: 1px solid var(--danger);
  }

  .ui-message-row--failed:hover {
    background-color: var(--danger-bg);
  }

  .ui-message-row__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-8);
    min-width: 0;
  }

  .ui-message-row__sender {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
  }

  .ui-message-row__time {
    font-size: var(--font-size-12);
    color: var(--muted);
  }

  .ui-message-row__content {
    min-width: 0;
    font-size: var(--font-size-15);
    line-height: var(--line-height-message);
  }

  .ui-message-row__footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-width: 0;
  }

  .ui-message-row__sending {
    font-size: var(--font-size-12);
    color: var(--text2);
  }

  .ui-message-row__error {
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-medium);
    color: var(--danger);
    overflow-wrap: anywhere;
  }

  .ui-message-row__actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
  }
</style>
