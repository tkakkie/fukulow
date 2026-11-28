import { createAnnouncementController, type AnnouncementControllerOptions } from './announcements'
import type { ChannelsState } from './channels'
import type { Replies } from './replies'

type Announcements = ReturnType<typeof createAnnouncementController>
type TimelineUpdate = Parameters<Announcements['onTimelineUpdated']>[0]

export function createWorkspaceAnnouncements(
  options: AnnouncementControllerOptions,
  lastView: { get(): string; set(viewId: string): void },
) {
  const announcements = createAnnouncementController(options)

  function syncView(input: {
    selected: { id: string; kind: 'channel' | 'dm' } | undefined
    isChannelListLoading: () => boolean
    topicId: () => string | null | undefined
    topicName: () => string
    isTopicLoading: () => boolean
    channelName: () => string
    unnamedTopic: string
  }) {
    const { selected } = input
    if (!selected) { lastView.set(''); return }
    if (input.isChannelListLoading()) return
    const topicId = input.topicId()
    const viewId = `${selected.id}/${topicId ?? ''}`
    if (topicId && !input.topicName() && input.isTopicLoading()) return
    if (viewId === lastView.get()) return
    lastView.set(viewId)
    announcements.onViewChanged({
      viewId,
      kind: topicId ? 'topic' : selected.kind,
      name: topicId ? (input.topicName() || input.unnamedTopic) : input.channelName(),
    })
  }

  function syncTimeline(input: {
    selected: { id: string } | undefined
    topicId: () => string | null | undefined
    timeline: () => Pick<TimelineUpdate, 'messages' | 'status'> | null
    activeReplyMessageId: () => string | null
    replies: () => Pick<ReturnType<Replies['get']>, 'rootId' | 'messages'> | null
    live: () => boolean
    selfId: () => string | undefined
    resolveSenderName: (senderId: string) => string
    hasCustomSenderName: () => boolean
    isAuthorPending: (senderId: string) => boolean
  }) {
    if (!input.selected) return
    const viewId = `${input.selected.id}/${input.topicId() ?? ''}`
    const timeline = input.timeline()
    if (!timeline || viewId !== lastView.get()) return
    const replies = input.activeReplyMessageId() ? input.replies() : null
    const replyChainIds = replies
      ? new Set([
          ...(replies.rootId ? [replies.rootId] : []),
          ...replies.messages.map(m => m.id),
        ])
      : undefined
    announcements.onTimelineUpdated({
      viewId,
      topicId: input.topicId() ?? null,
      status: timeline.status,
      live: input.live(),
      messages: timeline.messages,
      replyChainIds,
      selfId: input.selfId() ?? '',
      resolveSenderName: input.resolveSenderName,
      isSenderPending: id => !input.hasCustomSenderName() && id !== input.selfId() && input.isAuthorPending(id),
    })
  }

  function syncChannelList(state: Pick<ChannelsState, 'status' | 'channels'>) {
    announcements.syncChannelListLoading(state.status === 'loading' && state.channels.length === 0)
  }

  return {
    get: announcements.get,
    subscribe: announcements.subscribe,
    resetChannelListTimeout: announcements.resetChannelListTimeout,
    destroy: announcements.destroy,
    syncView,
    syncTimeline,
    syncChannelList,
  }
}
