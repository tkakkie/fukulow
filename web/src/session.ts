import { createChannels, type ChannelsApi } from './channels'
import { createSync, type SyncOptions } from './sync'

export type SessionOptions = {
  selfId: string
  /** Called when the session ends from the server side (401, 4001): the UI must go to Sign in. */
  onEnded: () => void
  /** Test seams for the transports; production uses the defaults. */
  channelsApi?: ChannelsApi
  sync?: Partial<SyncOptions>
}

/**
 * Controllers of one signed-in session, from Sign in to sign-out / 4001 (`close`). Their lifetime belongs to the
 * session, not to any UI that observes them: mounting or unmounting a view never starts or stops them. A new
 * session gets new controllers, so nothing of the old one can appear in it.
 * The only rule here is that the selected Channel is the watched one; all sync decisions stay in the controller.
 */
export function createSession(options: SessionOptions) {
  const sync = createSync({ ...options.sync, selfId: options.selfId, onSessionEnded: options.onEnded })
  const channels = createChannels(options.channelsApi)
  let watched: string | null = null
  const stopFollowing = channels.subscribe(() => {
    const id = channels.get().selectedId
    if (id === watched) return
    if (watched !== null) void sync.unwatch(watched)
    watched = id
    if (id !== null) void sync.watch(id)
  })
  void sync.start()
  void channels.load()
  return {
    sync,
    channels,
    close() {
      stopFollowing()
      channels.close()
      void sync.close()
    },
  }
}
export type Session = ReturnType<typeof createSession>
