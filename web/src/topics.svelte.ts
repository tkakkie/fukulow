import { createSubscriber } from 'svelte/reactivity'
import type { Topics } from './topics'

/** Reactive reads and user intents only; the session owns the controller lifetime. */
export function topicsAdapter(topics: Topics, channel: string) {
  const subscribe = createSubscriber(update => topics.subscribe(update))
  return {
    get state() { subscribe(); return topics.get(channel) },
    loadMain: () => topics.loadMain(channel),
    loadList: () => topics.loadList(channel),
    loadTopic: (id: string) => topics.loadTopic(channel, id),
    loadSummary: (id: string) => topics.loadSummary(channel, id),
    ensureSummary: (id: string) => topics.ensureSummary(channel, id),
    retrySummary: (id: string) => topics.retrySummary(channel, id),
  }
}
export type TopicsAdapter = ReturnType<typeof topicsAdapter>
