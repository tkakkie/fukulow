import type { Message } from './api'
import type { MobileLevel } from './focus-management'
import type { Navigation } from './navigation'
import type { NavigationTarget, PanelTab, PanelTarget } from './navigation-url'
import type { Replies } from './replies'
import type { SearchTarget } from './search'
import type { MainTimelineLine } from './topic-selectors'

type ResolveReplyAnchorInput = {
  activeReplyMessageId: string | null
  selectedChannelId: string | undefined
  lastOpenedAnchor: () => Message | null
  timelineMessages?: () => readonly Message[] | null | undefined
  topicLines?: () => readonly MainTimelineLine[] | null | undefined
  routedTopicMessages?: () => readonly Message[] | null | undefined
  replies?: () => Pick<ReturnType<Replies['get']>, 'anchor' | 'messages'> | null | undefined
}

/**
 * Resolves the in-memory Reply chain anchor for the active reply route in deterministic
 * lookup order, requiring a same-Channel match for the last opened anchor.
 */
export function resolveReplyAnchor({
  activeReplyMessageId,
  selectedChannelId,
  lastOpenedAnchor,
  timelineMessages,
  topicLines,
  routedTopicMessages,
  replies,
}: ResolveReplyAnchorInput): Message | null {
  if (!activeReplyMessageId || !selectedChannelId) return null
  const opened = lastOpenedAnchor()
  if (opened?.id === activeReplyMessageId && opened.channel_id === selectedChannelId) {
    return opened
  }
  const fromTimeline = timelineMessages?.()?.find((m) => m.id === activeReplyMessageId)
  if (fromTimeline) return fromTimeline
  for (const line of topicLines?.() ?? []) {
    if (line.kind === 'message' && line.message.id === activeReplyMessageId) return line.message
  }
  const fromTopic = routedTopicMessages?.()?.find((m) => m.id === activeReplyMessageId)
  if (fromTopic) return fromTopic
  const currentReplies = replies?.()
  if (currentReplies?.anchor?.id === activeReplyMessageId) return currentReplies.anchor
  const fromReplies = currentReplies?.messages.find((m) => m.id === activeReplyMessageId)
  if (fromReplies) return fromReplies
  return null
}

export function resolveMobileLevel(
  route: Pick<NavigationTarget, 'channelId' | 'panel'> | null | undefined,
  isSearchOpen: () => boolean,
): MobileLevel {
  const level: MobileLevel = !route?.channelId ? 'channels' : route.panel ? 'panel' : 'view'
  return level === 'channels' && isSearchOpen() ? 'view' : level
}

export function parseReplyMessageId(panel: PanelTarget | null | undefined): string | null {
  return panel?.startsWith('reply:') ? panel.slice(6) : null
}

export function parsePanelTab(panel: PanelTarget | null | undefined): PanelTab {
  return panel && !panel.startsWith('reply:') ? (panel as PanelTab) : 'topics'
}

export function shouldClosePanelForDm(
  selectedKind: 'channel' | 'dm' | undefined,
  getPanel: () => PanelTarget | null | undefined,
): boolean {
  if (selectedKind !== 'dm') return false
  const panel = getPanel()
  return Boolean(panel) && !panel!.startsWith('reply:')
}

type ChannelSelectionNavigation = Pick<Navigation, 'navigate' | 'openSearchResult'>

type ChannelSelectionUnread = {
  readonly state: {
    readonly stopped: boolean
    readonly main: { readonly stopped: boolean }
  }
  enter(topicId?: string | null): unknown
}

type ChannelSelectionDeps = {
  getOrganizationId: () => string
  getSelectedId: () => string | null
  getNavigation: () => ChannelSelectionNavigation
  selectChannel: (id: string) => void
  isDm: (id: string) => boolean
  selectDm: (id: string) => void
  retryAuthors: () => void
  getCurrentUnread: () => ChannelSelectionUnread | null | undefined
  onCloseDrawer: () => void
}

/**
 * Creates the Channel/DM selection handler with live dependency getters so reactive
 * Workspace state is always read at invocation time.
 */
export function createChannelSelection(deps: ChannelSelectionDeps) {
  return function handleSelectChannel(id: string, result?: SearchTarget): void {
    const same = id === deps.getSelectedId()
    if (same) deps.retryAuthors()
    const organizationId = deps.getOrganizationId()
    const navigation = deps.getNavigation()
    const navigated = result
      ? navigation.openSearchResult(organizationId, result)
      : navigation.navigate({ type: 'channel', organizationId, channelId: id })
    if (result || same || navigated === false) {
      if (deps.isDm(id)) deps.selectDm(id)
      else deps.selectChannel(id)
      if (navigated === false || (same && result?.replyRootId && !result.topicId)) {
        const currentUnread = deps.getCurrentUnread()
        if (currentUnread && (currentUnread.state.stopped || currentUnread.state.main.stopped)) {
          void currentUnread.enter(null)
        }
      }
    }
    deps.onCloseDrawer()
  }
}
