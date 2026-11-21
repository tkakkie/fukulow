import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchMessages, type SearchPage } from './api'
import {
  createSearchController,
  prepareSearchQuery,
  SEARCH_TIMEOUT_MS,
  type SearchTarget,
} from './search'
import {
  createDefaultSearchSource,
  type SearchRequest,
  type SearchResponse,
  type SearchSource,
} from './search-source'
import { createMockSearchSource, makeSearchHit } from './search-test-helpers'
import { createSync } from './sync'
import { deferred } from './unread-test-helpers'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
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

describe('createDefaultSearchSource', () => {
  it('calls GET /api/v1/orgs/{org}/search with query, channel_id, cursor, and signal and returns the SearchPage', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const page: SearchPage = {
      hits: [makeSearchHit(1, { body: 'リリース手順' })],
      next_cursor: 'opaque-cursor-1',
    }
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return jsonResponse(200, page)
    }
    const source = createDefaultSearchSource('org-1', {
      searchApi: (org, query, _f, signal) => searchMessages(org, query, fakeFetch, signal),
    })

    const ac = new AbortController()
    const res = await source.search({
      q: 'リリース 100%',
      channel_id: 'ch-1',
      cursor: 'opaque-cursor-0',
      signal: ac.signal,
    })

    expect(res).toEqual({ ok: true, page })
    expect(calls).toHaveLength(1)
    const parsed = new URL(calls[0].url, 'http://localhost')
    expect(parsed.pathname).toBe('/api/v1/orgs/org-1/search')
    expect(parsed.searchParams.get('q')).toBe('リリース 100%')
    expect(parsed.searchParams.get('channel_id')).toBe('ch-1')
    expect(parsed.searchParams.get('cursor')).toBe('opaque-cursor-0')
    expect(calls[0].init?.signal).toBe(ac.signal)
    expect(calls[0].init?.cache).toBe('no-store')
  })

  it('maps unavailable, too_short, timeout, rate_limited, shutting_down, invalid_cursor, too_long, 404, and 401', async () => {
    const onEnded = vi.fn()
    const onUnavailable = vi.fn()
    const responses: Response[] = [
      jsonResponse(503, { error: 'search_unavailable' }),
      jsonResponse(400, { error: 'search_query_too_short' }),
      jsonResponse(503, { error: 'search_timeout' }),
      jsonResponse(429, { error: 'search_rate_limited' }),
      jsonResponse(503, { error: 'shutting_down' }, { 'Retry-After': '2' }),
      jsonResponse(400, { error: 'search_query_too_long' }),
      jsonResponse(400, { error: 'invalid_cursor' }),
      jsonResponse(404, { error: 'channel_not_found' }),
      jsonResponse(404, { error: 'organization_unavailable' }),
      jsonResponse(401, { error: 'unauthorized' }),
    ]
    const fakeFetch: typeof fetch = async () => responses.shift()!
    const source = createDefaultSearchSource('org-1', {
      searchApi: (org, query, _f, signal) => searchMessages(org, query, fakeFetch, signal),
      onEnded,
      onUnavailable,
    })

    expect(await source.search({ q: 'テスト' })).toEqual({
      ok: false,
      failure: { kind: 'unavailable' },
    })
    expect(await source.search({ q: 'あ' })).toEqual({
      ok: false,
      failure: { kind: 'too_short', minLength: 2 },
    })
    expect(await source.search({ q: '重い' })).toEqual({
      ok: false,
      failure: { kind: 'timeout' },
    })
    expect(await source.search({ q: '連続' })).toEqual({
      ok: false,
      failure: { kind: 'error', retryable: true },
    })
    expect(await source.search({ q: '停止中' })).toEqual({
      ok: false,
      failure: { kind: 'error', retryable: true },
    })
    expect(await source.search({ q: '長すぎ' })).toEqual({
      ok: false,
      failure: { kind: 'error', retryable: false },
    })
    expect(await source.search({ q: 'テスト', cursor: 'bad' })).toEqual({
      ok: false,
      failure: { kind: 'invalid_cursor' },
    })
    expect(await source.search({ q: 'テスト', channel_id: 'hidden' })).toEqual({
      ok: false,
      failure: { kind: 'error', retryable: false },
    })
    expect(onUnavailable).not.toHaveBeenCalled()

    expect(await source.search({ q: 'テスト' })).toEqual({
      ok: false,
      failure: { kind: 'error', retryable: false },
    })
    expect(onUnavailable).toHaveBeenCalledTimes(1)

    expect(await source.search({ q: 'テスト' })).toEqual({
      ok: false,
      failure: { kind: 'error', retryable: false },
    })
    expect(onEnded).toHaveBeenCalledTimes(1)
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
          page: { hits: [], next_cursor: null },
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
    expect(requests[0].q).toBe('100%   _a_\\b')
    expect(requests[0].cursor).toBeUndefined()
    expect(ctrl.get().submittedQuery).toBe('100%   _a_\\b')
    ctrl.destroy()
  })

  it('pages results using an opaque cursor, never treats a short page with next_cursor as the end, and preserves loaded items on loadMore failure', async () => {
    const hits = Array.from({ length: 25 }, (_, i) => makeSearchHit(i + 1, { body: `共通キーワード ${i + 1}` }))
    const mock = createMockSearchSource({ hits })
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
    expect(ctrl.get().items[0].message.id).toBe('msg-1')
    expect(ctrl.get().nextCursor).toBe('mock:20')

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
    expect(ctrl.get().items[24].message.id).toBe('msg-25')
    expect(ctrl.get().nextCursor).toBeNull()
    expect(ctrl.get().loadMoreError).toBeNull()

    // Further loadMore is a no-op once exhausted.
    const countBefore = calls.length
    await ctrl.loadMore()
    expect(calls.length).toBe(countBefore)
    ctrl.destroy()
  })

  it('keeps loading by cursor when a page has fewer than 20 hits (even 0) with a non-null next_cursor', async () => {
    const pages: SearchPage[] = [
      { hits: [], next_cursor: 'cur-1' },
      { hits: [makeSearchHit(1, { body: '短いページ' })], next_cursor: 'cur-2' },
      { hits: [makeSearchHit(2, { body: '最終ページ' })], next_cursor: null },
    ]
    const cursors: (string | undefined)[] = []
    const source: SearchSource = {
      async search(req) {
        cursors.push(req.cursor)
        return { ok: true, page: pages.shift()! }
      },
    }

    const ctrl = createSearchController({ source })
    await ctrl.submit('ページ')
    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items).toHaveLength(0)
    expect(ctrl.get().nextCursor).toBe('cur-1')

    await ctrl.loadMore()
    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['msg-1'])
    expect(ctrl.get().nextCursor).toBe('cur-2')

    await ctrl.loadMore()
    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['msg-1', 'msg-2'])
    expect(ctrl.get().nextCursor).toBeNull()
    expect(cursors).toEqual([undefined, 'cur-1', 'cur-2'])
    ctrl.destroy()
  })

  it('transitions cleanly through loading, empty, too-short, timeout, unavailable, and error states and drops stale responses', async () => {
    const first = deferred<SearchResponse>()
    const second = deferred<SearchResponse>()
    const queue = [
      () => first.promise,
      () => second.promise,
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'too_short', minLength: 2 } }),
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'timeout' } }),
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'error', retryable: true } }),
      async (): Promise<SearchResponse> => ({ ok: false, failure: { kind: 'unavailable' } }),
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
      page: { hits: [makeSearchHit(99)], next_cursor: null },
    })
    await p1
    // Stale response must be ignored while second is still loading.
    expect(ctrl.get().status).toBe('loading')
    expect(ctrl.get().items).toHaveLength(0)

    second.resolve({
      ok: true,
      page: { hits: [], next_cursor: null },
    })
    await p2
    expect(ctrl.get().status).toBe('empty')

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

    await ctrl.submit('無効検索')
    expect(ctrl.get().status).toBe('unavailable')
    expect(ctrl.get().retryable).toBe(false)
    ctrl.destroy()
  })

  it('closes search and forwards the target and creation sequence to openSearchResult', async () => {
    const onOpenResult = vi.fn()
    const ctrl = createSearchController({ source: createMockSearchSource(), onOpenResult })
    await ctrl.submit('リリース')
    expect(ctrl.get().open).toBe(true)

    const target: SearchTarget = {
      channelId: 'general',
      topicId: 'topic-release',
      replyRootId: 'root-1',
      messageId: 'mock-msg-1',
      createdSeq: 3,
    }
    ctrl.openSearchResult(target)
    expect(ctrl.get().open).toBe(false)
    expect(onOpenResult).toHaveBeenCalledTimes(1)
    expect(onOpenResult).toHaveBeenCalledWith(target)
    ctrl.destroy()
  })

  it('keeps search open with notice when onOpenResult declines', async () => {
    const onOpenResult = vi.fn(() => false)
    const ctrl = createSearchController({
      source: createMockSearchSource(),
      onOpenResult,
    })
    await ctrl.submit('リリース')
    expect(ctrl.get().status).toBe('results')
    const first = ctrl.get().items[0]
    ctrl.openSearchResult({
      channelId: first.message.channel_id,
      topicId: first.message.topic_id,
      replyRootId: first.message.reply_root_id,
      messageId: first.message.id,
      createdSeq: first.message.created_seq,
    })
    expect(onOpenResult).toHaveBeenCalledTimes(1)
    expect(ctrl.get().open).toBe(true)
    expect(ctrl.get().openNotice).toContain('開けません')
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

    const hits = Array.from({ length: 22 }, (_, i) => makeSearchHit(i + 1, { channel_id: 'ch-1', body: `議事録 ${i + 1}` }))
    const search = createSearchController({ source: createMockSearchSource({ hits }) })
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
            return new Promise<SearchResponse>(() => {})
          }
          if (callCount === 2) {
            return Promise.resolve({
              ok: true,
              page: {
                hits: [makeSearchHit(1, { body: 'ページ1' })],
                next_cursor: 'cursor-1',
              },
            })
          }
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

      await ctrl.retry()
      expect(ctrl.get().status).toBe('results')
      expect(ctrl.get().items).toHaveLength(1)
      expect(ctrl.get().nextCursor).toBe('cursor-1')

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
              hits: [makeSearchHit(1, { body: '古いクエリ 1' })],
              next_cursor: 'cursor-old',
            },
          })
        }
        if (step === 2) return staleMore.promise
        return nextSearch.promise
      },
    }

    const ctrl = createSearchController({ source })
    await ctrl.submit('古いクエリ')
    expect(ctrl.get().items.map((item) => item.message.id)).toEqual(['msg-1'])

    const pMore = ctrl.loadMore()
    const pNew = ctrl.submit('新しいクエリ')

    nextSearch.resolve({
      ok: true,
      page: {
        hits: [makeSearchHit(200, { body: '新しいクエリ 1' })],
        next_cursor: null,
      },
    })
    await pNew
    expect(ctrl.get().items.map((item) => item.message.id)).toEqual(['msg-200'])

    staleMore.resolve({
      ok: true,
      page: {
        hits: [makeSearchHit(2, { body: '古いクエリ 2' })],
        next_cursor: null,
      },
    })
    await pMore

    expect(ctrl.get().submittedQuery).toBe('新しいクエリ')
    expect(ctrl.get().items.map((item) => item.message.id)).toEqual(['msg-200'])
    expect(ctrl.get().nextCursor).toBeNull()
    ctrl.destroy()
  })

  it('clears nextCursor on invalid_cursor and lets retry restart the submitted query from page one', async () => {
    const calls: SearchRequest[] = []
    let step = 0
    const source: SearchSource = {
      async search(req) {
        calls.push(req)
        step += 1
        if (step === 1) {
          return {
            ok: true,
            page: { hits: [makeSearchHit(1, { body: 'ページ1' })], next_cursor: 'stale-cur' },
          }
        }
        if (step === 2) {
          return { ok: false, failure: { kind: 'invalid_cursor' } }
        }
        return {
          ok: true,
          page: { hits: [makeSearchHit(2, { body: '再検索ページ1' })], next_cursor: null },
        }
      },
    }

    const ctrl = createSearchController({ source })
    await ctrl.submit('検索語')
    expect(ctrl.get().nextCursor).toBe('stale-cur')

    await ctrl.loadMore()
    expect(ctrl.get().status).toBe('results')
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['msg-1'])
    expect(ctrl.get().nextCursor).toBeNull()
    expect(ctrl.get().loadMoreError).toBe('invalid_cursor')
    expect(ctrl.get().retryable).toBe(true)

    // Further loadMore is a no-op once the invalid cursor is cleared.
    await ctrl.loadMore()
    expect(calls).toHaveLength(2)

    // retry() restarts the submitted query from page 1 with no cursor.
    await ctrl.retry()
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({ q: '検索語' })
    expect(calls[2].cursor).toBeUndefined()
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['msg-2'])
    expect(ctrl.get().loadMoreError).toBeNull()
    ctrl.destroy()
  })

  it('removes revoked Channel hits immediately and drops them from delayed pages in the same search', async () => {
    const delayedMore = deferred<SearchResponse>()
    let step = 0
    const source: SearchSource = {
      search() {
        step += 1
        if (step === 1) {
          return Promise.resolve({
            ok: true,
            page: {
              hits: [
                makeSearchHit(1, { id: 'rev-1', channel_id: 'ch-revoked', body: '機密 1' }),
                makeSearchHit(2, { id: 'keep-1', channel_id: 'ch-keep', body: '機密 2' }),
              ],
              next_cursor: 'cur-1',
            },
          })
        }
        if (step === 2) return delayedMore.promise
        return Promise.resolve({
          ok: true,
          page: {
            hits: [makeSearchHit(5, { id: 'rev-new', channel_id: 'ch-revoked', body: '再取得' })],
            next_cursor: null,
          },
        })
      },
    }

    const ctrl = createSearchController({ source })
    await ctrl.submit('機密')
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['rev-1', 'keep-1'])

    const pendingMore = ctrl.loadMore()
    ctrl.revokeChannel('ch-revoked')
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['keep-1'])

    // Delayed page started before the revoke resolves afterwards: revoked Channel hit is dropped, other stays.
    delayedMore.resolve({
      ok: true,
      page: {
        hits: [
          makeSearchHit(3, { id: 'rev-2', channel_id: 'ch-revoked', body: '機密 3' }),
          makeSearchHit(4, { id: 'keep-2', channel_id: 'ch-keep', body: '機密 4' }),
        ],
        next_cursor: null,
      },
    })
    await pendingMore
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['keep-1', 'keep-2'])

    // Revoking the last remaining Channel transitions to empty when no nextCursor remains.
    ctrl.revokeChannel('ch-keep')
    expect(ctrl.get().items).toHaveLength(0)
    expect(ctrl.get().status).toBe('empty')

    // A fresh submit resets the per-search revocation fence.
    await ctrl.submit('再取得')
    expect(ctrl.get().items.map((h) => h.message.id)).toEqual(['rev-new'])
    ctrl.destroy()
  })
})

afterEach(() => {
  vi.useRealTimers()
})
