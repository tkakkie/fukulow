import { createSubscriber } from 'svelte/reactivity'
import type { SearchController, SearchState, SearchTarget } from './search'

export type { SearchState, SearchStatus, SearchTarget } from './search'

/** Thin reactive adapter over the plain TypeScript search controller (`AGENTS.md` Web layers). */
export function searchAdapter(controller: SearchController) {
  const subscribe = createSubscriber((update) => controller.subscribe(update))
  return {
    get state(): SearchState {
      subscribe()
      return controller.get()
    },
    setInput: (value: string) => controller.setInput(value),
    submit: (rawQuery?: string) => controller.submit(rawQuery),
    loadMore: () => controller.loadMore(),
    retry: () => controller.retry(),
    openSearchResult: (target: SearchTarget) => controller.openSearchResult(target),
    close: () => controller.close(),
    clear: () => controller.clear(),
  }
}

export type SearchAdapter = ReturnType<typeof searchAdapter>
