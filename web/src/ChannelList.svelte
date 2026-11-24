<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import type { Channel } from './channels.svelte'
  import { createPendingFocus, type FocusableTarget } from './focus-management'
  import SectionDialogs, { type SectionDialogMode } from './SectionDialogs.svelte'
  import {
    OTHER_CHANNELS_LABEL,
    reorderList,
    resolveDeleteFocusTargets,
    sectionWriteError,
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

  type PendingFocusIntent =
    | { kind: 'section-move'; sectionId: string; direction: 'up' | 'down' }
    | { kind: 'channel-move-order'; channelId: string; direction: 'up' | 'down' }
    | { kind: 'channel-move-group'; channelId: string; destinationKey: string }
    | {
        kind: 'section-delete'
        deletedId: string
        nextSectionIds: readonly string[]
        prevSectionIds: readonly string[]
      }

  type PendingFocusWrite = {
    token: number
    intent: PendingFocusIntent
    phase: 'writing' | 'awaiting-layout' | 'applying'
    baselineLayoutRevision: number
  }

  type PendingFocusPlan = {
    ticks: 1 | 2
    selectors: readonly string[]
  }

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
  let pendingWrite: PendingFocusWrite | null = null
  let pendingFocusTrigger = $state(0)
  let unmounted = false
  let dialogOpener: unknown = null

  const pendingFocus = createPendingFocus({
    cancelOnPointerDown: true,
    requireVisible: true,
    onUserCancel: () => {
      pendingWrite = null
    },
  })

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

  function clearPendingFocus() {
    pendingWrite = null
    pendingFocus.cancel()
  }

  function startPendingFocus(intent: PendingFocusIntent, extraAllowed?: readonly unknown[]): number {
    const token = pendingFocus.begin(extraAllowed)
    pendingWrite = {
      token,
      intent,
      phase: 'writing',
      baselineLayoutRevision: -1,
    }
    pendingFocusTrigger++
    return token
  }

  function armPendingFocusAfterWrite(token: number) {
    if (unmounted || !pendingWrite || pendingWrite.token !== token || !pendingFocus.isActive(token)) return
    if (pendingFocus.hasUserMovedFocus(token)) {
      clearPendingFocus()
      return
    }
    if (dialogFocusFallback) pendingFocus.allow(dialogFocusFallback, token)
    pendingWrite.baselineLayoutRevision = sections?.state.layoutRevision ?? 0
    pendingWrite.phase = 'awaiting-layout'
    pendingFocusTrigger++
  }

  onDestroy(() => {
    unmounted = true
    pendingWrite = null
    pendingFocus.destroy()
  })

  function toggleCollapse(key: string) {
    collapsed[key] = !collapsed[key]
  }

  function openDialog(mode: Exclude<DialogIntent, null>) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogOpener = typeof document !== 'undefined' ? document.activeElement : null
    if (mode.kind === 'create') {
      pendingCreateId = crypto.randomUUID()
      pendingCreateName = ''
    }
    dialogMode = mode
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
    const token = startPendingFocus(
      {
        kind: 'section-delete',
        deletedId: sectionId,
        nextSectionIds: idx >= 0 ? customGroups.slice(idx + 1).map((g) => g.id) : [],
        prevSectionIds: idx >= 0 ? customGroups.slice(0, idx).reverse().map((g) => g.id) : [],
      },
      [dialogOpener, dialogFocusFallback],
    )
    const result = await sections.delete(sectionId)
    if (unmounted) return
    if (!result.ok) {
      if (pendingWrite?.token === token) clearPendingFocus()
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
    const token = startPendingFocus(
      { kind: 'channel-move-group', channelId, destinationKey },
      [dialogOpener, dialogFocusFallback],
    )
    const result = await sections.moveChannel(channelId, { section_id: destinationId })
    if (unmounted) return
    if (!result.ok) {
      if (pendingWrite?.token === token) clearPendingFocus()
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
    const next = reorderList(customGroups.map((g) => g.id), index, direction)
    if (!next) return
    const token = startPendingFocus({ kind: 'section-move', sectionId, direction })
    const result = await sections.reorder({ section_ids: next })
    if (unmounted) return
    if (!result.ok) {
      if (pendingWrite?.token === token) clearPendingFocus()
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
    const token = startPendingFocus({ kind: 'channel-move-order', channelId: ids[index], direction })
    const result = await sections.reorderChannels({ section_id: sectionId, channel_ids: next })
    if (unmounted) return
    if (!result.ok) {
      if (pendingWrite?.token === token) clearPendingFocus()
      inlineError = sectionWriteError(result)
      return
    }
    armPendingFocusAfterWrite(token)
  }

  // Wait two ticks for dialog-driven mutations so restoration runs after Dialog's close focus restoration.
  const PENDING_FOCUS_PLANS: {
    [K in PendingFocusIntent['kind']]: (intent: Extract<PendingFocusIntent, { kind: K }>) => PendingFocusPlan
  } = {
    'section-move': (p) => ({
      ticks: 1,
      selectors: [
        `[data-testid="section-move-${p.direction}-${CSS.escape(p.sectionId)}"]`,
        `[data-section-heading="${CSS.escape(p.sectionId)}"]`,
      ],
    }),
    'channel-move-order': (p) => ({
      ticks: 1,
      selectors: [
        `[data-testid="channel-move-${p.direction}-${CSS.escape(p.channelId)}"]`,
        `[data-channel-id="${CSS.escape(p.channelId)}"] .ui-list-row`,
      ],
    }),
    'channel-move-group': (p) => ({
      ticks: 2,
      selectors: [
        `[data-channel-id="${CSS.escape(p.channelId)}"] .ui-list-row`,
        `[data-section-heading="${CSS.escape(p.destinationKey)}"]`,
      ],
    }),
    'section-delete': (p) => ({
      ticks: 2,
      selectors: resolveDeleteFocusTargets(
        customGroups.map((g) => g.id),
        p.nextSectionIds,
        p.prevSectionIds,
        Boolean(otherGroup && otherGroup.channels.length > 0),
      ).flatMap((target) => {
        if (target.kind === 'section') return [`[data-section-heading="${CSS.escape(target.id)}"]`]
        if (target.kind === 'other') return [`[data-section-heading="${OTHER_KEY}"]`]
        return []
      }),
    }),
  }

  function buildPendingFocusPlan(intent: PendingFocusIntent): PendingFocusPlan {
    switch (intent.kind) {
      case 'section-move':
        return PENDING_FOCUS_PLANS['section-move'](intent)
      case 'channel-move-order':
        return PENDING_FOCUS_PLANS['channel-move-order'](intent)
      case 'channel-move-group':
        return PENDING_FOCUS_PLANS['channel-move-group'](intent)
      case 'section-delete':
        return PENDING_FOCUS_PLANS['section-delete'](intent)
    }
  }

  $effect(() => {
    void pendingFocusTrigger
    const layoutRevision = sectionsState?.layoutRevision ?? 0
    const p = pendingWrite
    if (!p || p.phase !== 'awaiting-layout' || writing || resolvedDialogMode !== null) return
    if (!pendingFocus.isActive(p.token)) {
      pendingWrite = null
      return
    }
    if (pendingFocus.hasUserMovedFocus(p.token)) {
      clearPendingFocus()
      return
    }
    if (layoutRevision <= p.baselineLayoutRevision) return
    if (p.intent.kind === 'section-delete') {
      const { deletedId } = p.intent
      if (customGroups.some((g) => g.id === deletedId)) return
    }
    p.phase = 'applying'
    const plan = buildPendingFocusPlan(p.intent)
    const wait = plan.ticks === 2 ? tick().then(() => tick()) : tick()
    void wait.then(() => {
      if (unmounted || pendingWrite !== p) return
      pendingFocus.apply(
        plan.selectors.map((sel) => () => containerEl?.querySelector<HTMLElement>(sel)),
        {
          token: p.token,
          fallback: [
            () => channelListHeading,
            () => containerEl?.querySelector<HTMLElement>('[data-section-heading]'),
            () => containerEl?.querySelector<HTMLElement>('.section-channel-list__toolbar button'),
          ],
        },
      )
      if (pendingWrite === p) pendingWrite = null
    })
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
        <Button variant="secondary" disabled={controlsDisabled} onclick={() => openDialog({ kind: 'create' })}>
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
                  onclick={() => openDialog({ kind: 'rename', sectionId: group.id, currentName: group.name })}
                >
                  ✎
                </Button>
                <Button
                  variant="icon"
                  ariaLabel="セクションを削除"
                  disabled={controlsDisabled}
                  onclick={() => openDialog({ kind: 'delete', sectionId: group.id, sectionName: group.name })}
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
                            onclick={() => openDialog({ kind: 'move', channelId: c.id })}
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
