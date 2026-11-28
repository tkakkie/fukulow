import { expect, it, vi } from 'vitest'
import { makeSearchHit } from './search-test-helpers'
import { selectMainTimeline } from './topic-selectors'
import { watchWorkspaceAuthors } from './workspace-authors'

it('watches authors in projection order with the selected Channel as lookup scope', () => {
  const hit = (number: number, sender: string, topic_id: string | null = null) =>
    makeSearchHit(number, { sender, topic_id })
  const naked = hit(0, 'main')
  const summary = hit(1, 'summary', 'T')
  const searchSummary = hit(6, 'search-summary', 'T')
  const searchLine = hit(7, 'search-already-watched')
  const watch = vi.fn()
  const input = {
    topicLines: selectMainTimeline([naked.message, summary.message], [], []),
    timelineMessages: () => [naked.message, hit(2, 'timeline').message],
    topicId: (): string | null => 'T',
    routedTopicMessages: () => [hit(3, 'topic').message],
    replyMessages: () => [hit(4, 'reply').message],
    searchMessages: () => [hit(5, 'search-anchor').message],
    searchLines: () => selectMainTimeline([searchSummary.message, searchLine.message], [], []),
    isSearchOpen: () => true,
    searchHits: () => [hit(8, 'search-hit')],
    replyAnchor: () => hit(9, 'reply-anchor').message,
    authors: () => ({ watch }),
    selectedId: () => 'A',
  }
  watchWorkspaceAuthors(input)
  expect(watch).toHaveBeenCalledWith(
    ['main', 'summary', 'main', 'timeline', 'topic', 'reply', 'search-anchor', 'search-summary', 'search-hit', 'reply-anchor'],
    'A',
  )
  const searchHits = vi.fn(input.searchHits)
  const routedTopicMessages = vi.fn(input.routedTopicMessages)
  watchWorkspaceAuthors({
    ...input, isSearchOpen: () => false, searchHits, topicId: () => null, routedTopicMessages,
    replyAnchor: () => null, selectedId: () => undefined,
  })
  expect(searchHits).not.toHaveBeenCalled()
  expect(routedTopicMessages).not.toHaveBeenCalled()
  expect(watch).toHaveBeenLastCalledWith(
    ['main', 'summary', 'main', 'timeline', 'reply', 'search-anchor', 'search-summary'],
    undefined,
  )
  const selectedId = vi.fn()
  watchWorkspaceAuthors({ ...input, authors: () => undefined, selectedId })
  expect(selectedId).not.toHaveBeenCalled()
})
