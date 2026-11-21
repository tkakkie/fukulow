import type { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';

export function startRssSampler(server: Pick<EventEmitter, 'once' | 'off'>, readRss: (signal: AbortSignal) => Promise<number>, samples: { at: number; kb: number }[]) {
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => {
    controller.abort();
    server.off('exit', stop);
  };
  server.once('exit', stop);
  const done = (async () => {
    while (!signal.aborted) {
      try {
        const kb = await readRss(signal);
        if (!signal.aborted) samples.push({ at: performance.now(), kb });
      } catch { /* ps can fail if the process has exited */ }
      if (!signal.aborted) await setTimeout(500, undefined, { signal }).catch(() => { /* stopped */ });
    }
  })();
  return { stop, done };
}
