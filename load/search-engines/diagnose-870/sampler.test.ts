import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { awaitCoverage, covered, coverageDeadlineMs, freshFast, gaps, otherWorkers, parseMeminfo, stopProcess, windowFacts, type Sample } from './sampler.ts';

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

test('gaps use each observation interval at its widest: from the earlier start to the later return', () => {
  const o = (at: number, done: number) => ({...fast(at), done});
  // Started 30 s apart, but the second returned 0.5 s later: up to 30.5 s between the readings.
  assert.deepEqual(gaps([o(0, 0), o(30_000, 30_500), o(40_000, 40_000)], 'fast', 10_000, 35_000), ['fast sampler gap over 30 s']);
  assert.deepEqual(gaps([o(0, 0), o(29_500, 30_000), o(40_000, 40_000)], 'fast', 10_000, 35_000), []);
  // A failed reading in between covers nothing.
  const failed = {at: 15_000, done: 15_100, stream: 'fast' as const, error: 'docker exec failed'};
  assert.deepEqual(gaps([o(0, 0), failed, o(31_000, 31_000)], 'fast', 10_000, 20_000), ['fast sampler gap over 30 s']);
});

test('the gap across each restart is checked: over 30 s, or no fresh fast sample, makes the round INVALID', () => {
  // Fast readings fail from 60 s while the server restarts; the window starts at 100 s.
  const around = (lastBefore: number, firstAfter: number) => [
    ...steady().filter(x => x.stream !== 'fast' || x.at <= lastBefore),
    ...Array.from({length: 40}, (_, i) => fast(firstAfter + i * 1000))];
  const restart = {at: 60_500, fresh: true};
  const facts = (s: Sample[], r = restart) => windowFacts(s, 100_000, 120_000, [], {...opts, restart: r}).invalid;
  // 30 s exactly between the last reading before and the first after the restart is valid; 1 ms more is INVALID.
  assert.deepEqual(facts(around(60_000, 90_000)), []);
  assert.deepEqual(facts(around(60_000, 90_001)), ['fast sampler gap over 30 s across the restart']);
  // The window alone would look clean: the restart gap is what catches it.
  assert.deepEqual(windowFacts(around(60_000, 95_000), 100_000, 120_000, [], opts).invalid, []);
  assert.deepEqual(facts(around(60_000, 95_000)), ['fast sampler gap over 30 s across the restart']);
  assert.deepEqual(facts(around(60_000, 90_000), {at: 60_500, fresh: false}), ['no fresh fast sample within 30 s after the restart']);
});

test('coverage waiting has a hard deadline and stops when the sampler process is gone', async () => {
  let t = 100_000;
  const io = (alive = true) => ({now: () => t, sleep: async (ms: number) => { t += ms; }, alive: () => alive});
  const few = steady().filter(x => x.at <= 80_000);
  t = 90_000;
  const r = await awaitCoverage(() => few, 85_000, true, io(), 1_000);
  assert.equal(r.reached, true);
  assert.ok(t >= 85_000 + coverageDeadlineMs && t <= 85_000 + coverageDeadlineMs + 1_000);
  // The stalled sampler leaves gaps once the deadline passes.
  assert.deepEqual(windowFacts(r.samples, 60_000, 85_000, [], opts).invalid.length > 0, true);
  t = 90_000;
  await assert.rejects(awaitCoverage(() => few, 85_000, true, io(false)), /sampler process exited/);
  // A hard deadline even when the clock never reaches the coverage deadline through `covered`.
  let calls = 0;
  const frozen = {now: () => (calls++ < 3 ? 0 : 1e12), sleep: async () => undefined, alive: () => true};
  assert.equal((await awaitCoverage(() => [], 1e13, true, frozen)).reached, false);
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null; signalCode: string | null = null; signals: string[] = [];
  exitOn: string[];
  constructor(exitOn: string[]) { super(); this.exitOn = exitOn; }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (this.exitOn.includes(signal)) setTimeout(() => { this.signalCode = signal; this.emit('exit'); }, 1);
    return true;
  }
}

test('the sampler stop is SIGTERM, a bounded wait, SIGKILL, and a verified exit', async () => {
  const term = new FakeChild(['SIGTERM']);
  assert.deepEqual(await stopProcess(term, 50, 50), {verified: true, how: 'SIGTERM'});
  assert.deepEqual(term.signals, ['SIGTERM']);
  const stubborn = new FakeChild(['SIGKILL']);
  assert.deepEqual(await stopProcess(stubborn, 10, 50), {verified: true, how: 'SIGKILL'});
  assert.deepEqual(stubborn.signals, ['SIGTERM', 'SIGKILL']);
  const stuck = new FakeChild([]);
  assert.deepEqual(await stopProcess(stuck, 10, 10), {verified: false, how: 'did not exit after SIGKILL'});
  const gone = new FakeChild([]);
  gone.exitCode = 0;
  assert.deepEqual(await stopProcess(gone), {verified: true, how: 'already exited'});
  assert.deepEqual(gone.signals, []);
});

test('an autovacuum reading that partly overlaps a block only blocks the H5 rule-out; support needs it wholly inside', () => {
  const av = {autovacuum: [{pid: 1, datname: 'measured', query: 'autovacuum: VACUUM public.messages'}]};
  const blocks = [{query: 'q1', start: 40_000, end: 60_000}];
  const env = (s: Parameters<typeof windowFacts>[0]) => windowFacts(s, 20_000, 80_000, blocks, opts).env;
  // Started 0.4 s before the block and returned inside it: the worker may have finished before the block.
  const partial = env([...steady(), {...fast(39_600, av), done: 40_200}]);
  assert.deepEqual([partial.autovacuumQueries, partial.autovacuumInsideQueries], [['q1'], []]);
  const inside = env([...steady(), {...fast(40_000, av), done: 40_600}]);
  assert.deepEqual([inside.autovacuumQueries, inside.autovacuumInsideQueries], [['q1'], ['q1']]);
  const before = env([...steady(), {...fast(39_000, av), done: 39_500}]);
  assert.deepEqual([before.autovacuumQueries, before.autovacuumInsideQueries], [[], []]);
});

test('the sampler stop is verified only when its whole process group is gone', async () => {
  // The sampler exits on SIGTERM but one of its commands keeps the group alive until SIGKILL.
  const child = new FakeChild(['SIGTERM']);
  let group = true;
  const kill = child.kill.bind(child);
  child.kill = (signal: NodeJS.Signals) => { if (signal === 'SIGKILL') group = false; return kill(signal); };
  assert.deepEqual(await stopProcess(child, 30, 30, () => group), {verified: true, how: 'SIGKILL'});
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  const stuck = new FakeChild(['SIGTERM']);
  assert.deepEqual(await stopProcess(stuck, 10, 10, () => true), {verified: false, how: 'its process group outlived SIGKILL'});
});
