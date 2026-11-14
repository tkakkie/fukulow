import { day, inventory, type BackupBucket, type Generation, type ObjectInfo } from './backup-r2-model.ts'

export interface CheckerState { aliveDate?: string }
export async function checkBackups(options: {
  backups: BackupBucket; images: { list(): Promise<ObjectInfo[]> }; now: () => number
  notify: (event: string) => Promise<void>; state: CheckerState
  operations: { classA: number; classB: number }
}) {
  const now = options.now(), alerts: string[] = [], deleted: string[] = []
  try {
    const data = await inventory(options.backups, now)
    const backups = data.verified.filter(g => g.prefix.startsWith('backups/'))
    const drills = data.verified.filter(g => g.prefix.startsWith('restore-verified/'))
    const latest = backups[0], drill = drills[0]
    if (data.malformed.length) alerts.push('malformed-generations')
    const stale = !latest || now - Date.parse(latest.manifest.captureTime) >= day
    if (stale) alerts.push('stale-backup')
    if (backups.length < 30) alerts.push('insufficient-generations')
    if (!drill || now - Math.max(...drill.objects.map(o => o.uploaded)) >= 35 * day) alerts.push('drill-overdue')
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
    if (options.operations.classA >= 700_000) alerts.push('class-a-70')
    if (options.operations.classB >= 7_000_000) alerts.push('class-b-70')
    // All deletion is frozen on unsafe inventory, not just the backup prefix.
    if (stale || backups.length < 30 || data.malformed.length) alerts.push('pruning-refused')
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
    for (const alert of alerts) await options.notify(alert)
    const date = new Date(now).toISOString().slice(0, 10)
    if (options.state.aliveDate !== date) {
      await options.notify(JSON.stringify({ event: 'checker-alive', newestCapture: latest?.manifest.captureTime ?? null,
        backupBytes, imageBytes, total, percentage, operations: options.operations }))
      options.state.aliveDate = date
    }
    return { alerts, deleted, backupBytes, imageBytes, total }
  } catch {
    try { await options.notify('checker-failed') } catch { /* Keep notification diagnostics private. */ }
    throw new Error('Checker failed (diagnostics suppressed)')
  }
}
