import { createNavigationTargets } from './navigation-targets'
import * as api from './api'
import { createChannelMembers } from './channel-members'
import { createChannels, type ChannelsApi } from './channels'
import { repliesApi, type RepliesApi } from './replies'
import { createReplySync } from './reply-sync'
import type { SyncOptions } from './sync'
import { createTopicSync } from './topic-sync'
import { topicsApi, type TopicsApi } from './topics'
import { unreadApi, type UnreadApi } from './unread'
import { createUnreadSync } from './unread-sync'

export type SessionOptions = {
  selfId: string
  organizationId?: string
  /** Account-lifetime owner fences this callback, including late 401s after an Organization switch. */
  onEnded: () => void
  channelsApi?: ChannelsApi
  topicsApi?: TopicsApi
  repliesApi?: RepliesApi
  unreadApi?: UnreadApi
  sync?: Partial<SyncOptions>
}

/** One Organization's controllers. Closing fences its data, while late 401s still reach the Account owner. */
export function createSession(options: SessionOptions) {
  const organizationId = options.organizationId ?? ''
  let closed = false
  let ended = false
  const notifyEnded = () => { if (!ended) { ended = true; options.onEnded() } }
  let unavailable = false
  const observe = async <T>(promise: Promise<api.Result<T>>): Promise<api.Result<T>> => {
    const result = await promise
    if (!result.ok && result.kind === 'http' && result.status === 401) notifyEnded()
    else if (!closed && api.isOrganizationUnavailable(result)) terminate()
    return result
  }
  const source = options.channelsApi ?? {
    listChannels: () => api.listChannels(organizationId),
    createChannel: body => api.createChannel(organizationId, body),
  }
  const timeline = options.sync?.api ?? {
    listMessages: (channel, query) => api.listMessages(organizationId, channel, query),
    sendMessage: (channel, body) => api.sendMessage(organizationId, channel, body),
  } satisfies NonNullable<SyncOptions['api']>
  const topicSource = options.topicsApi ?? topicsApi(organizationId)
  const replySource = options.repliesApi ?? repliesApi(organizationId)
  const unreadSource = options.unreadApi ?? unreadApi(organizationId)
  const topicComposition = createTopicSync({ ...options.sync, selfId: options.selfId, organizationId,
    api: { listMessages: (channel, query) => observe(timeline.listMessages(channel, query)),
      sendMessage: (channel, body) => observe(timeline.sendMessage(channel, body)) },
    topicsApi: {
      listTimeline: (channel, query) => observe(topicSource.listTimeline(channel, query)),
      listTopics: (channel, query) => observe(topicSource.listTopics(channel, query)),
      getTopicSummary: (channel, topic) => observe(topicSource.getTopicSummary(channel, topic)),
      listTopicMessages: (channel, topic, query) => observe(topicSource.listTopicMessages(channel, topic, query)),
    },
    checkMembership: options.sync?.checkMembership ?? (() => observe(api.getOrganizationMe(organizationId))),
    onSessionEnded: notifyEnded,
  })
  const replyComposition = createReplySync(
    {
      ...options.sync,
      selfId: options.selfId,
      organizationId,
      repliesApi: {
        listReplyChain: (channel, anchor, query) => observe(replySource.listReplyChain(channel, anchor, query)),
      },
      onSessionEnded: notifyEnded,
    },
    topicComposition.sync,
  )
  const { topics } = topicComposition
  const { replies } = replyComposition
  const { sync, unread } = createUnreadSync(
    {
      ...options.sync,
      selfId: options.selfId,
      organizationId,
      unreadApi: {
        listChannels: () => observe(unreadSource.listChannels()),
        markRead: (scope, body) => observe(unreadSource.markRead(scope, body)),
        getTopicSummary: (channel, topic) => observe(unreadSource.getTopicSummary(channel, topic)),
      },
      onSessionEnded: notifyEnded,
    },
    { sync: replyComposition.sync, topics },
  )
  const navigationTargets = createNavigationTargets({
    topic: (channel, topic) => observe(topicSource.getTopicSummary(channel, topic)),
    reply: (channel, message) => observe(replySource.listReplyChain(channel, message, { limit: 1 })),
    channelUnavailable: channel => { void sync.channelUnavailable(channel) },
  })
  let watched: string | null = null
  const channels = createChannels(
    {
      listChannels: () => observe(source.listChannels()),
      createChannel: body => observe(source.createChannel(body)),
    },
    id => {
      if (!closed && !unavailable && id === watched && sync.get().organization === 'available') {
        if (sync.get().channels[id]?.state === 'unavailable') {
          void sync.watch(id)
        } else if (unread.get(id).stopped || unread.get(id).main.stopped) {
          void unread.enter({ channel: id, topicId: null })
        }
      }
    },
  )
  function terminate() {
    if (unavailable) return
    unavailable = true
    channels.close()
    void sync.unavailable()
  }
  const stopSync = sync.subscribe(() => {
    if (sync.get().organization === 'unavailable') terminate()
  })
  const memberControllers = new Map<string, ReturnType<typeof createChannelMembers>>()
  const memberAvailability = new Map<string, boolean>()
  const stopMemberAccess = sync.subscribe(() => {
    for (const [id, controller] of memberControllers) {
      const lost = sync.get().organization === 'unavailable' || sync.get().channels[id]?.state === 'unavailable'
      if (lost) controller.unavailable()
      else if (memberAvailability.get(id)) controller.reselect()
      memberAvailability.set(id, lost)
    }
  })
  const stopFollowing = channels.subscribe(() => {
    const id = channels.get().selectedId
    if (id === watched) return
    if (watched !== null) void sync.unwatch(watched)
    watched = id
    if (id !== null) void sync.watch(id)
  })
  void sync.start()
  void channels.load()
  return {
    sync, topics, replies, unread, channels, navigationTargets,
    channelMembers(channel: string) {
      memberControllers.get(channel)?.close()
      const controller = createChannelMembers(organizationId, channel, r => {
        if (!r.ok && r.kind === 'http' && r.status === 401) notifyEnded()
        else if (!closed && api.isOrganizationUnavailable(r)) terminate()
      }, api, () => { void sync.channelUnavailable(channel) }, () => channels.load())
      memberControllers.set(channel, controller)
      const lost = sync.get().organization === 'unavailable' || sync.get().channels[channel]?.state === 'unavailable'
      memberAvailability.set(channel, lost)
      if (lost) controller.unavailable()
      else {
        void controller.load()
        void channels.load()
      }
      return controller
    },
    close() {
      closed = true
      navigationTargets.close()
      stopFollowing(); stopSync(); stopMemberAccess()
      memberControllers.forEach(c => c.close()); memberControllers.clear()
      channels.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
