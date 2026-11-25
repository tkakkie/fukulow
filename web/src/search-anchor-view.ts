import type { Message, Result } from './api'
import type { SearchResultTarget } from './navigation'
import type { MainSearchDirection } from './search-main-read'
import type { MainTimelineLine } from './topic-selectors'

export const initialSearchView = (target: SearchResultTarget) => ({
  target, visit: Symbol(), status: 'loading' as 'loading' | 'ready' | 'missing' | 'error',
  lines: [] as MainTimelineLine[], messages: [] as Message[], reply: undefined as Message | undefined,
  hasOlder: false, hasNewer: false, detached: false, paging: false,
  pageError: undefined as MainSearchDirection | undefined, asOfSeq: undefined as number | undefined,
})
export type SearchAnchorView = ReturnType<typeof initialSearchView>

export const isSearchSnapshotExpired = (result: Exclude<Result<unknown>, { ok: true }>) =>
  result.kind === 'http' && result.error === 'snapshot_expired'

export const matchesSearchTarget = (target: SearchResultTarget, message: Message) =>
  message.id === target.messageId && message.created_seq === target.createdSeq &&
  message.channel_id === target.channelId && message.topic_id === (target.topicId ?? null) &&
  (!target.replyRootId || (message.reply_root_id ?? message.id) === target.replyRootId) && !message.deleted
