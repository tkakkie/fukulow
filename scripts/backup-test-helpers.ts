import type { RunLock } from './backup-checker-state.ts'
import { SafeFailure } from './backup-safety.ts'

export function memoryRunLock(): RunLock {
  let busy = false
  return async work => {
    if (busy) throw new SafeFailure('lock', 'busy')
    busy = true
    try { return await work() } finally { busy = false }
  }
}
