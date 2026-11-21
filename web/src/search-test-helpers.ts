import type { Message, SearchHit } from './api'
import type { SearchRequest, SearchResponse, SearchSource } from './search-source'

const DAY_MS = 24 * 60 * 60 * 1000
const HISTORY_GENERATION = '00000000-0000-4000-8000-000000000515'

export function makeSearchHit(
  index: number,
  overrides: Partial<Message> = {},
  channelKind: SearchHit['channel_kind'] = 'channel',
): SearchHit {
  const id = overrides.id ?? `msg-${index}`
  return {
    channel_kind: channelKind,
    message: {
      id,
      client_message_id: `client-${id}`,
      channel_id: 'ch-1',
      sender: 'sender-1',
      topic_id: null,
      reply_to: null,
      reply_root_id: null,
      created_seq: index + 1,
      version: index + 1,
      history_generation: HISTORY_GENERATION,
      deleted: false,
      created_at: `2026-11-${String(20 - (index % 19)).padStart(2, '0')}T10:00:00.000Z`,
      body: `検索テスト本文 ${index}`,
      ...overrides,
    },
  }
}

export type MockSearchOptions = {
  hits?: readonly SearchHit[]
  pageSize?: number
  minLength?: number
}

function buildDefaultMockHits(): readonly SearchHit[] {
  const nowMs = Date.now()
  return [
    makeSearchHit(1, {
      id: 'mock-msg-1',
      created_seq: 3,
      channel_id: 'general',
      topic_id: 'topic-release',
      sender: 'sender-tanaka',
      created_at: new Date(nowMs - 1 * DAY_MS).toISOString(),
      body: '来週のリリース手順書を更新しました。確認をお願いします。',
    }),
    makeSearchHit(2, {
      id: 'mock-msg-2',
      created_seq: 2,
      channel_id: 'general',
      reply_root_id: 'mock-root-1',
      sender: 'sender-sato',
      created_at: new Date(nowMs - 2 * DAY_MS).toISOString(),
      body: '進捗率 100% の確認と query_log\\backup の手順を追記しました。',
    }),
    makeSearchHit(
      3,
      {
        id: 'mock-msg-3',
        created_seq: 1,
        channel_id: 'dm-1',
        sender: 'sender-suzuki',
        created_at: new Date(nowMs - 3 * DAY_MS).toISOString(),
        body: '明日の定例ミーティングの議題を共有します。',
      },
      'dm',
    ),
  ]
}

export function createMockSearchSource(options: MockSearchOptions = {}): SearchSource {
  const minLength = options.minLength ?? 2
  const pageSize = options.pageSize ?? 20

  return {
    async search(request: SearchRequest): Promise<SearchResponse> {
      if (request.signal?.aborted) {
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
      if ([...request.q].length < minLength) {
        return { ok: false, failure: { kind: 'too_short', minLength } }
      }
      const offset = request.cursor?.startsWith('mock:')
        ? Number.parseInt(request.cursor.slice('mock:'.length), 10) || 0
        : 0
      const hits = options.hits ?? buildDefaultMockHits()
      const needle = request.q.toLocaleLowerCase()
      const matched = hits.filter((hit) => {
        if (request.channel_id && hit.message.channel_id !== request.channel_id) return false
        return (hit.message.body ?? '').toLocaleLowerCase().includes(needle)
      })
      const pageHits = matched.slice(offset, offset + pageSize)
      const nextOffset = offset + pageHits.length
      return {
        ok: true,
        page: {
          hits: pageHits,
          next_cursor: nextOffset < matched.length ? `mock:${nextOffset}` : null,
        },
      }
    },
  }
}
