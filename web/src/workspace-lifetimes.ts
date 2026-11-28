import type { createChannelMembers } from './channel-members'
import type { NavigationTarget, PanelTab } from './navigation-url'
import { createSearchController, type SearchControllerOptions, type SearchTarget } from './search'
import { createDefaultSearchSource, type SearchSource } from './search-source'

type SearchScope = {
  organizationId: string
  source: SearchSource | undefined
}
type ChannelMemberScope = {
  session: object
  organizationId: string
  channelId: string | null
}
type OpenChannelMembers = (channelId: string) => ReturnType<typeof createChannelMembers>

export function channelMemberTarget(
  panelOpen: boolean,
  tab: () => PanelTab,
  selectedId: () => string | undefined,
  selectedKind: () => 'channel' | 'dm' | undefined,
): string | null {
  if (!panelOpen || tab() !== 'members') return null
  const id = selectedId()
  return id && selectedKind() !== 'dm' ? id : null
}

export function openWorkspaceSearch(
  scope: SearchScope,
  options: {
    onOpenResult: (organizationId: string, target: SearchTarget) => boolean
    onAnnounce: SearchControllerOptions['onAnnounce']
    onChannelRevoked: (revoke: (channelId: string) => void) => (() => void) | undefined
  },
) {
  const controller = createSearchController({
    source: scope.source ?? createDefaultSearchSource(scope.organizationId),
    onOpenResult: target => options.onOpenResult(scope.organizationId, target),
    onAnnounce: options.onAnnounce,
  })
  const stopRevoke = options.onChannelRevoked(controller.revokeChannel)
  return {
    read(current: SearchScope) {
      if (current.organizationId === scope.organizationId && current.source === scope.source) return controller
    },
    dispose() {
      stopRevoke?.()
      controller.destroy()
    },
  }
}

export function openWorkspaceChannelMembers(
  scope: ChannelMemberScope,
  open: OpenChannelMembers | undefined,
  loadDirectory: () => unknown,
) {
  if (!scope.channelId || !open) return
  void loadDirectory()
  const controller = open(scope.channelId)
  return {
    read(current: ChannelMemberScope) {
      if (current.session === scope.session && current.organizationId === scope.organizationId && current.channelId === scope.channelId) {
        return controller
      }
    },
    dispose: controller.close,
  }
}

export function createSearchRouteSync() {
  let lastMainKey: string | null = null
  return (route: NavigationTarget | null, close: () => void) => {
    const mainKey = `${route?.organizationId ?? ''}:${route?.channelId ?? ''}:${route?.topicId ?? ''}`
    if (lastMainKey !== null && mainKey !== lastMainKey) close()
    lastMainKey = mainKey
  }
}
