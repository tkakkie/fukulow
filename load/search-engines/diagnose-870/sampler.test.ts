import assert from 'node:assert/strict';
import test from 'node:test';
import { covered, coverageDeadlineMs, freshFast, gaps, otherWorkers, parseMeminfo, windowFacts, type Sample } from './sampler.ts';

const fast = (at: number, over: Partial<Extract<Sample, {stream: 'fast'; dirtyBytes: number}>> = {}): Sample =>
  ({at, stream: 'fast', dirtyBytes: 10, writebackBytes: 5, cachedBytes: 1, autovacuum: [], checkpointer: {}, wal: {}, ...over});
const proc = (at: number, workers: string[] = []): Sample => ({at, stream: 'process', load: [0, 0, 0], workers, processes: []});
const ctr = (at: number, containers: string[] = []): Sample => ({at, stream: 'containers', containers});
const thermal = (at: number, t: number, f: number): Sample =>
  ({at, stream: 'thermal', temperaturesC: {'k10temp/temp1': t, 'nvme/temp1': 99}, frequencyKHz: {'0': f, '1': f * 2}});
// Samples every second (fast), every 10 s (process, containers) and every 5 s (thermal) from t = 0 to 120 s.
const steady = () => [
  ...Array.from({length: 121}, (_, i) => fast(i * 1000)),
  ...Array.from({length: 13}, (_, i) => proc(i * 10_000)),
  ...Array.from({length: 13}, (_, i) => ctr(i * 10_000 + 300)),
  ...Array.from({length: 25}, (_, i) => thermal(i * 5000, 60, 4_000_000)),
];
const opts = {thermal: true, serverCpus: [0]};

test('a steady window is valid and reports dirty memory at its start, the CPU temperature and server frequency', () => {
  const facts = windowFacts(steady(), 20_000, 80_000, [], opts);
  assert.deepEqual(facts.invalid, []);
  assert.equal(facts.env.dirtyWritebackAtStartBytes, 15);
  assert.equal(facts.env.meanTemperatureC, 60);
  assert.equal(facts.env.meanFrequencyKHz, 4_000_000);
});

test('a gap over 30 s in any stream is INVALID; failed readings count as missing', () => {
  const s = steady().filter(x => !(x.stream === 'fast' && x.at > 30_000 && x.at < 62_000));
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], opts).invalid, ['fast sampler gap over 30 s']);
  const failed = steady().map(x => x.stream === 'process' && x.at >= 20_000 && x.at <= 60_000 ? {at: x.at, stream: 'process' as const, error: 'ps failed'} : x);
  assert.deepEqual(windowFacts(failed, 20_000, 80_000, [], opts).invalid, ['process sampler gap over 30 s']);
  assert.deepEqual(gaps([], 'fast', 0, 1), ['fast sampler gap over 30 s']);
});

test('a gap of exactly 30 s is valid; one millisecond more is INVALID', () => {
  const at = (ts: number[]) => ts.map(t => fast(t));
  assert.deepEqual(gaps(at([0, 30_000, 60_000]), 'fast', 10_000, 50_000), []);
  assert.deepEqual(gaps(at([0, 30_001, 60_000]), 'fast', 10_000, 50_000), ['fast sampler gap over 30 s']);
});

test('a window is covered once every stream has an observation at or after its end, or past the deadline', () => {
  const s = steady().filter(x => x.at <= 80_000 || x.stream === 'fast');
  assert.equal(covered(s, 70_000, true, 81_000), true);
  // No process sample after 80 s yet: wait (a sample started at end + 9 s may still be running).
  assert.equal(covered(s, 81_000, true, 95_000), false);
  assert.equal(covered(s, 81_000, true, 81_000 + coverageDeadlineMs), true);
  assert.deepEqual(windowFacts(steady(), 20_000, 81_000, [], opts).invalid, []);
});

test('a missing thermal stream is a gap on Linux only', () => {
  const s = steady().filter(x => x.stream !== 'thermal');
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], opts).invalid, ['thermal sampler gap over 30 s']);
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], {thermal: false, serverCpus: null}).invalid, []);
});

test('a worker process or another container during the window is INVALID; outside it is not', () => {
  const s = [...steady(), proc(50_000, ['123 codex exec x']), ctr(90_000, ['other'])];
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], opts).invalid, ['worker process during the measurement: 123 codex exec x']);
  assert.deepEqual(windowFacts(s, 85_000, 95_000, [], opts).invalid, ['other container during the measurement: other']);
});

