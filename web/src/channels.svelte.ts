import { createSubscriber } from 'svelte/reactivity'
import { channelNameTooLong, type ChannelsState, type createChannels } from './channels'

export { channelNameTooLong, type Channel, type ChannelVisibility } from './channels'

type Channels = ReturnType<typeof createChannels>

/**
 * Maps the Channel list controller to reactive reads and forwards user intents. Reads go to the controller;
 * `createSubscriber` only tells Svelte when to read again and releases its listener with the last observer.
 */
export function channelsAdapter(channels: Channels) {
  const subscribe = createSubscriber(update => channels.subscribe(update))
  return {
    get state(): ChannelsState {
      subscribe()
      return channels.get()
    },
    load: () => channels.load(),
    select: (id: string) => channels.select(id),
    /** Returns an error message, or null when the Channel was created. */
    async create(name: string, visibility: 'public' | 'private'): Promise<string | null> {
      const r = await channels.create({ name, visibility })
      return 'error' in r ? r.error : null
    },
  }
}
export type ChannelsAdapter = ReturnType<typeof channelsAdapter>
