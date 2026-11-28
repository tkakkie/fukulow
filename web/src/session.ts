import { completeCountFields } from './unread-counts'
import { createActivity, createActivityTarget, type ActivityTarget } from './activity'
import { createNavigationTargets } from './navigation-targets'
import { createSearchAnchor, SEARCH_WINDOW_LIMIT } from './search-anchor'
import { createDefaultSearchSource } from './search-source'
import * as api from './api'
import { createChannelCreation } from './channel-creation'
import { createChannelMembers } from './channel-members'
import type { MemberListAccess } from './members'
import { createChannels, markChannelsRead, type ChannelsApi } from './channels'
import { accessOutcome } from './core-wasm'
import { createDms, dmsApi, type Dms, type DmsApi } from './dms'
import type { InitialTimeline } from './initial-timeline'
import { createMoveChain, type MoveChainApi } from './move-chain'
import { observeGeneration } from './observe-generation'
import { repliesApi, type RepliesApi } from './replies'
import { createReplyCounts, type ReplyCountsApi } from './reply-counts'
import { createReplySync } from './reply-sync'
import { createSections, sectionsApi, type SectionsApi } from './sections'
import { timelineApi, type SyncOptions } from './sync'
import { createTopicSync } from './topic-sync'
import { topicsApi, type TopicsApi } from './topics'
import { unreadApi, type UnreadApi } from './unread'
import { createUnreadSync } from './unread-sync'

export async function startInitialChannels(organizationId: string, accountSignal: AbortSignal) {
  const request = new AbortController()
  const abort = () => request.abort()
  accountSignal.addEventListener('abort', abort, { once: true })
  // Match the Channel list deadline while there is no session controller.
  const timeout = setTimeout(abort, 10_000)
  try {
    return await api.listChannels(organizationId, undefined, request.signal, undefined, markChannelsRead(['initial']))
  } finally {
    clearTimeout(timeout)
    accountSignal.removeEventListener('abort', abort)
  }
}

export function createSessionEndReporter(onEnded: () => void, accountSignal?: AbortSignal) {
  let ended = false
  return () => {
    if (ended || accountSignal?.aborted) return false
    ended = true
    onEnded()
    return true
  }
}

export type SessionOptions = {
  selfId: string
  organizationId?: string
  /** Account-lifetime owner fences this callback, including late 401s after an Organization switch. */
  onEnded: () => void
  /** Aborted by the Account owner after it fences the ended Account Session. */
  accountSignal?: AbortSignal
  channelsApi?: ChannelsApi
  /** The first ordinary Channel list may already be in flight when the core starts. */
  initialChannels?: ReturnType<typeof api.listChannels>
  initialTimeline?: InitialTimeline
  initialChannelHint?(): string | null
  topicsApi?: TopicsApi
  replyCountsApi?: ReplyCountsApi
  repliesApi?: RepliesApi
  moveChainApi?: MoveChainApi
  unreadApi?: UnreadApi
  dmsApi?: DmsApi
  sectionsApi?: SectionsApi
  initialRole?: api.Role
  initialCanCreateChannels?: boolean
  onIdentity?: (identity: api.Identity) => void
  onIdentityInvalidated?: () => void
  sync?: Partial<SyncOptions>
}

