import type { Result } from './api'
import type { ChannelState } from './protocol-types'
import type { createSync } from './sync'

type AccessObserver = Pick<ReturnType<typeof createSync>, 'reportAccess' | 'close' | 'unavailable'>

/** Observe C6 and C10 on the transport promise, even when the caller stops waiting. */
export function observeReadAccess(
  sync: AccessObserver,
  operation: Promise<Result<unknown>>,
  startedSession: number,
  currentSession: () => number,
): void {
  void operation.then(result => {
    if (startedSession === currentSession()) sync.reportAccess(result, sync)
  })
}

export function isBelowMutationFloor(
  asOfSeq: number,
  startedMutationSeq: number,
  channel: Pick<ChannelState, 'mutationSeq' | 'moveSeq'> | undefined,
): boolean {
  const mutationSeq = channel?.mutationSeq ?? 0
  // The current mutation only fences reads already in flight. The Move floor also covers new reads.
  const floor = startedMutationSeq < mutationSeq ? mutationSeq : channel?.moveSeq ?? 0
  return asOfSeq < floor
}
