// Deadlines depend only on configuration and elapsed time, never request completion.
export async function schedule(
  durationMs: number, intervalMs: number, batchSize: number,
  clock: () => number, wait: (ms: number) => Promise<void>,
  send: (index: number) => Promise<void>,
): Promise<{ startedAt: number; offered: number; elapsedMs: number; maxLagMs: number }> {
  const started = clock();
  const pending = new Set<Promise<void>>();
  let offered = 0;
  let rejected = false;
  let rejection: unknown;
  let maxLagMs = 0;
  for (let offset = 0; offset < durationMs; offset += intervalMs) {
    await wait(Math.max(0, started + offset - clock()));
    // Do not catch up by bursting after generator starvation; invalidate the run instead.
    const lag = clock() - started - offset;
    if (lag >= intervalMs) throw new Error('Load generator missed a send deadline');
    maxLagMs = Math.max(maxLagMs, lag);
    for (let slot = 0; slot < batchSize; slot++) {
      const request = send(offered++);
      pending.add(request);
      void request.then(() => pending.delete(request), (error) => {
        pending.delete(request);
        rejected = true;
        rejection = error;
      });
    }
  }
  await wait(Math.max(0, started + durationMs - clock()));
  const elapsedMs = clock() - started;
  await Promise.allSettled(pending);
  if (rejected) throw rejection;
  return { startedAt: started, offered, elapsedMs, maxLagMs };
}

export function sessionIndex(socket: number, socketsPerSession: number): number {
  return Math.floor(socket / socketsPerSession);
}
