import { RunBudget } from './budget.ts'
import { notificationText } from '../../scripts/backup-notification-text.ts'
import { defaultRetryDelayMs, discordAttempts, discordOutcome, retryAfterDelayMs } from '../../scripts/backup-discord-retry.ts'
import { accountUsage } from '../../scripts/backup-usage-model.ts'
import type { Guard } from './bindings.ts'

export type Fetch = typeof fetch
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function https(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid HTTP configuration')
  return url.href
}
export function discordNotifier(url: string, guard: Guard, request: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = pause, now = Date.now, budget = new RunBudget()) {
  return async (event: string): Promise<void> => {
    let content: string
    try { content = notificationText(event) } catch { throw new Error('Notification failed category=event') }
    for (let attempt = 0; attempt < discordAttempts; attempt++) {
      await guard()
      budget.external(event === 'checker-failed')
      let status = 0, delay = defaultRetryDelayMs
      try {
        const response = await request(https(url), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(30_000) })
        status = response.status
        delay = retryAfterDelayMs(response.headers.get('retry-after'), now)
        await response.body?.cancel()
      } catch { /* Raw transport diagnostics and URLs never leave this adapter. */ }
      await guard()
      const outcome = discordOutcome(status)
      if (outcome === 'delivered') return
      if (outcome !== 'retry') throw new Error(`Notification failed category=${outcome}`)
      if (attempt < discordAttempts - 1) { await sleep(delay); await guard() }
    }
    throw new Error('Notification failed category=unavailable')
  }
}
export function analyticsUsage(config: { url: string; token: string; account: string }, guard: Guard, request: Fetch = fetch, budget = new RunBudget()) {
  return accountUsage({ async query(body) {
    try {
      await guard()
      if (!config.token) throw new Error('Missing analytics secret')
      budget.external()
      const response = await request(https(config.url), { method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
      await guard()
      if (!response.ok) { await response.body?.cancel(); throw new Error('Analytics unavailable') }
      const result: unknown = await response.json()
      await guard()
      return result
    } catch { throw new Error('Account operation usage unavailable') }
  } }, config.account)
}
