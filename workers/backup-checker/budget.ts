import type { DurableStorage, StorageTransaction } from './bindings.ts'

// Three external attempts and eighty internal operations remain for reporting,
// fenced state persistence and lease release after normal work stops.
export const externalLimit = 12, failureAttempts = 3
export const internalLimit = 800, internalWorkLimit = 720
export class RunBudget {
  externalUsed = 0
  internalUsed = 0
  private exhausted = false
  external(failure = false) {
    if (this.externalUsed >= externalLimit - (failure ? 0 : failureAttempts)) {
      this.exhausted = true
      throw new Error('External fetch budget exhausted')
    }
    this.externalUsed++
  }
  internal(work = false) {
    if (this.internalUsed >= (work ? internalWorkLimit : internalLimit)) {
      this.exhausted = true
      throw new Error('Internal operation budget exhausted')
    }
    this.internalUsed++
  }
  imagePageAvailable() { return this.internalUsed + 4 <= internalWorkLimit }
  check() { if (this.internalUsed >= internalWorkLimit) this.exhausted = true; if (this.exhausted) throw new Error('Checker budget exhausted') }
}
// Count storage calls too, conservatively including transaction entry. Local
// SQLite calls need not consume provider subrequests; counting them is safer.
export function budgetStorage(storage: DurableStorage, budget: RunBudget): DurableStorage {
  const wrap = (tx: StorageTransaction): StorageTransaction => ({
    async get<T>(key: string) { budget.internal(); return tx.get<T>(key) },
    async put<T>(key: string, value: T) { budget.internal(); return tx.put(key, value) },
    async delete(key: string) { budget.internal(); return tx.delete(key) },
  })
  return { ...wrap(storage), async transaction<T>(body: (tx: StorageTransaction) => Promise<T>) {
    budget.internal()
    return storage.transaction(tx => body(wrap(tx)))
  } }
}
