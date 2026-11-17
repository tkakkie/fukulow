import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { batch, sizing, readers, nextDeadline, type Run, type Scenario } from './reply-counts-model.ts';
import type { ReplyCountPage, ReplyCountRequest } from '../web/src/api-schema.d.ts';
export async function measure(url: string, cookie: string, scenario: Scenario, repeat: number, pilot: boolean, check: () => void): Promise<Run> {
  async function request(sample: number) {
    check();
    const expected = batch(scenario, sample);
    const body: ReplyCountRequest = { ids: expected.map(a => a.message_id) };
    const start = performance.now();
    const response = await fetch(url, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    const ms = performance.now() - start; // Includes connection, HTTP, full body transfer; excludes oracle validation.
    assert.equal(response.status, 200, `reply-counts HTTP ${response.status}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = JSON.parse(text) as ReplyCountPage;
    assert.equal(page.as_of_seq, sizing(scenario).messages);
    assert.match(page.history_generation, /^[0-9a-f-]{36}$/);
    assert.deepEqual(page.counts, expected);
    return ms;
  }
  const run: Run = { scenario, repeat, firstMs: await request(0), errors: 0, latencies: [], seconds: 0 };
  for (let i = 0; i < (pilot ? 10 : 100); i++) await request(i);
  const start = performance.now();
  const perReader = pilot ? 50 : 2500;
  await Promise.all(Array.from({ length: readers }, async (_, reader) => {
    let due = performance.now();
    for (let i = 0; i < perReader; i++) {
      try { run.latencies.push(await request(reader * perReader + i)); }
      catch { run.errors++; check(); }
      // Absolute 25 ms deadlines avoid timer drift, with bounded catch-up of at most
      // two intervals after a slow response. Each reader awaits its request, so
      // at most one is in flight per reader (at most 4 concurrent requests).
      if (i + 1 < perReader) {
        due = nextDeadline(due, performance.now());
        const remaining = due - performance.now();
        if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      }
    }
  }));
  run.seconds = (performance.now() - start) / 1000;
  return run;
}
