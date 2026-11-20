/**
 * Web-only search data source contract and mock implementation (#153).
 *
 * Types here are intentionally web-only and do not mirror or edit `api-schema.d.ts`
 * or `openapi.json`. Once the server search endpoint exists, plug the real API
 * adapter into `createDefaultSearchSource` below.
 */

export type SearchResultContext =
  | {
      kind: 'channel'
      channelId: string
      channelName: string
      topicId?: string
      topicName?: string
    }
  | {
      kind: 'dm'
      channelId: string
      peerName: string
      peerActive: boolean
    }

export type SearchResultItem = {
  messageId: string
  channelId: string
  topicId: string | null
  replyRootId: string | null
  context: SearchResultContext
  authorName: string
  authorActive: boolean
  createdAt: string
  excerpt: string
}

export type SearchRequest = {
  /** Trimmed query as typed by the user; server performs normalization. */
  query: string
  limit: number
  cursor?: string
  channelId?: string
  signal?: AbortSignal
}

export type SearchPage = {
  items: readonly SearchResultItem[]
  nextCursor: string | null
  rangeDays: number
  /** ISO-8601 timestamp for the start of the 180-day search window. */
  rangeStart: string
}

export type SearchFailure =
  | { kind: 'too_short'; minLength?: number }
  | { kind: 'timeout' }
  | { kind: 'error'; retryable: boolean }

export type SearchResponse =
  | { ok: true; page: SearchPage }
  | { ok: false; failure: SearchFailure }

export interface SearchSource {
  search(request: SearchRequest): Promise<SearchResponse>
}

export const SEARCH_RANGE_DAYS = 180

export type MockSearchOptions = {
  items?: readonly SearchResultItem[]
  rangeDays?: number
  rangeStart?: string
  minLength?: number
}

const DEFAULT_RANGE_START = '2026-05-24T00:00:00.000Z'

const DEFAULT_MOCK_ITEMS: readonly SearchResultItem[] = [
  {
    messageId: 'mock-msg-1',
    channelId: 'general',
    topicId: 'topic-release',
    replyRootId: null,
    context: {
      kind: 'channel',
      channelId: 'general',
      channelName: 'general',
      topicId: 'topic-release',
      topicName: 'リリース準備',
    },
    authorName: '田中 美咲',
    authorActive: true,
    createdAt: '2026-11-19T09:30:00.000Z',
    excerpt: '来週のリリース手順書を更新しました。確認をお願いします。',
  },
  {
    messageId: 'mock-msg-2',
    channelId: 'general',
    topicId: null,
    replyRootId: 'mock-root-1',
    context: {
      kind: 'channel',
      channelId: 'general',
      channelName: 'general',
    },
    authorName: '佐藤 健',
    authorActive: true,
    createdAt: '2026-11-18T14:15:00.000Z',
    excerpt: '進捗率 100% の確認と query_log\\backup の手順を追記しました。',
  },
  {
    messageId: 'mock-msg-3',
    channelId: 'dm-1',
    topicId: null,
    replyRootId: null,
    context: {
      kind: 'dm',
      channelId: 'dm-1',
      peerName: '鈴木 花子',
      peerActive: true,
    },
    authorName: '鈴木 花子',
    authorActive: true,
    createdAt: '2026-11-17T11:05:00.000Z',
    excerpt: '明日の定例ミーティングの議題を共有します。',
  },
]

function encodeCursor(offset: number): string {
  return `mock:${offset}`
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor || !cursor.startsWith('mock:')) return 0
  const parsed = Number.parseInt(cursor.slice(5), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** Deterministic in-memory mock used by tests and by the app until the server search API exists. */
export function createMockSearchSource(options: MockSearchOptions = {}): SearchSource {
  const items = options.items ?? DEFAULT_MOCK_ITEMS
  const rangeDays = options.rangeDays ?? SEARCH_RANGE_DAYS
  const rangeStart = options.rangeStart ?? DEFAULT_RANGE_START
  const minLength = options.minLength ?? 2

  return {
    async search(request: SearchRequest): Promise<SearchResponse> {
      if (request.signal?.aborted) {
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
      const scalarLength = [...request.query].length
      if (scalarLength < minLength) {
        return { ok: false, failure: { kind: 'too_short', minLength } }
      }
      const needle = request.query.toLocaleLowerCase()
      const matched = items.filter((item) => {
        if (request.channelId && item.channelId !== request.channelId) return false
        return item.excerpt.toLocaleLowerCase().includes(needle)
      })
      const offset = decodeCursor(request.cursor)
      const pageItems = matched.slice(offset, offset + request.limit)
      const nextOffset = offset + pageItems.length
      const nextCursor = nextOffset < matched.length ? encodeCursor(nextOffset) : null
      return {
        ok: true,
        page: {
          items: pageItems,
          nextCursor,
          rangeDays,
          rangeStart,
        },
      }
    },
  }
}

/**
 * Single plug-in point for the production search API adapter (#153).
 * Replace `createMockSearchSource()` here once the server `/api/v1` search endpoint is added.
 */
export function createDefaultSearchSource(_organizationId: string): SearchSource {
  return createMockSearchSource()
}
