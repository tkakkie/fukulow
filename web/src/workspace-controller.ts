import type { ChannelsState } from './channels'
import type { Navigation, SearchResultTarget } from './navigation'
import type { NavigationTarget, PanelTarget } from './navigation-url'
import type { SearchTarget } from './search'
import type { Topics } from './topics'
import { shouldClosePanelForDm } from './workspace-routing'

type TopicsState = ReturnType<Topics['get']>
type KnownTopics = {
  topic(id: string): Pick<ReturnType<TopicsState['topic']>, 'notFound'>
  topics: readonly Pick<TopicsState['topics'][number], 'topicId'>[]
  list: Pick<TopicsState['list'], 'asOfSeq' | 'hasMore'>
  main: Pick<TopicsState['main'], 'asOfSeq' | 'hasMore'>
}

export function createWorkspaceController() {
  let recoveredSelection = ''

  return {
    initialize(
      status: ChannelsState['status'],
      organizationId: () => string,
      channelId: () => string | null,
      initialize: Navigation['initialize'],
    ) {
      if (status !== 'ready') return
      const orgId = organizationId()
      if (!orgId) return
      initialize({ organizationId: orgId, channelId: channelId(), topicId: null, panel: null })
    },
    syncSelection(
      status: ChannelsState['status'],
      route: () => NavigationTarget | null,
      organizationId: () => string,
      selectedId: () => string | null,
      selectHint: (channelId: string) => void,
    ) {
      if (status !== 'ready') return
      const target = route()
      if (target?.organizationId !== organizationId()) return
      if (target.channelId && target.channelId !== selectedId()) selectHint(target.channelId)
    },
    syncNavigationTargets(input: {
      route: NavigationTarget | null
      organizationId: string
      organizationUnavailable: () => boolean
      searchReply: () => boolean
      replies: () => unknown
      activeReplyMessageId: () => string | null
      inMemoryReplyAnchor: () => unknown
      load: (route: NavigationTarget) => unknown
    }) {
      const { route } = input
      if (route?.organizationId !== input.organizationId || input.organizationUnavailable()) return
      const skipReplyHint = input.searchReply() ||
        Boolean(input.replies() && input.activeReplyMessageId() && input.inMemoryReplyAnchor())
      void input.load(skipReplyHint ? { ...route, panel: null } : route)
    },
    syncSearchAnchor(anchor: { open(result: SearchResultTarget | undefined): unknown } | undefined,
      result: SearchResultTarget | undefined, closeDrawer: () => void) {
      anchor?.open(result)
      if (result) closeDrawer()
    },
    syncDmPanel(
      kind: 'channel' | 'dm' | undefined,
      panel: () => PanelTarget | null | undefined,
      navigate: Navigation['navigate'],
    ) {
      if (shouldClosePanelForDm(kind, panel)) navigate({ type: 'close' })
    },
    syncRecoveredDm(id: string | null | undefined, selectedId: () => string | null, select: (id: string) => void) {
      if (!id) { recoveredSelection = ''; return }
      if (id !== recoveredSelection && selectedId() === id) {
        recoveredSelection = id
        select(id)
      }
    },
    async openDm(open: () => unknown, selectedDm: () => string | null | undefined,
      selectedChannel: () => string | null, select: (id: string) => void) {
      await open()
      const id = selectedDm()
      if (id && selectedChannel() === id) select(id)
    },
    selectTopic(topicId: string, input: {
      selected: { id: string } | undefined
      organizationId: () => string
      closeSearch: () => void
      currentTopicId: () => string | null | undefined
      phone: () => boolean
      navigate: Navigation['navigate']
      unread: () => {
        readonly state: { readonly stopped: boolean; readonly topics: Readonly<Record<string, { stopped: boolean }>> }
        enter(topicId: string): unknown
      } | null
      closeDrawer: () => void
    }) {
      if (!input.selected || !input.organizationId()) return
      input.closeSearch()
      const wasSameTopic = input.currentTopicId() === topicId
      input.navigate({ type: 'topic', topicId, phone: input.phone() })
      const unread = wasSameTopic ? input.unread() : null
      if (unread && (unread.state.stopped || unread.state.topics[topicId]?.stopped)) void unread.enter(topicId)
      input.closeDrawer()
    },
    openSearchResult(organizationId: string, target: SearchTarget, input: {
      currentOrganizationId: string
      organizationUnavailable: () => boolean
      isDm: (id: string) => boolean
      isKnownChannel: (id: string) => boolean
      topics: (id: string) => KnownTopics
      select: (id: string, result: SearchTarget) => void
    }): boolean {
      if (!organizationId || organizationId !== input.currentOrganizationId || input.organizationUnavailable()) return false
      const isDm = input.isDm(target.channelId)
      // A hit's kind permits an unknown Channel or DM hint; the server decides availability.
      if (!isDm && !input.isKnownChannel(target.channelId) && !target.channelKind) return false
      if (target.topicId) {
        if (isDm || target.channelKind === 'dm') return false
        const topics = input.topics(target.channelId)
        if (topics.topic(target.topicId).notFound) return false
        if (!topics.topics.some(t => t.topicId === target.topicId)) {
          const allKnown = topics.list.asOfSeq !== undefined
            ? !topics.list.hasMore
            : topics.main.asOfSeq !== undefined && !topics.main.hasMore
          if (allKnown) return false
        }
      }
      input.select(target.channelId, target)
      return true
    },
  }
}
