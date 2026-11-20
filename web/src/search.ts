import {
  SEARCH_RANGE_DAYS,
  type SearchResultItem,
  type SearchSource,
} from './search-source'

export const SEARCH_PAGE_SIZE = 20

export type SearchTarget = {
  channelId: string
  topicId?: string | null
  replyRootId?: string | null
  messageId: string
}

export type SearchStatus =
  | 'idle'
  | 'loading'
  | 'results'
  | 'loading-more'
  | 'empty'
  | 'too-short'
  | 'timeout'
  | 'error'

export type SearchState = {
  open: boolean
  input: string
  submittedQuery: string
  status: SearchStatus
  items: readonly SearchResultItem[]
  nextCursor: string | null
  rangeDays: number
  rangeStart: string | null
  minLength: number | null
  retryable: boolean
  loadMoreError: 'timeout' | 'error' | null
}

export type SearchControllerOptions = {
  source: SearchSource
  onOpenResult?: (target: SearchTarget) => void
}

/**
 * Prepares a user-typed search query per #153:
 * trims leading and trailing whitespace while preserving internal whitespace,
 * Unicode form, case, and literal `%`, `_`, `\` characters (normalization is server-side).
 */
export function prepareSearchQuery(raw: string): string {
  return raw.trim()
}

function initialState(): SearchState {
  return {
    open: false,
    input: '',
    submittedQuery: '',
    status: 'idle',
    items: [],
    nextCursor: null,
    rangeDays: SEARCH_RANGE_DAYS,
    rangeStart: null,
    minLength: null,
    retryable: false,
    loadMoreError: null,
  }
}

export function createSearchController(options: SearchControllerOptions) {
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
      rangeStart: null,
      minLength: null,
      retryable: false,
      loadMoreError: null,
    })

    try {
      const response = await options.source.search({
        query,
        limit: SEARCH_PAGE_SIZE,
        signal: controller.signal,
      })
      if (destroyed || gen !== generation || controller.signal.aborted) return
      inFlight = null

      if (response.ok) {
        const { items, nextCursor, rangeDays, rangeStart } = response.page
        publish({
          ...state,
          status: items.length > 0 ? 'results' : 'empty',
          items: [...items],
          nextCursor,
          rangeDays,
          rangeStart,
          minLength: null,
          retryable: false,
          loadMoreError: null,
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
    } catch {
      if (destroyed || gen !== generation || controller.signal.aborted) return
      inFlight = null
      publish({
        ...state,
        status: 'error',
        retryable: true,
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
    })

    try {
      const response = await options.source.search({
        query,
        limit: SEARCH_PAGE_SIZE,
        cursor,
        signal: controller.signal,
      })
      if (destroyed || gen !== generation || controller.signal.aborted) return
      inFlight = null

      if (response.ok) {
        const { items, nextCursor, rangeDays, rangeStart } = response.page
        publish({
          ...state,
          status: 'results',
          items: [...state.items, ...items],
          nextCursor,
          rangeDays,
          rangeStart,
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
        retryable: failure.kind === 'error' ? failure.retryable : true,
      })
    } catch {
      if (destroyed || gen !== generation || controller.signal.aborted) return
      inFlight = null
      publish({
        ...state,
        status: 'results',
        loadMoreError: 'error',
        retryable: true,
      })
    }
  }

  async function retry(): Promise<void> {
    if (state.items.length > 0 && state.loadMoreError !== null && state.nextCursor !== null) {
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
    close()
    options.onOpenResult?.(target)
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
