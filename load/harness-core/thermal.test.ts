import assert from 'node:assert/strict';
import test from 'node:test';
import { blockThermal, busyFraction, isFailed, parseProcStat, parseSamples, tctl, timed, type SampleLine, type ThermalSample } from './thermal.ts';

const sets = { server: [0, 2], client: [1, 3] };
const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 0, 0, s)).toISOString();
const sample = (s: number, f: (number | null)[], t: number | null = 80): ThermalSample =>
  ({ at: at(s), avgFreqKHz: f, temperaturesC: t === null ? {} : { 'k10temp/Tctl': t }, fansRpm: {} });
// /proc/stat counters for one CPU: user, nice, system, idle, iowait, irq, softirq, steal.
const counters = (busy: number, idle: number, iowait = 0) => [busy, 0, 0, idle, iowait, 0, 0, 0];
// Ticks with cumulative /proc/stat counters: each tick adds 500 jiffies per CPU, busy[cpu] of them busy
// (default: every CPU fully busy).
function series(specs: { s: number; f: (number | null)[]; busy?: number[]; mono?: number }[]): ThermalSample[] {
  const acc = specs[0].f.map(() => [0, 0]);
  return specs.map(({ s, f, busy, mono }) => {
    acc.forEach((c, cpu) => { const b = busy?.[cpu] ?? 1; c[0] += 500 * b; c[1] += 500 * (1 - b); });
    return { ...sample(s, f), procStat: acc.map(([b, i]) => counters(b, i)), ...(mono === undefined ? {} : { monoMs: mono }) };
  });
}
const B = (lines: SampleLine[], from: number, to: number, minBusy = 0.5) => blockThermal(lines, Date.parse(at(from)), Date.parse(at(to)), sets, minBusy);

test('a block keeps, per CPU, its active ticks and the median of its active readings, inside its window only', () => {
  const lines = series([{ s: 0, f: [9, 9, 9, 9] }, { s: 10, f: [5000, 3000, 4800, 3400] }, { s: 15, f: [4000, 3200, 4200, 3300] }, { s: 20, f: [4400, 3500, 4600, 3100] }, { s: 30, f: [1, 1, 1, 1] }]);
  lines[2].temperaturesC = { 'k10temp/Tctl': 85 };
  const b = B(lines, 10, 20);
  assert.deepEqual([b.samples, b.failed, b.ticks, b.maxGapMs], [3, 0, 3, 10_000]); // the tick before the window is at 0 s: no tick at 5 s
  assert.deepEqual(b.server, { problem: null, cpus: [{ cpu: 0, activeTicks: 3, valueKHz: 4400 }, { cpu: 2, activeTicks: 3, valueKHz: 4600 }] });
  assert.deepEqual(b.client.cpus.map(c => c.valueKHz), [3200, 3300]);
  assert.equal(b.maxTctlC, 85);
});

test('/proc/stat: busy is 1 - (idle + iowait delta) / total delta over the first 8 counters', () => {
  const stat = parseProcStat('cpu  10 0 0 10 0 0 0 0 0 0\ncpu0 100 5 20 300 40 1 2 3 7 0\ncpu2 1 2 3\ncpu3 1 2 3 4 5 6 7 -8\nintr 1 2\n');
  assert.deepEqual(stat, [[100, 5, 20, 300, 40, 1, 2, 3, 7, 0], null, null, null]); // the aggregate line is skipped; short, negative or absent lines are null
  // 400 jiffies: 150 idle + 50 iowait; guest (index 8) is already in user and is not added.
  assert.equal(busyFraction([0, 0, 0, 0, 0, 0, 0, 0, 0], [180, 10, 5, 150, 50, 2, 2, 1, 99]), 0.5);
  assert.equal(busyFraction(counters(0, 0), counters(100, 300)), 0.25);
  assert.equal(busyFraction(counters(0, 0), counters(0, 0, 400)), 0); // iowait counts as idle
  // Backwards counters, no progress or a short line: unknown, never idle.
  assert.equal(busyFraction(counters(10, 10), counters(20, 9)), null);
  assert.equal(busyFraction(counters(10, 10, 5), counters(20, 20, 4)), null);
  assert.equal(busyFraction(counters(10, 10), counters(10, 10)), null);
  assert.equal(busyFraction([1, 2, 3], counters(10, 10)), null);
});

test('busy exactly 0.5 is active, just below is not; an idle CPU at the cpuinfo_min_freq placeholder is never judged', () => {
  const min = 623_377;
  const lines = series([{ s: 0, f: [1, 1, 1, 1] }, { s: 5, f: [4_900_000, min, min, 3_470_000], busy: [0.5, 0.498, 0, 1] }, { s: 10, f: [4_950_000, min, min, 3_470_000], busy: [0.5, 0.498, 0, 1] }]);
  const b = B(lines, 5, 10);
  assert.deepEqual(b.server.cpus, [{ cpu: 0, activeTicks: 2, valueKHz: 4_925_000 }, { cpu: 2, activeTicks: 0, valueKHz: null }]);
  assert.deepEqual(b.client.cpus, [{ cpu: 1, activeTicks: 0, valueKHz: null }, { cpu: 3, activeTicks: 2, valueKHz: 3_470_000 }]);
});

