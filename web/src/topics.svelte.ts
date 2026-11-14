import { createSubscriber } from 'svelte/reactivity'
import type { Topics } from './topics'

/** Reactive reads and user intents only; the session owns the controller lifetime. */
export function topicsAdapter(topics: Topics, channel: string) {
  const subscribe = createSubscriber(update => topics.subscribe(update, channel))
  return {
    get state() { subscribe(); return topics.get(channel) },
    loadMain: () => topics.loadMain(channel),
    loadMainLatest: () => topics.loadMainLatest(channel),
    loadList: () => topics.loadList(channel),
    loadTopic: (id: string) => topics.loadTopic(channel, id),
    loadTopicLatest: (id: string) => topics.loadTopicLatest(channel, id),
    releaseTopic: (id: string) => topics.releaseTopic(channel, id),
    setMainPinned: (pinned: boolean) => topics.setMainPinned(channel, pinned),
    setTopicPinned: (id: string, pinned: boolean) => topics.setTopicPinned(channel, id, pinned),
    loadSummary: (id: string) => topics.loadSummary(channel, id),
    ensureSummary: (id: string) => topics.ensureSummary(channel, id),
    retrySummary: (id: string) => topics.retrySummary(channel, id),
  }
}
export type TopicsAdapter = ReturnType<typeof topicsAdapter>
