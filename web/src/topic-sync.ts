import * as api from './api'
import { createSync, type SyncOptions } from './sync'
import { createTopics, topicsApi, type TopicsApi } from './topics'

/** Opt-in composition for the Topic UI. Existing sync consumers keep their current history transport. */
export function createTopicSync(options: SyncOptions & { topicsApi?: TopicsApi }) {
  const transport = options.api ?? {
    listMessages: (channel: string, query?: api.ListMessagesQuery) => api.listMessages(options.organizationId ?? '', channel, query),
    sendMessage: (channel: string, body: api.SendMessageRequest) => api.sendMessage(options.organizationId ?? '', channel, body),
  }
  const sync = createSync({ ...options, api: {
    ...transport,
    listMessages: (channel, query) => sync.get().channels[channel]?.cursor === null &&
      query?.after_seq === undefined && query?.before_seq === undefined
      ? topics.bootstrap(channel) : transport.listMessages(channel, query),
  } })
  const topics = createTopics(sync, { api: options.topicsApi ?? topicsApi(options.organizationId ?? ''),
    onSessionEnded: options.onSessionEnded, requestTimeoutMs: options.requestTimeoutMs })
  return { topics, sync: { ...sync,
    replaceSession(selfId: string) { topics.replaceSession(); return sync.replaceSession(selfId) },
    async close() { topics.close(); await sync.close() },
  } }
}
