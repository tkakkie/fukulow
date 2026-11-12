import { createSubscriber } from 'svelte/reactivity'
import type { Unread } from './unread'

/** Reactive reads and viewport/view/visibility intents; the Account Session owns lifetime. */
export function unreadAdapter(unread: Unread, channel: string) {
  const subscribe = createSubscriber(update => unread.subscribe(update, channel))
  return {
    get state() { subscribe(); return unread.get(channel) },
    enter: (topicId: string | null = null) => unread.enter({ channel, topicId }),
    leave: (visit: symbol) => unread.leave(visit),
    presented: (visit: symbol, seqs: number[]) => unread.presented(visit, seqs),
    visibility: (visible: boolean) => unread.visibility(visible),
    refresh: () => unread.refresh(),
  }
}
export type UnreadAdapter = ReturnType<typeof unreadAdapter>
