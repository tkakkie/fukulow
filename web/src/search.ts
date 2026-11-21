import type { SearchHit } from './api'
import type {
  SearchRequest,
  SearchResponse,
  SearchSource,
} from './search-source'

export const SEARCH_TIMEOUT_MS = 10_000
const SEARCH_UNAVAILABLE_NOTICE = 'メッセージ検索は現在準備中です。'
const SEARCH_OPEN_FAILED_NOTICE = 'この検索結果は現在開けません。'

export type SearchTarget = {
  channelId: string
  topicId?: string | null
  replyRootId?: string | null
  messageId: string
  createdSeq: number
}

export type SearchStatus =
  | 'idle'
  | 'loading'
  | 'results'
  | 'loading-more'
  | 'empty'
  | 'too-short'
  | 'unavailable'
  | 'timeout'
  | 'error'

export type SearchState = {
  open: boolean
  input: string
  submittedQuery: string
  status: SearchStatus
  items: readonly SearchHit[]
  nextCursor: string | null
  minLength: number | null
  retryable: boolean
  loadMoreError: 'timeout' | 'error' | null
  openNotice: string | null
}

export type SearchControllerOptions = {
  source: SearchSource
  /** Return `false` to cancel navigation and keep the current view with an inline notice. */
  onOpenResult?: (target: SearchTarget) => boolean | void
  /** Announces non-error search outcomes (e.g. unavailable or unopenable hit) through the page live region. */
  onAnnounce?: (message: string) => void
  /** Request timeout in milliseconds (defaults to `SEARCH_TIMEOUT_MS`, 10 s per `docs/ui.md` §5). */
  timeoutMs?: number
}

/**
 * Prepares a user-typed search query per #153:
 * trims leading and trailing Unicode White_Space while preserving internal whitespace,
 * Unicode form, case, and literal `%`, `_`, `\` characters (normalization is server-side).
 * Matches Rust `str::trim()`: unlike `String.prototype.trim()`, it keeps U+FEFF (BOM) and removes U+0085.
 */
export function prepareSearchQuery(raw: string): string {
  return raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
}

function initialState(): SearchState {
  return {
    open: false,
    input: '',
    submittedQuery: '',
    status: 'idle',
    items: [],
    nextCursor: null,
    minLength: null,
    retryable: false,
    loadMoreError: null,
    openNotice: null,
  }
}

