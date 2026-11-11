import { createNavigationTargets } from './navigation-targets'
import * as api from './api'
import { createChannels, type ChannelsApi } from './channels'
import { createSync, type SyncOptions } from './sync'

export type SessionOptions = {
  selfId: string
  organizationId?: string
  /** Account-lifetime owner fences this callback, including late 401s after an Organization switch. */
  onEnded: () => void
  channelsApi?: ChannelsApi
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
  const sync = createSync({ ...options.sync, selfId: options.selfId, organizationId,
    api: { listMessages: (channel, query) => observe(timeline.listMessages(channel, query)),
      sendMessage: (channel, body) => observe(timeline.sendMessage(channel, body)) },
    checkMembership: options.sync?.checkMembership ?? (() => observe(api.getOrganizationMe(organizationId))),
    onSessionEnded: notifyEnded,
  })
  const navigationTargets = createNavigationTargets({
    topic: (channel, topic) => observe(api.getTopicSummary(organizationId, channel, topic)),
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
    sync, channels, navigationTargets,
    close() {
      closed = true
      navigationTargets.close()
      stopFollowing(); stopSync()
      channels.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
