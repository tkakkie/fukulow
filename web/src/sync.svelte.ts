import { createSubscriber } from 'svelte/reactivity'
import type { SendMessageRequest } from './api'
import {
  foldTopicName,
  MESSAGE_BODY_MAX,
  messageBodyError,
  TOPIC_NAME_MAX,
  topicNameError,
  type createSync,
  type ChannelComposerState,
  type TimelineState,
  type TopicComposerState,
} from './sync'

export { foldTopicName, MESSAGE_BODY_MAX, messageBodyError, TOPIC_NAME_MAX, topicNameError }
export type { ChannelComposerState, TimelineState, TopicComposerState }

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
  const subscribeComposer = createSubscriber(update => timeline.composer.subscribe(update))
  const topics = new Map<string, ReturnType<typeof topicAdapter>>()
  const replies = new Map<string, ReturnType<typeof replyAdapter>>()
  function topicAdapter(topicId: string) {
    const tc = timeline.topic(topicId)
    const subscribeTopicComposer = createSubscriber(update => tc.subscribe(update))
    return {
      get composer(): TopicComposerState {
        subscribeTopicComposer()
        return tc.get()
      },
      setDraft: (draft: string) => tc.setDraft(draft),
      submit: (topicName: string) => tc.submit(topicName),
      restore: (clientMessageId: string) => tc.restore(clientMessageId),
    }
  }
  function replyAdapter(replyRootId: string, topicId: string | null = null) {
    const rc = timeline.reply(replyRootId, topicId)
    const subscribeReplyComposer = createSubscriber(update => rc.subscribe(update))
    return {
      get composer(): TopicComposerState {
        subscribeReplyComposer()
        return rc.get()
      },
      setDraft: (draft: string) => rc.setDraft(draft),
      submit: (replyTo?: string) => rc.submit(replyTo),
      retry: (clientMessageId: string) => rc.retry(clientMessageId),
      restore: (clientMessageId: string) => rc.restore(clientMessageId),
      migrateDraftFrom: (fromReplyRootId: string, fromTopicId?: string | null) =>
        rc.migrateDraftFrom(fromReplyRootId, fromTopicId),
    }
  }
  return {
    get timeline(): TimelineState {
      subscribe()
      return timeline.get()
    },
    get composer(): ChannelComposerState {
      subscribeComposer()
      return timeline.composer.get()
    },
    /** The server confirmed this Channel's subscription (live indicator). */
    get live(): boolean {
      subscribe()
      return sync.get().channels[channel]?.subscription?.confirmed === true
    },
    loadLatest: () => timeline.loadLatest(),
    loadOlder: () => timeline.loadOlder(),
    setDraft: (draft: string) => timeline.setDraft(draft),
    setTopicDraft: (topicDraft: string) => timeline.setTopicDraft(topicDraft),
    submit: () => timeline.submit(),
    send: (body: string, target?: Pick<SendMessageRequest, 'topic_name' | 'reply_to'>) => timeline.send(body, target),
    retry: (clientMessageId: string) => timeline.retry(clientMessageId),
    restore: (clientMessageId: string) => timeline.restore(clientMessageId),
    discard: (clientMessageId: string) => timeline.discard(clientMessageId),
    topic(topicId: string) {
      let t = topics.get(topicId)
      if (!t) topics.set(topicId, (t = topicAdapter(topicId)))
      return t
    },
    reply(replyRootId: string, topicId: string | null = null) {
      const key = JSON.stringify([topicId, replyRootId])
      let r = replies.get(key)
      if (!r) replies.set(key, (r = replyAdapter(replyRootId, topicId)))
      return r
    },
  }
}
export type ChannelSync = ReturnType<typeof channelAdapter>

export function syncAdapter(sync: Sync) {
  const channels = new Map<string, ChannelSync>()
  const subscribe = createSubscriber(update => sync.subscribe(update))
  return {
    get unavailable() { subscribe(); return sync.get().organization === 'unavailable' },
    markUnavailable: () => sync.unavailable(),
    onUnavailable(listener: () => void) {
      return sync.subscribe(() => { if (sync.get().organization === 'unavailable') listener() })
    },
    hasUnsavedChanges: () => sync.hasUnsavedChanges(),
    channel(id: string): ChannelSync {
      let c = channels.get(id)
      if (!c) channels.set(id, (c = channelAdapter(sync, id)))
      return c
    },
  }
}
export type SyncAdapter = ReturnType<typeof syncAdapter>
