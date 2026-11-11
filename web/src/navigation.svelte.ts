import { createSubscriber } from 'svelte/reactivity'
import type { Navigation } from './navigation'

export function navigationAdapter(getController: () => Navigation) {
  const controller = getController()
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return {
    get state() { subscribe(); return controller.get() },
    navigate: controller.navigate,
    initialize: controller.initialize,
  }
}
