import * as api from './api'
import { createChannelMembers } from './channel-members'
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
  const channels = createChannels({ listChannels: () => observe(source.listChannels()),
    createChannel: body => observe(source.createChannel(body)) })
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
  let watched: string | null = null
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
    sync, channels: { ...channels, select(id: string) {
      channels.select(id)
      if (!closed && id === watched && sync.get().channels[id]?.state === 'unavailable') void sync.watch(id)
    } },
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
      stopFollowing(); stopSync(); stopMemberAccess()
      memberControllers.forEach(c => c.close()); memberControllers.clear()
      channels.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
