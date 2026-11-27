import {
  isOrganizationUnavailable,
  isSessionEnded,
  searchMessages,
  type SearchPage,
  type SearchQuery,
} from './api'

const SEARCH_MIN_SCALARS = 2

export type SearchRequest = SearchQuery & {
  signal?: AbortSignal
}

export type SearchFailure =
  | { kind: 'too_short'; minLength?: number }
  | { kind: 'invalid_cursor' }
  | { kind: 'unavailable' }
  | { kind: 'timeout' }
  | { kind: 'error'; retryable: boolean }

export type SearchResponse =
  | { ok: true; page: SearchPage }
  | { ok: false; failure: SearchFailure }

export interface SearchSource {
  search(request: SearchRequest): Promise<SearchResponse>
}

export type DefaultSearchSourceOptions = {
  searchApi?: typeof searchMessages
  onEnded?: () => void
  onUnavailable?: () => void
}

export function createDefaultSearchSource(
  organizationId: string,
  options: DefaultSearchSourceOptions = {},
): SearchSource {
  const searchApi = options.searchApi ?? searchMessages

  return {
    async search(request: SearchRequest): Promise<SearchResponse> {
      if (request.signal?.aborted) {
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
      const query: SearchQuery = {
        q: request.q,
        ...(request.channel_id !== undefined ? { channel_id: request.channel_id } : {}),
        ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      }
      const result = await searchApi(organizationId, query, undefined, request.signal)
      if (result.ok) {
        return { ok: true, page: result.data }
      }
      if (result.kind === 'network') {
        if (result.error === 'search_unavailable') {
          return { ok: false, failure: { kind: 'unavailable' } }
        }
        if (result.error === 'search_timeout') {
          return { ok: false, failure: { kind: 'timeout' } }
        }
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
      if (result.status === 400 && result.error === 'search_query_too_short') {
        return { ok: false, failure: { kind: 'too_short', minLength: SEARCH_MIN_SCALARS } }
      }
      if (result.status === 400 && result.error === 'invalid_cursor') {
        return { ok: false, failure: { kind: 'invalid_cursor' } }
      }
      if (isSessionEnded(result)) {
        options.onEnded?.()
        return { ok: false, failure: { kind: 'error', retryable: false } }
      }
      if (isOrganizationUnavailable(result)) {
        options.onUnavailable?.()
        return { ok: false, failure: { kind: 'error', retryable: false } }
      }
      if (result.status === 429) {
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
      return { ok: false, failure: { kind: 'error', retryable: false } }
    },
  }
}
