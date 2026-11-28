import type { Result } from './api'
import { createRequestDeadlines } from './request-deadlines'

const REQUEST_TIMEOUT_MS = 10_000
const networkFailure = { ok: false, kind: 'network' } as const

export type SearchRequest = {
  isCurrent(): boolean
  run<T>(read: (signal: AbortSignal) => Promise<Result<T>>): Promise<Result<T>>
}

type Operation = {
  key: string
  cancelled: boolean
  transport?: AbortController
  execute(): Promise<void>
  discard(): void
}

export function createSearchRequestControl() {
  const deadlines = createRequestDeadlines()
  const queue: Operation[] = []
  let active: Operation | undefined

  function drain() {
    if (active) return
    const next = queue.shift()
    if (!next) return
    active = next
    void next.execute()
  }

  return {
    enqueue(key: string, execute: (request: SearchRequest) => Promise<void>, onTimeout: () => void) {
      if ((active?.key === key && !active.cancelled) || queue.some(op => op.key === key)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const expiresAt = performance.now() + REQUEST_TIMEOUT_MS
        const expire = () => {
          const notify = !entry.cancelled
          entry.cancelled = true
          entry.transport?.abort()
          const index = queue.indexOf(entry)
          if (index !== -1) {
            queue.splice(index, 1)
            resolve()
          }
          if (notify) onTimeout()
          return networkFailure
        }
        const deadline = deadlines.start(networkFailure, { timeoutMs: REQUEST_TIMEOUT_MS, onTimeout: expire })
        const entry: Operation = {
          key,
          cancelled: false,
          async execute() {
            try {
              // A preceding operation can release the slot before this operation's timer callback runs.
              if (performance.now() >= expiresAt) {
                expire()
                resolve()
                return
              }
              await execute({
                isCurrent: () => !entry.cancelled,
                async run(read) {
                  if (entry.cancelled) return networkFailure
                  const controller = entry.transport = new AbortController()
                  const transport = Promise.resolve().then(() =>
                    controller.signal.aborted ? networkFailure : read(controller.signal),
                  ).catch(() => networkFailure)
                  try {
                    return await Promise.race([transport, deadline.until])
                  } finally {
                    entry.transport = undefined
                  }
                },
              })
              resolve()
            } catch (error) {
              reject(error)
            } finally {
              deadline.clear()
              active = undefined
              drain()
            }
          },
          discard() {
            deadline.clear()
            resolve()
          },
        }
        queue.push(entry)
        drain()
      })
    },
    cancel() {
      for (const op of queue.splice(0)) op.discard()
      if (!active) return
      // Fence the result now, but keep its slot until the transport settles or its deadline releases it.
      active.cancelled = true
      active.transport?.abort()
    },
  }
}
