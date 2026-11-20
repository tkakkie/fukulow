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
      let cancel: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const { signal, channel, timeoutMs, onTimeout } = options
      const clear = () => {
        clearTimeout(timer)
        timer = undefined
        if (!cancel) return
        const fn = cancel
        cancel = undefined
        signal?.removeEventListener('abort', fn)
        pending.delete(fn)
      }
      const until = new Promise<T>(resolve => {
        if (signal?.aborted) {
          resolve(cancelled)
          return
        }
        cancel = () => {
          clear()
          resolve(cancelled)
        }
        pending.set(cancel, channel)
        signal?.addEventListener('abort', cancel, { once: true })
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            clear()
            let outcome = cancelled
            try {
              if (onTimeout) outcome = onTimeout()
            } finally {
              // Settle the wait even if onTimeout throws; let the error surface to the host.
              resolve(outcome)
            }
          }, timeoutMs)
        }
      })
      return { until, clear }
    },
    cancel(channel?: string) {
      for (const [cancel, owner] of pending) {
        if (channel !== undefined && owner !== channel) continue
        cancel()
      }
    },
  }
}
