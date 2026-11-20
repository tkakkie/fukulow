import { createSubscriber } from 'svelte/reactivity'
import type { Message } from './api'
import type { MoveDestination, MoveResult } from './move-chain'
import type { Replies } from './replies'
import type { ReplyCounts } from './reply-counts'

/** Reactive reads and user intents only; the session owns the controller lifetime. */
export function repliesAdapter(
  replies: Replies,
  channel: string,
  counts?: ReplyCounts,
  moveChain?: (channel: string, anchor: string, destination: MoveDestination) => Promise<MoveResult>,
) {
  const subscribe = createSubscriber(update => replies.subscribe(update))
  const subscribeCounts = createSubscriber(update => counts?.subscribe(update))
  return {
    get counts() { subscribeCounts(); return counts?.get(channel) ?? {} },
    get state() { subscribe(); return replies.get(channel) },
    open: (anchor: Message) => replies.open(channel, anchor),
    loadMore: () => replies.loadMore(channel),
    loadOlder: () => replies.loadOlder(channel),
    loadLatest: () => replies.loadLatest(channel),
    setPinned: (pinned: boolean) => replies.setPinned(channel, pinned),
    dismiss: () => replies.dismiss(channel),
    send: (body: string, parentId?: string) => replies.send(channel, body, parentId),
    retry: (clientMessageId: string) => replies.retry(channel, clientMessageId),
    move: (anchor: string, destination: MoveDestination): Promise<MoveResult> =>
      moveChain ? moveChain(channel, anchor, destination) : Promise.resolve({ kind: 'baseline_unavailable' }),
  }
}
export type RepliesAdapter = ReturnType<typeof repliesAdapter>
