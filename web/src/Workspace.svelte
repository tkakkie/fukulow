<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import type { Navigation } from './navigation'
  import { navigationAdapter } from './navigation.svelte'
  import type { SearchPresentation } from './search-anchor.svelte'
  import { createSubscriber, MediaQuery } from 'svelte/reactivity'
  import { BREAKPOINT_QUERIES, resolveViewportClass, type ViewportClass } from './breakpoints'
  import { createAnnouncementController } from './announcements'
  import type { MentionName } from './mentions'
  import { senderName } from './authors'
  import type { Channel, ChannelVisibility, DmDiscovery, Identity, Message, SearchHit } from './api'
  import type { ChannelCreationBlocked } from './channel-creation'
  import Logo from './Logo.svelte'
  import type { Organization } from './api-schema.d.ts'
  import type { SessionModel } from './auth.svelte'
  import { shouldCloseOnEscape, shouldTogglePanelShortcut } from './composer-keys'
  import {
    createTopicSummaryFocusController,
    focusAfterPanelClose,
    focusIfVisible,
    focusTarget,
    resolveChannelListNavigation,
    resolveMainTimelineFocusStatus,
    resolveSkipLinkTargetId,
    type SkipLinkTargetId,
  } from './focus-management'
  import { channelMembersAdapter } from './channel-members.svelte'
  import type { membersAdapter } from './members.svelte'
  import { createSearchController, type SearchTarget } from './search'
  import { searchAdapter } from './search.svelte'
  import { createDefaultSearchSource, type SearchSource } from './search-source'
  import WorkspaceChannelColumn from './WorkspaceChannelColumn.svelte'
  import WorkspaceMainView from './WorkspaceMainView.svelte'
  import WorkspacePanelContent from './WorkspacePanelContent.svelte'
  import {
    createChannelSelection,
    parsePanelTab,
    parseReplyMessageId,
    resolveMobileLevel,
    resolveReplyAnchor,
    shouldClosePanelForDm,
  } from './workspace-routing'
  import Button from './ui/Button.svelte'
  import Panel from './ui/Panel.svelte'

  // The session's controllers outlive this component: unmounting it never closes the connection.
  let {
    session,
    navigation,
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
    searchSource,
  }: {
    navigation: Navigation
    session: SessionModel
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
    searchSource?: SearchSource
  } = $props()

  const channels = $derived(session.channels)
  const creationAccess = $derived(channels.creationAccess)
  const channelCreation = $state({ name: '', visibility: 'public' as ChannelVisibility, error: '',
    permissionError: null as ChannelCreationBlocked['blocked'] | null, busy: false })
  $effect(() => {
    if (creationAccess === 'allowed' && channelCreation.permissionError) channelCreation.permissionError = null
  })
  const creationLifetime = new AbortController()
  onDestroy(() => creationLifetime.abort())
  // One adapter read per derived: every read of the adapter registers a listener effect.
  const s = $derived(channels.state)
  const sectionsState = $derived(session.sections?.state)
  const dmState = $derived(session.dms?.state)
  const channelListStatus = $derived(s.status)
  const currentOrganizationId = $derived(selectedOrganizationId || organization?.organization.organization_id || '')
  const nav = navigationAdapter(() => navigation)
  const route = $derived(nav.state.target)
  const routeChannelId = $derived(route?.organizationId === currentOrganizationId ? route.channelId : s.selectedId)
  const selected = $derived<Channel | DmDiscovery | undefined>(dmState?.rows.find(row => row.identity.id === routeChannelId)?.identity ?? s.channels.find((c) => c.id === routeChannelId) ?? (s.openChannel?.id === routeChannelId ? s.openChannel : undefined) ?? s.archivedList?.channels.find((c) => c.id === routeChannelId) ?? (routeChannelId ? {
    id: routeChannelId, kind: 'channel', archived: false, name: 'チャンネル', visibility: 'public',
    capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_manage_managers: { allowed: false }, can_leave: { allowed: false }, can_rename: { allowed: false }, can_archive: { allowed: false } },
  } : undefined))
  const conversationName = $derived(selected?.kind === 'dm' ? selected.peer.name : selected?.name ?? '')
  const dmLapsed = $derived(selected?.kind === 'dm' && dmState?.sendBlocks[selected.id] === 'dm_peer_access_lapsed')
  const dmSendDisabled = $derived(selected?.kind === 'dm' && (!selected.peer.active || Boolean(dmState?.sendBlocks[selected.id])))
  const selectedArchived = $derived(selected?.kind === 'channel' && (selected.archived || channels.isArchived(selected.id)))
  const archiveStatePending = $derived(s.openChannelPending && s.openChannel?.id === selected?.id)
  const sendDisabled = $derived(dmSendDisabled || selectedArchived || archiveStatePending)
  const currentChannel = $derived(selected ? session.sync.channel(selected.id) : null)
  const currentTimeline = $derived(currentChannel ? currentChannel.timeline : null)
  const currentLive = $derived(currentChannel ? currentChannel.live : false)
  const currentTopics = $derived(selected?.kind === 'channel' ? session.topics(selected.id) : null)
  const currentTopicsState = $derived(currentTopics ? currentTopics.state : null)
  const currentReplies = $derived(selected ? session.replies?.(selected.id) ?? null : null)
  const currentRepliesState = $derived(currentReplies ? currentReplies.state : null)
  const currentUnread = $derived(selected ? session.unread?.(selected.id) ?? null : null)
  const selectedChannelUnread = $derived(s.selectedId ? session.unread?.(s.selectedId) ?? null : null)
  const selectedChannelUnreadState = $derived(selectedChannelUnread ? selectedChannelUnread.state : null)
  const channelUnreadCount = (id: string): number | null =>
    session.unread?.(id).state.unreadCount ?? null
  const channelMentionUnreadCount = (id: string): number | null =>
    session.unread?.(id).state.mentionUnreadCount ?? null
  const activeReplyMessageId = $derived(parseReplyMessageId(route?.panel))
  const searchResult = $derived(route?.organizationId === currentOrganizationId ? nav.state.searchResult : undefined)
  const searchRead = $derived(session.searchAnchor?.state)
  const searchView = $derived(searchRead?.target === searchResult ? searchRead : undefined)
  const search = $derived<SearchPresentation | undefined>(session.searchAnchor && searchResult && !searchResult.replyRootId
    ? { target: searchResult, view: searchView, retry: session.searchAnchor.retry, loadOlder: session.searchAnchor.loadOlder,
        loadNewer: session.searchAnchor.loadNewer, latest: navigation.leaveSearchResult }
    : undefined)
  const searchReply = $derived(Boolean(searchResult?.replyRootId))
  let lastOpenedAnchor = $state<Message | null>(null)
  const inMemoryReplyAnchor = $derived(
    resolveReplyAnchor({
      activeReplyMessageId,
      selectedChannelId: selected?.id,
      lastOpenedAnchor: () => lastOpenedAnchor,
      timelineMessages: () => currentTimeline?.messages,
      topicLines: () => currentTopicsState?.lines,
      routedTopicMessages: () => (route?.topicId && currentTopicsState ? currentTopicsState.topic(route.topicId).messages : undefined),
      replies: () => currentRepliesState,
    }),
  )
  const replyTargetState = $derived(
    searchReply
      ? { status: searchView?.status === 'missing' ? 'unavailable' as const : searchView?.status ?? 'loading' as const,
          anchor: searchView?.reply }
      : session.navigationTargets &&
      (!session.navigationTargets.state.reply.targetId ||
        session.navigationTargets.state.reply.targetId === activeReplyMessageId)
      ? session.navigationTargets.state.reply
      : { status: 'idle' as const, name: '' },
  )
  const resolvedReplyAnchor = $derived(
    (searchReply ? searchView?.reply : inMemoryReplyAnchor ?? replyTargetState.anchor) ?? null,
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
  const activePanelTab = $derived(parsePanelTab(route?.panel))
  $effect(() => {
    if (shouldClosePanelForDm(selected?.kind, () => route?.panel)) nav.navigate({ type: 'close' })
  })
  const phoneQuery = new MediaQuery(BREAKPOINT_QUERIES.phone, false)
  const tabletQuery = new MediaQuery(BREAKPOINT_QUERIES.tablet, false)
  const desktopQuery = new MediaQuery(BREAKPOINT_QUERIES.desktop, true)
  const viewport = $derived<ViewportClass>(
    resolveViewportClass({
      phone: phoneQuery.current,
      tablet: tabletQuery.current,
      desktop: desktopQuery.current,
    }),
  )
  const isPhone = $derived(viewport === 'phone')

  let channelListHeadingRef = $state<HTMLElement | null>(null)
  let mainComposerRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let mainHeadingRef = $state<HTMLElement | null>(null)
  let mainTopicInputRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let mainTimelineRef = $state<{ isPositioning(): boolean } | null>(null)
  let replyComposerRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let searchInputRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let channelListSearchInputRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let searchResultsHeadingRef = $state<HTMLElement | null>(null)
  let panelToggleBtn = $state<HTMLButtonElement | null>(null)
  let panelHeadingRef = $state<HTMLElement | null>(null)
  let focusTopicInputNext = false
  let appliedFocusRevision = -1
  let navFocusBaseline: { revision: number; active: Element | null } = { revision: -1, active: null }
  const topicSummaryFocus = createTopicSummaryFocusController()

  let activeSearch = $state.raw<{
    organizationId: string
    source: SearchSource | undefined
    controller: ReturnType<typeof createSearchController>
  } | undefined>(undefined)
  const resolvedSearchSource = $derived(searchSource ?? session.searchSource)
  const searchModel = $derived(
    activeSearch &&
      activeSearch.organizationId === currentOrganizationId &&
      activeSearch.source === resolvedSearchSource
      ? searchAdapter(activeSearch.controller)
      : undefined,
  )
  const searchState = $derived(searchModel?.state)
  const searchOpen = $derived(Boolean(searchState?.open && !organizationUnavailable))
  const effectiveMobileLevel = $derived(resolveMobileLevel(route, () => searchOpen))
  const mainViewSelected = $derived(
    !isPhone || effectiveMobileLevel === 'view',
  )
  const currentSkipTargetId = $derived(
    resolveSkipLinkTargetId({
      viewport,
      mobileLevel: effectiveMobileLevel,
      panelOpen,
    }),
  )
  $effect(() => {
    const orgId = currentOrganizationId
    const providedSource = resolvedSearchSource
    const controller = createSearchController({
      source: providedSource ?? createDefaultSearchSource(orgId),
      onOpenResult: (target) => handleOpenSearchResult(orgId, target),
      onAnnounce: (message) => onannounce?.(message),
    })
    const stopRevoke = session.onChannelRevoked?.((channelId) => controller.revokeChannel(channelId))
    const entry = { organizationId: orgId, source: providedSource, controller }
    activeSearch = entry
    return () => {
      stopRevoke?.()
      controller.destroy()
      if (activeSearch === entry) activeSearch = undefined
    }
  })
  let lastSearchMainKey: string | null = null
  $effect(() => {
    const mainKey = `${route?.organizationId ?? ''}:${route?.channelId ?? ''}:${route?.topicId ?? ''}`
    if (lastSearchMainKey !== null && mainKey !== lastSearchMainKey) {
      untrack(() => searchModel?.close())
    }
    lastSearchMainKey = mainKey
  })

  const selectedChannelId = $derived(selected?.id)
  const selectedKind = $derived(selected?.kind)
  const channelMemberTarget = $derived(
    panelOpen && activePanelTab === 'members' && selectedChannelId && selectedKind !== 'dm'
      ? selectedChannelId
      : null,
  )
  let activeChannelMembers = $state.raw<{
    session: SessionModel
    organizationId: string
    channelId: string
    controller: ReturnType<NonNullable<SessionModel['channelMembers']>>
  } | undefined>(undefined)
  const channelMemberModel = $derived(
    activeChannelMembers &&
      activeChannelMembers.session === session &&
      activeChannelMembers.organizationId === currentOrganizationId &&
      activeChannelMembers.channelId === channelMemberTarget
      ? channelMembersAdapter(activeChannelMembers.controller)
      : undefined,
  )
  $effect(() => {
    const currentSession = session
    const orgId = currentOrganizationId
    const channelId = channelMemberTarget
    const open = currentSession.channelMembers
    if (!channelId || !open) {
      activeChannelMembers = undefined
      return
    }
    const controller = untrack(() => {
      void members?.load()
      return open(channelId)
    })
    const entry = { session: currentSession, organizationId: orgId, channelId, controller }
    activeChannelMembers = entry
    return () => {
      controller.close()
      if (activeChannelMembers === entry) activeChannelMembers = undefined
    }
  })
  let lastViewId = $state('')
  // A cold descendant URL can resolve to its root before its own body is paged in.
  let openedReplyTarget = ''

  const authorIdentities = $derived(members?.authors.identities)
  const resolveMentionName: MentionName = (id, fallback, mentions) => members?.authors.mentionName(id, fallback, mentions) ?? fallback
  const memberNames = $derived(new Map((members?.state.members ?? []).map(member => [member.id, member.name])))
  $effect(() => {
    const ids: string[] = []
    for (const line of currentTopicsState?.lines ?? []) {
      ids.push(line.kind === 'message' ? line.message.sender : line.latestMessage.sender)
    }
    for (const message of currentTimeline?.messages ?? []) ids.push(message.sender)
    if (route?.topicId && currentTopicsState) {
      for (const message of currentTopicsState.topic(route.topicId).messages) ids.push(message.sender)
    }
    for (const message of currentRepliesState?.messages ?? []) ids.push(message.sender)
    for (const message of searchView?.messages ?? []) ids.push(message.sender)
    for (const line of searchView?.lines ?? []) if (line.kind === 'topic') ids.push(line.latestMessage.sender)
    if (searchOpen && searchState) {
      for (const hit of searchState.items) ids.push(hit.message.sender)
    }
    if (resolvedReplyAnchor) ids.push(resolvedReplyAnchor.sender)
    members?.authors.watch(ids)
  })
  $effect(() => { void selectedChannelId; members?.authors.retry() })
  $effect(() => { if (currentLive) members?.authors.retry() })

  const initialDisplayViewKey = $derived(
    selected && currentChannel && !search
      ? `${currentOrganizationId}:${selected.id}:${route?.topicId ?? ''}`
      : '',
  )
  const activeTopicView = $derived(
    route?.topicId && currentTopicsState ? currentTopicsState.topic(route.topicId) : null,
  )
  const activeViewBaseReady = $derived.by(() => {
    if (!selected || !currentChannel || search || organizationUnavailable) return false
    if (route?.topicId && currentTopics) {
      return Boolean(
        activeTopicView?.initialized &&
          !activeTopicView.notFound &&
          currentTimeline?.status !== 'unavailable' &&
          !currentTopicsState?.unavailable,
      )
    }
    if (currentTimeline?.status !== 'ready' || currentTopicsState?.unavailable) return false
    if (currentTopics) return currentTopicsState?.main.asOfSeq !== undefined
    return true
  })
  const activeViewUnavailable = $derived(
    Boolean(
      organizationUnavailable ||
        currentTimeline?.status === 'unavailable' ||
        currentTopicsState?.unavailable ||
        (route?.topicId && activeTopicView?.notFound),
    ),
  )
  const initialViewSenderIds = $derived.by((): string[] => {
    if (!initialDisplayViewKey || activeViewUnavailable || !members || resolveSenderName) return []
    const selfId = organization?.member.id ?? ''
    const ids = new Set<string>()
    if (route?.topicId && activeTopicView) {
      for (const message of activeTopicView.messages) {
        if (message.sender !== selfId) ids.add(message.sender)
      }
    } else {
      const lines = currentTopicsState?.lines ?? (currentTimeline?.messages ?? []).map(message => ({ kind: 'message' as const, message }))
      for (const line of lines) {
        if (line.kind === 'message' && line.message.sender !== selfId) ids.add(line.message.sender)
      }
    }
    return [...ids]
  })
  let initialDisplayCompletedKey = $state('')
  let reportedPositioning = $state<{ key: string; positioning: boolean }>({ key: '', positioning: false })
  const activeViewPositioning = $derived(
    Boolean(
      initialDisplayViewKey &&
        !activeViewUnavailable &&
        (reportedPositioning.key !== initialDisplayViewKey || reportedPositioning.positioning),
    ),
  )
  const awaitingInitialSenders = $derived(
    Boolean(
      initialDisplayViewKey &&
        !activeViewUnavailable &&
        members &&
        !resolveSenderName &&
        initialDisplayCompletedKey !== initialDisplayViewKey &&
        !members.authors.isInitialDisplayTimedOut(initialDisplayViewKey) &&
        initialViewSenderIds.some(id => !memberNames.has(id) && members.authors.isPending(id)),
    ),
  )
  const firstDisplayReached = $derived.by(() => {
    if (organizationUnavailable) return false
    if (searchOpen) return true
    if (selected && currentChannel) {
      if (route?.topicId && currentTopics) {
        const topicStatus = session.navigationTargets?.state.topic.status ?? 'idle'
        const terminal = Boolean(
          currentTimeline?.status === 'unavailable' ||
            currentTopicsState?.unavailable ||
            activeTopicView?.notFound ||
            activeTopicView?.error ||
            topicStatus === 'unavailable' ||
            topicStatus === 'error',
        )
        return terminal || (activeViewBaseReady && !awaitingInitialSenders && !activeViewPositioning)
      }
      const terminal = Boolean(
        currentTimeline?.status === 'unavailable' ||
          currentTimeline?.status === 'error' ||
          currentTopicsState?.unavailable ||
          (currentTopics && currentTimeline?.status === 'ready' && currentTopicsState?.main.asOfSeq === undefined && currentTopicsState?.main.error),
      )
      return terminal || (activeViewBaseReady && !awaitingInitialSenders && !activeViewPositioning)
    }
    return channelListStatus === 'ready' || channelListStatus === 'error'
  })
  $effect(() => {
    if (!members) return
    members.authors.syncInitialDisplay(initialDisplayViewKey, awaitingInitialSenders)
    if (initialDisplayViewKey && activeViewBaseReady && !awaitingInitialSenders && initialDisplayCompletedKey !== initialDisplayViewKey) {
      initialDisplayCompletedKey = initialDisplayViewKey
    }
  })
  $effect(() => {
    if (firstDisplayReached) members?.scheduleActivate()
  })

  function resolveSender(senderId: string): string {
    if (resolveSenderName) return resolveSenderName(senderId)
    const listed = memberNames.get(senderId)
    if (listed !== undefined) return listed
    const identity = authorIdentities?.get(senderId)
    if (identity) return senderName(identity)
    // A pending or failed directory load must not hide the caller's own name.
    if (organization?.member.id === senderId) return organization.member.name
    return senderName(undefined)
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
    nav.initialize({ organizationId: currentOrganizationId, channelId: isPhone ? null : s.selectedId, topicId: null, panel: null })
  })

  $effect(() => {
    if (channelListStatus !== 'ready' || route?.organizationId !== currentOrganizationId) return
    // Follow URL changes; reacting to creation's selection would briefly reselect the old Channel.
    if (route.channelId && route.channelId !== untrack(() => s.selectedId)) channels.selectHint(route.channelId)
  })

  $effect(() => {
    if (route?.organizationId !== currentOrganizationId || organizationUnavailable) return
    const skipReplyHint = searchReply || Boolean(currentReplies && activeReplyMessageId && untrack(() => inMemoryReplyAnchor))
    void session.navigationTargets?.load(skipReplyHint ? { ...route, panel: null } : route)
  })

  $effect(() => {
    const anchor = session.searchAnchor
    const result = searchResult
    anchor?.open(result)
    if (result) drawerOpen = false
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
      else if (state.focus === 'opener') {
        if (searchOpen) {
          if (!focusTarget(navigation.getOpener()) && !focusTarget(searchInputRef)) {
            focusTarget(searchResultsHeadingRef)
          }
        } else {
          focusAfterPanelClose(navigation.getOpener(), mainComposerRef)
        }
      }
      else {
        const preferTopicInput = focusTopicInputNext
        focusTopicInputNext = false
        if (!(preferTopicInput && focusTarget(mainTopicInputRef))) {
          if (!focusTarget(mainComposerRef) && state.searchResult) focusTarget(mainHeadingRef)
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
    if (mainTimelineRef?.isPositioning()) return
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
      awaitingInitialSenders,
      positioning: activeViewPositioning,
    })
    const composer = mainComposerRef
    let cancelled = false
    void tick().then(() => {
      if (cancelled || nav.state.revision !== revision || mainTimelineRef?.isPositioning()) return
      topicSummaryFocus.step({
        revision,
        status,
        findSummary: (topic) => {
          if (activeViewPositioning) return null
          const el = document.querySelector<HTMLElement>(`#main-content [data-topic-id="${CSS.escape(topic)}"]`)
          if (!el || el.closest('[inert], [aria-busy="true"]')) return null
          return el
        },
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
      kind: route?.topicId ? 'topic' : selected.kind === 'dm' ? 'dm' : 'channel',
      name: route?.topicId ? (resolvedTopicName || 'トピック') : conversationName,
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
      isSenderPending: (id) => !resolveSenderName && id !== organization?.member.id && (members?.authors.isPending(id) ?? false),
    })
  })

  const handleSelectChannel = createChannelSelection({
    getOrganizationId: () => currentOrganizationId,
    getSelectedId: () => s.selectedId,
    getNavigation: () => nav,
    selectChannel: (id) => channels.select(id),
    isKnownChannel: (id) =>
      s.channels.some((c) => c.id === id) ||
      Boolean(s.archivedList?.channels.some((c) => c.id === id)) ||
      s.openChannel?.id === id,
    selectChannelHint: (id) => channels.selectHint(id),
    isDm: (id) => Boolean(dmState?.rows.some((row) => row.identity.id === id)),
    selectDm: (id) => session.dms?.select(id),
    retryAuthors: () => { members?.authors.retry() },
    getCurrentUnread: () => currentUnread,
    onCloseDrawer: () => { drawerOpen = false },
  })

  async function handleOpenDm(member: string, renew = false) {
    await session.dms?.open(member, renew)
    const id = session.dms?.state.selected
    if (id && channels.state.selectedId === id) handleSelectChannel(id)
  }
  let recoveredSelection = ''
  $effect(() => {
    const id = dmState?.recovered
    if (!id) { recoveredSelection = ''; return }
    if (id !== recoveredSelection && s.selectedId === id) {
      recoveredSelection = id
      untrack(() => handleSelectChannel(id))
    }
  })

  function handleSelectTopic(topicId: string) {
    if (!selected || !currentOrganizationId) return
    searchModel?.close()
    const wasSameTopic = route?.topicId === topicId
    nav.navigate({
      type: 'topic',
      topicId,
      phone: isPhone,
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
      if (isPhone && route.panel) {
        navigated = Boolean(nav.navigate({ type: 'close' })) || navigated
      }
    } else if (isPhone && panelOpen) {
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

  async function handleCreateChannel(name: string, visibility: ChannelVisibility): Promise<string | ChannelCreationBlocked | null | false> {
    const result = await channels.create(name, visibility, creationLifetime.signal)
    if (!result || creationLifetime.signal.aborted) return false
    if ('blocked' in result) return result
    if ('error' in result) return result.error
    handleSelectChannel(result.channel.id)
    return null
  }

  function openPanel() {
    if (selected?.kind === 'dm') return
    const active = typeof document !== 'undefined' ? document.activeElement : null
    const opener = searchOpen
      ? (active instanceof HTMLElement && active !== document.body && active !== document.documentElement
          ? active
          : searchInputRef)
      : panelToggleBtn
    nav.navigate({ type: 'tab', tab: 'topics' }, opener)
  }
  function closePanel() { nav.navigate({ type: 'close' }) }
  function togglePanel() { if (panelOpen) closePanel(); else openPanel() }
  function goToChannelList() {
    const next = resolveChannelListNavigation(viewport)
    drawerOpen = next.drawerOpen
    if (isPhone && nav.navigate({ type: 'list' })) {
      return
    }
    void tick().then(() => {
      focusIfVisible(channelListHeadingRef)
    })
  }

  function resolveSearchContext(hit: SearchHit): string {
    const channelId = hit.message.channel_id
    if (hit.channel_kind === 'dm') {
      const peer = dmState?.rows.find((row) => row.identity.id === channelId)?.identity.peer
      if (!peer) return 'ダイレクトメッセージ'
      return `ダイレクトメッセージ: ${peer.name}${peer.active ? '' : '（無効）'}`
    }
    const channelName =
      s.channels.find((c) => c.id === channelId)?.name ??
      s.archivedList?.channels.find((c) => c.id === channelId)?.name ??
      (s.openChannel?.id === channelId ? s.openChannel.name : undefined)
    const base = channelName ? `# ${channelName}` : 'チャンネル'
    const topicId = hit.message.topic_id
    if (!topicId) return base
    const topicName = session.topics(channelId).state.topics
      .find((t) => t.topicId === topicId)?.baseline?.summary.name
    return topicName ? `${base} › ${topicName}` : base
  }

  function canOpenSearchTarget(target: SearchTarget): boolean {
    const isDm = Boolean(dmState?.rows.some((row) => row.identity.id === target.channelId))
    const hasChannel = Boolean(
      isDm ||
      s.channels.some((c) => c.id === target.channelId) ||
      s.archivedList?.channels.some((c) => c.id === target.channelId) ||
      s.openChannel?.id === target.channelId,
    )
    // A hit's kind comes from the server, which only returns readable Messages; an unloaded
    // Channel or DM opens through the unknown-kind hint and the server decides availability.
    if (!hasChannel && !target.channelKind) return false
    if (!target.topicId) return true
    if (isDm || target.channelKind === 'dm') return false
    const topicsState = session.topics(target.channelId).state
    if (topicsState.topic(target.topicId).notFound) return false
    if (topicsState.topics.some((t) => t.topicId === target.topicId)) return true
    const allKnown =
      topicsState.list.asOfSeq !== undefined
        ? !topicsState.list.hasMore
        : topicsState.main.asOfSeq !== undefined && !topicsState.main.hasMore
    return !allKnown
  }

  function handleOpenSearchResult(organizationId: string, target: SearchTarget): boolean {
    if (!organizationId || organizationId !== currentOrganizationId || organizationUnavailable || !canOpenSearchTarget(target)) return false
    handleSelectChannel(target.channelId, target)
    return true
  }

  function handleSubmitSearch(value: string, origin: 'main' | 'channel-list') {
    if (!searchModel) return
    void searchModel.submit(value)
    if (origin === 'channel-list' && value.trim().length > 0) {
      void tick().then(() => {
        if (!focusTarget(searchInputRef)) focusTarget(searchResultsHeadingRef)
      })
    }
  }

  function handleCloseSearch() {
    searchModel?.close()
    void tick().then(() => {
      const target =
        isPhone && !route?.channelId
          ? channelListSearchInputRef
          : searchInputRef
      focusTarget(target)
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
    if (searchOpen) {
      e.preventDefault()
      handleCloseSearch()
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
        <Logo />
      </div>
      <Button
        variant="icon"
        ariaLabel="チャンネル一覧"
        ariaExpanded={drawerOpen}
        onclick={() => {
          if (isPhone) {
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
    <WorkspaceChannelColumn
      {organizations}
      {currentOrganizationId}
      {organization}
      {organizationUnavailable}
      showMobileSearch={isPhone && effectiveMobileLevel === 'channels' && Boolean(searchModel && searchState)}
      searchInput={searchState?.input ?? ''}
      {searchOpen}
      searchDisabled={organizationUnavailable || !currentOrganizationId}
      channelListStatus={s.status}
      channelListTimedOut={announcementView.channelListTimedOut}
      sectionsReconnecting={Boolean(sectionsState?.reconnecting)}
      channels={s.channels}
      selectedId={s.selectedId}
      activeTopicId={route?.channelId === s.selectedId ? (route?.topicId ?? null) : null}
      topics={currentTopicsState && selected?.id === s.selectedId ? currentTopicsState.topics : []}
      allTopicsKnown={selected?.id === s.selectedId ? allTopicsKnown : false}
      {channelUnreadCount}
      {channelMentionUnreadCount}
      topicUnreadCounts={selectedChannelUnreadState?.topics ?? {}}
      sections={session.sections}
      {creationAccess}
      createChannelDraft={channelCreation}
      archivedList={s.archivedList}
      dms={dmState && session.dms
        ? {
            rows: dmState.rows,
            loading: dmState.status === 'loading',
            error: dmState.status === 'error',
            message: dmState.message,
            busy: dmState.busy,
            more: !dmState.lanes.browse.done,
          }
        : null}
      {members}
      {authError}
      bind:headingRef={channelListHeadingRef}
      bind:searchInputRef={channelListSearchInputRef}
      {onselectorganization}
      onsearchinput={(value) => searchModel?.setInput(value)}
      onsearchsubmit={(value) => handleSubmitSearch(value, 'channel-list')}
      onretrychannels={() => {
        announcementController.resetChannelListTimeout()
        void channels.load()
      }}
      onselectchannel={handleSelectChannel}
      onselecttopic={handleSelectTopic}
      onopenalltopics={(opener) => nav.navigate({ type: 'tab', tab: 'topics' }, opener)}
      oncreatechannel={handleCreateChannel}
      onholdarchived={() => channels.holdArchived()}
      onretryarchived={() => channels.retryArchived()}
      ondmmore={() => session.dms?.browse()}
      ondmretry={() => session.dms?.refresh()}
      onopenmembers={() => { void members?.load() }}
      onopendm={session.dms ? (member) => { void handleOpenDm(member) } : undefined}
      onmemberchanged={(id) => {
        if (organization && id === organization.member.id && currentOrganizationId) {
          onselectorganization?.(currentOrganizationId)
        }
      }}
    />
  </nav>

  <main id="main-content" class="main-card" tabindex="-1">
    <WorkspaceMainView
      searchState={searchModel ? searchState : undefined}
      {searchOpen}
      searchDisabled={organizationUnavailable || !currentOrganizationId}
      {selected}
      {conversationName}
      {currentChannel}
      {currentLive}
      currentTimelineUnavailable={currentTimeline?.status === 'unavailable'}
      {currentTopics}
      {currentReplies}
      {currentUnread}
      activeTopicId={route?.topicId ?? null}
      {resolvedTopicName}
      topicStatus={session.navigationTargets?.state.topic.status ?? 'idle'}
      {search}
      organizationName={organization?.organization.name}
      selfId={organization?.member.id ?? ''}
      canRenewDm={organization?.member.role !== 'guest'}
      {dmLapsed}
      dmBusy={dmState?.busy ?? false}
      {selectedArchived}
      {archiveStatePending}
      {sendDisabled}
      {organizationUnavailable}
      reconnecting={announcementView.reconnecting}
      channelListStatus={s.status}
      {panelOpen}
      {mainViewSelected}
      {awaitingInitialSenders}
      members={members?.state.members ?? []}
      resolveSenderName={resolveSender}
      {resolveSearchContext}
      {resolveMentionName}
      bind:searchInputRef={searchInputRef}
      bind:searchResultsHeadingRef={searchResultsHeadingRef}
      bind:mainHeadingRef={mainHeadingRef}
      bind:panelToggleBtn={panelToggleBtn}
      bind:composerRef={mainComposerRef}
      bind:topicInputRef={mainTopicInputRef}
      bind:timelineRef={mainTimelineRef}
      onsearchinput={(value) => searchModel?.setInput(value)}
      onsearchsubmit={(value) => handleSubmitSearch(value, 'main')}
      onclosesearch={handleCloseSearch}
      onopensearchresult={(target) => searchModel?.openSearchResult(target)}
      onloadmoresearch={() => { void searchModel?.loadMore() }}
      onretrysearch={() => { void searchModel?.retry() }}
      onbacktochannels={() => {
        if (isPhone) nav.navigate({ type: 'list' })
      }}
      onbacktochannel={() => nav.navigate({ type: 'topic-back' })}
      ontogglepanel={togglePanel}
      onrenewdm={() => { if (selected?.kind === 'dm') void handleOpenDm(selected.peer.id, true) }}
      onmentionrequest={() => { void members?.load() }}
      onopentopic={handleSelectTopic}
      onopenreplies={handleOpenReplies}
      onretrytopicmeta={() => {
        if (route) void session.navigationTargets?.load(route, true)
      }}
      ongoToChannelList={goToChannelList}
      onrecheckmembership={onselectorganization && currentOrganizationId ? () => onselectorganization(currentOrganizationId) : undefined}
      onswitchorganization={otherOrg && onselectorganization ? () => onselectorganization(otherOrg.organization_id) : undefined}
      onpositioningchange={(positioning) => {
        reportedPositioning = { key: initialDisplayViewKey, positioning }
      }}
    />
  </main>

  {#if panelOpen}
    <div class="right-panel-slot">
      <Panel
        id="panel-content"
        title={selected ? `${selected.kind === 'dm' ? '' : '# '}${conversationName}` : '詳細'}
        activeTab={activePanelTab}
        mode={route?.panel?.startsWith('reply:') ? 'reply' : 'tabs'}
        showBack={!!nav.state.previousTab || isPhone}
        onback={() => nav.navigate({ type: selected?.kind !== 'dm' && nav.state.previousTab ? 'reply-back' : 'close' })}
        bind:headingRef={panelHeadingRef}
        onselecttab={(tab) => {
          nav.navigate({ type: 'tab', tab })
        }}
        onclose={closePanel}
      >
        <WorkspacePanelContent
          mode={route?.panel?.startsWith('reply:') ? 'reply' : 'tabs'}
          activeTab={activePanelTab}
          {selected}
          {currentChannel}
          {currentTopics}
          {currentReplies}
          {currentUnread}
          {channelMemberModel}
          moveChain={session.moveChain}
          activeTopicId={route?.topicId ?? null}
          {activeReplyMessageId}
          {resolvedReplyAnchor}
          replyTargetStatus={replyTargetState.status}
          {searchReply}
          searchVisit={searchReply ? searchView?.visit : undefined}
          selfId={organization?.member.id}
          {organizationUnavailable}
          currentTimelineUnavailable={currentTimeline?.status === 'unavailable'}
          {sendDisabled}
          {selectedArchived}
          {archiveStatePending}
          members={members?.state.members ?? []}
          resolveSenderName={resolveSender}
          {resolveMentionName}
          bind:replyComposerRef={replyComposerRef}
          {onannounce}
          onmentionrequest={() => { void members?.load() }}
          onopenreplies={handleOpenReplies}
          onretrytarget={() => {
            if (searchReply) void session.searchAnchor?.retry()
            else if (route) void session.navigationTargets?.load(route, true)
          }}
          onretryreplyload={() => {
            if (route) void session.navigationTargets?.load(route, true)
          }}
          ongoToChannelList={goToChannelList}
          onrecheckmembership={onselectorganization && currentOrganizationId ? () => { if (currentOrganizationId) onselectorganization(currentOrganizationId) } : undefined}
          onswitchorganization={otherOrg && onselectorganization ? () => { if (otherOrg) onselectorganization(otherOrg.organization_id) } : undefined}
          onselecttopic={handleSelectTopic}
          onstartnewtopic={handleStartNewTopic}
          onrename={(name) => (selected?.kind === 'channel' ? channels.rename(selected.id, name) : Promise.resolve(null))}
          onarchive={() => (selected?.kind === 'channel' ? channels.archive(selected.id) : Promise.resolve(null))}
          onrestore={() => (selected?.kind === 'channel' ? channels.restore(selected.id) : Promise.resolve(null))}
        />
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
    /* clip (not hidden) avoids creating a scroll container that focus() on a sliding-in panel can scroll sideways */
    overflow: clip;
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

  .right-panel-slot {
    height: 100%;
    min-height: 0;
    min-width: 0;
  }

  /* 960px - 1279px: right panel overlays main from the right (docs/ui.md §3) */
  @media (960px <= width < 1280px) {
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
  @media (600px <= width < 960px) {
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
  @media (width < 600px) {
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
