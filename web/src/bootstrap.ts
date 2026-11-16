/** No controller or session starts before the selected core is ready. */
export async function bootstrap(initialize: () => Promise<void>, start: () => void, fail: () => void): Promise<void> {
  try { await initialize() } catch { fail(); return }
  start()
}
