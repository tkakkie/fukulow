<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Navigation } from './navigation'
  import { navigationAdapter } from './navigation.svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import { createAnnouncementController } from './announcements'
  import type { Channel, Identity, Message } from './api'
  import type { Organization } from './api-schema.d.ts'
  import type { SessionModel } from './auth.svelte'
  import ChannelList from './ChannelList.svelte'
  import { shouldCloseOnEscape, shouldTogglePanelShortcut } from './composer-keys'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import {
    createTopicSummaryFocusController,
    focusAfterPanelClose,
    focusIfVisible,
    focusTarget,
    MOBILE_BREAKPOINT_PX,
    resolveChannelListNavigation,
    resolveMainTimelineFocusStatus,
    resolveSkipLinkTargetId,
    type SkipLinkTargetId,
  } from './focus-management'
  import Members from './MemberList.svelte'
  import ChannelMembers from './ChannelMembers.svelte'
  import { channelMembersAdapter } from './channel-members.svelte'
  import type { membersAdapter } from './members.svelte'
  import ReplyPanel from './ReplyPanel.svelte'
  import Timeline from './Timeline.svelte'
  import TopicList from './TopicList.svelte'
  import TopicView from './TopicView.svelte'
  import Button from './ui/Button.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Panel, { type PanelTabId } from './ui/Panel.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  // The session's controllers outlive this component: unmounting it never closes the connection.
  let {
    session,
    navigation,
    canCreateChannels = true,
    members = null,
    organization = null,
    organizations = [],
    selectedOrganizationId = '',
    busy = false,
    authError = '',
    skipTargetId = $bindable<SkipLinkTargetId>('main-content'),
    resolveSenderName,
    onselectorganization,
    onsettings,
    onsignout,
    onannounce,
  }: {
    navigation: Navigation
    session: SessionModel
    canCreateChannels?: boolean
    members?: ReturnType<typeof membersAdapter> | null
    organization?: Identity | null
    organizations?: Organization[]
    selectedOrganizationId?: string
    busy?: boolean
    authError?: string
    skipTargetId?: SkipLinkTargetId
    resolveSenderName?: (senderId: string) => string
    onselectorganization?: (id: string) => void
    onsettings?: () => void
    onsignout?: () => void
    onannounce?: (message: string) => void
  } = $props()

  const channels = $derived(session.channels)
  // One adapter read per derived: every read of the adapter registers a listener effect.
  const s = $derived(channels.state)
  const channelListStatus = $derived(s.status)
  const currentOrganizationId = $derived(selectedOrganizationId || organization?.organization.organization_id || '')
  const nav = navigationAdapter(() => navigation)
  const route = $derived(nav.state.target)
  const routeChannelId = $derived(route?.organizationId === currentOrganizationId ? route.channelId : s.selectedId)
  const selected = $derived<Channel | undefined>(s.channels.find((c) => c.id === routeChannelId) ?? (routeChannelId ? {
    id: routeChannelId, name: 'チャンネル', visibility: 'public',
    capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_manage_managers: { allowed: false }, can_leave: { allowed: false } },
  } : undefined))
  const currentChannel = $derived(selected ? session.sync.channel(selected.id) : null)
  const currentTimeline = $derived(currentChannel ? currentChannel.timeline : null)
  const currentLive = $derived(currentChannel ? currentChannel.live : false)
  const currentTopics = $derived(selected ? session.topics(selected.id) : null)
  const currentTopicsState = $derived(currentTopics ? currentTopics.state : null)
  const currentReplies = $derived(selected ? session.replies?.(selected.id) ?? null : null)
  const currentRepliesState = $derived(currentReplies ? currentReplies.state : null)
  const currentUnread = $derived(selected ? session.unread?.(selected.id) ?? null : null)
  const selectedChannelUnread = $derived(s.selectedId ? session.unread?.(s.selectedId) ?? null : null)
  const selectedChannelUnreadState = $derived(selectedChannelUnread ? selectedChannelUnread.state : null)
  const channelUnreadCount = (id: string): number | null =>
    session.unread?.(id).state.unreadCount ?? null
  const activeReplyMessageId = $derived(route?.panel?.startsWith('reply:') ? route.panel.slice(6) : null)
  let lastOpenedAnchor = $state<Message | null>(null)
  const inMemoryReplyAnchor = $derived.by(() => {
    if (!activeReplyMessageId || !selected) return null
    if (lastOpenedAnchor?.id === activeReplyMessageId && lastOpenedAnchor.channel_id === selected.id) {
      return lastOpenedAnchor
    }
    const fromTimeline = currentTimeline?.messages.find((m) => m.id === activeReplyMessageId)
    if (fromTimeline) return fromTimeline
    for (const line of currentTopicsState?.lines ?? []) {
      if (line.kind === 'message' && line.message.id === activeReplyMessageId) return line.message
    }
    if (route?.topicId && currentTopicsState) {
      const fromTopic = currentTopicsState.topic(route.topicId).messages.find((m) => m.id === activeReplyMessageId)
      if (fromTopic) return fromTopic
    }
    if (currentRepliesState?.anchor?.id === activeReplyMessageId) return currentRepliesState.anchor
    const fromReplies = currentRepliesState?.messages.find((m) => m.id === activeReplyMessageId)
    if (fromReplies) return fromReplies
    return null
  })
  const replyTargetState = $derived(
    session.navigationTargets &&
      (!session.navigationTargets.state.reply.targetId ||
        session.navigationTargets.state.reply.targetId === activeReplyMessageId)
      ? session.navigationTargets.state.reply
      : { status: 'idle' as const, name: '' },
  )
  const resolvedReplyAnchor = $derived(
    inMemoryReplyAnchor ?? replyTargetState.anchor ?? null,
  )
  const allTopicsKnown = $derived(
    currentTopicsState
      ? currentTopicsState.list.asOfSeq !== undefined
        ? !currentTopicsState.list.hasMore
        : currentTopicsState.main.asOfSeq !== undefined && !currentTopicsState.main.hasMore
      : false,
  )
  const resolvedTopicName = $derived(
    route?.topicId
      ? currentTopicsState?.topics.find((t) => t.topicId === route.topicId)?.baseline?.summary.name ||
        session.navigationTargets?.state.topic.name ||
        ''
      : '',
  )
  const organizationUnavailable = $derived(session.sync.unavailable)
  const otherOrg = $derived(organizations.find((o) => o.organization_id !== currentOrganizationId))

  const announcementController = createAnnouncementController({
    onAnnounce: (msg) => onannounce?.(msg),
  })
  const subscribeAnnouncements = createSubscriber((update) => announcementController.subscribe(update))
  const announcementView = $derived.by(() => {
    subscribeAnnouncements()
    return announcementController.get()
  })

  let drawerOpen = $state(false)
  const panelOpen = $derived(!!route?.panel)
  const activePanelTab = $derived<PanelTabId>(route?.panel && !route.panel.startsWith('reply:') ? route.panel as PanelTabId : 'topics')
  const mobileLevel = $derived(!route?.channelId ? 'channels' : route.panel ? 'panel' : 'view')
  const effectiveMobileLevel = $derived(mobileLevel)
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280)
  const mainViewSelected = $derived(
    viewportWidth >= MOBILE_BREAKPOINT_PX || effectiveMobileLevel === 'view',
  )
  const currentSkipTargetId = $derived(
    resolveSkipLinkTargetId({
      viewportWidth,
      mobileLevel: effectiveMobileLevel,
      panelOpen,
    }),
  )

  let channelListHeadingRef = $state<HTMLElement | null>(null)
  let mainComposerRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let mainTopicInputRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let replyComposerRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let panelToggleBtn = $state<HTMLButtonElement | null>(null)
  let panelHeadingRef = $state<HTMLElement | null>(null)
  let focusTopicInputNext = false
  let appliedFocusRevision = -1
  let navFocusBaseline: { revision: number; active: Element | null } = { revision: -1, active: null }
  const topicSummaryFocus = createTopicSummaryFocusController()

  const selectedChannelId = $derived(selected?.id)
  const channelMemberController = $derived.by(() => {
    if (!panelOpen || activePanelTab !== 'members' || !selectedChannelId) return undefined
    const open = session.channelMembers
    return untrack(() => open?.(selectedChannelId))
  })
  const channelMemberModel = $derived(channelMemberController ? channelMembersAdapter(channelMemberController) : undefined)
  $effect(() => {
    const controller = channelMemberController
    return () => controller?.close()
  })
  let lastViewId = $state('')
  // A cold descendant URL can resolve to its root before its own body is paged in.
  let openedReplyTarget = ''

  function resolveSender(senderId: string): string {
    if (resolveSenderName) return resolveSenderName(senderId)
    if (organization?.member.id === senderId) return organization.member.name
    return members?.state.members.find((member) => member.id === senderId)?.name ?? 'メンバー'
  }

  $effect(() => () => announcementController.destroy())

  $effect(() => {
    skipTargetId = currentSkipTargetId
  })

  // 10 s loading timeout for Channel list (docs/ui.md §5)
  $effect(() => {
    announcementController.syncChannelListLoading(s.status === 'loading' && s.channels.length === 0)
  })

  $effect(() => {
    if (s.status !== 'ready' || !currentOrganizationId) return
    nav.initialize({ organizationId: currentOrganizationId, channelId: viewportWidth < 600 ? null : s.selectedId, topicId: null, panel: null })
  })

  $effect(() => {
    if (channelListStatus !== 'ready' || route?.organizationId !== currentOrganizationId) return
    // Follow URL changes; reacting to creation's selection would briefly reselect the old Channel.
    if (route.channelId && route.channelId !== untrack(() => s.selectedId)) channels.selectHint(route.channelId)
  })

  $effect(() => {
    if (route?.organizationId !== currentOrganizationId || organizationUnavailable) return
    const skipReplyHint = Boolean(currentReplies && activeReplyMessageId && untrack(() => inMemoryReplyAnchor))
    void session.navigationTargets?.load(skipReplyHint ? { ...route, panel: null } : route)
  })

  $effect(() => {
    if (!currentReplies || !selected) return
    if (!activeReplyMessageId) {
      openedReplyTarget = ''
      if (currentRepliesState?.anchor) currentReplies.dismiss()
      return
    }
    if (organizationUnavailable || currentTimeline?.status === 'unavailable' || currentRepliesState?.unavailable) {
      return
    }
    // Wait until the Channel timeline is watched before opening the Reply chain.
    void currentTimeline?.status
    const anchor = resolvedReplyAnchor
    if (!anchor || anchor.channel_id !== selected.id) return
    const targetRootId = anchor.reply_root_id ?? anchor.id
    const targetKey = `${selected.id}:${activeReplyMessageId}`
    const alreadyOpen = Boolean(
      currentRepliesState?.anchor &&
        currentRepliesState.rootId === targetRootId &&
        openedReplyTarget === targetKey,
    )
    if (!alreadyOpen) {
      openedReplyTarget = targetKey
      void currentReplies.open(anchor)
    }
  })

  $effect(() => {
    const snap = navigation.get()
    navFocusBaseline = {
      revision: snap.revision,
      active: typeof document !== 'undefined' ? document.activeElement : null,
    }
    topicSummaryFocus.syncNavigation(snap, navigation.getReturningTopicId())
    const unsubscribe = navigation.subscribe(() => {
      const next = navigation.get()
      if (next.revision !== navFocusBaseline.revision) {
        navFocusBaseline = {
          revision: next.revision,
          active: typeof document !== 'undefined' ? document.activeElement : null,
        }
      }
      topicSummaryFocus.syncNavigation(next, navigation.getReturningTopicId())
    })
    return () => {
      unsubscribe()
      topicSummaryFocus.destroy()
    }
  })

  $effect(() => {
    const state = nav.state
    if (state.focus === 'topic-summary') {
      focusTopicInputNext = false
      return
    }
    // Wait for API-owned Channel selection and the rendered destination before focusing.
    if (!state.target || state.target.organizationId !== currentOrganizationId) return
    const revision = state.revision
    if (appliedFocusRevision === revision) return
    void tick().then(() => {
      if (nav.state.revision !== revision || appliedFocusRevision === revision) return
      appliedFocusRevision = revision
      if (
        navFocusBaseline.revision === revision &&
        typeof document !== 'undefined' &&
        document.activeElement &&
        document.activeElement !== document.body &&
        document.activeElement !== document.documentElement &&
        (document.activeElement as HTMLElement).isConnected !== false &&
        document.activeElement !== navFocusBaseline.active
      ) {
        focusTopicInputNext = false
        return
      }
      if (state.focus === 'list') focusIfVisible(channelListHeadingRef)
      else if (state.focus === 'heading') focusTarget(panelHeadingRef)
      else if (state.focus === 'reply-composer') {
        if (!focusTarget(replyComposerRef ?? document.querySelector<HTMLElement>('#panel-content textarea'))) {
          focusTarget(panelHeadingRef)
        }
      }
      else if (state.focus === 'tab') focusTarget(document.getElementById(`panel-tab-${activePanelTab}`))
      else if (state.focus === 'opener') focusAfterPanelClose(navigation.getOpener(), mainComposerRef)
      else {
        const preferTopicInput = focusTopicInputNext
        focusTopicInputNext = false
        if (!(preferTopicInput && focusTarget(mainTopicInputRef))) {
          focusTarget(mainComposerRef)
        }
      }
    })
  })

  $effect(() => {
    const state = nav.state
    const returningTopicId = navigation.getReturningTopicId()
    topicSummaryFocus.syncNavigation(state, returningTopicId)
    if (
      state.focus !== 'topic-summary' ||
      !state.target ||
      state.target.organizationId !== currentOrganizationId ||
      !topicSummaryFocus.isPending(state.revision)
    ) {
      return
    }
    const revision = state.revision
    void currentTimeline?.messages.length
    void currentTopicsState?.lines.length
    const status = resolveMainTimelineFocusStatus({
      channelListStatus,
      hasSelectedTimeline: Boolean(selected && currentChannel && route?.channelId === selected.id && !route?.topicId),
      organizationUnavailable,
      timelineStatus: currentTimeline?.status ?? null,
      hasTopics: Boolean(currentTopics),
      topicsMain: currentTopicsState?.main ?? null,
      topicsUnavailable: Boolean(currentTopicsState?.unavailable),
      topicPendingSend: Boolean(
        returningTopicId &&
          currentTimeline?.pending.some((p) => p.status === 'sending' && !p.replyTo && p.topicId === returningTopicId),
      ),
    })
    const composer = mainComposerRef
    let cancelled = false
    void tick().then(() => {
      if (cancelled || nav.state.revision !== revision) return
      topicSummaryFocus.step({
        revision,
        status,
        findSummary: (topic) =>
          document.querySelector<HTMLElement>(`#main-content [data-topic-id="${CSS.escape(topic)}"]`),
        composer: mainComposerRef ?? composer,
      })
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (!selected) { lastViewId = ''; return }
    if (s.status === 'loading') return
    const viewId = `${selected.id}/${route?.topicId ?? ''}`
    if (route?.topicId && !resolvedTopicName && session.navigationTargets?.state.topic.status === 'loading') return
    if (viewId === lastViewId) return
    lastViewId = viewId
    announcementController.onViewChanged({
      viewId,
      kind: route?.topicId ? 'topic' : 'channel',
      name: route?.topicId ? (resolvedTopicName || 'トピック') : selected.name,
    })
  })

  // Track timeline updates for live-message announcements and offline state (docs/ui.md §6)
  $effect(() => {
    const viewId = selected ? `${selected.id}/${route?.topicId ?? ''}` : ''
    if (!selected || !currentTimeline || viewId !== lastViewId) return
    const replyChainIds =
      activeReplyMessageId && currentRepliesState
        ? new Set([
            ...(currentRepliesState.rootId ? [currentRepliesState.rootId] : []),
            ...currentRepliesState.messages.map((m) => m.id),
          ])
        : undefined
    announcementController.onTimelineUpdated({
      viewId,
      topicId: route?.topicId ?? null,
      status: currentTimeline.status,
      live: currentLive,
      messages: currentTimeline.messages,
      replyChainIds,
      selfId: organization?.member.id ?? '',
      resolveSenderName: resolveSender,
    })
  })

  function handleSelectChannel(id: string) {
    const navigated = nav.navigate({ type: 'channel', organizationId: currentOrganizationId, channelId: id })
    if (id === s.selectedId || navigated === false) {
      channels.select(id)
      if (
        navigated === false &&
        typeof currentUnread !== 'undefined' &&
        currentUnread &&
        (currentUnread.state.stopped || currentUnread.state.main.stopped)
      ) {
        void currentUnread.enter(null)
      }
    }
    drawerOpen = false
  }

  function handleSelectTopic(topicId: string) {
    if (!selected || !currentOrganizationId) return
    const wasSameTopic = route?.topicId === topicId
    nav.navigate({
      type: 'topic',
      topicId,
      phone: viewportWidth < MOBILE_BREAKPOINT_PX,
    })
    if (wasSameTopic && currentUnread && (currentUnread.state.stopped || currentUnread.state.topics[topicId]?.stopped)) {
      void currentUnread.enter(topicId)
    }
    drawerOpen = false
  }

  function handleOpenReplies(message: Message, opener?: HTMLElement | null) {
    lastOpenedAnchor = message
    openedReplyTarget = `${message.channel_id}:${message.id}`
    void currentReplies?.open(message)
    nav.navigate({ type: 'reply', messageId: message.id }, opener)
  }

  function handleStartNewTopic() {
    if (!selected || !currentOrganizationId) return
    let navigated = false
    if (route?.topicId) {
      focusTopicInputNext = true
      navigated = Boolean(
        nav.navigate({
          type: 'channel',
          organizationId: currentOrganizationId,
          channelId: selected.id,
        }),
      )
      if (viewportWidth < MOBILE_BREAKPOINT_PX && route.panel) {
        navigated = Boolean(nav.navigate({ type: 'close' })) || navigated
      }
    } else if (viewportWidth < MOBILE_BREAKPOINT_PX && panelOpen) {
      focusTopicInputNext = true
      navigated = Boolean(nav.navigate({ type: 'close' }))
    }
    if (!navigated) {
      focusTopicInputNext = false
      void tick().then(() => {
        if (!focusTarget(mainTopicInputRef)) focusTarget(mainComposerRef)
      })
    }
  }

  async function handleCreateChannel(name: string, visibility: 'public' | 'private'): Promise<string | null> {
    const result = await channels.create(name, visibility)
    if ('error' in result) return result.error
    handleSelectChannel(result.channel.id)
    return null
  }

  function openPanel() { nav.navigate({ type: 'tab', tab: 'topics' }, panelToggleBtn) }
  function closePanel() { nav.navigate({ type: 'close' }) }
  function togglePanel() { if (panelOpen) closePanel(); else openPanel() }
  function goToChannelList() {
    const width = typeof window !== 'undefined' ? window.innerWidth : viewportWidth
    viewportWidth = width
    const next = resolveChannelListNavigation(width)
    drawerOpen = next.drawerOpen
    if (width < MOBILE_BREAKPOINT_PX && nav.navigate({ type: 'list' })) {
      return
    }
    void tick().then(() => {
      focusIfVisible(channelListHeadingRef)
    })
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    // A modal dialog is the topmost layer and handles its own Escape / Tab (docs/ui.md §9).
    if (typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]')) {
      return
    }
    if (shouldTogglePanelShortcut(e)) {
      e.preventDefault()
      togglePanel()
      return
    }
    if (!shouldCloseOnEscape(e)) return
    if (drawerOpen) {
      e.preventDefault()
      drawerOpen = false
      return
    }
    if (panelOpen) {
      e.preventDefault()
      closePanel()
      return
    }
    if (typeof document !== 'undefined' && document.activeElement?.closest('.ui-message-row') && mainComposerRef) {
      e.preventDefault()
      focusTarget(mainComposerRef)
    }
  }

  // Best-effort prompt for any Channel's unsent draft or pending send in the session (docs/ui.md §3).
  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (session.sync.hasUnsavedChanges()) {
      e.preventDefault()
    }
  }
