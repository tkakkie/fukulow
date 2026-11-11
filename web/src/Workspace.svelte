<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { Navigation } from './navigation'
  import { navigationAdapter } from './navigation.svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import { createAnnouncementController } from './announcements'
  import type { Identity } from './api'
  import type { Organization } from './api-schema.d.ts'
  import type { SessionModel } from './auth.svelte'
  import ChannelList from './ChannelList.svelte'
  import { shouldCloseOnEscape, shouldTogglePanelShortcut } from './composer-keys'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import {
    focusAfterPanelClose,
    focusTarget,
    resolveSkipLinkTargetId,
    type SkipLinkTargetId,
  } from './focus-management'
  import Members from './MemberList.svelte'
  import type { membersAdapter } from './members.svelte'
  import Timeline from './Timeline.svelte'
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
  const selected = $derived(s.channels.find((c) => c.id === routeChannelId) ?? (routeChannelId ? { id: routeChannelId, name: 'チャンネル', visibility: 'public' } : undefined))
  const currentChannel = $derived(selected ? session.sync.channel(selected.id) : null)
  const currentTimeline = $derived(currentChannel ? currentChannel.timeline : null)
  const currentLive = $derived(currentChannel ? currentChannel.live : false)
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
  const currentSkipTargetId = $derived(
    resolveSkipLinkTargetId({
      viewportWidth,
      mobileLevel: effectiveMobileLevel,
      panelOpen,
    }),
  )

  let mainComposerRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null)
  let panelToggleBtn = $state<HTMLButtonElement | null>(null)
  let panelHeadingRef = $state<HTMLElement | null>(null)

  let lastViewId = ''

  function resolveSender(senderId: string): string {
    if (resolveSenderName) return resolveSenderName(senderId)
    if (organization?.member.id === senderId) return organization.member.name
    return 'メンバー'
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
    if (route?.organizationId === currentOrganizationId && !organizationUnavailable) void session.navigationTargets?.load(route)
  })

  $effect(() => {
    const state = nav.state
    // Wait for API-owned Channel selection and the rendered destination before focusing.
    if (!state.target || state.target.organizationId !== currentOrganizationId) return
    const revision = state.revision
    void tick().then(() => {
      if (nav.state.revision !== revision) return
      if (state.focus === 'list') focusTarget(document.getElementById('channel-content'))
      else if (state.focus === 'heading') focusTarget(panelHeadingRef)
      else if (state.focus === 'reply-composer') {
        if (!focusTarget(document.querySelector<HTMLElement>('#panel-content textarea'))) focusTarget(panelHeadingRef)
      }
      else if (state.focus === 'tab') focusTarget(document.getElementById(`panel-tab-${activePanelTab}`))
      else if (state.focus === 'opener') focusAfterPanelClose(navigation.getOpener(), mainComposerRef)
      else if (state.focus === 'topic-summary') {
        const topic = navigation.getReturningTopicId()
        const summary = topic ? document.querySelector<HTMLElement>(`[data-topic-id="${CSS.escape(topic)}"]`) : null
        if (!focusTarget(summary)) focusTarget(mainComposerRef)
      }
      else focusTarget(mainComposerRef)
    })
  })

  $effect(() => {
    if (!selected) { lastViewId = ''; return }
    if (s.status === 'loading') return
    const viewId = `${selected.id}/${route?.topicId ?? ''}`
    if (route?.topicId && session.navigationTargets?.state.topic.status === 'loading') return
    if (viewId === lastViewId) return
    lastViewId = viewId
    announcementController.onViewChanged({ viewId, kind: route?.topicId ? 'topic' : 'channel', name: route?.topicId ? (session.navigationTargets?.state.topic.name || 'トピック') : selected.name })
  })

  // Track timeline updates for live-message announcements and offline state (docs/ui.md §6)
  $effect(() => {
    if (!selected || route?.topicId || !currentTimeline) return
    announcementController.onTimelineUpdated({
      viewId: selected.id,
      status: currentTimeline.status,
      live: currentLive,
      messages: currentTimeline.messages,
      selfId: organization?.member.id ?? '',
      resolveSenderName: resolveSender,
    })
  })

  function handleSelectChannel(id: string) {
    nav.navigate({ type: 'channel', organizationId: currentOrganizationId, channelId: id })
    drawerOpen = false
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
    if (viewportWidth < 600) nav.navigate({ type: 'list' })
    else drawerOpen = true
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
          drawerOpen = !drawerOpen
          if (viewportWidth < 600) nav.navigate({ type: 'list' })
        }}
      >
        #
      </Button>
    </div>

    <div class="rail__bottom">
      {#if onsignout}
        <Button variant="icon" ariaLabel="ログアウト" disabled={busy} onclick={onsignout}>⇥</Button>
      {/if}
    </div>
  </nav>

  <nav id="channel-content" class="channel-column" aria-label="チャンネル" tabindex="-1">
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

      <ChannelList channels={s.channels} selectedId={s.selectedId} onselect={handleSelectChannel} />
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
          {#if route?.topicId && !organizationUnavailable && currentTimeline?.status !== 'unavailable'}
            <Button variant="quiet" onclick={() => nav.navigate({ type: 'topic-back' })}># {selected.name} ›</Button>
          {/if}
          <h1 class="main-card__title">{route?.topicId ? (session.navigationTargets?.state.topic.name || 'トピック') : selected.name}</h1>
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
        {#if route?.topicId && !organizationUnavailable && currentTimeline?.status !== 'unavailable'}
          {#if session.navigationTargets?.state.topic.status === 'loading'}
            <Skeleton rows={3} label="トピックを読み込み中" />
          {:else if session.navigationTargets?.state.topic.status === 'error'}
            <StatusBanner tone="danger" role="alert" message="トピックを読み込めませんでした。" actionLabel="再試行" onaction={() => { if (route) void session.navigationTargets?.load(route, true) }} />
          {:else}
            <EmptyState title={session.navigationTargets?.state.topic.status === 'unavailable' ? 'このトピックは利用できません。' : 'トピック表示は準備中です。'} actionLabel="チャンネルへ戻る" onaction={() => nav.navigate({ type: 'topic-back' })} />
          {/if}
        {:else}
        {#key selected.id}
          <Timeline
            channel={currentChannel}
            channelId={selected.id}
            selfId={organization?.member.id ?? ''}
            {organizationUnavailable}
            reconnecting={announcementView.reconnecting}
            bind:composerRef={mainComposerRef}
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
          {#if session.navigationTargets?.state.reply.status === 'loading'}
            <Skeleton rows={3} label="返信のつながりを読み込み中" />
          {:else if session.navigationTargets?.state.reply.status === 'error'}
            <StatusBanner tone="danger" role="alert" message="返信のつながりを読み込めませんでした。" actionLabel="再試行" onaction={() => { if (route) void session.navigationTargets?.load(route, true) }} />
          {:else}
            <EmptyState title={session.navigationTargets?.state.reply.status === 'unavailable' ? 'この返信のつながりは利用できません。' : '返信のつながりの表示は準備中です。'} />
          {/if}
        {:else if activePanelTab === 'topics'}
          <EmptyState
            title="トピック一覧は準備中です。"
            description="メインタイムラインからメッセージを閲覧・送信できます。"
          />
        {:else if activePanelTab === 'overview'}
          <EmptyState
            title="チャンネル概要は準備中です。"
            description={selected ? `# ${selected.name}（${selected.visibility === 'private' ? 'プライベート' : 'パブリック'}）` : undefined}
          />
        {:else}
          <EmptyState
            title="メンバー一覧は準備中です。"
          />
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
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
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
