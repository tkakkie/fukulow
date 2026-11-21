import { createSubscriber } from 'svelte/reactivity'
import type { createSearchAnchor } from './search-anchor'
import type { SearchResultTarget } from './navigation'

export function searchAnchorAdapter(controller: ReturnType<typeof createSearchAnchor>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return {
    get state() { subscribe(); return controller.get() },
    open: controller.open,
    retry: controller.retry,
    loadOlder: controller.loadOlder,
    loadNewer: controller.loadNewer,
  }
}
export type SearchAnchorAdapter = ReturnType<typeof searchAnchorAdapter>
export type SearchPresentation = Pick<SearchAnchorAdapter, 'retry' | 'loadOlder' | 'loadNewer'> & {
  target: SearchResultTarget
  view: SearchAnchorAdapter['state']
  latest(): void
}
