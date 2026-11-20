import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSearchController,
  prepareSearchQuery,
  SEARCH_PAGE_SIZE,
  SEARCH_TIMEOUT_MS,
  type SearchTarget,
} from './search'
import {
  createDefaultSearchSource,
  createMockSearchSource,
  SEARCH_RANGE_DAYS,
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

  it('trims only Unicode White_Space like Rust str::trim: keeps a leading/trailing BOM, removes NEL', () => {
    expect(prepareSearchQuery('\uFEFF検索\uFEFF')).toBe('\uFEFF検索\uFEFF')
    expect(prepareSearchQuery(' \uFEFF検索 ')).toBe('\uFEFF検索')
    expect(prepareSearchQuery('\u0085\u2028検索\u2029\u00A0')).toBe('検索')
    expect(prepareSearchQuery('\uFEFF')).toBe('\uFEFF')
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

  it('returns an unavailable state in production default source and keeps search open with notice when onOpenResult declines', async () => {
    const prodSource = createDefaultSearchSource('org-1', { isDev: false })
    const prodCtrl = createSearchController({ source: prodSource })
    await prodCtrl.submit('リリース')
    expect(prodCtrl.get().open).toBe(true)
    expect(prodCtrl.get().status).toBe('unavailable')
    expect(prodCtrl.get().items).toHaveLength(0)
    expect(prodCtrl.get().retryable).toBe(false)
    prodCtrl.destroy()

    const onOpenResult = vi.fn(() => false)
    const devCtrl = createSearchController({
      source: createDefaultSearchSource('org-1', { isDev: true }),
      onOpenResult,
    })
    await devCtrl.submit('リリース')
    expect(devCtrl.get().status).toBe('results')
    const first = devCtrl.get().items[0]
    devCtrl.openSearchResult({
      channelId: first.channelId,
      topicId: first.topicId,
      replyRootId: first.replyRootId,
      messageId: first.messageId,
    })
    expect(onOpenResult).toHaveBeenCalledTimes(1)
    expect(devCtrl.get().open).toBe(true)
    expect(devCtrl.get().openNotice).toContain('開けません')
    devCtrl.destroy()
  })

  it('computes mock rangeStart as now minus 180 days from injected clock and excludes older hits', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    let nowMs = Date.parse('2026-11-20T12:00:00.000Z')
    const exactCutoffIso = new Date(nowMs - SEARCH_RANGE_DAYS * DAY_MS).toISOString()
    const items = [
      makeItem(1, { createdAt: new Date(nowMs - 1 * DAY_MS).toISOString(), excerpt: '範囲内ヒット' }),
      makeItem(2, { createdAt: exactCutoffIso, excerpt: '範囲内ヒット 境界' }),
      makeItem(3, { createdAt: new Date(nowMs - SEARCH_RANGE_DAYS * DAY_MS - 1000).toISOString(), excerpt: '範囲内ヒット 期限切れ' }),
    ]
    const source = createMockSearchSource({ items, now: () => nowMs })

    const first = await source.search({ query: '範囲内ヒット', limit: 20 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.page.rangeStart).toBe(exactCutoffIso)
    expect(first.page.items.map((item) => item.messageId)).toEqual(['msg-1', 'msg-2'])

    // Advance the clock by 10 days: rangeStart moves forward and the boundary item is now excluded.
    nowMs += 10 * DAY_MS
    const second = await source.search({ query: '範囲内ヒット', limit: 20 })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.page.rangeStart).toBe(new Date(nowMs - SEARCH_RANGE_DAYS * DAY_MS).toISOString())
    expect(second.page.items.map((item) => item.messageId)).toEqual(['msg-1'])
  })

  it('keeps mock pagination stable when the injected clock advances 1 ms past a boundary hit', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    let nowMs = Date.parse('2026-11-20T12:00:00.000Z')
    const exactCutoffIso = new Date(nowMs - SEARCH_RANGE_DAYS * DAY_MS).toISOString()
    const items = [
      makeItem(1, { createdAt: exactCutoffIso, excerpt: '境界ページング 1' }),
      makeItem(2, { createdAt: new Date(nowMs - 1 * DAY_MS).toISOString(), excerpt: '境界ページング 2' }),
    ]
    const source = createMockSearchSource({ items, now: () => nowMs })

    const page1 = await source.search({ query: '境界ページング', limit: 1 })
    expect(page1.ok).toBe(true)
    if (!page1.ok) return
    expect(page1.page.items.map((item) => item.messageId)).toEqual(['msg-1'])
    expect(page1.page.nextCursor).not.toBeNull()

    // Advancing the clock by 1 ms expires msg-1 under a fresh cutoff, but paging must not skip msg-2.
    nowMs += 1
    const page2 = await source.search({
      query: '境界ページング',
      limit: 1,
      cursor: page1.page.nextCursor!,
    })
    expect(page2.ok).toBe(true)
    if (!page2.ok) return
    expect(page2.page.items.map((item) => item.messageId)).toEqual(['msg-2'])
    expect(page2.page.nextCursor).toBeNull()
  })

  it('aborts and shows retryable timeout after 10 seconds for stalled initial and paging requests', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      let callCount = 0
      const source: SearchSource = {
        search(req) {
          callCount += 1
          if (req.signal) signals.push(req.signal)
          if (callCount === 1) {
            // Stalled initial request: never settles.
            return new Promise<SearchResponse>(() => {})
          }
          if (callCount === 2) {
            return Promise.resolve({
              ok: true,
              page: {
                items: [makeItem(1, { excerpt: 'ページ1' })],
                nextCursor: 'cursor-1',
                rangeDays: 180,
                rangeStart: '2026-05-24T00:00:00.000Z',
              },
            })
          }
          // Stalled loadMore request: never settles.
          return new Promise<SearchResponse>(() => {})
        },
      }

      const ctrl = createSearchController({ source })
      const p1 = ctrl.submit('停止クエリ')
      expect(ctrl.get().status).toBe('loading')
      expect(signals[0]?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS)
      await p1
      expect(signals[0]?.aborted).toBe(true)
      expect(ctrl.get().status).toBe('timeout')
      expect(ctrl.get().retryable).toBe(true)

      // Retry succeeds with page 1 and nextCursor.
      await ctrl.retry()
      expect(ctrl.get().status).toBe('results')
      expect(ctrl.get().items).toHaveLength(1)
      expect(ctrl.get().nextCursor).toBe('cursor-1')

      // Stalled loadMore times out after 10s, aborts, and keeps page 1 for retry.
      const pMore = ctrl.loadMore()
      expect(ctrl.get().status).toBe('loading-more')
      await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS)
      await pMore
      expect(signals[2]?.aborted).toBe(true)
      expect(ctrl.get().status).toBe('results')
      expect(ctrl.get().items).toHaveLength(1)
      expect(ctrl.get().nextCursor).toBe('cursor-1')
      expect(ctrl.get().loadMoreError).toBe('timeout')
      expect(ctrl.get().retryable).toBe(true)
      ctrl.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a stale loadMore response so it cannot append to a new query', async () => {
    const staleMore = deferred<SearchResponse>()
    const nextSearch = deferred<SearchResponse>()
    let step = 0
    const source: SearchSource = {
      search() {
        step += 1
        if (step === 1) {
          return Promise.resolve({
            ok: true,
            page: {
              items: [makeItem(1, { excerpt: '古いクエリ 1' })],
              nextCursor: 'cursor-old',
              rangeDays: 180,
              rangeStart: '2026-05-24T00:00:00.000Z',
            },
          })
        }
        if (step === 2) return staleMore.promise
        return nextSearch.promise
      },
    }

    const ctrl = createSearchController({ source })
    await ctrl.submit('古いクエリ')
    expect(ctrl.get().items.map((item) => item.messageId)).toEqual(['msg-1'])

    const pMore = ctrl.loadMore()
    const pNew = ctrl.submit('新しいクエリ')

    nextSearch.resolve({
      ok: true,
      page: {
        items: [makeItem(200, { excerpt: '新しいクエリ 1' })],
        nextCursor: null,
        rangeDays: 180,
        rangeStart: '2026-05-24T00:00:00.000Z',
      },
    })
    await pNew
    expect(ctrl.get().items.map((item) => item.messageId)).toEqual(['msg-200'])

    staleMore.resolve({
      ok: true,
      page: {
        items: [makeItem(2, { excerpt: '古いクエリ 2' })],
        nextCursor: null,
        rangeDays: 180,
        rangeStart: '2026-05-24T00:00:00.000Z',
      },
    })
    await pMore

    expect(ctrl.get().submittedQuery).toBe('新しいクエリ')
    expect(ctrl.get().items.map((item) => item.messageId)).toEqual(['msg-200'])
    expect(ctrl.get().nextCursor).toBeNull()
    ctrl.destroy()
  })
})

afterEach(() => {
  vi.useRealTimers()
})
