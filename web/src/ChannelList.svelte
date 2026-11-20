<script lang="ts">
  import { tick } from 'svelte'
  import type { Channel } from './channels.svelte'
  import { focusTarget, type FocusableTarget } from './focus-management'
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

  type PendingFocus =
    | { kind: 'section-move'; sectionId: string; direction: 'up' | 'down'; expectedIndex: number }
    | { kind: 'channel-move-order'; channelId: string; groupKey: string; direction: 'up' | 'down'; expectedIndex: number }
    | { kind: 'channel-move-group'; channelId: string; destinationKey: string }
    | { kind: 'section-delete'; deletedId: string; targets: readonly DeleteFocusTarget[] }

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
  let dialogMode = $state<SectionDialogMode>(null)
  let dialogError = $state('')
  let inlineError = $state('')
  let pendingCreateId = ''
  let pendingCreateName = ''
  let pendingFocus = $state<PendingFocus | null>(null)

  function groupKeyOf(id: string | null): string {
    return id ?? OTHER_KEY
  }

  function toggleCollapse(key: string) {
    collapsed[key] = !collapsed[key]
  }

  function openCreateDialog() {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    pendingCreateId = crypto.randomUUID()
    pendingCreateName = ''
    dialogMode = { kind: 'create' }
  }

  function openRenameDialog(section: Extract<SectionGroup, { id: string }>) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogMode = { kind: 'rename', sectionId: section.id, currentName: section.name }
  }

  function openDeleteDialog(section: Extract<SectionGroup, { id: string }>) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogMode = { kind: 'delete', sectionId: section.id, sectionName: section.name }
  }

  function openMoveDialog(channel: Channel, currentSectionId: string | null) {
    if (controlsDisabled) return
    inlineError = ''
    dialogError = ''
    dialogMode = {
      kind: 'move',
      channelId: channel.id,
      channelName: channel.name,
      currentSectionId,
    }
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
    const section = customGroups.find((g) => g.id === sectionId)
    const otherWillBeVisible =
      (otherGroup?.channels.length ?? 0) > 0 || (section?.channels.length ?? 0) > 0
    const targets = resolveDeleteFocusTargets(
      customGroups.map((g) => g.id),
      sectionId,
      otherWillBeVisible,
    )
    const result = await sections.delete(sectionId)
    if (!result.ok) {
      dialogError = sectionWriteError(result)
      return
    }
    pendingFocus = { kind: 'section-delete', deletedId: sectionId, targets }
    dialogMode = null
  }

  async function handleMoveChannel(channelId: string, destinationId: string | null) {
    if (!sections || controlsDisabled) return
    dialogError = ''
    const destinationKey = groupKeyOf(destinationId)
    const result = await sections.moveChannel(channelId, { section_id: destinationId })
    if (!result.ok) {
      dialogError = sectionWriteError(result)
      return
    }
    if (collapsed[destinationKey]) collapsed[destinationKey] = false
    pendingFocus = { kind: 'channel-move-group', channelId, destinationKey }
    dialogMode = null
  }

  async function handleReorderSection(sectionId: string, index: number, direction: 'up' | 'down') {
    if (!sections || controlsDisabled) return
    inlineError = ''
    const ids = customGroups.map((g) => g.id)
    const next = reorderList(ids, index, direction)
    if (!next) return
    const expectedIndex = direction === 'up' ? index - 1 : index + 1
    const result = await sections.reorder({ section_ids: next })
    if (!result.ok) {
      inlineError = sectionWriteError(result)
      return
    }
    pendingFocus = { kind: 'section-move', sectionId, direction, expectedIndex }
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
    const expectedIndex = direction === 'up' ? index - 1 : index + 1
    const result = await sections.reorderChannels({ section_id: sectionId, channel_ids: next })
    if (!result.ok) {
      inlineError = sectionWriteError(result)
      return
    }
    pendingFocus = {
      kind: 'channel-move-order',
      channelId,
      groupKey: groupKeyOf(sectionId),
      direction,
      expectedIndex,
    }
  }

  function focusDeleteTargets(targets: readonly DeleteFocusTarget[]) {
    for (const target of targets) {
      if (target.kind === 'section') {
        const el = containerEl?.querySelector<HTMLElement>(
          `[data-section-heading="${CSS.escape(target.id)}"]`,
        )
        if (focusTarget(el)) return
      } else if (target.kind === 'other') {
        const el = containerEl?.querySelector<HTMLElement>(
          `[data-section-heading="${OTHER_KEY}"]`,
        )
        if (focusTarget(el)) return
      } else if (focusTarget(channelListHeading)) {
        return
      }
    }
  }

  $effect(() => {
    const p = pendingFocus
    if (!p || writing || dialogMode !== null) return
    if (p.kind === 'section-move') {
      if (customGroups.findIndex((g) => g.id === p.sectionId) !== p.expectedIndex) return
      pendingFocus = null
      void tick().then(() => {
        const btn = containerEl?.querySelector<HTMLElement>(
          `[data-testid="section-move-${p.direction}-${CSS.escape(p.sectionId)}"]`,
        )
        if (!focusTarget(btn)) {
          const heading = containerEl?.querySelector<HTMLElement>(
            `[data-section-heading="${CSS.escape(p.sectionId)}"]`,
          )
          focusTarget(heading)
        }
      })
      return
    }
    if (p.kind === 'channel-move-order') {
      const group = groups.find((g) => groupKeyOf(g.id) === p.groupKey)
      if (!group || group.channels.findIndex((c) => c.id === p.channelId) !== p.expectedIndex) return
      pendingFocus = null
      void tick().then(() => {
        const btn = containerEl?.querySelector<HTMLElement>(
          `[data-testid="channel-move-${p.direction}-${CSS.escape(p.channelId)}"]`,
        )
        if (!focusTarget(btn)) {
          const row = containerEl?.querySelector<HTMLElement>(
            `[data-channel-id="${CSS.escape(p.channelId)}"] .ui-list-row`,
          )
          focusTarget(row)
        }
      })
      return
    }
    if (p.kind === 'channel-move-group') {
      const group = groups.find((g) => groupKeyOf(g.id) === p.destinationKey)
      if (!group || !group.channels.some((c) => c.id === p.channelId)) return
      pendingFocus = null
      // Wait two ticks so this runs after Dialog's close focus restoration.
      void tick()
        .then(() => tick())
        .then(() => {
          const row = containerEl?.querySelector<HTMLElement>(
            `[data-channel-id="${CSS.escape(p.channelId)}"] .ui-list-row`,
          )
          if (!focusTarget(row)) {
            const heading = containerEl?.querySelector<HTMLElement>(
              `[data-section-heading="${CSS.escape(p.destinationKey)}"]`,
            )
            focusTarget(heading)
          }
        })
      return
    }
    if (p.kind === 'section-delete') {
      if (customGroups.some((g) => g.id === p.deletedId)) return
      pendingFocus = null
      void tick()
        .then(() => tick())
        .then(() => focusDeleteTargets(p.targets))
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
                            onclick={() => openMoveDialog(c, group.id)}
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
      mode={dialogMode}
      busy={writing}
      error={dialogError}
      customSections={customGroups}
      returnFocusFallback={channelListHeading}
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
