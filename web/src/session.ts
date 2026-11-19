import { completeCountFields } from './unread-counts'
import { createActivity, createActivityTarget, type ActivityTarget } from './activity'
import { createNavigationTargets } from './navigation-targets'
import * as api from './api'
import { createChannelMembers } from './channel-members'
import type { MemberListAccess } from './members'
import { createChannels, type ChannelsApi } from './channels'
import { createDms, dmsApi, type Dms, type DmsApi } from './dms'
import { createMoveChain, type MoveChainApi } from './move-chain'
import { repliesApi, type RepliesApi } from './replies'
import { createReplyCounts, type ReplyCountsApi } from './reply-counts'
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
  replyCountsApi?: ReplyCountsApi
  repliesApi?: RepliesApi
  moveChainApi?: MoveChainApi
  unreadApi?: UnreadApi
  dmsApi?: DmsApi
  initialRole?: api.Role
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
  let dms: Dms | undefined
  let history: ReturnType<typeof createTopicSync>['sync'] | undefined
  const observeAccess = (result: api.Result<unknown>) => {
    if (!result.ok && result.kind === 'http' && result.status === 401) notifyEnded()
    else if (!closed && api.isOrganizationUnavailable(result)) terminate()
  }
  const observe = async <T>(promise: Promise<api.Result<T>>): Promise<api.Result<T>> => {
    const epoch = history?.get().historyEpoch
    const result = await promise
    observeAccess(result)
    if (!closed && history && (epoch === undefined || epoch === history.get().historyEpoch)) {
      const generation = result.ok && result.data && typeof result.data === 'object' && 'history_generation' in result.data ? result.data.history_generation : undefined
      if (typeof generation === 'string' && !history.observeHistoryGeneration(generation)) return { ok: false, kind: 'network' }
      if (!result.ok && result.kind === 'http' && result.status === 409 && result.error === 'history_generation_changed') { history.observeHistoryGeneration(); return { ok: false, kind: 'network' } }
    } else if (result.ok && epoch !== undefined && epoch !== history?.get().historyEpoch) return { ok: false, kind: 'network' }
    return result
  }
  const activity = createActivity({
    kind: id => isDm(id) ? 'dm' : channels.isOrdinary(id) ? 'channel' : undefined,
    watched: id => sync.get().channels[id]?.subscription?.confirmed === true,
    covered: (notice, target) => {
      if (notice.type === 'channel_activity') return (unread.get(notice.channel_id).asOfSeq ?? -1) >= notice.seq
      if (notice.type !== 'read_position_changed') return false
      if ((target === 'channels' || target === 'dms')) return notice.topic_id === null && unread.activityMainCoverage(notice.channel_id) >= notice.read_seq
      if (notice.topic_id !== null) {
        const summary = topics.get(notice.channel_id).topics.find(t => t.topicId === notice.topic_id)?.baseline?.summary
        return summary !== undefined && completeCountFields(summary) && summary.read_seq >= notice.read_seq
      }
      return false
    },
    revoke: id => { dms?.access(id, true); channels.revoke(id); unread.activityRevoke(id); memberControllers.get(id)?.unavailable() },
    access: id => { dms?.access(id); unread.activityAccess(id); topics.activityAccess(id) },
    reconcile: () => unread.activityReconcile(),
    random: options.sync?.random,
  })
  const isDm = (id: string) => dms?.get().rows.some(row => row.identity.id === id) ?? false
  const source: ChannelsApi = options.channelsApi ?? {
    listChannels: signal => api.listChannels(organizationId, undefined, signal, { history_generation: history?.get().historyGeneration }),
    createChannel: body => api.createChannel(organizationId, body),
    listArchivedChannels: signal => api.listChannels(organizationId, undefined, signal, { archived: true, history_generation: history?.get().historyGeneration }),
    getChannel: (id, signal) => api.getChannel(organizationId, id, undefined, signal),
    updateChannel: (id, body) => api.updateChannel(organizationId, id, body),
  }
  const timeline = options.sync?.api ?? {
    listChannelEvents: (channel, query) => api.listChannelEvents(organizationId, channel, query),
    listMessages: (channel, query) => api.listMessages(organizationId, channel, query),
    sendMessage: (channel, body) => api.sendMessage(organizationId, channel, body),
  } satisfies NonNullable<SyncOptions['api']>
  const topicSource = options.topicsApi ?? topicsApi(organizationId, () => history?.get().historyGeneration)
  const replySource = options.repliesApi ?? repliesApi(organizationId)
  const unreadSource = options.unreadApi ?? unreadApi(organizationId, () => history?.get().historyGeneration)
  const topicComposition = createTopicSync({ ...options.sync, activity, selfId: options.selfId, organizationId,
    isDm,
    api: { listChannelEvents: (channel, query) => observe(timeline.listChannelEvents(channel, query)),
      listMessages: (channel, query) => observe(timeline.listMessages(channel, query)),
      sendMessage: async (channel, body) => {
        const result = await observe(timeline.sendMessage(channel, body))
        if (!closed && !unavailable) dms?.peerRefusal(channel, result)
        return result
      } },
    topicsApi: {
      listTimeline: (channel, query) => observe(topicSource.listTimeline(channel, query)),
      listTopics: (channel, query, signal) => observe(signal ? topicSource.listTopics(channel, query, signal) : topicSource.listTopics(channel, query)),
      getTopicSummary: (channel, topic, signal) => observe(signal ? topicSource.getTopicSummary(channel, topic, signal) : topicSource.getTopicSummary(channel, topic)),
      listTopicMessages: (channel, topic, query) => observe(topicSource.listTopicMessages(channel, topic, query)),
    },
    checkMembership: options.sync?.checkMembership ?? (() => observe(api.getOrganizationMe(organizationId))),
    onSessionEnded: notifyEnded,
  })
  history = topicComposition.sync
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
      refreshDms: () => dms?.refresh(),
      isDm,
      unreadApi: {
        listChannels: () => observe(unreadSource.listChannels()),
        markRead: (scope, body) => observe(unreadSource.markRead(scope, body)),
        getTopicSummary: (channel, topic) => observe(options.unreadApi ? unreadSource.getTopicSummary(channel, topic) : topics.activitySummary(channel, topic, unread.get(channel).topics[topic]?.position ?? 0)),
      },
      onSessionEnded: notifyEnded,
    },
    { sync: replyComposition.sync, topics },
  )
  const replyCounts = createReplyCounts(sync, { replies, topics }, {
    api: (channel, body, signal) => observe(options.replyCountsApi ? options.replyCountsApi(channel, body, signal) : api.getReplyCounts(organizationId, channel, body, signal)),
    onSessionEnded: notifyEnded, requestTimeoutMs: options.sync?.requestTimeoutMs, random: options.sync?.random,
  })
  const moveChain = createMoveChain(sync, replies, {
    newId: options.sync?.newId, requestTimeoutMs: options.sync?.requestTimeoutMs,
    async api(channel, anchor, body) {
      const result = await (options.moveChainApi?.(channel, anchor, body) ?? api.moveChain(organizationId, channel, anchor, body))
      observeAccess(result)
      return result
    },
  })
  const navigationTargets = createNavigationTargets({
    topic: (channel, topic) => observe(topicSource.getTopicSummary(channel, topic)),
    reply: (channel, message) => observe(replySource.listReplyChain(channel, message, { limit: 1 })),
    channelUnavailable: channel => { void sync.channelUnavailable(channel) },
  })
  let watched: string | null = null
  const { listArchivedChannels, getChannel, updateChannel } = source
  const channels = createChannels(
    {
      listChannels: signal => observe(options.channelsApi ? source.listChannels(signal) : unreadSource.listChannels(signal)),
      createChannel: body => observe(source.createChannel(body)),
      listArchivedChannels: listArchivedChannels && (signal => observe(listArchivedChannels(signal))),
      getChannel: getChannel && ((id, signal) => observe(getChannel(id, signal))),
      updateChannel: updateChannel && (async (id, body) => {
        const result = await updateChannel(id, body)
        observeAccess(result)
        return result
      }),
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
    {
      canOpen: id => !isDm(id) && sync.get().channels[id]?.state !== 'unavailable',
      verifyOrdinary: (id, signal) => observe(topicSource.listTopics(id, { limit: 1 }, signal)),
      unavailable: id => { void sync.channelUnavailable(id) },
      onOpen: channel => unread.activityArchive(channel.id, channel.archived),
      onArchivedSnapshot: rows => {
        const active = new Set(channels.get().channels.map(c => c.id))
        unread.activityArchivedSnapshot(rows.filter(row => !active.has(row.id)))
      },
    },
  )
  const dmSource = options.dmsApi ?? dmsApi(organizationId)
  dms = createDms({ api: {
    list: (query, signal) => observe(dmSource.list({ history_generation: history?.get().historyGeneration, ...query }, signal)),
    changes: (query, signal) => observe(dmSource.changes(query, signal)),
    open: (body, signal) => observe(dmSource.open(body, signal)),
  }, activity, watched: id => sync.get().channels[id]?.subscription?.confirmed === true,
  baseline: (dm, replace) => unread.activityDmSnapshot(dm, replace),
  processed: identity => {
    if (channels.get().selectedId === identity.id) channels.refreshOpen()
    topicComposition.resolveDm(identity.id)
  },
  drop: id => unread.activityRevoke(id),
  select: id => {
    if (closed || unavailable) return
    const same = channels.get().selectedId === id
    channels.selectHint(id)
    if (same && sync.get().channels[id]?.state === 'unavailable') void sync.watch(id)
  }, random: options.sync?.random, timeoutMs: options.sync?.requestTimeoutMs })
  const stopActivity = sync.onActivity(notice => {
    if (notice.type === 'activity_ready') dms?.ready()
    activity.notice(notice)
  })
  function terminate() {
    if (unavailable) return
    unavailable = true
    activity.close(); capabilities.close()
    channels.close()
    dms?.close()
    void sync.unavailable()
  }
  let listAccess: MemberListAccess = options.initialRole ?? 'guest'
  const memberListAccess = () => listAccess
  const capabilities = createActivityTarget({
    load: signal => observe(api.getOrganizationMe(organizationId, undefined, signal)),
    accept: identity => {
      listAccess = identity.member.role
      // Resume held lists after revalidation. A confirmed Guest starts with no rows.
      activity.invalidateMemberLists()
      options.onIdentity?.(identity)
    },
    hide: () => {
      if (listAccess !== null) listAccess = listAccess === 'guest' ? null : 'revalidating'
      options.onIdentityInvalidated?.()
    },
    error: () => {
      if (listAccess === null) return
      listAccess = null
      activity.invalidateMemberLists()
    },
    terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || r.error === 'organization_unavailable'),
  })
  activity.hold('capabilities', capabilities)
  let historyEpoch = sync.get().historyEpoch
  let openUnavailable = false
  const stopSync = sync.subscribe(() => {
    const state = sync.get()
    if (historyEpoch !== state.historyEpoch) {
      historyEpoch = state.historyEpoch
      dms?.resetHistory()
      navigationTargets.resetHistory()
      channels.resetHistory()
    }
    if (!state.connected) activity.disconnected()
    if (state.organization === 'unavailable') return terminate()
    const id = channels.get().selectedId
    const nextUnavailable = id !== null && state.channels[id]?.state === 'unavailable'
    if (nextUnavailable !== openUnavailable) {
      openUnavailable = nextUnavailable
      channels.refreshOpen()
    }
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
    dms?.trackSelection(id)
    if (id !== null) void sync.watch(id)
  })
  void sync.start()
  void channels.load()
  return {
    sync, topics, replies, moveChain, replyCounts, unread, channels, dms, navigationTargets,
    memberListAccess,
    holdActivity: (key: string, target: ActivityTarget) => activity.hold(key, target),
    channelMembers(channel: string) {
      memberControllers.get(channel)?.close()
      const controller = createChannelMembers(organizationId, channel, r => {
        if (!r.ok && r.kind === 'http' && r.status === 401) notifyEnded()
        else if (!closed && api.isOrganizationUnavailable(r)) terminate()
      }, api, () => { void sync.channelUnavailable(channel) }, () => channels.load(), memberListAccess)
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
      navigationTargets.close(); replyCounts.close()
      stopFollowing(); stopSync(); stopMemberAccess()
      memberControllers.forEach(c => c.close()); memberControllers.clear()
      channels.close()
      dms?.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
