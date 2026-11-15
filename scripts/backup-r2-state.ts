import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { privateDirectory, syncDirectory } from './backup-safety.ts'

export const checkerAlerts = ['malformed-generations', 'stale-backup', 'insufficient-generations', 'drill-overdue', 'implausible-size', 'capacity-70', 'capacity-90', 'class-a-70', 'class-b-70', 'pruning-refused', 'pruning-guarded', 'operations-unknown', 'state-missing', 'state-corrupt', 'checker-failed'] as const
export interface CheckerState { aliveDate?: string; sentAlerts?: string[] }
export interface StateStore {
  load(): Promise<{ state: CheckerState; warning?: 'state-missing' | 'state-corrupt' }>
  save(state: CheckerState): Promise<void>
}
function valid(state: CheckerState): boolean {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false
  if (Object.keys(state).some(key => key !== 'aliveDate' && key !== 'sentAlerts')) return false
  if (state.aliveDate !== undefined && (typeof state.aliveDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(state.aliveDate) || new Date(state.aliveDate).toISOString().slice(0, 10) !== state.aliveDate)) return false
  return Array.isArray(state.sentAlerts) && state.sentAlerts.length <= checkerAlerts.length && new Set(state.sentAlerts).size === state.sentAlerts.length && state.sentAlerts.every(a => checkerAlerts.includes(a as typeof checkerAlerts[number]))
}
export function fileStateStore(path: string, sync = syncDirectory): StateStore {
  const directory = dirname(path)
  return {
    async load() {
      privateDirectory(directory)
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 16_384) throw new Error('Invalid state file')
          const parsed = JSON.parse(await handle.readFile('utf8'))
          if (parsed?.version !== 1 || Object.keys(parsed).sort().join() !== 'state,version' || !valid(parsed.state)) throw new Error('Invalid state')
          return { state: parsed.state }
        } finally { await handle.close() }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { state: { sentAlerts: [] }, warning: 'state-missing' }
        return { state: { sentAlerts: [] }, warning: 'state-corrupt' }
      }
    },
    async save(state) {
      privateDirectory(directory)
      if (!valid(state)) throw new Error('Invalid checker state')
      // Refuse symlinks and unsafe files even though rename would replace them.
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Unsafe state destination')
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error('State persistence failed')
      }
      const temporary = join(directory, `.checker-state-${randomUUID()}`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ version: 1, state })); await handle.sync() } finally { await handle.close() }
        await rename(temporary, path)
        sync(directory)
      } catch { throw new Error('State persistence failed') }
      finally { await rm(temporary, { force: true }) }
    },
  }
}
