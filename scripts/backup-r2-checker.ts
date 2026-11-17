import { day, inventory, type BackupBucket, type Generation, type ObjectInfo } from './backup-r2-inventory.ts'
import { type RunLock } from './backup-checker-state.ts'
import { type CheckerState, type StateStore } from './backup-checker-state.ts'
import { validUsage, type UsageClient, type OperationUsage } from './backup-usage-model.ts'

export type { CheckerState } from './backup-checker-state.ts'
interface CheckOptions {
  backups: BackupBucket; images: { list(): Promise<ObjectInfo[]> }; now: () => number
  notify: (event: string) => Promise<void>; state: CheckerState; usage: UsageClient
  persist?: (state: CheckerState) => Promise<void>
  initialAlerts?: string[]; freeze?: boolean
}
export async function checkBackups(options: {
  lock: RunLock
} & CheckOptions) {
  try { return await options.lock(() => checkLocked(options)) }
  catch {
    try { await options.notify('checker-failed') } catch { /* Keep notification diagnostics private. */ }
    throw new Error('Checker failed (diagnostics suppressed)')
  }
}
export async function runChecker(options: Omit<CheckOptions, 'state' | 'persist' | 'initialAlerts' | 'freeze'> & { lock: RunLock; store: StateStore }) {
  try {
    return await options.lock(async () => {
      const loaded = await options.store.load()
      return checkLocked({ ...options, state: loaded.state, persist: state => options.store.save(state),
        initialAlerts: loaded.warning ? [loaded.warning] : [], freeze: !!loaded.warning })
    })
  } catch {
    try { await options.notify('checker-failed') } catch { /* Keep notification diagnostics private. */ }
    throw new Error('Checker failed (diagnostics suppressed)')
  }
}
async function checkLocked(options: CheckOptions) {
  const now = options.now(), alerts: string[] = [...options.initialAlerts ?? []], deleted: string[] = []
  const persist = () => options.persist?.(options.state)
  const alert = async (event: string) => {
    if (options.state.sentAlerts?.includes(event)) return
    await options.notify(event)
    options.state.sentAlerts = [...options.state.sentAlerts ?? [], event]
    await persist()
  }
  let operations: OperationUsage | null = null
  try {
    const value = await options.usage.read(now)
    if (validUsage(value)) operations = { classA: value.classA, classB: value.classB }
  } catch { /* Unknown usage must alert, never become zero. */ }
  if (!operations) alerts.push('operations-unknown')
  const data = await inventory(options.backups, now)
  const backups = data.verified.filter(g => g.prefix.startsWith('backups/'))
  const completionTime = (g: Generation) => Math.max(...g.objects.map(o => o.uploaded))
  const drills = data.verified.filter(g => g.prefix.startsWith('restore-verified/'))
    .sort((a, b) => completionTime(b) - completionTime(a) || b.prefix.localeCompare(a.prefix))
  const latest = backups[0], drill = drills[0]
  if (data.malformed.length) alerts.push('malformed-generations')
  const stale = !latest || now - Date.parse(latest.manifest.captureTime) >= day
  if (stale) alerts.push('stale-backup')
  if (backups.length < 30) alerts.push('insufficient-generations')
  if (!drill || now - completionTime(drill) >= 35 * day) alerts.push('drill-overdue')
  if (backups.length >= 8) {
    const sizes = backups.slice(1, 8).map(g => g.manifest.ciphertext.size).sort((a, b) => a - b)
    if (latest.manifest.ciphertext.size < sizes[3] / 2 || latest.manifest.ciphertext.size > sizes[3] * 2) alerts.push('implausible-size')
  }
  const images = await options.images.list()
  const backupBytes = data.objects.reduce((sum, o) => sum + o.size, 0)
  const imageBytes = images.reduce((sum, o) => sum + o.size, 0)
  const total = backupBytes + imageBytes, percentage = total / 10_000_000_000 * 100
  if (percentage >= 70) alerts.push('capacity-70')
  if (percentage >= 90) alerts.push('capacity-90')
  if (operations && operations.classA >= 700_000) alerts.push('class-a-70')
  if (operations && operations.classB >= 7_000_000) alerts.push('class-b-70')
  // All deletion is frozen on unsafe inventory, not just the backup prefix.
  if (options.freeze || !operations || stale || backups.length < 30 || data.malformed.length) alerts.push('pruning-refused')
  else {
    const candidates: Generation[] = []
    for (const generation of backups.slice(30)) {
      if (drill && generation.manifest.captureTime === drill.manifest.captureTime) continue
      if (generation.objects.every(o => now - o.uploaded >= 35 * day)) candidates.push(generation)
    }
    for (const generation of drills.slice(1)) {
      if (generation.objects.every(o => now - o.uploaded >= 40 * day)) candidates.push(generation)
    }
    for (const generation of candidates.slice(0, 5)) {
      // Remove marker first so interruption cannot leave a verified partial generation.
      for (const name of ['verified.json', 'manifest.json', 'archive.dump.age']) await options.backups.delete(generation.prefix + name)
      deleted.push(generation.prefix)
    }
    if (!candidates.length && backups.length > 30) alerts.push('pruning-guarded')
  }
  for (const event of alerts) await alert(event)
  const date = new Date(now).toISOString().slice(0, 10)
  if (options.state.aliveDate !== date) {
    await options.notify(JSON.stringify({ event: 'checker-alive', newestCapture: latest?.manifest.captureTime ?? null,
      backupBytes, imageBytes, total, percentage, operations }))
    options.state.aliveDate = date
    await persist()
  }
  options.state.sentAlerts = alerts
  await persist()
  return { alerts, deleted, backupBytes, imageBytes, total }
}
