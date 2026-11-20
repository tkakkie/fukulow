import { describe, expect, it, vi } from 'vitest'
import { createSearchController, prepareSearchQuery, SEARCH_PAGE_SIZE, type SearchTarget } from './search'
import {
  createMockSearchSource,
  type SearchRequest,
  type SearchResponse,
  type SearchResultItem,
  type SearchSource,
} from './search-source'
import { createSync } from './sync'
import { deferred } from './unread-test-helpers'

function makeItem(index: number, overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    messageId: `msg-${index}`,
    channelId: 'ch-1',
    topicId: null,
    replyRootId: null,
    context: { kind: 'channel', channelId: 'ch-1', channelName: 'general' },
    authorName: '田中 美咲',
    authorActive: true,
    createdAt: `2026-11-${String(20 - (index % 19)).padStart(2, '0')}T10:00:00.000Z`,
    excerpt: `検索テスト本文 ${index}`,
    ...overrides,
  }
}

describe('prepareSearchQuery', () => {
  it('trims leading/trailing whitespace, keeps internal whitespace, and leaves normalization and wildcard chars untouched', () => {
    expect(prepareSearchQuery('  \t　リリース  準備　\n ')).toBe('リリース  準備')
    expect(prepareSearchQuery('  100% _test_ \\path\\  ')).toBe('100% _test_ \\path\\')
    // NFD string ("か" + combining dakuten) and uppercase ASCII stay as typed; server normalizes.
    const nfd = 'か\u3099 AbC'
    expect(prepareSearchQuery(` ${nfd} `)).toBe(nfd)
    expect(prepareSearchQuery('   \u3000\t  ')).toBe('')
  })
})

