import assert from 'node:assert/strict';
import test from 'node:test';
import { blockThermal, isFailed, parseSamples, tctl, timed, type ThermalSample } from './thermal.ts';

const sets = { server: [0, 2], client: [1, 3] };
const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 0, 0, s)).toISOString();
const sample = (s: number, f: (number | null)[], t: number | null = 80): ThermalSample =>
  ({ at: at(s), avgFreqKHz: f, temperaturesC: t === null ? {} : { 'k10temp/Tctl': t }, fansRpm: {} });

test('a block takes the median of per-sample set medians and the minimum of set minima, inside its window only', () => {
  const samples = [sample(0, [9, 9, 9, 9], 99), sample(10, [5000, 3000, 4800, 3400], 80), sample(15, [4000, 3200, 4200, 3300], 85), sample(20, [4400, 3500, 4600, 3100], 82), sample(30, [1, 1, 1, 1], 99)];
  const b = blockThermal(samples, Date.parse(at(10)), Date.parse(at(20)), sets);
  assert.deepEqual([b.samples, b.failed, b.maxGapMs], [3, 0, 10_000]); // the tick before the window is at 0 s: no tick at 5 s
  assert.deepEqual(b.server, { medianKHz: 4500, minKHz: 4000 });
  assert.deepEqual(b.client, { medianKHz: 3250, minKHz: 3000 });
  assert.equal(b.maxTctlC, 85);
});

test('an unreadable CPU in any sample, or no sample at all, makes the set null', () => {
  const b = blockThermal([sample(1, [5000, 3000, 5000, 3000]), sample(2, [5000, null, 5000, 3000])], Date.parse(at(0)), Date.parse(at(5)), sets);
  assert.deepEqual([b.server?.medianKHz, b.client], [5000, null]);
  const empty = blockThermal([], 0, 1, sets);
  assert.deepEqual([empty.samples, empty.server, empty.client, empty.maxTctlC, empty.maxGapMs], [0, null, null, null, Infinity]);
});

test('a failed tick inside the window nulls both sets; a missing tick shows as the gap, edges included', () => {
  const ok = (s: number) => sample(s, [5000, 3000, 5000, 3000]);
  const lines = [ok(0), ok(5), { at: at(10), error: 'EIO' }, ok(15), ok(20)];
  const b = blockThermal(lines, Date.parse(at(3)), Date.parse(at(17)), sets);
  assert.deepEqual([b.samples, b.failed, b.server, b.client, b.maxGapMs], [2, 1, null, null, 5000]);
  const gap = blockThermal([ok(0), ok(5), ok(15), ok(20)], Date.parse(at(3)), Date.parse(at(17)), sets);
  assert.deepEqual([gap.failed, gap.maxGapMs, gap.server?.medianKHz], [0, 10_000, 5000]);
  assert.equal(blockThermal([ok(5), ok(10)], Date.parse(at(3)), Date.parse(at(12)), sets).maxGapMs, Infinity); // no tick before the start
});

test('the measured window is taken around the call, with its monotonic length', () => {
  const wall = [1000, 4000];
  const mono = [10, 2510];
  const r = timed(() => 'out', { wall: () => wall.shift()!, mono: () => mono.shift()! });
  assert.deepEqual(r, { value: 'out', window: { startMs: 1000, endMs: 4000, monoMs: 2500 } });
});

test('error, torn and timeless lines are kept as failed ticks; Tctl is read from k10temp', () => {
  const s = parseSamples(`${JSON.stringify(sample(1, [1]))}\n{"at":"${at(6)}","error":"EIO"}\n{"at":"${at(11)}","avgF\n{"error":"x"}\n\n`);
  assert.equal(s.length, 4);
  assert.deepEqual(s.map(isFailed), [false, true, true, true]);
  assert.deepEqual(s.slice(1).map(l => l.at), [at(6), null, null]);
  assert.equal(tctl(s[0] as ThermalSample), 80);
  assert.equal(tctl(null), null);
});

test('the guard keeps edge ticks out; gaps and the clock-step spread use the sampler\'s monotonic stamps', () => {
  const tick = (s: number, mono: number, f = 5000): ThermalSample => ({ ...sample(s, [f, f, f, f]), monoMs: mono });
  // A +0.9 s wall step before the block: a tick taken 0.5 s before the start is stamped 0.4 s after it.
  const lines = [tick(0, 0), { ...tick(10, 9_500, 1), at: new Date(Date.parse(at(10)) + 400).toISOString() }, tick(15, 14_100), tick(20, 19_100), tick(25, 24_100), tick(30, 29_100)];
  const open = blockThermal(lines, Date.parse(at(10)), Date.parse(at(25)), sets);
  assert.equal(open.server?.minKHz, 1); // without a guard the outside tick is counted
  const guarded = blockThermal(lines, Date.parse(at(10)), Date.parse(at(25)), sets, 1000);
  assert.deepEqual([guarded.ticks, guarded.windowMs, guarded.server?.minKHz, guarded.monoComplete, guarded.maxGapMs, guarded.offsetSpreadMs], [2, 13_000, 5000, true, 5000, 0]);
  const stepped = blockThermal([tick(0, 0), tick(5, 5000), tick(10, 8_500), tick(15, 13_500)], Date.parse(at(4)), Date.parse(at(11)), sets);
  assert.deepEqual([stepped.maxGapMs, stepped.offsetSpreadMs], [5000, 1500]);
  assert.equal(blockThermal([sample(0, [1, 1, 1, 1]), tick(5, 5000), tick(10, 10_000)], Date.parse(at(4)), Date.parse(at(6)), sets).monoComplete, false);
});
