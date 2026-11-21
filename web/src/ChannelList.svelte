<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import type { Channel } from './channels.svelte'
  import { focusIfVisible, focusTarget, type FocusableTarget, type VisibleFocusableTarget } from './focus-management'
  import SectionDialogs, { type SectionDialogMode } from './SectionDialogs.svelte'
  import {
    OTHER_CHANNELS_LABEL,
    reorderList,
    resolveDeleteFocusTargets,
    sectionWriteError,
    type DeleteFocusTarget,
  } from './section-ui'
  import type { SectionGroup, SectionsAdapter } from './sections.svelte'
  import type { TopicLine } from './topic-selectors'
  import Button from './ui/Button.svelte'
  import ListRow from './ui/ListRow.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  /** Maximum number of recent Topics shown under the open Channel (`docs/ui.md` §3). */
  const RECENT_TOPICS_MAX = 5
  const OTHER_KEY = '__other__'

  type DialogIntent =
    | { kind: 'create' }
    | { kind: 'rename'; sectionId: string; currentName: string }
    | { kind: 'delete'; sectionId: string; sectionName: string }
    | { kind: 'move'; channelId: string }
    | null

  type PendingFocusBase = {
    phase: 'writing' | 'awaiting-layout' | 'applying'
    baselineLayoutRevision: number
    allowedActive: Set<unknown>
    cancelled: boolean
  }

  type PendingFocus =
    | (PendingFocusBase & {
        kind: 'section-move'
        sectionId: string
        direction: 'up' | 'down'
      })
    | (PendingFocusBase & {
        kind: 'channel-move-order'
        channelId: string
        direction: 'up' | 'down'
      })
    | (PendingFocusBase & {
        kind: 'channel-move-group'
        channelId: string
        destinationKey: string
      })
    | (PendingFocusBase & {
        kind: 'section-delete'
        deletedId: string
        nextSectionIds: readonly string[]
        prevSectionIds: readonly string[]
      })

  let {
    channels,
    selectedId,
    activeTopicId = null,
    topics = [],
    allTopicsKnown = false,
    channelUnreadCount,
    channelMentionUnreadCount,
    topicUnreadCounts = {},
    sections,
    disabled = false,
    channelListHeading = null,
    onselect,
    onselecttopic,
    onopenalltopics,
  }: {
    channels: Channel[]
    selectedId: string | null
    activeTopicId?: string | null
    topics?: readonly TopicLine[]
    allTopicsKnown?: boolean
    channelUnreadCount?: (channelId: string) => number | null
    topicUnreadCounts?: Readonly<Record<string, { readonly unreadCount: number | null; readonly mentionUnreadCount?: number | null }>>
    channelMentionUnreadCount?: (channelId: string) => number | null
    sections?: SectionsAdapter
    disabled?: boolean
    channelListHeading?: FocusableTarget | null
    onselect: (id: string) => void
    onselecttopic?: (topicId: string) => void
    onopenalltopics?: (opener: HTMLElement | null) => void
  } = $props()

  const uid = $props.id()
  const recentTopics = $derived([...topics].reverse().slice(0, RECENT_TOPICS_MAX))
  const allTopicsLabel = $derived(
    allTopicsKnown ? `すべてのトピック(${topics.length})›` : 'すべてのトピック›',
  )
  let allTopicsBtn = $state<HTMLButtonElement | null>(null)
  let containerEl = $state<HTMLElement | null>(null)

  const sectionsState = $derived(sections?.state)
  const groups = $derived(sectionsState?.groups ?? [])
  const customGroups = $derived(
    groups.filter((g): g is Extract<SectionGroup, { id: string }> => g.id !== null),
  )
  const otherGroup = $derived(
    groups.find((g): g is Extract<SectionGroup, { id: null }> => g.id === null),
  )
  const visibleGroups = $derived<readonly SectionGroup[]>([
    ...customGroups,
    ...(otherGroup && otherGroup.channels.length > 0 ? [otherGroup] : []),
  ])
  const writing = $derived(Boolean(sectionsState?.writing))
  const reconnecting = $derived(Boolean(sectionsState?.reconnecting))
  const controlsDisabled = $derived(disabled || writing || reconnecting)

  // Collapse state is local memory only: no synchronization or web storage (docs/spec/sections.md).
  let collapsed = $state<Record<string, boolean>>({})
  let dialogMode = $state<DialogIntent>(null)
  let dialogError = $state('')
  let inlineError = $state('')
  let pendingCreateId = ''
  let pendingCreateName = ''
  let activePendingFocus: PendingFocus | null = null
  let pendingFocusTrigger = $state(0)
  let focusListenersAttached = false
  let unmounted = false
  let dialogOpener: unknown = null
  let applyingFocus = false

  function findAuthorizedChannel(channelId: string): { channel: Channel; sectionId: string | null } | null {
    for (const g of groups) {
      const ch = g.channels.find((c) => c.id === channelId)
      if (ch) return { channel: ch, sectionId: g.id }
    }
    return null
  }

  const resolvedDialogMode = $derived.by<SectionDialogMode>(() => {
    if (!dialogMode) return null
    if (dialogMode.kind === 'move') {
      const entry = findAuthorizedChannel(dialogMode.channelId)
      if (!entry) return null
      return {
        kind: 'move',
        channelId: entry.channel.id,
        channelName: entry.channel.name,
        currentSectionId: entry.sectionId,
      }
    }
    return dialogMode
  })

  const dialogFocusFallback = $derived.by<FocusableTarget | null>(() => {
    if (channelListHeading) return channelListHeading
    return (
      containerEl?.querySelector<HTMLElement>('[data-section-heading]') ??
      containerEl?.querySelector<HTMLElement>('.section-channel-list__toolbar button') ??
      null
    )
  })

  $effect(() => {
    if (dialogMode?.kind === 'move' && !findAuthorizedChannel(dialogMode.channelId)) {
      dialogMode = null
      dialogError = ''
    }
  })

  function groupKeyOf(id: string | null): string {
    return id ?? OTHER_KEY
  }

  function isResetOrDisconnected(el: unknown): boolean {
    if (!el) return true
    if (typeof document !== 'undefined' && (el === document.body || el === document.documentElement)) {
      return true
    }
    if (typeof el === 'object' && 'isConnected' in el && (el as { isConnected?: boolean }).isConnected === false) {
      return true
    }
    return false
  }

  function hasUserMovedFocus(p: PendingFocus): boolean {
    if (typeof document === 'undefined') return false
    const active = document.activeElement
    if (isResetOrDisconnected(active)) return false
    return !p.allowedActive.has(active)
  }

  function onFocusIn(e: FocusEvent) {
    if (applyingFocus || !activePendingFocus) return
    const target = e.target
    if (isResetOrDisconnected(target) || activePendingFocus.allowedActive.has(target)) return
    clearPendingFocus()
  }

  function onPointerDown() {
    if (!activePendingFocus) return
    clearPendingFocus()
  }

  function clearPendingFocus() {
    if (activePendingFocus) {
      activePendingFocus.cancelled = true
      activePendingFocus = null
    }
    if (focusListenersAttached && typeof document !== 'undefined') {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      focusListenersAttached = false
    }
  }

  function beginPendingFocus(token: PendingFocus) {
    clearPendingFocus()
    activePendingFocus = token
    if (typeof document !== 'undefined' && !focusListenersAttached) {
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('pointerdown', onPointerDown, true)
      focusListenersAttached = true
    }
    pendingFocusTrigger++
  }

  function armPendingFocusAfterWrite(token: PendingFocus) {
    if (unmounted || token.cancelled || activePendingFocus !== token) return
    if (hasUserMovedFocus(token)) {
      clearPendingFocus()
      return
    }
    if (dialogFocusFallback) token.allowedActive.add(dialogFocusFallback)
    token.baselineLayoutRevision = sections?.state.layoutRevision ?? 0
    token.phase = 'awaiting-layout'
    pendingFocusTrigger++
  }

  onDestroy(() => {
    unmounted = true
    clearPendingFocus()
  })

  function applyFocus(target: FocusableTarget | null | undefined): boolean {
    if (!target) return false
    applyingFocus = true
    try {
      if ('getClientRects' in target) {
        return focusIfVisible(target as VisibleFocusableTarget)
      }
      return focusTarget(target)
    } finally {
      applyingFocus = false
    }
  }

  function focusVisibleFallback(): boolean {
    if (applyFocus(channelListHeading)) return true
    const firstHeading = containerEl?.querySelector<HTMLElement>('[data-section-heading]')
    if (applyFocus(firstHeading)) return true
    const createBtn = containerEl?.querySelector<HTMLElement>('.section-channel-list__toolbar button')
    return applyFocus(createBtn)
  }

  function toggleCollapse(key: string) {
    collapsed[key] = !collapsed[key]
  }

  function openCreateDialog() {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogOpener = typeof document !== 'undefined' ? document.activeElement : null
    pendingCreateId = crypto.randomUUID()
    pendingCreateName = ''
    dialogMode = { kind: 'create' }
  }

  function openRenameDialog(section: Extract<SectionGroup, { id: string }>) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogOpener = typeof document !== 'undefined' ? document.activeElement : null
    dialogMode = { kind: 'rename', sectionId: section.id, currentName: section.name }
  }

  function openDeleteDialog(section: Extract<SectionGroup, { id: string }>) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogOpener = typeof document !== 'undefined' ? document.activeElement : null
    dialogMode = { kind: 'delete', sectionId: section.id, sectionName: section.name }
  }

  function openMoveDialog(channelId: string) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogOpener = typeof document !== 'undefined' ? document.activeElement : null
    dialogMode = { kind: 'move', channelId }
  }

  function closeDialog() {
    if (writing) return
    dialogMode = null
    dialogError = ''
  }

  async function handleCreateSection(name: string) {
    if (!sections || controlsDisabled) return
    dialogError = ''
    if (!pendingCreateId || (pendingCreateName !== '' && pendingCreateName !== name)) {
      pendingCreateId = crypto.randomUUID()
    }
    pendingCreateName = name
    const result = await sections.create({ id: pendingCreateId, name })
    if (!result.ok) {
      if (result.kind === 'http' && (result.error === 'section_id_conflict' || result.error === 'section_deleted')) {
        pendingCreateId = crypto.randomUUID()
      }
      dialogError = sectionWriteError(result)
      return
    }
    pendingCreateId = ''
    pendingCreateName = ''
    dialogMode = null
  }

  async function handleRenameSection(sectionId: string, name: string) {
    if (!sections || controlsDisabled) return
    dialogError = ''
    const result = await sections.rename(sectionId, { name })
    if (!result.ok) {
      dialogError = sectionWriteError(result)
      return
    }
    dialogMode = null
  }

  async function handleDeleteSection(sectionId: string) {
    if (!sections || controlsDisabled) return
    dialogError = ''
    const idx = customGroups.findIndex((g) => g.id === sectionId)
    const nextSectionIds = idx >= 0 ? customGroups.slice(idx + 1).map((g) => g.id) : []
    const prevSectionIds = idx >= 0 ? customGroups.slice(0, idx).reverse().map((g) => g.id) : []
    const baselineActive = typeof document !== 'undefined' ? document.activeElement : null
    const token: PendingFocus = {
      kind: 'section-delete',
      deletedId: sectionId,
      nextSectionIds,
      prevSectionIds,
      phase: 'writing',
      baselineLayoutRevision: -1,
      allowedActive: new Set([baselineActive, dialogOpener, dialogFocusFallback]),
      cancelled: false,
    }
    beginPendingFocus(token)
    const result = await sections.delete(sectionId)
    if (unmounted) return
    if (!result.ok) {
      if (activePendingFocus === token) clearPendingFocus()
      dialogError = sectionWriteError(result)
      return
    }
    armPendingFocusAfterWrite(token)
    dialogMode = null
  }

  async function handleMoveChannel(channelId: string, destinationId: string | null) {
    if (!sections || controlsDisabled) return
    dialogError = ''
    const destinationKey = groupKeyOf(destinationId)
    const baselineActive = typeof document !== 'undefined' ? document.activeElement : null
    const token: PendingFocus = {
      kind: 'channel-move-group',
      channelId,
      destinationKey,
      phase: 'writing',
      baselineLayoutRevision: -1,
      allowedActive: new Set([baselineActive, dialogOpener, dialogFocusFallback]),
      cancelled: false,
    }
    beginPendingFocus(token)
    const result = await sections.moveChannel(channelId, { section_id: destinationId })
    if (unmounted) return
    if (!result.ok) {
      if (activePendingFocus === token) clearPendingFocus()
      dialogError = sectionWriteError(result)
      return
    }
    if (collapsed[destinationKey]) collapsed[destinationKey] = false
    armPendingFocusAfterWrite(token)
    dialogMode = null
  }

  async function handleReorderSection(sectionId: string, index: number, direction: 'up' | 'down') {
    if (!sections || controlsDisabled) return
    inlineError = ''
    const ids = customGroups.map((g) => g.id)
    const next = reorderList(ids, index, direction)
    if (!next) return
    const baselineActive = typeof document !== 'undefined' ? document.activeElement : null
    const token: PendingFocus = {
      kind: 'section-move',
      sectionId,
      direction,
      phase: 'writing',
      baselineLayoutRevision: -1,
      allowedActive: new Set([baselineActive]),
      cancelled: false,
    }
    beginPendingFocus(token)
    const result = await sections.reorder({ section_ids: next })
    if (unmounted) return
    if (!result.ok) {
      if (activePendingFocus === token) clearPendingFocus()
      inlineError = sectionWriteError(result)
      return
    }
    armPendingFocusAfterWrite(token)
  }

  async function handleReorderChannel(
    sectionId: string | null,
    groupChannels: readonly Channel[],
    index: number,
    direction: 'up' | 'down',
  ) {
    if (!sections || controlsDisabled) return
    inlineError = ''
    const ids = groupChannels.map((c) => c.id)
    const next = reorderList(ids, index, direction)
    if (!next) return
    const channelId = ids[index]
    const baselineActive = typeof document !== 'undefined' ? document.activeElement : null
    const token: PendingFocus = {
      kind: 'channel-move-order',
      channelId,
      direction,
      phase: 'writing',
      baselineLayoutRevision: -1,
      allowedActive: new Set([baselineActive]),
      cancelled: false,
    }
    beginPendingFocus(token)
    const result = await sections.reorderChannels({ section_id: sectionId, channel_ids: next })
    if (unmounted) return
    if (!result.ok) {
      if (activePendingFocus === token) clearPendingFocus()
      inlineError = sectionWriteError(result)
      return
    }
    armPendingFocusAfterWrite(token)
  }

  function focusDeleteTargets(targets: readonly DeleteFocusTarget[]) {
    for (const target of targets) {
      if (target.kind === 'section') {
        const el = containerEl?.querySelector<HTMLElement>(
          `[data-section-heading="${CSS.escape(target.id)}"]`,
        )
        if (applyFocus(el)) return
      } else if (target.kind === 'other') {
        const el = containerEl?.querySelector<HTMLElement>(
          `[data-section-heading="${OTHER_KEY}"]`,
        )
        if (applyFocus(el)) return
      } else if (focusVisibleFallback()) {
        return
      }
    }
  }

  $effect(() => {
    void pendingFocusTrigger
    const layoutRevision = sectionsState?.layoutRevision ?? 0
    const p = activePendingFocus
    if (!p || p.cancelled || p.phase !== 'awaiting-layout' || writing || resolvedDialogMode !== null) return
    if (hasUserMovedFocus(p)) {
      clearPendingFocus()
      return
    }
    if (layoutRevision <= p.baselineLayoutRevision) return
    if (p.kind === 'section-delete') {
      if (customGroups.some((g) => g.id === p.deletedId)) return
      p.phase = 'applying'
      const targets = resolveDeleteFocusTargets(
        customGroups.map((g) => g.id),
        p.nextSectionIds,
        p.prevSectionIds,
        Boolean(otherGroup && otherGroup.channels.length > 0),
      )
      void tick()
        .then(() => tick())
        .then(() => {
          if (unmounted || p.cancelled || activePendingFocus !== p) return
          if (hasUserMovedFocus(p)) {
            clearPendingFocus()
            return
          }
          focusDeleteTargets(targets)
          clearPendingFocus()
        })
      return
    }
    p.phase = 'applying'
    if (p.kind === 'section-move') {
      void tick().then(() => {
        if (unmounted || p.cancelled || activePendingFocus !== p) return
        if (hasUserMovedFocus(p)) {
          clearPendingFocus()
          return
        }
        const btn = containerEl?.querySelector<HTMLElement>(
          `[data-testid="section-move-${p.direction}-${CSS.escape(p.sectionId)}"]`,
        )
        if (!applyFocus(btn)) {
          const heading = containerEl?.querySelector<HTMLElement>(
            `[data-section-heading="${CSS.escape(p.sectionId)}"]`,
          )
          if (!applyFocus(heading)) focusVisibleFallback()
        }
        clearPendingFocus()
      })
      return
    }
    if (p.kind === 'channel-move-order') {
      void tick().then(() => {
        if (unmounted || p.cancelled || activePendingFocus !== p) return
        if (hasUserMovedFocus(p)) {
          clearPendingFocus()
          return
        }
        const btn = containerEl?.querySelector<HTMLElement>(
          `[data-testid="channel-move-${p.direction}-${CSS.escape(p.channelId)}"]`,
        )
        if (!applyFocus(btn)) {
          const row = containerEl?.querySelector<HTMLElement>(
            `[data-channel-id="${CSS.escape(p.channelId)}"] .ui-list-row`,
          )
          if (!applyFocus(row)) focusVisibleFallback()
        }
        clearPendingFocus()
      })
      return
    }
    if (p.kind === 'channel-move-group') {
      // Wait two ticks so this runs after Dialog's close focus restoration.
      void tick()
        .then(() => tick())
        .then(() => {
          if (unmounted || p.cancelled || activePendingFocus !== p) return
          if (hasUserMovedFocus(p)) {
            clearPendingFocus()
            return
          }
          const row = containerEl?.querySelector<HTMLElement>(
            `[data-channel-id="${CSS.escape(p.channelId)}"] .ui-list-row`,
          )
          if (!applyFocus(row)) {
            const heading = containerEl?.querySelector<HTMLElement>(
              `[data-section-heading="${CSS.escape(p.destinationKey)}"]`,
            )
            if (!applyFocus(heading)) focusVisibleFallback()
          }
          clearPendingFocus()
        })
    }
  })
