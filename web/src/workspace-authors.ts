import type { Message, SearchHit } from './api'
import type { createAuthors } from './authors'
import type { MainTimelineLine } from './topic-selectors'

export function watchWorkspaceAuthors(input: {
  topicLines: readonly MainTimelineLine[] | undefined
  timelineMessages: () => readonly Message[] | undefined
  topicId: () => string | null | undefined
  routedTopicMessages: (topicId: string) => readonly Message[] | undefined
  replyMessages: () => readonly Message[] | undefined
  searchMessages: () => readonly Message[] | undefined
  searchLines: () => readonly MainTimelineLine[] | undefined
  isSearchOpen: () => boolean
  searchHits: () => readonly SearchHit[] | undefined
  replyAnchor: () => Message | null
  authors: () => Pick<ReturnType<typeof createAuthors>, 'watch'> | undefined
  selectedId: () => string | undefined
}) {
  const ids: string[] = []
  for (const line of input.topicLines ?? []) {
    ids.push(line.kind === 'message' ? line.message.sender : line.latestMessage.sender)
  }
  for (const message of input.timelineMessages() ?? []) ids.push(message.sender)
  const topicId = input.topicId()
  if (topicId) {
    for (const message of input.routedTopicMessages(topicId) ?? []) ids.push(message.sender)
  }
  for (const message of input.replyMessages() ?? []) ids.push(message.sender)
  for (const message of input.searchMessages() ?? []) ids.push(message.sender)
  for (const line of input.searchLines() ?? []) if (line.kind === 'topic') ids.push(line.latestMessage.sender)
  if (input.isSearchOpen()) {
    for (const hit of input.searchHits() ?? []) ids.push(hit.message.sender)
  }
  const replyAnchor = input.replyAnchor()
  if (replyAnchor) ids.push(replyAnchor.sender)
  input.authors()?.watch(ids, input.selectedId())
}
