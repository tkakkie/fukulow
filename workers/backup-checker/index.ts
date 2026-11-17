import { runChecker } from '../../scripts/backup-r2-checker.ts'
import type { DurableStorage, Env } from './bindings.ts'
import { analyticsUsage, discordNotifier, type Fetch } from './http.ts'
import { CheckerLease } from './lease.ts'
import { backupAdapter, imagesAdapter } from './r2.ts'

export class BackupChecker {
  private lease: CheckerLease
  private env: Env
  private runtime: { now?: () => number; request?: Fetch }
  constructor(state: { storage: DurableStorage }, env: Env, runtime: {
    now?: () => number; request?: Fetch
  } = {}) {
    this.env = env; this.runtime = runtime
    this.lease = new CheckerLease(state.storage, runtime.now)
  }
  async fetch(): Promise<Response> {
    try {
      const result = await this.lease.run(async (guard, store) => {
        const notify = discordNotifier(this.env.DISCORD_WEBHOOK_URL, guard, this.runtime.request)
        return runChecker({ lock: async work => work(), store,
          backups: backupAdapter(this.env.BACKUPS, guard), images: imagesAdapter(this.env.IMAGES, guard),
          now: this.runtime.now ?? Date.now, notify,
          usage: analyticsUsage({ url: this.env.ANALYTICS_URL, token: this.env.ANALYTICS_TOKEN, account: this.env.ANALYTICS_ACCOUNT }, guard, this.runtime.request) })
      })
      return new Response(null, { status: 'busy' in result ? 409 : 204 })
    } catch { return new Response('Checker failed (diagnostics suppressed)', { status: 500 }) }
  }
}
export default {
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const response = await env.CHECKER.get(env.CHECKER.idFromName('backup-checker')).fetch(new Request('https://checker.invalid/run', { method: 'POST' }))
    // Overlap is a safe no-op; other failures remain visible to platform monitoring.
    if (!response.ok && response.status !== 409) throw new Error('Checker failed (diagnostics suppressed)')
  },
}
