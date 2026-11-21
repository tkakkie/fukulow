import type { Message } from './api'
import type { MobileLevel } from './focus-management'
import type { Navigation } from './navigation'
import type { NavigationTarget, PanelTab, PanelTarget } from './navigation-url'
import type { Replies } from './replies'
import type { SearchTarget } from './search'
import type { MainTimelineLine } from './topic-selectors'

export type ResolveReplyAnchorInput = {
  activeReplyMessageId: string | null
  selectedChannelId: string | undefined
  lastOpenedAnchor: Message | null
  timelineMessages?: readonly Message[] | null
  topicLines?: readonly MainTimelineLine[] | null
  routedTopicMessages?: readonly Message[] | null
  replies?: Pick<ReturnType<Replies['get']>, 'anchor' | 'messages'> | null
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
  if (lastOpenedAnchor?.id === activeReplyMessageId && lastOpenedAnchor.channel_id === selectedChannelId) {
    return lastOpenedAnchor
  }
  const fromTimeline = timelineMessages?.find((m) => m.id === activeReplyMessageId)
  if (fromTimeline) return fromTimeline
  for (const line of topicLines ?? []) {
    if (line.kind === 'message' && line.message.id === activeReplyMessageId) return line.message
  }
  const fromTopic = routedTopicMessages?.find((m) => m.id === activeReplyMessageId)
  if (fromTopic) return fromTopic
  if (replies?.anchor?.id === activeReplyMessageId) return replies.anchor
  const fromReplies = replies?.messages.find((m) => m.id === activeReplyMessageId)
  if (fromReplies) return fromReplies
  return null
}

export function resolveMobileLevel(
  route: Pick<NavigationTarget, 'channelId' | 'panel'> | null | undefined,
  searchOpen: boolean,
): MobileLevel {
  const level: MobileLevel = !route?.channelId ? 'channels' : route.panel ? 'panel' : 'view'
  return level === 'channels' && searchOpen ? 'view' : level
}

export function parseReplyMessageId(panel: PanelTarget | null | undefined): string | null {
  return panel?.startsWith('reply:') ? panel.slice(6) : null
}

export function parsePanelTab(panel: PanelTarget | null | undefined): PanelTab {
  return panel && !panel.startsWith('reply:') ? (panel as PanelTab) : 'topics'
}

export function shouldClosePanelForDm(
  selectedKind: 'channel' | 'dm' | undefined,
  panel: PanelTarget | null | undefined,
): boolean {
  return selectedKind === 'dm' && Boolean(panel) && !panel!.startsWith('reply:')
}

export type ChannelSelectionNavigation = Pick<Navigation, 'navigate' | 'openSearchResult'>

export type ChannelSelectionUnread = {
  readonly state: {
    readonly stopped: boolean
    readonly main: { readonly stopped: boolean }
  }
  enter(topicId?: string | null): unknown
}

export type ChannelSelectionDeps = {
  getOrganizationId: () => string
  getSelectedId: () => string | null
  getNavigation: () => ChannelSelectionNavigation
  selectChannel: (id: string) => void
  isDm?: (id: string) => boolean
  selectDm?: (id: string) => void
  retryAuthors?: () => void
  getCurrentUnread?: () => ChannelSelectionUnread | null | undefined
  onCloseDrawer?: () => void
}

/**
 * Creates the Channel/DM selection handler with live dependency getters so reactive
 * Workspace state is always read at invocation time.
 */
export function createChannelSelection(deps: ChannelSelectionDeps) {
  return function handleSelectChannel(id: string, result?: SearchTarget): void {
    const same = id === deps.getSelectedId()
    if (same) deps.retryAuthors?.()
    const organizationId = deps.getOrganizationId()
    const navigation = deps.getNavigation()
    const navigated = result
      ? navigation.openSearchResult(organizationId, result)
      : navigation.navigate({ type: 'channel', organizationId, channelId: id })
    if (result || same || navigated === false) {
      if (deps.isDm?.(id)) deps.selectDm?.(id)
      else deps.selectChannel(id)
      const currentUnread = deps.getCurrentUnread?.()
      if (
        (navigated === false || (same && result?.replyRootId && !result.topicId)) &&
        currentUnread &&
        (currentUnread.state.stopped || currentUnread.state.main.stopped)
      ) {
        void currentUnread.enter(null)
      }
    }
    deps.onCloseDrawer?.()
  }
}
