import type { Activity } from './activity'
import * as api from './api'
import type { InitialTimeline } from './initial-timeline'
import { createSync, type SyncOptions } from './sync'
import { createTopics, topicsApi, type TopicsApi } from './topics'

/** Opt-in composition for the Topic UI. Existing sync consumers keep their current history transport. */
export function createTopicSync(options: SyncOptions & { topicsApi?: TopicsApi; activity?: Activity; isDm?(channel: string): boolean; initialTimeline?: InitialTimeline }) {
  const transport = options.api ?? {
    listChannelEvents: (channel: string, query: api.ListChannelEventsQuery) => api.listChannelEvents(options.organizationId ?? '', channel, query),
    listMessages: (channel: string, query?: api.ListMessagesQuery) => api.listMessages(options.organizationId ?? '', channel, query),
    sendMessage: (channel: string, body: api.SendMessageRequest) => api.sendMessage(options.organizationId ?? '', channel, body),
  }
  const projected = new Set<string>()
  const sync = createSync({ ...options, api: {
    ...transport,
    async listMessages(channel, query) {
      if (options.isDm?.(channel) || sync.get().channels[channel]?.cursor !== null ||
        query?.after_seq !== undefined || query?.before_seq !== undefined) return transport.listMessages(channel, query)
      if (options.isDm) projected.add(channel)
      const request = sync.get().channels[channel]?.latest
      const result = await topics.bootstrap(channel)
      // Discovery can finish while the initial projection is in flight.
      if (options.isDm?.(channel)) {
        projected.delete(channel)
        return sync.get().channels[channel]?.latest === request ? transport.listMessages(channel, query) : { ok: false, kind: 'network' }
      }
      return result
    },
  } })
  const topics = createTopics(sync, { api: options.topicsApi ?? topicsApi(options.organizationId ?? ''),
    requestTimeoutMs: options.requestTimeoutMs, activity: options.activity,
    initialTimeline: options.initialTimeline, isDm: options.isDm })
  function resolveDm(channel: string) {
    if (options.isDm?.(channel)) options.initialTimeline?.discard(channel)
    const c = sync.get().channels[channel]
    if (!c) { projected.delete(channel); return }
    if (!projected.has(channel) || !options.isDm?.(channel) || !c.watched ||
      c.cursor === null || c.latest !== undefined || c.state === 'unavailable') return
    // A Topic bootstrap retains only W. Reload the unfiltered window without moving its cursor.
    projected.delete(channel)
    void sync.getTimeline(channel).loadLatest()
  }
  let previous = sync.get()
  const stop = sync.subscribe(changed => {
    const state = sync.get()
    if (options.initialTimeline) {
      if (!state.running || state.organization === 'unavailable' || state.historyEpoch !== previous.historyEpoch ||
        (previous.connection !== null && state.connection !== previous.connection)) options.initialTimeline.discard()
      for (const channel of changed) {
        const old = previous.channels[channel], next = state.channels[channel]
        if (!next || !next.watched || next.state === 'unavailable' ||
          (old?.latest !== undefined && old.latest !== next.latest) ||
          (old && old.versionEpoch !== next.versionEpoch)) options.initialTimeline.discard(channel)
      }
    }
    previous = state
    for (const channel of projected) resolveDm(channel)
  })
  return { topics, resolveDm, sync: { ...sync,
    replaceSession(selfId: string) { options.initialTimeline?.discard(); projected.clear(); topics.replaceSession(); return sync.replaceSession(selfId) },
    async close() { options.initialTimeline?.discard(); stop(); projected.clear(); topics.close(); await sync.close() },
  } }
}
