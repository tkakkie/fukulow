/**
 * The shell mounts and starts its REST reads at once; the core loads in parallel.
 * Sync controllers wait for `initialize` themselves (auth.svelte.ts), so none starts before the core is ready.
 * On failure the shell is replaced by the startup error.
 */
export function bootstrap<T>(initialize: () => Promise<void>, start: () => T, fail: (started: T) => void): Promise<void> {
  const ready = initialize()
  const started = start()
  return ready.catch(() => fail(started))
}
