import { decodeState, validState, type StateStore } from '../../scripts/backup-checker-state.ts'
import type { DurableStorage, Guard, StorageTransaction } from './bindings.ts'

export const jobDeadline = 10 * 60_000
// Longer than both our action deadline and the scheduled Worker's 15 min limit.
// A DO fetch itself has no such wall-time bound: the in-memory flag must also
// refuse takeover while any old job (including awaited R2 I/O) is still alive.
export const leaseDuration = 20 * 60_000
export const leaseKey = 'lease', stateKey = 'checker-state'
interface Lease { runId: string; expires: number }
function validLease(value: unknown): value is Lease {
  return !!value && typeof value === 'object' && Object.keys(value).sort().join() === 'expires,runId' &&
    'runId' in value && typeof value.runId === 'string' && !!value.runId &&
    'expires' in value && Number.isSafeInteger(value.expires)
}
export class CheckerLease {
  private busy = false
  private storage: DurableStorage
  private now: () => number
  private id: () => string
  constructor(storage: DurableStorage, now = Date.now, id: () => string = () => crypto.randomUUID()) {
    this.storage = storage; this.now = now; this.id = id
  }
  async run<T>(work: (guard: Guard, store: StateStore) => Promise<T>): Promise<{ busy: true } | { result: T }> {
    if (this.busy) return { busy: true }
    // Set synchronously, before even the first storage await.
    this.busy = true
    let runId: string | undefined
    let acquired = false
    try {
      runId = this.id()
      const started = this.now()
      acquired = await this.storage.transaction(async tx => {
        const old = await tx.get<unknown>(leaseKey)
        if (old !== undefined && !validLease(old)) throw new Error('Invalid checker lease')
        if (old !== undefined && (old as Lease).expires > this.now()) return false
        await tx.put(leaseKey, { runId, expires: started + leaseDuration })
        return true
      })
      if (!acquired) return { busy: true }
      const deadline = () => { if (this.now() >= started + jobDeadline) throw new Error('Checker deadline exceeded') }
      const fence = async (tx: StorageTransaction) => {
        deadline()
        const lease = await tx.get<unknown>(leaseKey)
        deadline()
        if (!validLease(lease) || lease.runId !== runId || lease.expires <= this.now()) throw new Error('Checker lease lost')
      }
      const guard = async () => { await fence(this.storage); deadline() }
      const store: StateStore = {
        load: () => this.storage.transaction(async tx => {
          await fence(tx)
          const state = await tx.get(stateKey)
          await fence(tx)
          return decodeState(state, this.now())
        }),
        save: state => this.storage.transaction(async tx => {
          await fence(tx)
          if (!validState(state)) throw new Error('Invalid checker state')
          // Lease check and write are one transaction: no awaited network gap.
          await tx.put(stateKey, { version: 1, state })
          await fence(tx)
        }),
      }
      return { result: await work(guard, store) }
    } finally {
      try {
        if (acquired) await this.storage.transaction(async tx => {
          const lease = await tx.get<unknown>(leaseKey)
          if (validLease(lease) && lease.runId === runId) await tx.delete(leaseKey)
        })
      } finally { this.busy = false }
    }
  }
}
