import { createSubscriber } from 'svelte/reactivity'
import type { Message } from './api'
import type { Replies } from './replies'

/** Reactive reads and user intents only; the session owns the controller lifetime. */
export function repliesAdapter(replies: Replies, channel: string) {
  const subscribe = createSubscriber(update => replies.subscribe(update))
  return {
    get state() { subscribe(); return replies.get(channel) },
    open: (anchor: Message) => replies.open(channel, anchor),
    loadMore: () => replies.loadMore(channel),
    dismiss: () => replies.dismiss(channel),
    send: (body: string, parentId?: string) => replies.send(channel, body, parentId),
    retry: (clientMessageId: string) => replies.retry(channel, clientMessageId),
  }
}
export type RepliesAdapter = ReturnType<typeof repliesAdapter>

/** Counts unique known replies per root/parent Message ID across stream, projection and open chain windows. */
export function countRepliesByMessageId(sources: readonly Iterable<Message>[]): Map<string, number> {
  const sets = new Map<string, Set<string>>()
  const add = (targetId: string, replyId: string) => {
    if (targetId === replyId) return
    let set = sets.get(targetId)
    if (!set) {
      set = new Set()
      sets.set(targetId, set)
    }
    set.add(replyId)
  }
  for (const source of sources) {
    for (const m of source) {
      if (m.reply_root_id) add(m.reply_root_id, m.id)
      if (m.reply_to) add(m.reply_to, m.id)
    }
  }
  const counts = new Map<string, number>()
  for (const [id, set] of sets) counts.set(id, set.size)
  return counts
}
