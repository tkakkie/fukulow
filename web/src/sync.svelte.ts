import { createSubscriber } from 'svelte/reactivity'
import { MESSAGE_BODY_MAX, messageBodyError, type createSync, type TimelineState } from './sync'

export { MESSAGE_BODY_MAX, messageBodyError }

type Sync = ReturnType<typeof createSync>

/**
 * Maps one Channel of the session's sync controller to reactive reads and forwards user intents.
 * Holds no sync rules and no copy of the state: reads go to the controller, and `createSubscriber` only tells
 * Svelte when to read again. Its listener exists while an effect observes this Channel and is released with the
 * last observer; the controller (connection, cursor, pending) is not affected by observers coming and going.
 */
function channelAdapter(sync: Sync, channel: string) {
  const timeline = sync.getTimeline(channel)
  const subscribe = createSubscriber(update => timeline.subscribe(update))
  return {
    get timeline(): TimelineState {
      subscribe()
      return timeline.get()
    },
    /** The server confirmed this Channel's subscription (live indicator). */
    get live(): boolean {
      subscribe()
      return sync.get().channels[channel]?.subscription?.confirmed === true
    },
    loadLatest: () => timeline.loadLatest(),
    loadOlder: () => timeline.loadOlder(),
    setDraft: (draft: string) => timeline.setDraft(draft),
    submit: () => timeline.submit(),
    send: (body: string) => timeline.send(body),
    retry: (clientMessageId: string) => timeline.retry(clientMessageId),
    restore: (clientMessageId: string) => timeline.restore(clientMessageId),
    discard: (clientMessageId: string) => timeline.discard(clientMessageId),
  }
}
export type ChannelSync = ReturnType<typeof channelAdapter>

export function syncAdapter(sync: Sync) {
  const channels = new Map<string, ChannelSync>()
  const subscribe = createSubscriber(update => sync.subscribe(update))
  return {
    get unavailable() { subscribe(); return sync.get().organization === 'unavailable' },
    channel(id: string): ChannelSync {
      let c = channels.get(id)
      if (!c) channels.set(id, (c = channelAdapter(sync, id)))
      return c
    },
  }
}
export type SyncAdapter = ReturnType<typeof syncAdapter>
