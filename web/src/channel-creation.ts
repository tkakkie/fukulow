import type { FencedInvalidation } from './activity'
import type { Channel, CreateChannelRequest } from './api'

export type ChannelCreationAccess = 'allowed' | 'revalidating' | 'hidden' | 'denied'
export type ChannelCreationBlocked = { blocked: 'access-changed' | 'denied' | 'check-failed' }
type CreateResult = { channel: Channel } | { error: string }
type SubmissionResult = CreateResult | ChannelCreationBlocked | false

/** Keep the creation affordance stable while a routine check fences writes. */
export function createChannelCreation(allowed: boolean, create: (draft: CreateChannelRequest) => Promise<CreateResult>) {
  let access: ChannelCreationAccess = allowed ? 'allowed' : 'denied'
  let closed = false
  let held: { draft: CreateChannelRequest; signal?: AbortSignal; resolve(result: SubmissionResult | Promise<CreateResult>): void } | undefined
  const listeners = new Set<() => void>()

  function setAccess(next: ChannelCreationAccess) {
    if (access === next) return
    access = next
    listeners.forEach(listener => listener())
  }

  function takeHeld() {
    const submission = held
    held = undefined
    submission?.signal?.removeEventListener('abort', cancel)
    return submission
  }

  function cancel() { takeHeld()?.resolve(false) }

  function hide(reason: ChannelCreationBlocked['blocked']) {
    if (access !== 'denied') setAccess('hidden')
    takeHeld()?.resolve({ blocked: reason })
  }

  return {
    get: () => access,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    invalidate(reason: FencedInvalidation) {
      if (closed) return
      if (reason === 'access') hide('access-changed')
      else if (access === 'allowed') setAccess('revalidating')
    },
    confirm(allowed: boolean) {
      if (closed) return
      setAccess(allowed ? 'allowed' : 'denied')
      const submission = takeHeld()
      if (!submission) return
      // Consume the hold inside the generation-checked /me acceptance, before yielding.
      submission.resolve(allowed ? create(submission.draft) : { blocked: 'denied' })
    },
    failed() { if (!closed) hide('check-failed') },
    submit(draft: CreateChannelRequest, signal?: AbortSignal): Promise<SubmissionResult> {
      if (closed || signal?.aborted || held) return Promise.resolve(false)
      if (access === 'allowed') return create(draft)
      if (access !== 'revalidating') {
        return Promise.resolve({ blocked: access === 'hidden' ? 'access-changed' : 'denied' })
      }
      return new Promise(resolve => {
        held = { draft, signal, resolve }
        signal?.addEventListener('abort', cancel, { once: true })
      })
    },
    close() {
      closed = true
      setAccess('denied')
      cancel()
    },
  }
}
export type ChannelCreation = ReturnType<typeof createChannelCreation>