test('missing data fails the set: unreadable frequency or /proc/stat, backwards or stalled counters, no predecessor, a failed tick', () => {
  const base = () => series([{ s: 0, f: [5000, 3000, 5000, 3000] }, { s: 5, f: [5000, 3000, 5000, 3000] }, { s: 10, f: [5000, 3000, 5000, 3000] }, { s: 15, f: [5000, 3000, 5000, 3000] }]);
  const problem = (mutate: (l: ThermalSample[]) => SampleLine[] | void) => {
    const l = base();
    const out = mutate(l) ?? l;
    const b = B(out, 3, 12);
    return [b.server.problem, b.client.problem];
  };
  assert.deepEqual(problem(() => {}), [null, null]);
  // An active CPU's frequency is unreadable: that set only.
  assert.deepEqual(problem(l => { l[2].avgFreqKHz[2] = null; }), ['unreadable CPU frequency on CPU 2', null]);
  assert.deepEqual(problem(l => { l[1].avgFreqKHz[3] = null; }), [null, 'unreadable CPU frequency on CPU 3']);
  assert.deepEqual(problem(l => { l[2].procStat = null; }), ['unreadable /proc/stat on CPU 0', 'unreadable /proc/stat on CPU 1']);
  assert.deepEqual(problem(l => { delete l[0].procStat; }), ['unreadable /proc/stat on CPU 0', 'unreadable /proc/stat on CPU 1']); // the predecessor's, too
  assert.deepEqual(problem(l => { l[1].procStat![3] = null; }), [null, 'unreadable /proc/stat on CPU 3']);
  assert.deepEqual(problem(l => { l[2].procStat![0] = counters(0, 0); }), ['/proc/stat counters of CPU 0 went backwards or did not advance', null]);
  assert.deepEqual(problem(l => { l[2].procStat![1] = l[1].procStat![1]; }), [null, '/proc/stat counters of CPU 1 went backwards or did not advance']);
  assert.deepEqual(problem(l => l.slice(1)), ['no tick before the block', 'no tick before the block']);
  assert.deepEqual(problem(l => [{ at: l[0].at, error: 'EIO' }, ...l.slice(1)]), ['failed tick before the block', 'failed tick before the block']);
  assert.deepEqual(problem(l => [l[0], { at: l[1].at, error: 'EIO' }, ...l.slice(2)]), ['failed thermal tick', 'failed thermal tick']);
  assert.deepEqual(problem(l => [l[0], l[3]]), ['no thermal ticks', 'no thermal ticks']);
});

test('a failed tick inside the window counts; a missing tick shows as the gap, edges included', () => {
  const ok = series([0, 5, 10, 15, 20].map(s => ({ s, f: [5000, 3000, 5000, 3000] })));
  const lines: SampleLine[] = [ok[0], ok[1], { at: at(10), error: 'EIO' }, ok[3], ok[4]];
  const b = B(lines, 3, 17);
  assert.deepEqual([b.samples, b.failed, b.server.problem, b.maxGapMs], [2, 1, 'failed thermal tick', 5000]);
  const gap = B([ok[0], ok[1], ok[3], ok[4]], 3, 17);
  assert.deepEqual([gap.failed, gap.maxGapMs, gap.server.cpus[0].valueKHz], [0, 10_000, 5000]);
  assert.equal(B([ok[1], ok[2]], 3, 12).maxGapMs, Infinity); // no tick before the start
  const empty = blockThermal([], 0, 1, sets, 0.5);
  assert.deepEqual([empty.samples, empty.server.problem, empty.maxTctlC, empty.maxGapMs], [0, 'no thermal ticks', null, Infinity]);
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

test('every tick inside the window counts, edges included; gaps and the clock-step spread use the sampler\'s monotonic stamps', () => {
  const tick = (s: number, mono: number, f = 5000) => ({ s, f: [f, f, f, f], mono });
  // A +0.9 s wall step before the block: a tick taken 0.5 s before the start is stamped 0.4 s after it.
  // It is counted (no edge guard), and the step shows as a 900 ms offset spread, which the judge refuses.
  const lines = series([tick(0, 0), tick(10, 9_500, 1), tick(15, 14_100), tick(20, 19_100), tick(25, 24_100), tick(30, 29_100)]);
  lines[1].at = new Date(Date.parse(at(10)) + 400).toISOString();
  const open = B(lines, 10, 25);
  assert.deepEqual([open.ticks, open.windowMs, open.server.cpus[0].activeTicks, open.monoComplete, open.maxGapMs, open.offsetSpreadMs], [4, 15_000, 4, true, 9_500, 900]);
  // Ticks exactly on both edges are inside.
  const edges = B(series([tick(0, 0), tick(5, 5000), tick(10, 10_000), tick(15, 15_000)]), 5, 10);
  assert.deepEqual([edges.ticks, edges.windowMs, edges.offsetSpreadMs], [2, 5000, 0]);
  const stepped = B(series([tick(0, 0), tick(5, 5000), tick(10, 8_500), tick(15, 13_500)]), 4, 11);
  assert.deepEqual([stepped.maxGapMs, stepped.offsetSpreadMs], [5000, 1500]);
  const noMono = series([tick(0, 0), tick(5, 5000), tick(10, 10_000)]);
  delete noMono[0].monoMs;
  assert.equal(B(noMono, 4, 6).monoComplete, false);
});
