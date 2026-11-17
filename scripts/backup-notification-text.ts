import { checkerAlerts } from './backup-checker-state.ts'
import { validUsage } from './backup-usage-model.ts'

const events: readonly string[] = [...checkerAlerts, 'backup-failed', 'daily-readback-failed']
// Reconstruct every message; never forward caller text, even for alive JSON.
export function notificationText(event: string): string {
  if (events.includes(event)) return `Fukulow backup: ${event}.`
  const value = JSON.parse(event)
  const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  const capture = value?.newestCapture === null ? null : Date.parse(value?.newestCapture)
  if (value?.event !== 'checker-alive' || (capture !== null && !numeric(capture)) ||
    !['backupBytes', 'imageBytes', 'total', 'percentage'].every(key => numeric(value[key])) ||
    (value.operations !== null && !validUsage(value.operations))) throw new Error('Notification failed category=event')
  return `Fukulow backup: checker-alive. newestCapture=${capture} backupBytes=${value.backupBytes} imageBytes=${value.imageBytes} total=${value.total} percentage=${value.percentage} classA=${value.operations?.classA ?? null} classB=${value.operations?.classB ?? null}`
}
