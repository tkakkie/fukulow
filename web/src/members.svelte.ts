import { createSubscriber } from 'svelte/reactivity'
import { createMembers, createInviteAcceptance } from './members'

export function membersAdapter(controller: ReturnType<typeof createMembers>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return {
    get state() { subscribe(); return controller.get() },
    load: controller.load, invite: controller.invite, role: controller.role, close: controller.close,
  }
}
export function inviteAcceptanceAdapter(controller: ReturnType<typeof createInviteAcceptance>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return { get state() { subscribe(); return controller.get() }, accept: controller.accept }
}
