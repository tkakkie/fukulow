import { createSync, type SyncOptions } from './sync'
import { createReplies, repliesApi, type RepliesApi } from './replies'

/** Opt-in Reply composition; also accepts createTopicSync so a Topic and its chain share one Channel stream. */
export function createReplySync(options: SyncOptions & { repliesApi?: RepliesApi }, sync = createSync(options)) {
  const replies = createReplies(sync, { api: options.repliesApi ?? repliesApi(options.organizationId ?? ''),
    onSessionEnded: options.onSessionEnded, requestTimeoutMs: options.requestTimeoutMs })
  return { replies, sync: { ...sync,
    replaceSession(selfId: string) { replies.replaceSession(); return sync.replaceSession(selfId) },
    async close() { replies.close(); await sync.close() },
  } }
}
