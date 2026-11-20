/** Ends the caller's wait. The transport and its response observers keep running. */
export function createRequestDeadlines() {
  const pending = new Map<() => void, string | undefined>()
  return {
    start<T>(cancelled: T, options: {
      timeoutMs?: number
      onTimeout?: () => T
      channel?: string
      signal?: AbortSignal
    }) {
      let cancel!: () => void
      let timer: ReturnType<typeof setTimeout> | undefined
      const { signal, channel, timeoutMs, onTimeout } = options
      const until = new Promise<T>(resolve => {
        cancel = () => {
          clearTimeout(timer)
          resolve(cancelled)
        }
        pending.set(cancel, channel)
        if (signal?.aborted) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
        if (timeoutMs !== undefined) timer = setTimeout(() => resolve(onTimeout ? onTimeout() : cancelled), timeoutMs)
      })
      return {
        until,
        clear() {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          pending.delete(cancel)
        },
      }
    },
    cancel(channel?: string) {
      for (const [cancel, owner] of pending) {
        if (channel !== undefined && owner !== channel) continue
        pending.delete(cancel)
        cancel()
      }
    },
  }
}
