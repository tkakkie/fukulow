import assert from 'node:assert/strict';
import test from 'node:test';
import { blockThermal, parseSamples, tctl, type ThermalSample } from './thermal.ts';

const sets = { server: [0, 2], client: [1, 3] };
const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 0, 0, s)).toISOString();
const sample = (s: number, f: (number | null)[], t: number | null = 80): ThermalSample =>
  ({ at: at(s), avgFreqKHz: f, temperaturesC: t === null ? {} : { 'k10temp/Tctl': t }, fansRpm: {} });

test('a block takes the median of per-sample set medians and the minimum of set minima, inside its window only', () => {
  const samples = [sample(0, [9, 9, 9, 9], 99), sample(10, [5000, 3000, 4800, 3400], 80), sample(15, [4000, 3200, 4200, 3300], 85), sample(20, [4400, 3500, 4600, 3100], 82), sample(30, [1, 1, 1, 1], 99)];
  const b = blockThermal(samples, Date.parse(at(10)), Date.parse(at(20)), sets);
  assert.equal(b.samples, 3);
  assert.deepEqual(b.server, { medianKHz: 4500, minKHz: 4000 });
  assert.deepEqual(b.client, { medianKHz: 3250, minKHz: 3000 });
  assert.equal(b.maxTctlC, 85);
});

test('an unreadable CPU in any sample, or no sample at all, makes the set null', () => {
  const b = blockThermal([sample(1, [5000, 3000, 5000, 3000]), sample(2, [5000, null, 5000, 3000])], Date.parse(at(0)), Date.parse(at(5)), sets);
  assert.deepEqual([b.server?.medianKHz, b.client], [5000, null]);
  const empty = blockThermal([], 0, 1, sets);
  assert.deepEqual([empty.samples, empty.server, empty.client, empty.maxTctlC], [0, null, null, null]);
});

test('error lines are not samples; Tctl is read from k10temp', () => {
  const s = parseSamples(`${JSON.stringify(sample(1, [1]))}\n{"at":"x","error":"EIO"}\n\n`);
  assert.equal(s.length, 1);
  assert.equal(tctl(s[0]), 80);
  assert.equal(tctl(null), null);
});