export function createSearchController(options: SearchControllerOptions) {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS
  let state: SearchState = initialState()
  let generation = 0
  let destroyed = false
  let inFlight: AbortController | null = null
  const listeners = new Set<() => void>()

  const publish = (next: SearchState) => {
    state = next
    listeners.forEach((listener) => listener())
  }

  const abortInFlight = () => {
    inFlight?.abort()
    inFlight = null
  }

  async function runWithTimeout(
    request: Omit<SearchRequest, 'signal'>,
    controller: AbortController,
  ): Promise<SearchResponse | 'aborted'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let onAbort: (() => void) | undefined

    const deadlinePromise = new Promise<SearchResponse | 'aborted'>((resolve) => {
      onAbort = () => {
        if (timer !== undefined) clearTimeout(timer)
        if (!timedOut) resolve('aborted')
      }
      if (controller.signal.aborted) {
        resolve('aborted')
        return
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve({ ok: false, failure: { kind: 'timeout' } })
      }, timeoutMs)
    })

    const requestPromise = (async (): Promise<SearchResponse> => {
      try {
        return await options.source.search({
          ...request,
          signal: controller.signal,
        })
      } catch {
        return { ok: false, failure: { kind: 'error', retryable: true } }
      }
    })()

    try {
      return await Promise.race([requestPromise, deadlinePromise])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  async function submit(rawQuery?: string): Promise<void> {
    if (destroyed) return
    const nextInput = rawQuery !== undefined ? rawQuery : state.input
    const query = prepareSearchQuery(nextInput)
    if (query.length === 0) {
      if (nextInput !== state.input) {
        publish({ ...state, input: nextInput })
      }
      return
    }

    abortInFlight()
    const controller = new AbortController()
    inFlight = controller
    const gen = ++generation

    publish({
      ...state,
      open: true,
      input: nextInput,
      submittedQuery: query,
      status: 'loading',
      items: [],
      nextCursor: null,
      minLength: null,
      retryable: false,
      loadMoreError: null,
      openNotice: null,
    })

    const response = await runWithTimeout({ q: query }, controller)
    if (destroyed || gen !== generation || response === 'aborted') return
    inFlight = null

    if (response.ok) {
      const { hits, next_cursor } = response.page
      publish({
        ...state,
        status: hits.length > 0 || next_cursor !== null ? 'results' : 'empty',
        items: [...hits],
        nextCursor: next_cursor,
        minLength: null,
        retryable: false,
        loadMoreError: null,
        openNotice: null,
      })
      return
    }

    const { failure } = response
    if (failure.kind === 'too_short') {
      publish({
        ...state,
        status: 'too-short',
        minLength: failure.minLength ?? null,
        retryable: false,
      })
    } else if (failure.kind === 'unavailable') {
      publish({
        ...state,
        status: 'unavailable',
        retryable: false,
      })
      options.onAnnounce?.(SEARCH_UNAVAILABLE_NOTICE)
    } else if (failure.kind === 'timeout') {
      publish({
        ...state,
        status: 'timeout',
        retryable: true,
      })
    } else {
      publish({
        ...state,
        status: 'error',
        retryable: failure.retryable,
      })
    }
  }

  async function loadMore(): Promise<void> {
    if (destroyed) return
    if (
      !state.open ||
      state.nextCursor === null ||
      state.submittedQuery.length === 0 ||
      state.status === 'loading' ||
      state.status === 'loading-more'
    ) {
      return
    }

    abortInFlight()
    const controller = new AbortController()
    inFlight = controller
    const gen = ++generation
    const cursor = state.nextCursor
    const query = state.submittedQuery

    publish({
      ...state,
      status: 'loading-more',
      loadMoreError: null,
      openNotice: null,
    })

    const response = await runWithTimeout({ q: query, cursor }, controller)
    if (destroyed || gen !== generation || response === 'aborted') return
    inFlight = null

    if (response.ok) {
      const { hits, next_cursor } = response.page
      const seen = new Set(state.items.map((h) => h.message.id))
      const merged = [...state.items, ...hits.filter((h) => !seen.has(h.message.id))]
      publish({
        ...state,
        status: merged.length > 0 || next_cursor !== null ? 'results' : 'empty',
        items: merged,
        nextCursor: next_cursor,
        loadMoreError: null,
        retryable: false,
      })
      return
    }

    const { failure } = response
    publish({
      ...state,
      status: 'results',
      loadMoreError: failure.kind === 'timeout' ? 'timeout' : 'error',
      retryable: failure.kind === 'error' ? failure.retryable : failure.kind !== 'unavailable',
    })
  }

  async function retry(): Promise<void> {
    if (state.loadMoreError !== null && state.nextCursor !== null) {
      await loadMore()
      return
    }
    if (state.submittedQuery.length > 0) {
      await submit(state.submittedQuery)
    }
  }

  function close(): void {
    if (destroyed || !state.open) return
    abortInFlight()
    generation++
    const nextStatus: SearchStatus =
      state.status === 'loading'
        ? 'idle'
        : state.status === 'loading-more'
          ? 'results'
          : state.status
    publish({
      ...state,
      open: false,
      status: nextStatus,
      openNotice: null,
    })
  }

  function clear(): void {
    if (destroyed) return
    abortInFlight()
    generation++
    publish(initialState())
  }

  function openSearchResult(target: SearchTarget): void {
    if (destroyed) return
    const opened = options.onOpenResult?.(target)
    if (opened === false) {
      publish({
        ...state,
        openNotice: SEARCH_OPEN_FAILED_NOTICE,
      })
      options.onAnnounce?.(SEARCH_OPEN_FAILED_NOTICE)
      return
    }
    close()
  }

  return {
    get: (): SearchState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setInput(value: string): void {
      if (destroyed || value === state.input) return
      publish({ ...state, input: value })
    },
    submit,
    loadMore,
    retry,
    openSearchResult,
    close,
    clear,
    destroy(): void {
      destroyed = true
      abortInFlight()
      listeners.clear()
    },
  }
}

export type SearchController = ReturnType<typeof createSearchController>
