<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { FocusableTarget } from './focus-management'
  import Button from './ui/Button.svelte'
  import ChannelUnavailableBanner from './ui/ChannelUnavailableBanner.svelte'
  import OrganizationUnavailableBanner from './ui/OrganizationUnavailableBanner.svelte'
  import ReplaceDraftDialog from './ui/ReplaceDraftDialog.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  export type TimelineFrameClasses = {
    root?: string
    header?: string
    banner?: string
    positioning?: string
    scroll?: string
    scrollPositioning?: string
    older?: string
    newBelow?: string
    composer?: string
  }

  // Shared timeline frame (layer 1): renders banners, scroll container, older/newer controls,
  // Composer wrapper and ReplaceDraftDialog without owning I/O, sync or read-position rules.
  let {
    variant = 'main',
    rootTag = 'section',
    ariaLabel,
    classes,
    reconnecting = false,
    organizationUnavailable = false,
    channelUnavailable = false,
    channelUnavailableVariant = 'view',
    loadErrorMessage = null,
    onretry,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
    positioning = false,
    positioningLabel = 'メッセージを読み込み中',
    scrollEl = $bindable(null),
    onscroll,
    showOlder = false,
    olderLabel = '以前のメッセージを読み込む',
    olderDisabled = false,
    olderError = false,
    onloadolder,
    pinned = true,
    newerCount = 0,
    onjumptobottom,
    confirmReplaceId = null,
    replaceDraftDescription = '入力中の下書きを破棄して、送信できなかったメッセージを入力欄に戻します。',
    returnFocusFallback = null,
    onconfirmreplace,
    oncancelreplace,
    headerExtra,
    beforeOlder,
    children,
    composer,
    extraDialogs,
  }: {
    variant?: 'main' | 'panel'
    rootTag?: 'section' | 'div'
    ariaLabel?: string
    classes?: TimelineFrameClasses
    reconnecting?: boolean
    organizationUnavailable?: boolean
    channelUnavailable?: boolean
    channelUnavailableVariant?: 'view' | 'replyPanel'
    loadErrorMessage?: string | null
    onretry?: () => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
    positioning?: boolean
    positioningLabel?: string
    scrollEl?: HTMLElement | null
    onscroll?: () => void
    showOlder?: boolean
    olderLabel?: string
    olderDisabled?: boolean
    olderError?: boolean
    onloadolder?: () => void
    pinned?: boolean
    newerCount?: number
    onjumptobottom?: () => void
    confirmReplaceId?: string | null
    replaceDraftDescription?: string
    returnFocusFallback?: FocusableTarget | null
    onconfirmreplace: () => void
    oncancelreplace: () => void
    headerExtra?: Snippet
    beforeOlder?: Snippet
    children?: Snippet
    composer: Snippet
    extraDialogs?: Snippet
  } = $props()
</script>

{#snippet stateBanners()}
  {#if reconnecting}
    <div class={classes?.banner}>
      <StatusBanner tone="info" role={null} message="再接続しています…" />
    </div>
  {/if}

  {#if organizationUnavailable}
    <div class={classes?.banner}>
      <OrganizationUnavailableBanner {onrecheckmembership} {onswitchorganization} />
    </div>
  {:else if channelUnavailable}
    <div class={classes?.banner}>
      <ChannelUnavailableBanner {ongoToChannelList} variant={channelUnavailableVariant} />
    </div>
  {:else if loadErrorMessage}
    <div class={classes?.banner}>
      <StatusBanner
        tone="danger"
        role="alert"
        message={loadErrorMessage}
        actionLabel="再試行"
        onaction={onretry}
      />
    </div>
  {/if}
{/snippet}

{#snippet olderControls()}
  <Button variant="secondary" disabled={olderDisabled} onclick={onloadolder}>
    {olderLabel}
  </Button>
  {#if olderError}
    <StatusBanner
      tone="danger"
      role="alert"
      message="以前のメッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
      actionLabel="再試行"
      onaction={onloadolder}
    />
  {/if}
{/snippet}

<svelte:element
  this={rootTag}
  class={classes?.root}
  aria-label={ariaLabel}
>
  {#if variant === 'panel' || headerExtra}
    <div class={classes?.header}>
      {@render stateBanners()}
      {@render headerExtra?.()}
    </div>
  {:else}
    {@render stateBanners()}
  {/if}

  {#if positioning}
    <div class={classes?.positioning}>
      <Skeleton rows={4} label={positioningLabel} />
    </div>
  {/if}

  <div
    class={[classes?.scroll, positioning && classes?.scrollPositioning]}
    aria-busy={positioning ? 'true' : undefined}
    inert={positioning}
    bind:this={scrollEl}
    {onscroll}
  >
    {@render beforeOlder?.()}

    {#if showOlder}
      {#if classes?.older}
        <div class={classes.older}>
          {@render olderControls()}
        </div>
      {:else}
        {@render olderControls()}
      {/if}
    {/if}

    {@render children?.()}
  </div>

  {#if !pinned && newerCount > 0}
    <div class={classes?.newBelow}>
      <Button variant="primary" onclick={onjumptobottom}>
        新着 {newerCount}件 ↓
      </Button>
    </div>
  {/if}

  <div class={classes?.composer}>
    {@render composer()}
  </div>

  {@render extraDialogs?.()}

  <ReplaceDraftDialog
    pendingId={confirmReplaceId}
    description={replaceDraftDescription}
    {returnFocusFallback}
    onconfirm={onconfirmreplace}
    oncancel={oncancelreplace}
  />
</svelte:element>

<style>
  .timeline-section,
  .topic-view,
  .reply-panel {
    position: relative;
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }

  .timeline-section,
  .topic-view {
    gap: var(--space-8);
  }

  .reply-panel {
    overflow: hidden;
  }

  .reply-panel__header {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .timeline-section__banner,
  .topic-view__banner {
    padding: 0 var(--space-16);
    min-width: 0;
  }

  .reply-panel__banner {
    padding: var(--space-8) var(--space-12) 0;
    min-width: 0;
  }

  .timeline-scroll,
  .topic-view__scroll,
  .reply-panel__scroll {
    grid-row: 2;
    overflow-y: auto;
    overflow-anchor: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .timeline-scroll,
  .topic-view__scroll {
    /* Explicit column: the positioning overlay shares this cell, and auto-placement would move this into an implicit column. */
    grid-column: 1;
    padding: var(--space-8) var(--space-16);
    gap: var(--space-8);
  }

  .reply-panel__scroll {
    padding: var(--space-12);
    gap: var(--space-12);
  }

  .timeline-scroll--positioning,
  .topic-view__scroll--positioning {
    visibility: hidden;
  }

  .timeline-positioning,
  .topic-view__positioning {
    grid-row: 2;
    grid-column: 1;
    padding: var(--space-8) var(--space-16);
    overflow: hidden;
    min-width: 0;
  }

  .timeline-older,
  .topic-view__older {
    display: grid;
    justify-items: start;
    gap: var(--space-8);
    min-width: 0;
  }

  .timeline-new-below,
  .topic-view__new-below,
  .reply-panel__new-below {
    position: absolute;
    bottom: calc(var(--space-24) * 4);
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
  }

  .timeline-composer,
  .topic-view__composer,
  .reply-panel__composer {
    grid-row: 3;
    min-width: 0;
  }

  .timeline-composer,
  .topic-view__composer {
    padding: 0 var(--space-12) var(--space-12);
  }

  .reply-panel__composer {
    display: grid;
    gap: var(--space-8);
    padding: var(--space-8) var(--space-12) var(--space-12);
  }
</style>
