import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { batch, sizing, scheduleTime, startLag, inFlightCap, type Run, type Scenario } from './reply-counts-model.ts';
import type { ReplyCountPage, ReplyCountRequest } from '../web/src/api-schema.d.ts';
type Runtime = { clock: () => number; wait: (ms: number) => Promise<void>; fetch: typeof fetch };
const runtime: Runtime = {
  clock: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  fetch: (...args) => fetch(...args),
};
export async function measure(url: string, cookie: string, scenario: Scenario, repeat: number, pilot: boolean, check: () => void, io: Runtime = runtime): Promise<Run> {
  const controller = new AbortController();
  async function request(sample: number, scheduled?: number) {
    check();
    const expected = batch(scenario, sample);
    const body: ReplyCountRequest = { ids: expected.map(a => a.message_id) };
    const payload = JSON.stringify(body);
    const start = io.clock();
    if (scheduled !== undefined) {
      const lag = startLag(scheduled, start);
      run.startLags.push(lag.lagMs);
      if (lag.missed) { run.missedDeadlines++; return; }
      run.peakInFlight = Math.max(run.peakInFlight, pending.size + 1);
      if (run.peakInFlight > inFlightCap) { controller.abort(); return; }
    }
    const response = await io.fetch(url, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
    const text = await response.text();
    const end = io.clock(); // Full body consumed; oracle validation is excluded.
    assert.equal(response.status, 200, `reply-counts HTTP ${response.status}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = JSON.parse(text) as ReplyCountPage;
    assert.equal(page.as_of_seq, sizing(scenario).messages);
    assert.match(page.history_generation, /^[0-9a-f-]{36}$/);
    assert.deepEqual(page.counts, expected);
    return { sendMs: end - start, scheduledMs: end - (scheduled ?? start) };
  }
  const run: Run = { scenario, repeat, firstMs: null, errors: 0, scheduledLatencies: [],
    sendLatencies: [], startLags: [], missedDeadlines: 0, peakInFlight: 0, seconds: 0 };
  try {
    run.firstMs = (await request(0))!.sendMs;
    for (let i = 0; i < (pilot ? 10 : 100); i++) await request(i);
  } catch { run.errors++; check(); return run; }
  const start = io.clock();
  const pending = new Set<Promise<void>>();
  // scheduler.ts checks lag before the batch; preserve the formal run's per-request check after payload preparation.
  try {
    for (let k = 0; k < (pilot ? 200 : 10_000); k++) {
      const scheduled = scheduleTime(start, k);
      // Recheck after early timer wake-ups; never shift a deadline or catch up.
      while (io.clock() < scheduled) {
        await io.wait(scheduled - io.clock());
        check();
      }
      check();
      // request() records lag after synchronous oracle/payload preparation.
      const task = requestMeasured(k, scheduled);
      if (!task) break;
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    await Promise.all(pending);
  } finally {
    controller.abort();
    await Promise.all(pending);
    run.seconds = (io.clock() - start) / 1000;
  }
  return run;

  function requestMeasured(sample: number, scheduled: number): Promise<void> | undefined {
    const response = request(sample, scheduled);
    if (run.missedDeadlines || run.peakInFlight > inFlightCap) return;
    return response.then(ms => {
      if (!ms) return;
      run.scheduledLatencies.push(ms.scheduledMs);
      run.sendLatencies.push(ms.sendMs);
    }).catch(() => { run.errors++; });
  }
}
