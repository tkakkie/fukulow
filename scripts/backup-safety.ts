import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const stages = ['arguments', 'directory', 'lock', 'sweep', 'version', 'dump', 'archive-sync', 'list', 'publish', 'directory-sync', 'cleanup', 'image', 'start', 'ready', 'restore', 'sessions', 'integrity'] as const
export type Stage = typeof stages[number]
const categories = ['operation', 'permission', 'missing', 'space', 'io', 'busy'] as const
type Category = typeof categories[number]
export class SafeFailure extends Error {
  stage: Stage
  category: Category
  constructor(stage: Stage, category: Category) {
    super(`stage=${stage} category=${category}`)
    this.stage = stage; this.category = category
  }
}
export function safeFailure(stage: Stage, error: unknown): SafeFailure {
  // Inspect only an OS code; never stringify an error, cause, command or path.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const category = code === 'EACCES' || code === 'EPERM' ? 'permission' : code === 'ENOENT' ? 'missing'
    : code === 'ENOSPC' ? 'space' : code === 'EIO' ? 'io' : code === 'EEXIST' ? 'busy' : 'operation'
  return new SafeFailure(stage, category)
}
export function diagnostic(error: unknown): string {
  // Revalidate even SafeFailure fields: callers can mutate objects at runtime.
  if (error instanceof SafeFailure && stages.includes(error.stage) && categories.includes(error.category)) {
    return `stage=${error.stage} category=${error.category}`
  }
  return 'stage=arguments category=operation'
}
export function privateDirectory(directory: string): string {
  const destination = resolve(directory)
  mkdirSync(destination, { mode: 0o700, recursive: true })
  const info = lstatSync(destination)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error('Private directory required')
  return destination
}
export function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

// A crash leaves the lock in place. Never reap by age or PID: a suspended owner
// (or a different host) may still be running. Recovery requires quiescing writers.
const heldLocalLocks = new WeakMap<() => void, string>()
export function assertLocalLock(directory: string, release: () => void): void {
  if (heldLocalLocks.get(release) !== resolve(directory)) throw new SafeFailure('lock', 'busy')
}
export function acquireLocalLock(directory: string): () => void {
  const path = join(directory, '.backup-run.lock')
  const fd = openSync(path, 'wx', 0o600)
  try { fsyncSync(fd); syncDirectory(directory) } catch (error) { closeSync(fd); throw error }
  const release = () => {
    heldLocalLocks.delete(release)
    closeSync(fd); rmSync(path); syncDirectory(directory)
  }
  heldLocalLocks.set(release, resolve(directory))
  return release
}

// Called only under the same exclusive local lock as every backup writer.
export function sweepPartials(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (!/^\.partial-(?:age-)?[A-Za-z0-9]{6}$/.test(name)) continue
    const path = join(directory, name), info = lstatSync(path)
    if (info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700) rmSync(path, { recursive: true })
  }
}

export type RunLock = <T>(work: () => Promise<T>) => Promise<T>
// Used by local checker fakes; production checker uses a Durable Object lease.
export function memoryRunLock(): RunLock {
  let busy = false
  return async work => {
    if (busy) throw new SafeFailure('lock', 'busy')
    busy = true
    try { return await work() } finally { busy = false }
  }
}
