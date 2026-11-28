import type { Message, TopicSummary } from './api'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import type { Session } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'

export const HISTORY_GENERATION = '00000000-0000-4000-8000-000000000515'

export function createTopicWorkspaceSession(rawSession: Session) {
  const topicAdapters = new Map<string, TopicsAdapter>()
  return {
    channels: channelsAdapter(rawSession.channels),
    sync: syncAdapter(rawSession.sync),
    topics(channelId: string) {
      let a = topicAdapters.get(channelId)
      if (!a) {
        a = topicsAdapter(rawSession.topics, channelId)
        topicAdapters.set(channelId, a)
      }
      return a
    },
    navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
    close: () => rawSession.close(),
  }
}

export function createTopicWorkspaceNavigation(
  initialHref: string,
  getInnerWidth: () => number = () => 1280,
) {
  let href = initialHref
  let historyState: unknown = null
  const navigation = createNavigation({
    location: {
      get href() {
        return href
      },
    },
    history: {
      get state() {
        return historyState
      },
      pushState(state: unknown, _title: string, url: string) {
        historyState = state
        href = url
      },
      replaceState(state: unknown, _title: string, url: string) {
        historyState = state
        href = url
      },
    },
    get innerWidth() {
      return getInnerWidth()
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as NavigationBrowser)
  return {
    navigation,
    getHref: () => href,
  }
}

export function topicWorkspaceOrganization() {
  return {
    member: { id: 'me', name: '自分', role: 'owner' as const },
    organization: {
      organization_id: 'org-1',
      name: 'Acme',
      capabilities: {
        can_create_channels: { allowed: true },
        can_invite: { allowed: true },
        can_deactivate_members: { allowed: true },
        can_manage_roles: { allowed: true },
      },
    },
  }
}

export function topicSummaryItem(
  id: string,
  name: string,
  latestMessage: Message,
  {
    firstSeq = latestMessage.created_seq,
    lastSeq = latestMessage.created_seq,
    messageCount = 1,
  }: { firstSeq?: number; lastSeq?: number; messageCount?: number } = {},
): TopicSummary {
  return {
    mention_unread_count: 0,
    id,
    name,
    first_seq: firstSeq,
    last_seq: lastSeq,
    message_count: messageCount,
    latest_message: latestMessage,
    read_seq: 0,
    unread_count: 0,
  }
}
