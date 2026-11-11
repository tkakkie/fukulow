import { createNavigationTargets } from './navigation-targets'
import * as api from './api'
import { createChannelMembers } from './channel-members'
import { createChannels, type ChannelsApi } from './channels'
import type { SyncOptions } from './sync'
import { createTopicSync } from './topic-sync'
import { topicsApi, type TopicsApi } from './topics'

export type SessionOptions = {
  selfId: string
  organizationId?: string
  /** Account-lifetime owner fences this callback, including late 401s after an Organization switch. */
  onEnded: () => void
  channelsApi?: ChannelsApi
  topicsApi?: TopicsApi
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
  const { sync, topics } = createTopicSync({ ...options.sync, selfId: options.selfId, organizationId,
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
  const navigationTargets = createNavigationTargets({
    topic: (channel, topic) => observe(topicSource.getTopicSummary(channel, topic)),
    reply: (channel, message) => observe(api.listReplyChain(organizationId, channel, message, { limit: 1 })),
    channelUnavailable: channel => { void sync.channelUnavailable(channel) },
  })
  let watched: string | null = null
  const channels = createChannels(
    {
      listChannels: () => observe(source.listChannels()),
      createChannel: body => observe(source.createChannel(body)),
    },
    id => {
      if (!closed && !unavailable && id === watched && sync.get().organization === 'available' &&
        sync.get().channels[id]?.state === 'unavailable') {
        void sync.watch(id)
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
    sync, topics, channels, navigationTargets,
    channelMembers(channel: string) {
      memberControllers.get(channel)?.close()
      const controller = createChannelMembers(organizationId, channel, r => {
        if (!r.ok && r.kind === 'http' && r.status === 401) notifyEnded()
        else if (!closed && api.isOrganizationUnavailable(r)) terminate()
      }, api, () => { void sync.channelUnavailable(channel) })
      memberControllers.set(channel, controller)
      const lost = sync.get().organization === 'unavailable' || sync.get().channels[channel]?.state === 'unavailable'
      memberAvailability.set(channel, lost)
      if (lost) controller.unavailable()
      else void controller.load()
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