</script>

{#snippet channelRow(c: Channel)}
  {@const isExpanded = c.id === selectedId && recentTopics.length > 0}
  {@const channelUnread = channelUnreadCount?.(c.id) ?? null}
  <ListRow
    kind="channel"
    prefix={c.visibility === 'private' ? '🔒' : '#'}
    name={c.name}
    selected={c.id === selectedId && !activeTopicId}
    unreadCount={channelUnread !== null && channelUnread > 0 ? channelUnread : 0}
    mentionUnreadCount={channelMentionUnreadCount?.(c.id) ?? 0}
    expanded={isExpanded ? true : undefined}
    onclick={() => onselect(c.id)}
  >
    {#snippet children()}
      {#each recentTopics as t (t.topicId)}
        {@const topicUnread = topicUnreadCounts[t.topicId]?.unreadCount ?? null}
        <ListRow
          kind="topic"
          name={t.baseline?.summary.name ?? 'トピック'}
          selected={activeTopicId === t.topicId}
          unreadCount={topicUnread !== null && topicUnread > 0 ? topicUnread : 0}
          mentionUnreadCount={topicUnreadCounts[t.topicId]?.mentionUnreadCount ?? 0}
          onclick={() => onselecttopic?.(t.topicId)}
        />
      {/each}
      {#if onopenalltopics}
        <div class="channel-list__all-topics">
          <Button
            bind:buttonRef={allTopicsBtn}
            variant="quiet"
            onclick={() => onopenalltopics(allTopicsBtn)}
          >
            {allTopicsLabel}
          </Button>
        </div>
      {/if}
    {/snippet}
  </ListRow>
{/snippet}

{#if sections && sectionsState}
  <div class="section-channel-list" bind:this={containerEl} aria-busy={writing ? 'true' : undefined}>
    {#if !disabled}
      <div class="section-channel-list__toolbar">
        <Button variant="secondary" disabled={controlsDisabled} onclick={openCreateDialog}>
          セクションを作成
        </Button>
      </div>
    {/if}

    {#if !disabled && reconnecting}
      <StatusBanner tone="info" message="再接続中" />
    {:else if !disabled && sectionsState.error}
      <StatusBanner
        tone="danger"
        role="alert"
        message="セクションを読み込めませんでした。"
        detail="通信状況を確認して、もう一度お試しください。"
        actionLabel="再試行"
        onaction={() => sections.retry()}
      />
    {/if}

    {#if inlineError}
      <StatusBanner
        tone="danger"
        role="alert"
        message={inlineError}
        actionLabel="閉じる"
        onaction={() => { inlineError = '' }}
      />
    {/if}

    {#if !disabled && !reconnecting && !sectionsState.error && sectionsState.generation === undefined && channels.length > 0}
      <Skeleton rows={3} label="セクションを読み込み中" />
    {:else}
      {#each visibleGroups as group, groupIndex (groupKeyOf(group.id))}
        {@const key = groupKeyOf(group.id)}
        {@const isCollapsed = Boolean(collapsed[key])}
        {@const groupLabel = group.id === null ? OTHER_CHANNELS_LABEL : group.name}
        {@const bodyId = `${uid}-section-${key}`}
        <section class="section-group" aria-label={groupLabel} data-section-id={key}>
          <div class="section-group__header">
            <button
              type="button"
              class="section-group__heading"
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              data-section-heading={key}
              onclick={() => toggleCollapse(key)}
            >
              <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span class="section-group__title">{groupLabel}</span>
            </button>
            {#if group.id !== null}
              <div class="section-group__actions">
                <Button
                  variant="icon"
                  ariaLabel="上へ移動"
                  testid={`section-move-up-${group.id}`}
                  disabled={controlsDisabled || groupIndex === 0}
                  onclick={() => handleReorderSection(group.id, groupIndex, 'up')}
                >
                  ↑
                </Button>
                <Button
                  variant="icon"
                  ariaLabel="下へ移動"
                  testid={`section-move-down-${group.id}`}
                  disabled={controlsDisabled || groupIndex === customGroups.length - 1}
                  onclick={() => handleReorderSection(group.id, groupIndex, 'down')}
                >
                  ↓
                </Button>
                <Button
                  variant="icon"
                  ariaLabel="名前を変更"
                  disabled={controlsDisabled}
                  onclick={() => openRenameDialog(group)}
                >
                  ✎
                </Button>
                <Button
                  variant="icon"
                  ariaLabel="セクションを削除"
                  disabled={controlsDisabled}
                  onclick={() => openDeleteDialog(group)}
                >
                  ×
                </Button>
              </div>
            {/if}
          </div>

          {#if !isCollapsed}
            <div id={bodyId} class="section-group__body">
              {#if group.channels.length > 0}
                <ul class="channel-list">
                  {#each group.channels as c, channelIndex (c.id)}
                    <li class="channel-list__item" data-channel-id={c.id}>
                      <div class="channel-list__row">
                        <div class="channel-list__row-main">
                          {@render channelRow(c)}
                        </div>
                        <div class="channel-list__row-actions">
                          <Button
                            variant="icon"
                            ariaLabel="上へ移動"
                            testid={`channel-move-up-${c.id}`}
                            disabled={controlsDisabled || channelIndex === 0}
                            onclick={() => handleReorderChannel(group.id, group.channels, channelIndex, 'up')}
                          >
                            ↑
                          </Button>
                          <Button
                            variant="icon"
                            ariaLabel="下へ移動"
                            testid={`channel-move-down-${c.id}`}
                            disabled={controlsDisabled || channelIndex === group.channels.length - 1}
                            onclick={() => handleReorderChannel(group.id, group.channels, channelIndex, 'down')}
                          >
                            ↓
                          </Button>
                          <Button
                            variant="icon"
                            ariaLabel="チャンネルを移動"
                            disabled={controlsDisabled}
                            onclick={() => openMoveDialog(c.id)}
                          >
                            ⇄
                          </Button>
                        </div>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </section>
      {/each}
    {/if}

    <SectionDialogs
      mode={resolvedDialogMode}
      busy={writing}
      error={dialogError}
      customSections={customGroups}
      returnFocusFallback={dialogFocusFallback}
      oncreate={handleCreateSection}
      onrename={handleRenameSection}
      ondelete={handleDeleteSection}
      onmove={handleMoveChannel}
      onclose={closeDialog}
      oninputchange={() => { dialogError = '' }}
    />
  </div>
{:else}
  <ul class="channel-list">
    {#each channels as c (c.id)}
      <li class="channel-list__item" data-channel-id={c.id}>
        {@render channelRow(c)}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .section-channel-list {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .section-channel-list__toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    min-width: 0;
  }

  .section-group {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .section-group__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-width: 0;
  }

  .section-group__heading {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    flex: 1 1 6rem;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    background-color: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-semibold);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  .section-group__heading:hover {
    background-color: var(--hover);
  }

  .section-group__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .section-group__actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    flex-shrink: 0;
  }

  .section-group__body {
    min-width: 0;
  }

  .channel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .channel-list__item {
    min-width: 0;
  }

  .channel-list__row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-4);
    min-width: 0;
  }

  .channel-list__row-main {
    flex: 1 1 8rem;
    min-width: 0;
  }

  .channel-list__row-actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    flex-shrink: 0;
  }

  .channel-list__all-topics {
    padding-left: var(--space-16);
    min-width: 0;
  }
</style>
