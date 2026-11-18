import { RunBudget, budgetStorage } from './budget.ts'
import { runChecker } from '../../scripts/backup-r2-checker.ts'
import type { DurableStorage, Env } from './bindings.ts'
import { analyticsUsage, discordNotifier, type Fetch } from './http.ts'
import { CheckerLease } from './lease.ts'
import { backupAdapter, imagesAdapter } from './r2.ts'

export class BackupChecker {
  private storage: DurableStorage
  private busy = false
  private env: Env
  private runtime: { now?: () => number; request?: Fetch }
  constructor(state: { storage: DurableStorage }, env: Env, runtime: {
    now?: () => number; request?: Fetch
  } = {}) {
    this.env = env; this.runtime = runtime
    this.storage = state.storage
  }
  async fetch(): Promise<Response> {
    if (this.busy) return new Response(null, { status: 409 })
    this.busy = true
    const budget = new RunBudget()
    const lease = new CheckerLease(budgetStorage(this.storage, budget), this.runtime.now)
    try {
      const result = await lease.run(async (leaseGuard, store) => {
        const guard = async () => { budget.check(); await leaseGuard(); budget.check() }
        const notify = discordNotifier(this.env.DISCORD_WEBHOOK_URL, leaseGuard, this.runtime.request, undefined, undefined, budget)
        return runChecker({ lock: async work => work(), store, assertBudget: () => budget.check(),
          notifyBatch: events => notify(JSON.stringify({ event: 'checker-summary', events })),
          backups: backupAdapter(this.env.BACKUPS, guard, budget), images: imagesAdapter(this.env.IMAGES, guard, 10_000, budget),
          now: this.runtime.now ?? Date.now, notify,
          usage: analyticsUsage({ url: this.env.ANALYTICS_URL, token: this.env.ANALYTICS_TOKEN, account: this.env.ANALYTICS_ACCOUNT }, guard, this.runtime.request, budget) })
      })
      return new Response(null, { status: 'busy' in result ? 409 : 204 })
    } catch { return new Response('Checker failed (diagnostics suppressed)', { status: 500 }) }
    finally { this.busy = false }
  }
}
export default {
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const response = await env.CHECKER.get(env.CHECKER.idFromName('backup-checker')).fetch(new Request('https://checker.invalid/run', { method: 'POST' }))
    // Overlap is a safe no-op; other failures remain visible to platform monitoring.
    if (!response.ok && response.status !== 409) throw new Error('Checker failed (diagnostics suppressed)')
  },
}
