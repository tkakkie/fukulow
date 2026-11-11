import { createTopicSync } from './topic-sync'
import { createUnread, unreadApi, type UnreadApi } from './unread'
import type { Topics, TopicsApi } from './topics'
import type { createSync, SyncOptions } from './sync'

/** Opt-in: pass an existing Topic/Reply composition to share its single Channel stream. */
export function createUnreadSync(options: SyncOptions & { unreadApi?: UnreadApi; topicsApi?: TopicsApi },
  composition: { sync: ReturnType<typeof createSync>; topics: Topics } = createTopicSync(options)) {
  const { sync, topics } = composition
  const unread = createUnread(sync, { topics, api: options.unreadApi ?? unreadApi(options.organizationId ?? ''),
    onSessionEnded: options.onSessionEnded, requestTimeoutMs: options.requestTimeoutMs })
  return { topics, unread, sync: { ...sync,
    replaceSession(selfId: string) { unread.replaceSession(); return sync.replaceSession(selfId) },
    async close() { unread.close(); await sync.close() },
  } }
}
