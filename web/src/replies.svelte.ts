import { createSubscriber } from 'svelte/reactivity'
import type { Message } from './api'
import type { Replies } from './replies'

/** Reactive reads and user intents only; the session owns the controller lifetime. */
export function repliesAdapter(replies: Replies, channel: string) {
  const subscribe = createSubscriber(update => replies.subscribe(update))
  return {
    get state() { subscribe(); return replies.get(channel) },
    open: (anchor: Message) => replies.open(anchor),
    loadMore: () => replies.loadMore(channel),
    dismiss: () => replies.dismiss(channel),
    send: (body: string, parentId?: string) => replies.send(channel, body, parentId),
    retry: (clientMessageId: string) => replies.retry(channel, clientMessageId),
  }
}
