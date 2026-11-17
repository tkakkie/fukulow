import { notificationText } from '../../scripts/backup-notification-text.ts'
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
  sleep: (ms: number) => Promise<void> = pause, now = Date.now) {
  return async (event: string): Promise<void> => {
    let content: string
    try { content = notificationText(event) } catch { throw new Error('Notification failed category=event') }
    for (let attempt = 0; attempt < 3; attempt++) {
      await guard()
      let status = 0, delay = 1000
      try {
        const response = await request(https(url), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(30_000) })
        status = response.status
        const retry = response.headers.get('retry-after')
        if (retry) {
          const parsed = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now()
          if (Number.isFinite(parsed)) delay = Math.max(0, Math.min(30_000, parsed))
        }
        await response.body?.cancel()
      } catch { /* Raw transport diagnostics and URLs never leave this adapter. */ }
      await guard()
      if (status >= 200 && status < 300) return
      if (status >= 400 && status < 500 && status !== 429) throw new Error('Notification failed category=rejected')
      if (status !== 0 && status !== 429 && status < 500) throw new Error('Notification failed category=response')
      if (attempt < 2) { await sleep(delay); await guard() }
    }
    throw new Error('Notification failed category=unavailable')
  }
}
export function analyticsUsage(config: { url: string; token: string; account: string }, guard: Guard, request: Fetch = fetch) {
  return accountUsage({ async query(body) {
    try {
      await guard()
      if (!config.token) throw new Error('Missing analytics secret')
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
