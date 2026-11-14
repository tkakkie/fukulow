import type { Activity } from './activity'
import * as api from './api'
import { createSync, type SyncOptions } from './sync'
import { createTopics, topicsApi, type TopicsApi } from './topics'

/** Opt-in composition for the Topic UI. Existing sync consumers keep their current history transport. */
export function createTopicSync(options: SyncOptions & { topicsApi?: TopicsApi; activity?: Activity; isDm?(channel: string): boolean }) {
  const transport = options.api ?? {
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
      const result = await topics.bootstrap(channel)
      // Discovery can finish while the initial projection is in flight.
      if (options.isDm?.(channel)) { projected.delete(channel); return transport.listMessages(channel, query) }
      return result
    },
  } })
  const topics = createTopics(sync, { api: options.topicsApi ?? topicsApi(options.organizationId ?? ''),
    onSessionEnded: options.onSessionEnded, requestTimeoutMs: options.requestTimeoutMs, activity: options.activity })
  function resolveDm(channel: string) {
    const c = sync.get().channels[channel]
    if (!c) { projected.delete(channel); return }
    if (!projected.has(channel) || !options.isDm?.(channel) || !c.watched ||
      c.cursor === null || c.latest !== undefined || c.state === 'unavailable') return
    // A Topic bootstrap retains only W. Reload the unfiltered window without moving its cursor.
    projected.delete(channel)
    void sync.getTimeline(channel).loadLatest()
  }
  const stop = sync.subscribe(() => { for (const channel of projected) resolveDm(channel) })
  return { topics, resolveDm, sync: { ...sync,
    replaceSession(selfId: string) { projected.clear(); topics.replaceSession(); return sync.replaceSession(selfId) },
    async close() { stop(); projected.clear(); topics.close(); await sync.close() },
  } }
}
