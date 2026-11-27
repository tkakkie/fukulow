// Pure Discord webhook status and Retry-After rules shared by the Node notifier and the Worker (no I/O, no timers).
export type DiscordOutcome = 'delivered' | 'retry' | 'rejected' | 'response'

export const discordAttempts = 3
export const defaultRetryDelayMs = 1000
export const maxRetryDelayMs = 30_000

// Status 0 means no response (transport failure); NaN from an unparsable status line also retries.
export function discordOutcome(status: number): DiscordOutcome {
  if (status >= 200 && status < 300) return 'delivered'
  if (status >= 400 && status < 500 && status !== 429) return 'rejected'
  if (status !== 0 && status !== 429 && status < 500) return 'response'
  return 'retry'
}

// Retry-After as delta-seconds (fractions allowed) or HTTP-date; missing or unparsable keeps the default.
// `now` is read only for HTTP-dates.
export function retryAfterDelayMs(value: string | null | undefined, now: () => number): number {
  if (!value) return defaultRetryDelayMs
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now()
  return Number.isFinite(delay) ? Math.max(0, Math.min(maxRetryDelayMs, delay)) : defaultRetryDelayMs
}