</script>

<svelte:window
  bind:innerWidth={viewportWidth}
  onkeydown={handleWindowKeydown}
  onbeforeunload={handleBeforeUnload}
/>

<div
  class="workspace"
  data-panel-open={panelOpen}
  data-drawer-open={drawerOpen}
  data-mobile-level={effectiveMobileLevel}
>
  <nav class="rail" aria-label="メインナビゲーション">
    <div class="rail__top">
      <div class="rail__logo" aria-hidden="true">
        <span class="rail__owl">🦉</span>
      </div>
      <Button
        variant="icon"
        ariaLabel="チャンネル一覧"
        ariaExpanded={drawerOpen}
        onclick={() => {
          if (viewportWidth < MOBILE_BREAKPOINT_PX) {
            drawerOpen = false
            nav.navigate({ type: 'list' })
          } else {
            drawerOpen = !drawerOpen
          }
        }}
      >
        #
      </Button>
    </div>

    <div class="rail__bottom">
      {#if onsettings}
        <Button variant="icon" ariaLabel="設定" onclick={onsettings}>⚙</Button>
      {/if}
      {#if onsignout}
        <Button variant="icon" ariaLabel="ログアウト" disabled={busy} onclick={onsignout}>⇥</Button>
      {/if}
    </div>
  </nav>

  <nav id="channel-content" class="channel-column" aria-labelledby="channel-list-heading" tabindex="-1">
    <div class="channel-column__header">
      {#if organizations.length > 1 && onselectorganization}
        <label class="org-switcher">
          <span class="org-switcher__label">組織</span>
          <select
            class="org-switcher__select"
            value={currentOrganizationId}
            onchange={(e) => onselectorganization(e.currentTarget.value)}
          >
            {#each organizations as org (org.organization_id)}
              <option value={org.organization_id}>{org.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if organization}
        <p class="member-summary">{organization.organization.name} / {organization.member.name} さん</p>
      {/if}
      <h2
        bind:this={channelListHeadingRef}
        id="channel-list-heading"
        class="channel-column__heading"
        tabindex="-1"
      >
        チャンネル
      </h2>
    </div>

    <div class="channel-column__scroll">
      {#if !organizationUnavailable && (s.status === 'error' || (s.status === 'loading' && s.channels.length === 0 && announcementView.channelListTimedOut))}
        <StatusBanner
          tone="danger"
          role="alert"
          message="チャンネルを読み込めませんでした。"
          detail="通信状況を確認して、もう一度お試しください。"
          actionLabel="再試行"
          onaction={() => {
            announcementController.resetChannelListTimeout()
            void channels.load()
          }}
        />
      {:else if !organizationUnavailable && s.status === 'loading' && s.channels.length === 0}
        <Skeleton rows={3} label="チャンネルを読み込み中" />
      {/if}

      <ChannelList
        channels={s.channels}
        selectedId={s.selectedId}
        activeTopicId={route?.channelId === s.selectedId ? (route?.topicId ?? null) : null}
        topics={currentTopicsState && selected?.id === s.selectedId ? currentTopicsState.topics : []}
        allTopicsKnown={selected?.id === s.selectedId ? allTopicsKnown : false}
        {channelUnreadCount}
        topicUnreadCounts={selectedChannelUnreadState?.topics ?? {}}
        onselect={handleSelectChannel}
        onselecttopic={handleSelectTopic}
        onopenalltopics={(opener) => nav.navigate({ type: 'tab', tab: 'topics' }, opener)}
      />
      {#if !organizationUnavailable && canCreateChannels}
        <CreateChannelForm oncreate={handleCreateChannel} />
      {/if}
      {#if !organizationUnavailable && members && organization}
        <Members
          model={members}
          identity={organization}
          onchanged={(id) => {
            if (id === organization.member.id && currentOrganizationId) {
              onselectorganization?.(currentOrganizationId)
            }
          }}
        />
      {/if}
    </div>

    {#if authError}
      <div class="channel-column__footer">
        <StatusBanner tone="danger" role="alert" message={authError} />
      </div>
    {/if}
  </nav>

  <main id="main-content" class="main-card" tabindex="-1">
    {#if selected && currentChannel}
      <header class="main-card__header">
        <div class="main-card__title-group">
          <span class="mobile-only">
            <Button
              variant="icon"
              ariaLabel="チャンネル一覧へ戻る"
              onclick={() => {
                if (viewportWidth < 600) nav.navigate({ type: 'list' })
              }}
            >
              ‹
            </Button>
          </span>
          {#if route?.topicId}
            <Button
              variant="quiet"
              onclick={() => nav.navigate({ type: 'topic-back' })}
            >
              <span aria-hidden="true">‹</span>
              <span>チャンネルへ戻る</span>
            </Button>
            <span class="main-card__crumb"># {selected.name} ›</span>
          {/if}
          <h1 class="main-card__title">
            {route?.topicId ? (resolvedTopicName || 'トピック') : selected.name}
          </h1>
        </div>
        <div class="main-card__header-actions">
          <small class="live-status" data-testid="live-status" data-live={currentLive}>
            {currentLive ? 'リアルタイム接続済み' : 'リアルタイムに接続中…'}
          </small>
          <Button
            bind:buttonRef={panelToggleBtn}
            variant="icon"
            ariaLabel={panelOpen ? 'パネルを閉じる(⌘.)' : 'パネルを開く(⌘.)'}
            ariaExpanded={panelOpen}
            onclick={togglePanel}
          >
            ☰
          </Button>
        </div>
      </header>
      <div class="main-card__body">
        {#if route?.topicId && currentTopics}
          {#key `${selected.id}:${route.topicId}`}
            <TopicView
              channel={currentChannel}
              topics={currentTopics}
              replies={currentReplies}
              unread={currentUnread}
              channelId={selected.id}
              topicId={route.topicId}
              topicName={resolvedTopicName}
              topicStatus={session.navigationTargets?.state.topic.status ?? 'idle'}
              selfId={organization?.member.id ?? ''}
              viewSelected={mainViewSelected}
              {organizationUnavailable}
              reconnecting={announcementView.reconnecting}
              resolveSenderName={resolveSender}
              bind:composerRef={mainComposerRef}
              onopenreplies={handleOpenReplies}
              onretrytopicmeta={() => {
                if (route) void session.navigationTargets?.load(route, true)
              }}
              ongoToChannelList={goToChannelList}
              onrecheckmembership={onselectorganization && currentOrganizationId ? () => onselectorganization(currentOrganizationId) : undefined}
              onswitchorganization={otherOrg && onselectorganization ? () => onselectorganization(otherOrg.organization_id) : undefined}
            />
          {/key}
        {:else}
        {#key selected.id}
          <Timeline
            channel={currentChannel}
            topics={currentTopics}
            replies={currentReplies}
            unread={currentUnread}
            channelId={selected.id}
            selfId={organization?.member.id ?? ''}
            viewSelected={mainViewSelected}
            {organizationUnavailable}
            reconnecting={announcementView.reconnecting}
            resolveSenderName={resolveSender}
            bind:composerRef={mainComposerRef}
            bind:topicInputRef={mainTopicInputRef}
            onopentopic={handleSelectTopic}
            onopenreplies={handleOpenReplies}
            ongoToChannelList={goToChannelList}
            onrecheckmembership={onselectorganization && currentOrganizationId ? () => onselectorganization(currentOrganizationId) : undefined}
            onswitchorganization={otherOrg && onselectorganization ? () => onselectorganization(otherOrg.organization_id) : undefined}
          />
        {/key}
        {/if}
      </div>
    {:else if organizationUnavailable}
      <header class="main-card__header">
        <div class="main-card__title-group">
          <span class="mobile-only">
            <Button
              variant="icon"
              ariaLabel="チャンネル一覧へ戻る"
              onclick={() => {
                if (viewportWidth < 600) nav.navigate({ type: 'list' })
              }}
            >
              ‹
            </Button>
          </span>
          <h1 class="main-card__title">{organization?.organization.name ?? 'fukulow'}</h1>
        </div>
      </header>
      <div class="main-card__empty">
        <StatusBanner
          tone="danger"
          role="alert"
          message="この組織は利用できません。"
          detail="この組織へのアクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。"
          actionLabel={onselectorganization && currentOrganizationId ? 'メンバー資格を再確認' : undefined}
          onaction={onselectorganization && currentOrganizationId ? () => onselectorganization(currentOrganizationId) : undefined}
          secondaryActionLabel={otherOrg && onselectorganization ? '組織を切り替える' : undefined}
          onsecondaryaction={otherOrg && onselectorganization ? () => onselectorganization(otherOrg.organization_id) : undefined}
        />
      </div>
    {:else if s.status === 'ready'}
      <header class="main-card__header">
        <div class="main-card__title-group">
          <span class="mobile-only">
            <Button
              variant="icon"
              ariaLabel="チャンネル一覧へ戻る"
              onclick={() => {
                if (viewportWidth < 600) nav.navigate({ type: 'list' })
              }}
            >
              ‹
            </Button>
          </span>
          <h1 class="main-card__title">チャンネル</h1>
        </div>
      </header>
      <div class="main-card__empty">
        <EmptyState
          title="チャンネルがありません。"
          description="チャンネル一覧から作成してください。"
          actionLabel="チャンネル一覧へ"
          onaction={goToChannelList}
        />
      </div>
    {:else}
      <header class="main-card__header">
        <div class="main-card__title-group">
          <span class="mobile-only">
            <Button
              variant="icon"
              ariaLabel="チャンネル一覧へ戻る"
              onclick={() => {
                if (viewportWidth < 600) nav.navigate({ type: 'list' })
              }}
            >
              ‹
            </Button>
          </span>
          <h1 class="main-card__title">fukulow</h1>
        </div>
      </header>
      <div class="main-card__empty">
        <Skeleton rows={4} label="読み込み中" />
      </div>
    {/if}
  </main>

  {#if panelOpen}
    <div class="right-panel-slot">
      <Panel
        id="panel-content"
        title={selected ? `# ${selected.name}` : '詳細'}
        activeTab={activePanelTab}
        mode={route?.panel?.startsWith('reply:') ? 'reply' : 'tabs'}
        showBack={!!nav.state.previousTab || viewportWidth < 600}
        onback={() => nav.navigate({ type: nav.state.previousTab ? 'reply-back' : 'close' })}
        bind:headingRef={panelHeadingRef}
        onselecttab={(tab) => {
          nav.navigate({ type: 'tab', tab })
        }}
        onclose={closePanel}
      >
        {#if route?.panel?.startsWith('reply:')}
          {#if currentReplies && currentChannel && selected && activeReplyMessageId}
            <ReplyPanel
              channel={currentChannel}
              replies={currentReplies}
              channelId={selected.id}
              anchorMessageId={activeReplyMessageId}
              resolvedAnchor={resolvedReplyAnchor}
              replyTargetStatus={replyTargetState.status}
              selfId={organization?.member.id ?? ''}
              {organizationUnavailable}
              bind:composerRef={replyComposerRef}
              resolveSenderName={resolveSender}
              onopenreplies={handleOpenReplies}
              onretrytarget={() => {
                if (route) void session.navigationTargets?.load(route, true)
              }}
              ongoToChannelList={goToChannelList}
              onrecheckmembership={onselectorganization && currentOrganizationId ? () => onselectorganization(currentOrganizationId) : undefined}
              onswitchorganization={otherOrg && onselectorganization ? () => onselectorganization(otherOrg.organization_id) : undefined}
            />
          {:else if replyTargetState.status === 'loading'}
            <Skeleton rows={3} label="返信のつながりを読み込み中" />
          {:else if replyTargetState.status === 'error'}
            <StatusBanner tone="danger" role="alert" message="返信のつながりを読み込めませんでした。" actionLabel="再試行" onaction={() => { if (route) void session.navigationTargets?.load(route, true) }} />
          {:else}
            <EmptyState title={replyTargetState.status === 'unavailable' ? 'この返信のつながりは利用できません。' : '返信のつながりの表示は準備中です。'} />
          {/if}
        {:else if activePanelTab === 'topics'}
          {#if currentTopics && selected}
            <TopicList
              topics={currentTopics}
              unread={currentUnread}
              channelId={selected.id}
              activeTopicId={route?.topicId ?? null}
              unavailable={organizationUnavailable || currentTimeline?.status === 'unavailable'}
              onselecttopic={handleSelectTopic}
              onstartnewtopic={organizationUnavailable || currentTimeline?.status === 'unavailable' ? undefined : handleStartNewTopic}
            />
          {:else}
            <EmptyState title="チャンネルを選んでください。" />
          {/if}
        {:else if activePanelTab === 'overview'}
          <EmptyState
            title="チャンネル概要は準備中です。"
            description={selected ? `# ${selected.name}（${selected.visibility === 'private' ? 'プライベート' : 'パブリック'}）` : undefined}
          />
        {:else}
          {#if channelMemberModel && selected && organization}
            <ChannelMembers model={channelMemberModel} channel={selected} self={organization.member.id} candidates={members?.state.members ?? []} />
          {:else}
            <EmptyState title="チャンネルを選んでください。" />
          {/if}
        {/if}
      </Panel>
    </div>
  {/if}
</div>

<style>
  .workspace {
    position: relative;
    display: grid;
    grid-template-columns: var(--rail-width) var(--channel-col-width) minmax(var(--main-min-width), 1fr);
    gap: var(--region-gap);
    height: 100%;
    padding: var(--space-8);
    background-color: var(--app);
    min-width: 0;
    overflow: hidden;
  }

  .workspace[data-panel-open='true'] {
    grid-template-columns:
      var(--rail-width)
      var(--channel-col-width)
      minmax(var(--main-min-width), 1fr)
      var(--panel-width);
  }

  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-8) var(--space-4);
    border-radius: var(--radius-16);
    background-color: var(--navbox);
    min-width: 0;
    min-height: 0;
  }

  .rail__top,
  .rail__bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-8);
  }

  .rail__logo {
    display: grid;
    place-items: center;
    width: var(--touch-target);
    height: var(--touch-target);
    background-color: var(--amber);
    color: var(--on-amber);
    border-radius: var(--radius-10);
    font-size: var(--font-size-17);
  }

  .channel-column {
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: var(--space-8);
    padding: var(--space-12);
    background-color: var(--navbox);
    border-radius: var(--radius-16);
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .channel-column__header {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .channel-column__scroll {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    min-height: 0;
    min-width: 0;
  }

  .channel-column__footer {
    min-width: 0;
  }

  .org-switcher {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .org-switcher__label {
    font-size: var(--font-size-12);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
  }

  .org-switcher__select {
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

  .member-summary {
    margin: 0;
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .channel-column__heading {
    margin: 0;
    border-radius: var(--radius-8);
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-semibold);
    color: var(--text2);
  }

  .main-card {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100%;
    min-height: 0;
    min-width: 0;
    background-color: var(--surface);
    border-radius: var(--radius-16);
    overflow: hidden;
  }

  .main-card__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-12) var(--space-16);
    min-width: 0;
  }

  .main-card__title-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .main-card__crumb {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main-card__title {
    margin: 0;
    font-size: var(--font-size-17);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main-card__header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    flex-shrink: 0;
  }

  .live-status {
    font-size: var(--font-size-12);
    color: var(--muted);
  }

  .main-card__body {
    min-height: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  .main-card__empty {
    padding: var(--space-16);
    min-width: 0;
  }

  .right-panel-slot {
    height: 100%;
    min-height: 0;
    min-width: 0;
    transition: transform var(--duration-panel) var(--ease-out);
  }

  .mobile-only {
    display: none;
  }

  /* 960px - 1279px: right panel overlays main from the right (docs/ui.md §3) */
  @media (min-width: 960px) and (max-width: 1279px) {
    .workspace,
    .workspace[data-panel-open='true'] {
      grid-template-columns: var(--rail-width) var(--channel-col-width) minmax(var(--main-min-width), 1fr);
    }

    .right-panel-slot {
      position: absolute;
      top: var(--space-8);
      right: var(--space-8);
      bottom: var(--space-8);
      width: var(--panel-width);
      z-index: 20;
    }
  }

  /* 600px - 959px: channel column is a drawer; right panel overlays min(420px, 100%) (docs/ui.md §3) */
  @media (min-width: 600px) and (max-width: 959px) {
    .workspace,
    .workspace[data-panel-open='true'] {
      grid-template-columns: var(--rail-width) minmax(0, 1fr);
    }

    .channel-column {
      display: none;
    }

    .workspace[data-drawer-open='true'] .channel-column {
      display: grid;
      position: absolute;
      top: var(--space-8);
      left: calc(var(--rail-width) + var(--space-16));
      bottom: var(--space-8);
      width: var(--channel-col-width);
      z-index: 30;
    }

    .right-panel-slot {
      position: absolute;
      top: var(--space-8);
      right: var(--space-8);
      bottom: var(--space-8);
      width: min(var(--panel-narrow-max), calc(100% - var(--space-16)));
      z-index: 20;
    }
  }

  /* < 600px (phone): one screen at a time, bottom tab bar only at channels level (docs/ui.md §3) */
  @media (max-width: 599px) {
    .mobile-only {
      display: inline-flex;
    }

    .workspace,
    .workspace[data-panel-open='true'] {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 1fr auto;
      padding: var(--space-4);
      gap: var(--space-4);
    }

    .rail {
      grid-row: 2;
      flex-direction: row;
      width: 100%;
      padding: var(--space-4) var(--space-12);
    }

    .rail__top,
    .rail__bottom {
      flex-direction: row;
    }

    .workspace[data-mobile-level='view'] .rail,
    .workspace[data-mobile-level='view'] .channel-column,
    .workspace[data-mobile-level='view'] .right-panel-slot {
      display: none;
    }

    .workspace[data-mobile-level='channels'] .main-card,
    .workspace[data-mobile-level='channels'] .right-panel-slot {
      display: none;
    }

    .workspace[data-mobile-level='panel'] .rail,
    .workspace[data-mobile-level='panel'] .channel-column,
    .workspace[data-mobile-level='panel'] .main-card {
      display: none;
    }
  }
</style>