describe('createSearchController', () => {
  it('submits trimmed query without mutating internal whitespace or %, _, \\ and ignores whitespace-only queries', async () => {
    const requests: SearchRequest[] = []
    const source: SearchSource = {
      async search(req) {
        requests.push(req)
        return {
          ok: true,
          page: { items: [], nextCursor: null, rangeDays: 180, rangeStart: '2026-05-24T00:00:00.000Z' },
        }
      },
    }
    const ctrl = createSearchController({ source })
    await ctrl.submit('   \u3000  ')
    expect(requests).toHaveLength(0)
    expect(ctrl.get().open).toBe(false)
    expect(ctrl.get().status).toBe('idle')

    await ctrl.submit('  100%   _a_\\b  ')
    expect(requests).toHaveLength(1)
    expect(requests[0].query).toBe('100%   _a_\\b')
    expect(requests[0].limit).toBe(SEARCH_PAGE_SIZE)
    expect(requests[0].cursor).toBeUndefined()
    expect(ctrl.get().submittedQuery).toBe('100%   _a_\\b')
    ctrl.destroy()
  })

  it('pages 20 results at a time using an opaque cursor and preserves loaded items on loadMore failure', async () => {
    const items = Array.from({ length: 25 }, (_, i) => makeItem(i + 1, { excerpt: `共通キーワード ${i + 1}` }))
    const mock = createMockSearchSource({ items, rangeStart: '2026-05-24T00:00:00.000Z' })
    const calls: SearchRequest[] = []
    let failNextLoadMore: SearchResponse | null = null
    const source: SearchSource = {
      async search(req) {
        calls.push(req)
        if (req.cursor && failNextLoadMore) {
          const res = failNextLoadMore
          failNextLoadMore = null
          return res
        }
        return mock.search(req)
      },
    }

    const ctrl = createSearchController({ source })
    await ctrl.submit('共通キーワード')

    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items).toHaveLength(20)
    expect(ctrl.get().items[0].messageId).toBe('msg-1')
    expect(ctrl.get().nextCursor).toBe('mock:20')
    expect(ctrl.get().rangeStart).toBe('2026-05-24T00:00:00.000Z')

    // Load-more timeout preserves already loaded items and keeps cursor for retry.
    failNextLoadMore = { ok: false, failure: { kind: 'timeout' } }
    await ctrl.loadMore()
    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items).toHaveLength(20)
    expect(ctrl.get().nextCursor).toBe('mock:20')
    expect(ctrl.get().loadMoreError).toBe('timeout')

    // Retry loads page 2 using the opaque cursor and appends remaining 5 items.
    await ctrl.retry()
    expect(calls[calls.length - 1].cursor).toBe('mock:20')
    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items).toHaveLength(25)
    expect(ctrl.get().items[24].messageId).toBe('msg-25')
    expect(ctrl.get().nextCursor).toBeNull()
    expect(ctrl.get().loadMoreError).toBeNull()

    // Further loadMore is a no-op once exhausted.
    const countBefore = calls.length
    await ctrl.loadMore()
    expect(calls.length).toBe(countBefore)
    ctrl.destroy()
  })

  it('transitions cleanly through loading, empty, too-short, timeout, and error states and drops stale responses', async () => {
    const first = deferred<SearchResponse>()
    const second = deferred<SearchResponse>()
    const queue = [
      () => first.promise,
      () => second.promise,
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'too_short', minLength: 2 } }),
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'timeout' } }),
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'error', retryable: true } }),
    ]
    const source: SearchSource = {
      search: () => queue.shift()!(),
    }

    const ctrl = createSearchController({ source })
    const p1 = ctrl.submit('最初の検索')
    expect(ctrl.get().status).toBe('loading')
    expect(ctrl.get().open).toBe(true)

    // Supersede first in-flight request with a second search.
    const p2 = ctrl.submit('次の検索')
    first.resolve({
      ok: true,
      page: { items: [makeItem(99)], nextCursor: null, rangeDays: 180, rangeStart: '2026-05-24T00:00:00.000Z' },
    })
    await p1
    // Stale response must be ignored while second is still loading.
    expect(ctrl.get().status).toBe('loading')
    expect(ctrl.get().items).toHaveLength(0)

    second.resolve({
      ok: true,
      page: { items: [], nextCursor: null, rangeDays: 180, rangeStart: '2026-05-24T00:00:00.000Z' },
    })
    await p2
    expect(ctrl.get().status).toBe('empty')
    expect(ctrl.get().rangeStart).toBe('2026-05-24T00:00:00.000Z')

    await ctrl.submit('あ')
    expect(ctrl.get().status).toBe('too-short')
    expect(ctrl.get().minLength).toBe(2)
    expect(ctrl.get().retryable).toBe(false)

    await ctrl.submit('重い検索')
    expect(ctrl.get().status).toBe('timeout')
    expect(ctrl.get().retryable).toBe(true)

    await ctrl.retry()
    expect(ctrl.get().status).toBe('error')
    expect(ctrl.get().retryable).toBe(true)
    ctrl.destroy()
  })

  it('closes search and invokes openSearchResult(target) with channel, optional topic, optional replyRootId, and messageId', async () => {
    const onOpenResult = vi.fn()
    const ctrl = createSearchController({ source: createMockSearchSource(), onOpenResult })
    await ctrl.submit('リリース')
    expect(ctrl.get().open).toBe(true)

    const target: SearchTarget = {
      channelId: 'general',
      topicId: 'topic-release',
      replyRootId: 'root-1',
      messageId: 'mock-msg-1',
    }
    ctrl.openSearchResult(target)
    expect(ctrl.get().open).toBe(false)
    expect(onOpenResult).toHaveBeenCalledTimes(1)
    expect(onOpenResult).toHaveBeenCalledWith(target)
    ctrl.destroy()
  })

  it('never touches or advances any sync cursor when searching or paging results', async () => {
    const listMessages = vi.fn(async () => ({
      ok: true as const,
      data: {
        history_generation: '00000000-0000-4000-8000-000000000515',
        as_of_seq: 10,
        messages: [],
        has_more: false,
      },
    }))
    const sync = createSync({
      selfId: 'me',
      connect: () => ({ send: () => {}, close: () => {} }),
      api: {
        listChannelEvents: async () => ({ ok: false, kind: 'network' }),
        listMessages,
        sendMessage: async () => ({ ok: false, kind: 'network' }),
      },
    })
    await sync.start()
    await sync.watch('ch-1')
    const syncSnapshotBefore = sync.get()
    const channelBefore = syncSnapshotBefore.channels['ch-1']
    const syncNotified = vi.fn()
    sync.subscribe(syncNotified)

    const items = Array.from({ length: 22 }, (_, i) => makeItem(i + 1, { channelId: 'ch-1', excerpt: `議事録 ${i + 1}` }))
    const search = createSearchController({ source: createMockSearchSource({ items }) })
    await search.submit('議事録')
    await search.loadMore()

    expect(search.get().items).toHaveLength(22)
    expect(syncNotified).not.toHaveBeenCalled()
    expect(sync.get()).toBe(syncSnapshotBefore)
    expect(sync.get().channels['ch-1']).toBe(channelBefore)
    expect(listMessages).toHaveBeenCalledTimes(1)

    search.destroy()
    await sync.close()
  })
})
