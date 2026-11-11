import { createSubscriber } from 'svelte/reactivity'
import type { createNavigationTargets } from './navigation-targets'

export function navigationTargetsAdapter(controller: ReturnType<typeof createNavigationTargets>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return {
    get state() { subscribe(); return controller.get() },
    load: controller.load,
  }
}
