import { createSubscriber } from 'svelte/reactivity'
import type { createAuthors } from './authors'

export function authorsAdapter(controller: ReturnType<typeof createAuthors>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return {
    get identities() { subscribe(); return controller.get() },
    isPending(id: string) { subscribe(); return controller.isPending(id) },
    watch: controller.watch,
    retry: controller.retry,
  }
}
