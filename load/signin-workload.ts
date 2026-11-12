import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import type { SignInRequest } from '../web/src/api-schema.d.ts';
import type { Attempt } from './signin-summary.ts';

export type Config = { concurrency: number; seconds: number; rate: number; readRate: number;
  accounts: number; ipPool: number; correctEvery: number; timeoutSeconds: number };
export async function workload(base: string, password: string, token: string, organization: string,
  config: Config, signal: AbortSignal) {
  const attempts: Attempt[] = [];
  const pending = new Set<Promise<void>>();
  const started = performance.now();
  let signinActive = 0, readActive = 0, peak = 0, offered = 0, reads = 0, dropped = 0, readsDropped = 0;
  let maxSchedulingLagMs = 0;
  const send = async (index: number, read: boolean) => {
    const kind: Attempt['kind'] = read ? 'organization_b' : index % config.correctEvery === 0 ? 'correct' : index % 2 ? 'wrong_known' : 'unknown';
    const email = kind === 'unknown' ? `unknown-${index}@example.invalid` :
      `${kind === 'correct' ? 'correct' : 'known'}-${index % config.accounts}@example.invalid`;
    const ip = index % config.ipPool;
    const headers: Record<string,string> = read ? { Authorization: `Bearer ${token}` } :
      { 'Content-Type': 'application/json', 'X-Load-Client-IP': `10.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}` };
    const body: SignInRequest = { email, password: kind === 'correct' ? password : `${password}-wrong` };
    const start = performance.now();
    let status = 0;
    try {
      const response = await fetch(base + (read ? `/api/v1/orgs/${organization}/channels` : '/api/v1/native/session'),
        { method: read ? 'GET' : 'POST', headers, body: read ? undefined : JSON.stringify(body), redirect:'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]) });
      status = response.status;
      // Consume complete bodies for end-to-end latency; never retain credentials.
      await response.arrayBuffer();
    } catch { status = 0; }
    attempts.push({ kind, status, ms: performance.now() - start });
  };
  while (!signal.aborted && performance.now() - started < config.seconds * 1000) {
    const elapsed = performance.now() - started;
    for (const read of [false, true]) {
      const rate = read ? config.readRate : config.rate;
      let next = read ? reads : offered;
      const due = Math.min(Math.floor(elapsed * rate / 1000) + 1, Math.ceil(config.seconds * rate));
      while (next < due) {
        maxSchedulingLagMs = Math.max(maxSchedulingLagMs, elapsed - next * 1000 / rate);
        const index = next++;
        if (read ? readActive >= 4 : signinActive >= config.concurrency) {
          if (read) readsDropped++; else dropped++;
          continue;
        }
        if (read) readActive++; else signinActive++;
        peak = Math.max(peak, signinActive);
        const task = send(index, read).finally(() => {
          if (read) readActive--; else signinActive--;
          pending.delete(task);
        });
        pending.add(task);
      }
      if (read) reads = next; else offered = next;
    }
    await pause(2);
  }
  const schedulingMs = performance.now() - started;
  await Promise.all(pending);
  return { attempts, offered, readsOffered: reads, dropped, readsDropped, peakConcurrency: peak, schedulingMs,
    completedMs: performance.now() - started, maxSchedulingLagMs };
}
