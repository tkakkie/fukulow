import { completeCountFields } from './unread-counts'
import { createActivity, createActivityTarget, type ActivityTarget } from './activity'
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
  onIdentity?: (identity: api.Identity) => void
  onIdentityInvalidated?: () => void
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
  const activity = createActivity({
    watched: id => sync.get().channels[id]?.subscription?.confirmed === true,
    covered: (notice, target) => {
      if (notice.type === 'channel_activity') return (unread.get(notice.channel_id).asOfSeq ?? -1) >= notice.seq
      if (notice.type !== 'read_position_changed') return false
      if (target === 'channels') return notice.topic_id === null && unread.activityMainCoverage(notice.channel_id) >= notice.read_seq
      if (notice.topic_id !== null) {
        const summary = topics.get(notice.channel_id).topics.find(t => t.topicId === notice.topic_id)?.baseline?.summary
        return summary !== undefined && completeCountFields(summary) && summary.read_seq >= notice.read_seq
      }
      return false
    },
    revoke: id => { channels.revoke(id); unread.activityRevoke(id); memberControllers.get(id)?.unavailable() },
    access: id => { unread.activityAccess(id); topics.activityAccess(id) },
    reconcile: () => unread.activityReconcile(),
    random: options.sync?.random,
  })
  const source = options.channelsApi ?? {
    listChannels: signal => api.listChannels(organizationId, undefined, signal),
    createChannel: body => api.createChannel(organizationId, body),
  }
  const timeline = options.sync?.api ?? {
    listMessages: (channel, query) => api.listMessages(organizationId, channel, query),
    sendMessage: (channel, body) => api.sendMessage(organizationId, channel, body),
  } satisfies NonNullable<SyncOptions['api']>
  const topicSource = options.topicsApi ?? topicsApi(organizationId)
  const replySource = options.repliesApi ?? repliesApi(organizationId)
  const unreadSource = options.unreadApi ?? unreadApi(organizationId)
  const topicComposition = createTopicSync({ ...options.sync, activity, selfId: options.selfId, organizationId,
    api: { listMessages: (channel, query) => observe(timeline.listMessages(channel, query)),
      sendMessage: (channel, body) => observe(timeline.sendMessage(channel, body)) },
    topicsApi: {
      listTimeline: (channel, query) => observe(topicSource.listTimeline(channel, query)),
      listTopics: (channel, query, signal) => observe(signal ? topicSource.listTopics(channel, query, signal) : topicSource.listTopics(channel, query)),
      getTopicSummary: (channel, topic, signal) => observe(signal ? topicSource.getTopicSummary(channel, topic, signal) : topicSource.getTopicSummary(channel, topic)),
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
      refreshList: !options.channelsApi ? () => Promise.resolve().then(() => channels.load()) : undefined,
      unreadApi: {
        listChannels: () => observe(unreadSource.listChannels()),
        markRead: (scope, body) => observe(unreadSource.markRead(scope, body)),
        getTopicSummary: (channel, topic) => observe(options.unreadApi ? unreadSource.getTopicSummary(channel, topic) : topics.activitySummary(channel, topic, unread.get(channel).topics[topic]?.position ?? 0)),
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
      listChannels: signal => observe(options.channelsApi ? source.listChannels(signal) : unreadSource.listChannels(signal)),
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
    activity,
    rows => {
      const baselines = rows.filter((row): row is api.UnreadChannel => 'as_of_seq' in row && completeCountFields(row))
      if (baselines.length || rows.length === 0) unread.activitySnapshot(baselines)
    },
  )
  const stopActivity = sync.onActivity(notice => {
    activity.notice(notice)
  })
  function terminate() {
    if (unavailable) return
    unavailable = true
    activity.close(); capabilities.close()
    channels.close()
    void sync.unavailable()
  }
  const capabilities = createActivityTarget({
    load: signal => observe(api.getOrganizationMe(organizationId, undefined, signal)),
    accept: identity => options.onIdentity?.(identity),
    hide: () => options.onIdentityInvalidated?.(),
    terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || r.error === 'organization_unavailable'),
  })
  activity.hold('capabilities', capabilities)
  const stopSync = sync.subscribe(() => {
    if (!sync.get().connected) activity.disconnected()
    if (sync.get().organization === 'unavailable') terminate()
  })
  const memberControllers = new Map<string, ReturnType<typeof createChannelMembers>>()
  const memberAvailability = new Map<string, boolean>()
  const memberReleases = new Map<string, () => void>()
  function holdMembers(id: string, controller: ReturnType<typeof createChannelMembers>) {
    memberReleases.get(id)?.()
    memberReleases.set(id, activity.hold(`channel-members:${id}`, controller.activityTarget))
  }
  const stopMemberAccess = sync.subscribe(() => {
    for (const [id, controller] of memberControllers) {
      const lost = sync.get().organization === 'unavailable' || sync.get().channels[id]?.state === 'unavailable'
      if (lost) { controller.unavailable(); memberReleases.get(id)?.(); memberReleases.delete(id) }
      else if (memberAvailability.get(id)) { holdMembers(id, controller); controller.reselect() }
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
    holdActivity: (key: string, target: ActivityTarget) => activity.hold(key, target),
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
        holdMembers(channel, controller)
        void controller.load()
        void channels.load()
      }
      return controller
    },
    close() {
      closed = true
      stopActivity(); activity.close(); capabilities.close()
      navigationTargets.close()
      stopFollowing(); stopSync(); stopMemberAccess()
      memberControllers.forEach(c => c.close()); memberControllers.clear()
      channels.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
