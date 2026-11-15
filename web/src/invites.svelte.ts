import { createSubscriber } from 'svelte/reactivity'
import type { createInvites } from './invites'

export function invitesAdapter(controller: ReturnType<typeof createInvites>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return { get state() { subscribe(); return controller.get() }, load: controller.load,
    more: controller.more, retry: controller.retry, revoke: controller.revoke }
}
