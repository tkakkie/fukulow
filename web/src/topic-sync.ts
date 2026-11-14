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
  const sync = createSync({ ...options, api: {
    ...transport,
    async listMessages(channel, query) {
      if (options.isDm?.(channel) || sync.get().channels[channel]?.cursor !== null ||
        query?.after_seq !== undefined || query?.before_seq !== undefined) return transport.listMessages(channel, query)
      const result = await topics.bootstrap(channel)
      // A direct URL may arrive before discovery has supplied the Channel kind.
      return !result.ok && result.kind === 'http' && result.error === 'dm_topics_not_allowed'
        ? transport.listMessages(channel, query) : result
    },
  } })
  const topics = createTopics(sync, { api: options.topicsApi ?? topicsApi(options.organizationId ?? ''),
    onSessionEnded: options.onSessionEnded, requestTimeoutMs: options.requestTimeoutMs, activity: options.activity })
  return { topics, sync: { ...sync,
    replaceSession(selfId: string) { topics.replaceSession(); return sync.replaceSession(selfId) },
    async close() { topics.close(); await sync.close() },
  } }
}
