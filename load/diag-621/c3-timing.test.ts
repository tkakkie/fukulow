import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpfsBytes, type Tick } from './c3-observer.ts';
import { cpuWindow, DrainPending, latency, loadBoundaries, storageCoverage, storageReason, trafficReasons, type Traffic } from './c3-timing.ts';

const origin = 1_000_000;
const ticks = (app: (time: number) => number = time => 5 * time): Tick[] => Array.from({ length: 32 }, (_, index) => {
  const monoMs = index * 100;
  return { monoMs, wallMs: origin + monoMs, app: app(monoMs), db: monoMs * 20, spanMs: 0, used: 0 };
});
const calculate = (data: Tick[]) => cpuWindow(data, origin + 50, origin + 250, origin + 850);

test('CPU uses the first measured start and interpolates through 200 ms of idle after last response', () => {
  const data = ticks(time => time <= 1000 ? time * 30 : 30_000 + (time - 1000) * 5);
  const evidence = calculate(data);
  assert.deepEqual(evidence, { offsetMs: -origin, start: 250, end: 1200, drainMs: 350, endWallMs: origin + 1200,
    app: { usec: 23500, errorUsec: 6000 }, db: { usec: 19000, errorUsec: 4000 } });
  assert.throws(() => calculate(data.slice(0, 13)), DrainPending);
});

test('CPU invalidates malformed, uncovered, regressing and drifting clocks and gaps over 250 ms', () => {
  assert.throws(() => calculate([]), /missing or malformed/);
  assert.throws(() => calculate(ticks().slice(1)), /warm-up/);
  assert.throws(() => calculate(ticks().filter(row => ![500, 600].includes(row.monoMs))), /250 ms/);
  const gap = ticks().filter(row => ![500, 600].includes(row.monoMs));
  const tick = gap.find(row => row.monoMs === 700)!;
  tick.monoMs -= 50; tick.wallMs -= 50;
  assert.equal(calculate(gap).drainMs, 200);
  const stepped = ticks(); stepped[7].wallMs += 20;
  assert.throws(() => calculate(stepped), /clock offset drift/);
  const counter = ticks(); counter[7].app = 0;
  assert.throws(() => calculate(counter), /regressed/);
  counter[7].app = NaN;
  assert.throws(() => calculate(counter), /malformed/);
});

test('drain resets at exactly 1% of one core and rejects over two seconds', () => {
  assert.throws(() => calculate(ticks(time => 10 * time)), /within 2 s/);
  const exactCap = ticks(time => Math.min(time, 2800) * 10);
  assert.equal(cpuWindow(exactCap, origin + 50, origin + 250, origin + 1000).drainMs, 2000);
  assert.throws(() => calculate(exactCap), /within 2 s/);
});

function sample(accepted = 2000): Traffic {
  return { scenario: origin, requests: Array.from({ length: accepted }, (_, id) => ({ id, vu: 2, start: origin + id * 4,
    end: origin + id * 4 + 10, latency: id < 250 ? 5 : 2, status: 201 })), vus: [{ wallMs: origin + 1000, value: 100 }],
  load: { accepted, attempts: accepted, errors: 0, iterations: accepted, dropped: 0 } };
}

test('measured errors, drops and accepted count reject; both inclusive scheduler edges are valid', () => {
  assert.deepEqual(trafficReasons(sample(), true), []);
  assert.deepEqual(trafficReasons(sample(2001), true), []);
  for (const amount of [1999, 2002]) assert.match(trafficReasons(sample(amount), true).join(), /accepted count/);
  const dropped = sample(); dropped.load.dropped++;
  assert.match(trafficReasons(dropped, true).join(), /drops/);
  const failed = sample(2001); failed.load.errors++; failed.load.accepted--; failed.requests[0].status = 500;
  assert.match(trafficReasons(failed, true).join(), /errors/);
  failed.load.iterations++;
  assert.match(trafficReasons(failed, true).join(), /do not reconcile/);
  assert.deepEqual(trafficReasons(sample(750), false), []);
});

test('requires valid per-request timing, latency and VU samples; first-second latency is descriptive', () => {
  const data = sample();
  assert.deepEqual(latency(data.requests, origin).firstSecond, { count: 250, p50: 5000, p95: 5000 });
  assert.deepEqual(latency(data.requests, origin).rest, { count: 1750, p50: 2000, p95: 2000 });
  assert.throws(() => latency(data.requests.slice(0, 1), origin), /segment missing/);
  for (const patch of [{ requests: [] }, { requests: [data.requests[0], data.requests[0]] },
    { requests: [{ ...data.requests[0], latency: NaN }] }, { requests: [{ ...data.requests[0], vu: 0 }] },
    { requests: [{ ...data.requests[0], end: origin - 1 }] }, { vus: [] }, { vus: [{ value: -1, wallMs: origin }] }]) {
    assert.match(trafficReasons({ ...data, ...patch }, true).join(), /missing or malformed/);
  }
});

test('tmpfs peak is checked over all samples with a strict 90% upper limit', () => {
  assert.equal(storageReason([Math.floor(tmpfsBytes * 0.9)]), undefined);
  assert.match(storageReason([0, Math.ceil(tmpfsBytes * 0.9), 0])!, /exceeded 90%/);
  assert.match(storageReason([])!, /missing/);
  assert.match(storageReason([NaN])!, /malformed/);
  const samples = ticks().slice(0, 8);
  assert.equal(storageCoverage(samples, origin + 800), true);
  assert.equal(storageCoverage(samples, origin + 1000), false);
  assert.equal(storageCoverage(samples.filter(row => ![400, 500].includes(row.monoMs)), origin + 800), false);
});

test('warm-up and measured timestamps must agree across generator processes', () => {
  const warm = sample(750), measured = sample();
  assert.throws(() => loadBoundaries(warm, measured), /clocks do not agree/);
  const shift = 4000;
  measured.scenario += shift;
  measured.requests = measured.requests.map(row => ({ ...row, start: row.start + shift, end: row.end + shift }));
  assert.deepEqual(loadBoundaries(warm, measured), { start: origin, first: origin + shift, last: origin + shift + 8006 });
});