/** One Organization's controllers. Closing fences its data, while late 401s still reach the Account owner. */
export function createSession(options: SessionOptions) {
  const organizationId = options.organizationId ?? ''
  let closed = false
  let closeSections: (() => void) | undefined
  const notifyEnded = createSessionEndReporter(() => {
    closeSections?.()
    channelCreation.close()
    activity.close()
    options.onEnded()
  }, options.accountSignal)
  let unavailable = false
  let dms: Dms | undefined
  let history: ReturnType<typeof createTopicSync>['sync'] | undefined
  const reportAccess: NonNullable<SyncOptions['reportSyncAccess']> = (result, source?) => {
    if (result.ok) return
    const lifetime = options.accountSignal?.aborted ? 'replaced_session' : closed || unavailable ? 'retired_organization' : 'current'
    const outcome = accessOutcome('organization', lifetime, api.normalizedFailure(result))
    if (outcome === 'account_ended') {
      if (notifyEnded() && !closed) void source?.close()
    } else if (outcome === 'organization_unavailable') terminate()
  }
  const observeResponse = async <T>(promise: Promise<api.Result<T>>, report?: typeof reportAccess): Promise<api.Result<T>> => {
    const epoch = history?.get().historyEpoch
    const result = await promise
    report?.(result)
    if (!closed && history && (epoch === undefined || epoch === history.get().historyEpoch)) {
      if (observeGeneration(history, result) === 'stale') return { ok: false, kind: 'network' }
    } else if (result.ok && epoch !== undefined && epoch !== history?.get().historyEpoch) return { ok: false, kind: 'network' }
    return result
  }
  const observe = <T>(promise: Promise<api.Result<T>>) => observeResponse(promise, reportAccess)
  // These controllers report access through sync.reportAccess.
  const observeHistory = <T>(promise: Promise<api.Result<T>>) => observeResponse(promise)
  const channelRevokeListeners = new Set<(channelId: string) => void>()
  const activity = createActivity({
    kind: id => isDm(id) ? 'dm' : channels.isOrdinary(id) ? 'channel' : undefined,
    watched: id => sync.get().channels[id]?.subscription?.confirmed === true,
    covered: (notice, target) => {
      if (notice.type === 'channel_activity') return (unread.get(notice.channel_id).asOfSeq ?? -1) >= notice.seq
      if (notice.type !== 'read_position_changed') return false
      if ((target === 'channels' || target === 'dms')) return notice.topic_id === null && unread.activityMainCoverage(notice.channel_id) >= notice.read_seq
      if (notice.topic_id !== null) return unread.activityTopicCoverage(notice.channel_id, notice.topic_id) >= notice.read_seq
      return false
    },
    revoke: id => {
      options.initialTimeline?.discard(id)
      sections.hideChannel(id); dms?.access(id, true); channels.revoke(id); unread.activityRevoke(id); memberControllers.get(id)?.controller.unavailable()
      for (const listener of [...channelRevokeListeners]) listener(id)
    },
    access: id => { options.initialTimeline?.discard(id); dms?.access(id); unread.activityAccess(id); topics.activityAccess(id) },
    reconcile: () => unread.activityReconcile(),
    random: options.sync?.random,
  })
  const isDm = (id: string) => dms?.get().rows.some(row => row.identity.id === id) ?? false
  const source: ChannelsApi = options.channelsApi ?? {
    listChannels: (signal, readId) => api.listChannels(organizationId, undefined, signal, { history_generation: history?.get().historyGeneration }, readId),
    createChannel: body => api.createChannel(organizationId, body),
    listArchivedChannels: (signal, readId) => api.listChannels(organizationId, undefined, signal, { archived: true, history_generation: history?.get().historyGeneration }, readId),
    getChannel: (id, signal) => api.getChannel(organizationId, id, undefined, signal),
    updateChannel: (id, body) => api.updateChannel(organizationId, id, body),
  }
  const timeline = options.sync?.api ?? timelineApi(organizationId)
  const topicSource = options.topicsApi ?? topicsApi(organizationId, () => history?.get().historyGeneration)
  const replySource = options.repliesApi ?? repliesApi(organizationId)
  const unreadSource = options.unreadApi ?? unreadApi(organizationId, () => history?.get().historyGeneration)
  const topicComposition = createTopicSync({ ...options.sync, activity, selfId: options.selfId, organizationId,
    isDm, initialTimeline: options.initialTimeline,
    api: { listChannelEvents: (channel, query) => observe(timeline.listChannelEvents(channel, query)),
      listMessages: (channel, query) => observe(timeline.listMessages(channel, query)),
      sendMessage: async (channel, body) => {
        const result = await observe(timeline.sendMessage(channel, body))
        if (!closed && !unavailable) dms?.peerRefusal(channel, result)
        return result
      } },
    topicsApi: {
      listTimeline: (channel, query) => observeHistory(topicSource.listTimeline(channel, query)),
      listTopics: (channel, query, signal) => observeHistory(signal ? topicSource.listTopics(channel, query, signal) : topicSource.listTopics(channel, query)),
      getTopicSummary: (channel, topic, signal) => observeHistory(signal ? topicSource.getTopicSummary(channel, topic, signal) : topicSource.getTopicSummary(channel, topic)),
      listTopicMessages: (channel, topic, query) => observeHistory(topicSource.listTopicMessages(channel, topic, query)),
    },
    checkMembership: options.sync?.checkMembership ?? (() => observe(api.getOrganizationMe(organizationId))),
    onSessionEnded: notifyEnded,
    reportOrganizationUnavailable,
    reportSyncAccess: reportAccess,
  })
  history = topicComposition.sync
  const replyComposition = createReplySync(
    {
      ...options.sync,
      selfId: options.selfId,
      organizationId,
      repliesApi: {
        listReplyChain: (channel, anchor, query) => observeHistory(options.accountSignal
          ? replySource.listReplyChain(channel, anchor, query, options.accountSignal)
          : replySource.listReplyChain(channel, anchor, query)),
      },
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
      refreshList: !options.channelsApi ? async () => { await Promise.resolve().then(() => channels.load()) } : undefined,
      ensureList: !options.channelsApi ? async () => { await channels.ensure() } : undefined,
      refreshArchived: () => channels.refreshArchived(),
      refreshDms: () => dms?.refresh(),
      isDm,
      readTopicSummary: options.unreadApi ? undefined : topics.readTopicSummary,
      unreadApi: {
        listChannels: (signal, readId) => observeHistory(unreadSource.listChannels(signal, readId)),
        markRead: (scope, body) => observeHistory(unreadSource.markRead(scope, body)),
        getTopicSummary: (channel, topic) => observeHistory(unreadSource.getTopicSummary(channel, topic)),
      },
    },
    { sync: replyComposition.sync, topics },
  )
  const applyUnavailable = sync.unavailable
  sync.unavailable = async () => reportOrganizationUnavailable()
  const replyCounts = createReplyCounts(sync, { replies, topics }, {
    api: (channel, body, signal) => observeHistory(options.replyCountsApi ? options.replyCountsApi(channel, body, signal) : api.getReplyCounts(organizationId, channel, body, signal)),
    requestTimeoutMs: options.sync?.requestTimeoutMs, random: options.sync?.random,
  })
  const moveChain = createMoveChain(sync, replies, {
    newId: options.sync?.newId, requestTimeoutMs: options.sync?.requestTimeoutMs,
    async api(channel, anchor, body) {
      const result = await (options.moveChainApi?.(channel, anchor, body) ?? api.moveChain(organizationId, channel, anchor, body))
      reportAccess(result)
      return result
    },
  })
  const navigationTargets = createNavigationTargets({
    topic: (channel, topic) => observe(topicSource.getTopicSummary(channel, topic)),
    reply: (channel, message) => observe(replySource.listReplyChain(channel, message, { limit: 1 })),
    channelUnavailable: channel => { void sync.channelUnavailable(channel) },
  })
  const searchAnchor = createSearchAnchor(sync, {
    timeline: ({ channelId }, query, signal) => observe(topicSource.listTimeline(channelId, query, signal)),
    messages: ({ channelId, topicId }, query, signal) => observe(topicId
      ? topicSource.listTopicMessages(channelId, topicId, query, signal)
      : timeline.listMessages(channelId, query, signal)),
    reply: ({ channelId, messageId }, query, signal) => {
      const account = options.accountSignal
      const combined = account && signal ? AbortSignal.any([account, signal]) : account ?? signal
      return observe(replySource.listReplyChain(channelId, messageId, query, combined))
    },
  })
  const stopSearchBudget = searchAnchor.subscribe(() => {
    const view = searchAnchor.get()
    const target = view?.status === 'missing' || view?.target.replyRootId ? undefined : view?.target
    topics.reserveSearch(target?.channelId, target?.topicId ? 'topic' : 'main', target ? SEARCH_WINDOW_LIMIT : 0)
  })
  let watched: string | null = null
  const { listArchivedChannels, getChannel, updateChannel } = source
  let initialChannels = options.initialChannels
  const readChannels = (signal?: AbortSignal, readId?: string) => options.channelsApi ? source.listChannels(signal, readId) : unreadSource.listChannels(signal, readId)
  function listChannels(signal?: AbortSignal, readId?: string) {
    const initial = initialChannels
    initialChannels = undefined
    return observe(initial ? initial.then(result => {
      if (signal?.aborted && result.ok) return { ok: false, kind: 'network' } as const
      const generation = sync.get().historyGeneration
      // An unversioned startup response cannot supersede a generation learned while it was in flight.
      if (result.ok && generation !== undefined && result.data.history_generation !== generation) return readChannels(signal, markChannelsRead(['reconcile']))
      return result
    }) : readChannels(signal, readId))
  }
  const hasUnread = (row: api.Channel): row is api.UnreadChannel => 'as_of_seq' in row && completeCountFields(row)
  const channels = createChannels(
    {
      listChannels,
      createChannel: body => observe(source.createChannel(body)),
      listArchivedChannels: listArchivedChannels && ((signal, readId) => observe(listArchivedChannels(signal, readId))),
      getChannel: getChannel && ((id, signal) => observe(getChannel(id, signal))),
      updateChannel: updateChannel && (async (id, body) => {
        const result = await updateChannel(id, body)
        reportAccess(result)
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
      const baselines = rows.filter(hasUnread)
      if (baselines.length || rows.length === 0) unread.activitySnapshot(baselines)
    },
    {
      initialHint: options.initialChannelHint,
      canOpen: id => !isDm(id) && sync.get().channels[id]?.state !== 'unavailable',
      verifyOrdinary: (id, signal) => observe(topicSource.listTopics(id, { limit: 1 }, signal)),
      unavailable: id => { void sync.channelUnavailable(id) },
      onOpen: channel => unread.activityArchive(channel.id, channel.archived),
      onArchivedSnapshot: rows => {
        const active = new Set(channels.get().channels.map(c => c.id))
        unread.activityArchivedSnapshot(rows.filter(row => !active.has(row.id)))
      },
      connectionEpoch: () => {
        if (initialChannels !== undefined) return null
        const state = sync.get()
        return state.connected && state.connection !== null ? state.connection : null
      },
      coversUnread: rows => rows.every(row => !hasUnread(row) || unread.activityCoversListBaseline(row)),
      hasInitialChannels: () => initialChannels !== undefined,
    },
  )
  const channelCreation = createChannelCreation(options.initialCanCreateChannels ?? false, channels.create)
  const sections = createSections({
    api: options.sectionsApi ?? sectionsApi(organizationId), activity, list: channels.authorizedList, observeAccess: reportAccess,
    random: options.sync?.random, timeoutMs: options.sync?.requestTimeoutMs,
  })
  closeSections = sections.close
  const dmSource = options.dmsApi ?? dmsApi(organizationId)
  dms = createDms({ api: {
    list: (query, signal) => observe(dmSource.list({ history_generation: history?.get().historyGeneration, ...query }, signal)),
    changes: (query, signal) => observe(dmSource.changes(query, signal)),
    open: (body, signal) => observe(dmSource.open(body, signal)),
  }, activity, watched: id => sync.get().channels[id]?.subscription?.confirmed === true,
  waitForReady: true,
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
    // Subscribe rechecks Channel access (C9) and Organization Membership (C10) after the startup snapshot.
    if (notice.type === 'activity_ready') { dms?.ready(); sections.ready() }
    if (notice.type === 'read_position_changed') {
      unread.activityRead(notice.channel_id, notice.topic_id, notice.read_seq, true)
    }
    activity.notice(notice)
  })
  function retireOrganization() {
    if (closed || unavailable) return false
    unavailable = true
    channelCreation.close()
    activity.close(); capabilities.close()
    channels.close()
    sections.close()
    dms?.close()
    return true
  }
  function terminate() {
    if (retireOrganization()) return applyUnavailable()
  }
  // Socket and selection reports enter through sync before the Organization controllers retire.
  function reportOrganizationUnavailable(apply = applyUnavailable) {
    if (!closed && !unavailable && sync.get().organization === 'available') return apply()
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
      channelCreation.confirm(identity.organization.capabilities.can_create_channels.allowed)
    },
    hide: reason => {
      if (listAccess !== null) listAccess = listAccess === 'guest' ? null : 'revalidating'
      options.onIdentityInvalidated?.()
      channelCreation.invalidate(reason)
    },
    error: () => {
      options.onIdentityInvalidated?.()
      channelCreation.failed()
      if (listAccess === null) return
      listAccess = null
      activity.invalidateMemberLists()
    },
    terminal: r => !r.ok && accessOutcome('capabilities', 'current', api.normalizedFailure(r)) !== 'local_outcome',
  })
  activity.hold('capabilities', capabilities)
  let historyEpoch = sync.get().historyEpoch
  let connection = sync.get().connection, connected = sync.get().connected
  let openUnavailable = false
  const stopSync = sync.subscribe(() => {
    const state = sync.get()
    if ((connection !== null && connection !== state.connection) || (connected && !state.connected)) sections.disconnected()
    connection = state.connection; connected = state.connected
    if (historyEpoch !== state.historyEpoch) {
      historyEpoch = state.historyEpoch
      dms?.resetHistory()
      navigationTargets.resetHistory()
      channels.resetHistory()
    }
    if (!state.connected) activity.disconnected()
    if (state.organization === 'unavailable') { retireOrganization(); return }
    const id = channels.get().selectedId
    const nextUnavailable = id !== null && state.channels[id]?.state === 'unavailable'
    if (nextUnavailable !== openUnavailable) {
      openUnavailable = nextUnavailable
      channels.refreshOpen()
    }
  })
  type MemberEntry = { controller: ReturnType<typeof createChannelMembers>; lost: boolean; release?: () => void }
  const memberControllers = new Map<string, MemberEntry>()
  function holdMembers(id: string, entry: MemberEntry) {
    entry.release?.()
    entry.release = activity.hold(`channel-members:${id}`, entry.controller.activityTarget)
  }
  function releaseMembers(id: string, controller: ReturnType<typeof createChannelMembers>) {
    const entry = memberControllers.get(id)
    if (entry?.controller !== controller) return
    memberControllers.delete(id)
    entry.release?.()
    entry.release = undefined
  }
  const stopMemberAccess = sync.subscribe(() => {
    for (const [id, entry] of [...memberControllers]) {
      if (memberControllers.get(id) !== entry) continue
      const lost = sync.get().organization === 'unavailable' || sync.get().channels[id]?.state === 'unavailable'
      const wasLost = entry.lost
      entry.lost = lost
      if (lost) {
        entry.release?.()
        entry.release = undefined
        entry.controller.unavailable()
      } else if (wasLost) {
        holdMembers(id, entry)
        entry.controller.reselect()
      }
    }
  })
  const stopFollowing = channels.subscribe(() => {
    const id = channels.get().selectedId
    if (id === watched) return
    options.initialTimeline?.select(id)
    if (watched !== null) void sync.unwatch(watched)
    watched = id
    dms?.trackSelection(id)
    if (id !== null) void sync.watch(id)
  })
  const searchSource = createDefaultSearchSource(organizationId, {
    onEnded: notifyEnded,
    onUnavailable: terminate,
  })
  void sync.start()
  void channels.ensure()
  sections.hold()
  return {
    sync, topics, replies, moveChain, replyCounts, unread, channels, channelCreation, sections, dms, navigationTargets, searchAnchor, searchSource,
    memberListAccess,
    onChannelRevoked(listener: (channelId: string) => void) {
      channelRevokeListeners.add(listener)
      return () => { channelRevokeListeners.delete(listener) }
    },
    holdActivity: (key: string, target: ActivityTarget) => activity.hold(key, target),
    channelMembers(channel: string) {
      memberControllers.get(channel)?.controller.close()
      const controller = createChannelMembers(organizationId, channel, reportAccess,
        api, () => { void sync.channelUnavailable(channel) }, () => channels.load(), memberListAccess)
      const rawClose = controller.close
      const managed: ReturnType<typeof createChannelMembers> = {
        ...controller,
        close() {
          releaseMembers(channel, managed)
          rawClose()
        },
      }
      if (closed) {
        rawClose()
        return managed
      }
      const lost = sync.get().organization === 'unavailable' || sync.get().channels[channel]?.state === 'unavailable'
      const entry: MemberEntry = { controller: managed, lost }
      memberControllers.set(channel, entry)
      if (lost) managed.unavailable()
      else {
        holdMembers(channel, entry)
        void managed.load()
        void channels.load()
      }
      return managed
    },
    close() {
      closed = true
      channelCreation.close()
      stopActivity(); activity.close(); capabilities.close()
      navigationTargets.close(); replyCounts.close()
      stopSearchBudget(); searchAnchor.close()
      stopFollowing(); stopSync(); stopMemberAccess()
      for (const { controller } of [...memberControllers.values()]) controller.close()
      memberControllers.clear()
      channelRevokeListeners.clear()
      channels.close()
      sections.close()
      dms?.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