test('each observation counts at its own time: a container seen just after the end is outside the window', () => {
  // ps at 80 s, docker ps at 80.3 s: the container observation is after an 80 s window end.
  const s = [...steady(), ctr(80_300, ['late'])];
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], opts).invalid, []);
  assert.deepEqual(windowFacts(s, 20_000, 80_300, [], opts).invalid, ['other container during the measurement: late']);
});

test('frequency uses only samples that read every server CPU', () => {
  const partial = steady().map(x => x.stream === 'thermal' ? {...x, frequencyKHz: {'1': 9}} : x);
  assert.equal(windowFacts(partial, 20_000, 80_000, [], opts).env.meanFrequencyKHz, null);
  assert.equal(windowFacts(steady(), 20_000, 80_000, [], {thermal: false, serverCpus: null}).env.meanFrequencyKHz, null);
});

test('autovacuum on measured is attributed to the blocks it overlaps; other databases are ignored', () => {
  const av = (datname: string) => ({autovacuum: [{pid: 1, datname, query: 'autovacuum: VACUUM public.messages'}]});
  const s = [...steady(), fast(45_500, av('measured')), fast(70_500, av('base'))];
  const blocks = [{query: 'q1', start: 20_000, end: 40_000}, {query: 'q2', start: 40_000, end: 60_000}, {query: 'q3', start: 60_000, end: 80_000}];
  assert.deepEqual(windowFacts(s, 20_000, 80_000, blocks, opts).env.autovacuumQueries, ['q2']);
});

test('meminfo parsing and the worker filter that skips this diagnostic', () => {
  assert.deepEqual(parseMeminfo('MemTotal: 10 kB\nCached:  4 kB\nDirty:   2 kB\nWriteback:   1 kB\n'),
    {dirtyBytes: 2048, writebackBytes: 1024, cachedBytes: 4096});
  assert.throws(() => parseMeminfo('MemTotal: 10 kB\n'), /no Dirty/);
  const ps = ['1 node load/search-engines/diagnose-870/run.ts --stage 1', '2 node /x/load/search-engines/diagnose-870/sampler.ts',
    '3 codex exec review', '4 node load/other.ts'].join('\n');
  assert.deepEqual(otherWorkers(ps, 999), ['3 codex exec review', '4 node load/other.ts']);
});

test('a failed reading after the end does not cover the window; the next good one does', () => {
  // Good process samples at 85 s and 105 s, a failed one at 95 s, window end 90 s: the real gap is 20 s.
  const s = [...steady().filter(x => x.stream !== 'process' || x.at <= 80_000), proc(85_000),
    {at: 95_000, stream: 'process' as const, error: 'ps failed'}];
  assert.equal(covered(s, 90_000, true, 96_000), false);
  const later = [...s, proc(105_000)];
  assert.equal(covered(later, 90_000, true, 106_000), true);
  assert.deepEqual(windowFacts(later, 30_000, 90_000, [], opts).invalid, []);
});

test('after a restart over 30 s, a fresh fast sample keeps the restart-only window valid and sets its start', () => {
  // The server is down from 60 s to 100 s (fast readings fail); the window starts at 101.5 s.
  const down = steady().filter(x => x.stream !== 'fast' || x.at <= 60_000 || x.at > 120_000);
  const window = (extra: Sample[]) => windowFacts([...down, ...extra, ...Array.from({length: 20}, (_, i) => fast(102_000 + i * 1000))],
    101_500, 120_000, [], opts);
  assert.deepEqual(window([]).invalid, ['fast sampler gap over 30 s']);
  assert.equal(freshFast(down, 100_000), false);
  const fresh = fast(100_800, {dirtyBytes: 7, writebackBytes: 0});
  assert.equal(freshFast([...down, fresh], 100_000), true);
  assert.deepEqual(window([fresh]).invalid, []);
  assert.equal(window([fresh]).env.dirtyWritebackAtStartBytes, 7);
});

test('an observation whose interval overlaps the window counts against it, at either edge', () => {
  const seen = (at: number, done: number): Sample => ({at, done, stream: 'containers', containers: ['other']});
  assert.deepEqual(windowFacts([...steady(), seen(19_000, 20_500)], 20_000, 80_000, [], opts).invalid, ['other container during the measurement: other']);
  assert.deepEqual(windowFacts([...steady(), seen(79_500, 81_000)], 20_000, 80_000, [], opts).invalid, ['other container during the measurement: other']);
  assert.deepEqual(windowFacts([...steady(), seen(18_000, 19_900)], 20_000, 80_000, [], opts).invalid, []);
  assert.deepEqual(windowFacts([...steady(), seen(80_100, 80_400)], 20_000, 80_000, [], opts).invalid, []);
});
