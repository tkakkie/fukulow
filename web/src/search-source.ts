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
  | { kind: 'unavailable' }
  | { kind: 'timeout' }
  | { kind: 'error'; retryable: boolean }

export type SearchResponse =
  | { ok: true; page: SearchPage }
  | { ok: false; failure: SearchFailure }

export interface SearchSource {
  search(request: SearchRequest): Promise<SearchResponse>
}

export const SEARCH_RANGE_DAYS = 180
const DAY_MS = 24 * 60 * 60 * 1000

export type MockSearchOptions = {
  items?: readonly SearchResultItem[]
  rangeDays?: number
  /** Clock returning current epoch milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Explicit ISO cutoff override for tests; defaults to `now() - rangeDays` days. */
  rangeStart?: string
  minLength?: number
}

function buildDefaultMockItems(nowMs: number): readonly SearchResultItem[] {
  return [
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
      createdAt: new Date(nowMs - 1 * DAY_MS).toISOString(),
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
      createdAt: new Date(nowMs - 2 * DAY_MS).toISOString(),
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
      createdAt: new Date(nowMs - 3 * DAY_MS).toISOString(),
      excerpt: '明日の定例ミーティングの議題を共有します。',
    },
  ]
}

function encodeCursor(offset: number): string {
  return `mock:${offset}`
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor || !cursor.startsWith('mock:')) return 0
  const parsed = Number.parseInt(cursor.slice(5), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** Deterministic in-memory mock used by tests and dev builds until the server search API exists. */
export function createMockSearchSource(options: MockSearchOptions = {}): SearchSource {
  const rangeDays = options.rangeDays ?? SEARCH_RANGE_DAYS
  const now = options.now ?? (() => Date.now())
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
      const nowMs = now()
      const cutoffMs =
        options.rangeStart !== undefined
          ? Date.parse(options.rangeStart)
          : nowMs - rangeDays * DAY_MS
      const rangeStart =
        options.rangeStart !== undefined
          ? options.rangeStart
          : new Date(cutoffMs).toISOString()
      const items = options.items ?? buildDefaultMockItems(nowMs)
      const needle = request.query.toLocaleLowerCase()
      const matched = items.filter((item) => {
        if (request.channelId && item.channelId !== request.channelId) return false
        const createdMs = Date.parse(item.createdAt)
        if (Number.isFinite(cutoffMs) && (!Number.isFinite(createdMs) || createdMs < cutoffMs)) {
          return false
        }
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

/** Placeholder source returned in production builds until the server `/api/v1` search endpoint lands. */
export function createUnavailableSearchSource(): SearchSource {
  return {
    async search(request: SearchRequest): Promise<SearchResponse> {
      if (request.signal?.aborted) {
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
      return { ok: false, failure: { kind: 'unavailable' } }
    },
  }
}

/**
 * Single plug-in point for the production search API adapter (#153).
 * In production builds, returns an unavailable state until the server `/api/v1` search endpoint lands.
 * The in-memory mock is used only in tests and dev builds (`import.meta.env.DEV`).
 */
export function createDefaultSearchSource(
  _organizationId: string,
  options: { isDev?: boolean } = {},
): SearchSource {
  const isDev = options.isDev ?? import.meta.env.DEV
  return isDev ? createMockSearchSource() : createUnavailableSearchSource()
}
