import assert from 'node:assert/strict';
import test from 'node:test';
import { blockThermal, busyFraction, cpuDelta, cpuReadings, isActive, isFailed, parseProcStat, parseSamples, tctl, timed, type SampleLine, type ThermalSample } from './thermal.ts';

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
    acc.forEach((c, cpu) => { const b = busy?.[cpu] ?? 1; const j = Math.round(500 * b); c[0] += j; c[1] += 500 - j; });
    return { ...sample(s, f), procStat: acc.map(([b, i]) => counters(b, i)), ...(mono === undefined ? {} : { monoMs: mono }) };
  });
}
const B = (lines: SampleLine[], from: number, to: number, minBusy = 0.5) => blockThermal(lines, Date.parse(at(from)), Date.parse(at(to)), sets, minBusy);

test('a block keeps, per CPU, its active ticks and the median of its active readings, inside its window only', () => {
  const lines = series([{ s: 0, f: [9, 9, 9, 9] }, { s: 10, f: [5000, 3000, 4800, 3400] }, { s: 15, f: [4000, 3200, 4200, 3300] }, { s: 20, f: [4400, 3500, 4600, 3100] }, { s: 30, f: [1, 1, 1, 1] }]);
  lines[2].temperaturesC = { 'k10temp/Tctl': 85 };
  const b = B(lines, 10, 20);
  assert.deepEqual([b.samples, b.failed, b.ticks, b.maxGapMs], [3, 0, 3, 10_000]); // the tick before the window is at 0 s: no tick at 5 s
  assert.deepEqual(b.server, { problem: null, cpus: [{ cpu: 0, activeTicks: 3, valueKHz: 4400, mid: [4400, 4400] }, { cpu: 2, activeTicks: 3, valueKHz: 4600, mid: [4600, 4600] }] });
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
  assert.deepEqual(b.server.cpus, [{ cpu: 0, activeTicks: 2, valueKHz: 4_925_000, mid: [4_900_000, 4_950_000] }, { cpu: 2, activeTicks: 0, valueKHz: null, mid: null }]);
  assert.deepEqual(b.client.cpus, [{ cpu: 1, activeTicks: 0, valueKHz: null, mid: null }, { cpu: 3, activeTicks: 2, valueKHz: 3_470_000, mid: [3_470_000, 3_470_000] }]);
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
  // The tick after the failed one has no usable predecessor, so it fails too (F6).
  assert.deepEqual([b.samples, b.failed, b.server.problem, b.maxGapMs], [1, 2, 'failed thermal tick', 5000]);
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

test('round-1 blocker 4: busy >= 0.5 is decided in integers, even where a float would round to 0.5', () => {
  // 4,503,599,627,370,497 busy and one more idle jiffy: busy is just below 0.5 but rounds to 0.5 as a double.
  const busy = 4_503_599_627_370_497;
  const d = cpuDelta(counters(0, 0), counters(busy, busy + 1))!;
  assert.equal(1 - (busy + 1) / (2 * busy + 1), 0.5); // the floating-point form of the rule
  assert.equal(isActive(d, 0.5), false);
  assert.equal(isActive(cpuDelta(counters(0, 0), counters(busy, busy))!, 0.5), true);
  const lines = [{ ...sample(0, [5000, 5000, 5000, 5000]), procStat: [0, 1, 2, 3].map(() => counters(0, 0)) },
    { ...sample(5, [5000, 5000, 5000, 5000]), procStat: [counters(busy, busy + 1), counters(busy, busy), counters(1, 0), counters(1, 0)] }];
  assert.deepEqual(B(lines, 5, 5).server.cpus.map(c => c.activeTicks), [0, 1]);
  assert.throws(() => B(lines, 5, 5, 0.1234567), /at most 6 decimals/);
});

test('round-1 blocker 5: a tick with an unreadable frequency, unreadable counters or an invalid delta counts as failed', () => {
  const l = series([0, 5, 10, 15, 20].map(s => ({ s, f: [5000, 3000, 5000, 3000] })));
  assert.deepEqual([B(l, 3, 17).samples, B(l, 3, 17).failed], [3, 0]);
  const freq = series([0, 5, 10, 15, 20].map(s => ({ s, f: [5000, 3000, 5000, 3000] })));
  freq[2].avgFreqKHz[1] = null;
  assert.deepEqual([B(freq, 3, 17).samples, B(freq, 3, 17).failed, B(freq, 3, 17).client.problem], [2, 1, 'unreadable CPU frequency on CPU 1']);
  const stat = series([0, 5, 10, 15, 20].map(s => ({ s, f: [5000, 3000, 5000, 3000] })));
  stat[2].procStat = null;
  assert.deepEqual([B(stat, 3, 17).samples, B(stat, 3, 17).failed], [1, 2]); // ticks 10 and 15
  const stalled = series([0, 5, 10, 15, 20].map(s => ({ s, f: [5000, 3000, 5000, 3000] })));
  stalled[2].procStat![0] = stalled[1].procStat![0];
  assert.deepEqual([B(stalled, 3, 17).samples, B(stalled, 3, 17).failed], [2, 1]);
  // A CPU outside both sets is not judged.
  const outside = series([0, 5, 10].map(s => ({ s, f: [5000, 3000, 5000, 3000, 1] })));
  outside[1].avgFreqKHz[4] = null;
  assert.deepEqual([B(outside, 3, 12).samples, B(outside, 3, 12).failed], [2, 0]);
});

test('F2: a qualifying CPU\'s value is the median of its active readings only; an idle CPU still needs a readable frequency', () => {
  // CPU 0: active at 5000, 5000, 4000, idle at the 100 placeholder twice. The median of all five would be 4000.
  const l = series([{ s: 0, f: [1, 1, 1, 1] }, ...[5000, 100, 5000, 100, 4000].map((f, i) => ({ s: 5 * (i + 1), f: [f, 3000, 5000, 3000], busy: [f === 100 ? 0 : 1, 1, 1, 1] }))]);
  assert.deepEqual(B(l, 5, 25).server.cpus[0], { cpu: 0, activeTicks: 3, valueKHz: 5000, mid: [5000, 5000] });
  // Idle CPU 2 with an unreadable frequency: the set fails (F6 covers every CPU of the set).
  const idle = series([0, 5, 10].map(s => ({ s, f: [5000, 3000, 623_377, 3000], busy: [1, 1, 0, 1] })));
  idle[2].avgFreqKHz[2] = null;
  assert.equal(B(idle, 3, 12).server.problem, 'unreadable CPU frequency on CPU 2');
});

test('F7: the sampler reads cpuinfo_avg_freq only, as a positive integer; scaling_cur_freq is never used', () => {
  const fsys = (files: Record<string, string>) => (path: string) => files[path] ?? null;
  const freq = (cpu: number, f: string) => `/sys/devices/system/cpu/cpu${cpu}/cpufreq/${f}`;
  const r = cpuReadings(fsys({
    [freq(0, 'cpuinfo_avg_freq')]: '4900000\n', [freq(0, 'scaling_cur_freq')]: '1000\n',
    [freq(1, 'scaling_cur_freq')]: '3470000\n',
    [freq(2, 'cpuinfo_avg_freq')]: '0\n', [freq(3, 'cpuinfo_avg_freq')]: '3470000.5\n',
    '/proc/stat': 'cpu  1 1 1 1 1 1 1 1\ncpu0 1 2 3 4 5 6 7 8 0 0\ncpu1 1 2 3 4 5 6 7 8 0 0\n',
  }), 4);
  assert.deepEqual(r, { avgFreqKHz: [4_900_000, null, null, null], procStat: [[1, 2, 3, 4, 5, 6, 7, 8, 0, 0], [1, 2, 3, 4, 5, 6, 7, 8, 0, 0]] });
  assert.equal(cpuReadings(fsys({}), 1).procStat, null);
});
