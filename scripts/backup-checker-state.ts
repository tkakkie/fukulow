import { analyticsLag, validUsageCache, type UsageState } from './backup-usage-model.ts'
export const checkerAlerts = ['malformed-generations', 'stale-backup', 'insufficient-generations', 'drill-overdue', 'implausible-size', 'capacity-70', 'capacity-90', 'class-a-70', 'class-b-70', 'pruning-refused', 'pruning-guarded', 'operations-unknown', 'state-missing', 'state-corrupt', 'checker-failed', 'capacity-unknown'] as const
export interface CheckerState extends UsageState { aliveDate?: string; sentAlerts?: string[] }
export interface StateStore {
  load(): Promise<{ state: CheckerState; warning?: 'state-missing' | 'state-corrupt' }>
  save(state: CheckerState): Promise<void>
}
export function validState(state: CheckerState): boolean {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false
  if (Object.keys(state).some(key => key !== 'aliveDate' && key !== 'sentAlerts' && key !== 'usageCache')) return false
  if (state.usageCache !== undefined && !validUsageCache(state.usageCache)) return false
  if (state.aliveDate !== undefined && (typeof state.aliveDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(state.aliveDate) || !Number.isFinite(Date.parse(state.aliveDate)) || new Date(state.aliveDate).toISOString().slice(0, 10) !== state.aliveDate)) return false
  return Array.isArray(state.sentAlerts) && state.sentAlerts.length <= checkerAlerts.length && new Set(state.sentAlerts).size === state.sentAlerts.length && state.sentAlerts.every(a => checkerAlerts.includes(a as typeof checkerAlerts[number]))
}
export function decodeState(parsed: unknown, now?: number): Awaited<ReturnType<StateStore['load']>> {
  if (parsed === undefined) return { state: { sentAlerts: [] }, warning: 'state-missing' }
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || !('state' in parsed) ||
    parsed.version !== 1 || Object.keys(parsed).sort().join() !== 'state,version' || !validState(parsed.state as CheckerState) ||
    (now !== undefined && Object.keys((parsed.state as CheckerState).usageCache?.days ?? {}).some(date => Date.parse(date) + 86_400_000 + analyticsLag > now)))
    return { state: { sentAlerts: [] }, warning: 'state-corrupt' }
  return { state: parsed.state as CheckerState }
}
export type RunLock = <T>(work: () => Promise<T>) => Promise<T>
