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
    selectHint: (id: string) => channels.selectHint(id),
    create: (name: string, visibility: 'public' | 'private') => channels.create({ name, visibility }),
  }
}
export type ChannelsAdapter = ReturnType<typeof channelsAdapter>
