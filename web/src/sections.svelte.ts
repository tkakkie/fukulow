import { createSubscriber } from 'svelte/reactivity'
import type { ChannelOrder, CreateSection, MoveChannel, RenameSection, SectionOrder } from './api'
import type { Sections, SectionsState } from './sections'

export type { SectionGroup, SectionResult, Sections, SectionsState } from './sections'

/**
 * Maps the personal sections controller to reactive reads and forwards user intents.
 * `createSubscriber` only notifies Svelte when to re-read and releases its listener with the last observer.
 */
export function sectionsAdapter(sections: Sections) {
  const subscribe = createSubscriber(update => sections.subscribe(update))
  return {
    get state(): SectionsState {
      subscribe()
      return sections.get()
    },
    retry: () => sections.retry(),
    create: (body: CreateSection) => sections.create(body),
    rename: (id: string, body: RenameSection) => sections.rename(id, body),
    reorder: (body: SectionOrder) => sections.reorder(body),
    moveChannel: (channel: string, body: MoveChannel) => sections.moveChannel(channel, body),
    reorderChannels: (body: ChannelOrder) => sections.reorderChannels(body),
    delete: (id: string) => sections.delete(id),
  }
}
export type SectionsAdapter = ReturnType<typeof sectionsAdapter>
