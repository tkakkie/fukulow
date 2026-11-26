import type { createAuthors } from './authors'
import type { createChannels } from './channels'
import type { createSync } from './sync'

export function watchAuthorScope(
  channels: Pick<ReturnType<typeof createChannels>, 'get' | 'subscribe'>,
  sync: Pick<ReturnType<typeof createSync>, 'get' | 'subscribe' | 'onActivity'>,
  authors: Pick<ReturnType<typeof createAuthors>, 'confirmInitialSubscription' | 'invalidate' | 'retry' | 'selectChannel'>,
) {
  function scope() {
    const selection = channels.get().selectedId
    const state = sync.get()
    const channel = selection === null ? undefined : state.channels[selection]
    return {
      selection,
      connection: state.connection,
      connected: state.connected,
      historyEpoch: state.historyEpoch,
      cursor: channel?.cursor ?? null,
      unavailable: channel?.state === 'unavailable',
      confirmed: channel?.subscription?.confirmed === true,
    }
  }
  let previous = scope()
  let initial = !previous.confirmed
  function invalidate() {
    initial = false
    authors.invalidate()
  }
  function update() {
    const before = previous
    const next = scope()
    previous = next
    const changedSelection = before.selection !== next.selection
    if (changedSelection) {
      if (before.selection !== null) initial = false
      authors.selectChannel(next.selection)
    }
    if (before.connection !== next.connection || (before.connected && !next.connected) ||
        before.historyEpoch !== next.historyEpoch || (!changedSelection &&
          ((before.cursor !== null && next.cursor === null) || (!before.unavailable && next.unavailable)))) {
      invalidate()
    }
    if (next.confirmed && (!before.confirmed || changedSelection)) {
      if (initial && next.connection !== null) authors.confirmInitialSubscription()
      else authors.retry()
      initial = false
    }
  }

  const stopSelection = channels.subscribe(update)
  const stopSync = sync.subscribe(update)
  const stopActivity = sync.onActivity(notice => {
    if (notice.type === 'channel_access_revoked' && notice.channel_id === previous.selection) invalidate()
  })
  return () => { stopSelection(); stopSync(); stopActivity() }
}
