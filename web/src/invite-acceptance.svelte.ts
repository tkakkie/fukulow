import { createSubscriber } from 'svelte/reactivity'
import type { createInviteAcceptance } from './invite-acceptance'

export function inviteAcceptanceAdapter(controller: ReturnType<typeof createInviteAcceptance>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return { get state() { subscribe(); return controller.get() }, accept: controller.accept, signOutAndContinue: controller.signOutAndContinue }
}
