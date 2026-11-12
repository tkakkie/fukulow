import { createSubscriber } from 'svelte/reactivity'
import type { createChannelMembers } from './channel-members'

export function channelMembersAdapter(controller: ReturnType<typeof createChannelMembers>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return { get state() { subscribe(); return controller.get() }, load: controller.load, add: controller.add, remove: controller.remove, changeManager: controller.changeManager }
}
