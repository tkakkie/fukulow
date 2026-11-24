import assert from 'node:assert/strict';
import test from 'node:test';
import { gaps, otherWorkers, parseMeminfo, windowFacts, type Sample } from './sampler.ts';

const fast = (at: number, over: Partial<Extract<Sample, {stream: 'fast'; dirtyBytes: number}>> = {}): Sample =>
  ({at, stream: 'fast', dirtyBytes: 10, writebackBytes: 5, cachedBytes: 1, autovacuum: [], checkpointer: {}, wal: {}, ...over});
const proc = (at: number, workers: string[] = [], containers: string[] = []): Sample => ({at, stream: 'process', load: [0, 0, 0], workers, containers});
const thermal = (at: number, t: number, f: number): Sample =>
  ({at, stream: 'thermal', temperaturesC: {'k10temp/temp1': t, 'nvme/temp1': 99}, frequencyKHz: {'0': f, '1': f * 2}});
// Samples every second (fast), every 10 s (process) and every 5 s (thermal) from t = 0 to 120 s.
const steady = () => [
  ...Array.from({length: 121}, (_, i) => fast(i * 1000)),
  ...Array.from({length: 13}, (_, i) => proc(i * 10_000)),
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

test('a missing thermal stream is a gap on Linux only', () => {
  const s = steady().filter(x => x.stream !== 'thermal');
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], opts).invalid, ['thermal sampler gap over 30 s']);
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], {thermal: false, serverCpus: null}).invalid, []);
});

test('a worker process or another container during the window is INVALID; outside it is not', () => {
  const s = [...steady(), proc(50_000, ['123 codex exec x']), proc(90_000, [], ['other'])];
  assert.deepEqual(windowFacts(s, 20_000, 80_000, [], opts).invalid, ['worker process during the measurement: 123 codex exec x']);
  assert.deepEqual(windowFacts(s, 85_000, 95_000, [], opts).invalid, ['other container during the measurement: other']);
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
