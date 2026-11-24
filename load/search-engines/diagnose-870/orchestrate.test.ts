import assert from 'node:assert/strict';
import test from 'node:test';
import type { Measurement } from './judge.ts';
import { execute, type Deps } from './orchestrate.ts';
import { sequence } from './plan.ts';

const GiB = 1024 ** 3;

function fake(over: Partial<Deps> & {invalidIds?: string[]; failOn?: string} = {}) {
  const calls: string[] = [];
  let current = '';
  const d: Deps = {
    dockerFreeBytes: () => 200 * GiB,
    copy: async () => { calls.push('copy'); },
    settle: async () => { calls.push('settle'); return true; },
    restart: async () => { calls.push('restart'); },
    warmup: async step => { calls.push(`warmup ${step.order}`); },
    measure: async (step, opts) => {
      current = step.id;
      if (over.failOn === step.id) throw new Error('boom');
      calls.push(`measure ${step.id}${opts.explain ? ' +explain' : ''}`);
      return {id: step.id, kind: step.kind, arm: step.arm, order: step.order, settle: false, latencies: [], plans: null,
        sharedReads: 0, env: {dirtyWritebackAtStartBytes: null, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []},
        invalid: over.invalidIds?.includes(step.id) ? ['fake'] : []} satisfies Measurement;
    },
    revalidate: () => undefined,
    idle: async ms => { calls.push(`idle ${ms}`); },
    scan: async () => { calls.push('scan'); },
    log: () => undefined,
    ...over,
  };
  return {d, calls, current: () => current};
}

test('a copy round is copy, restart, warm-up, measure; hot only measures; restart-only skips the warm-up', async () => {
  const {d, calls} = fake();
  const {measurements, stopped} = await execute(sequence('smoke'), d);
  assert.equal(stopped, null);
  assert.deepEqual(calls, ['copy', 'settle', 'restart', 'warmup F', 'measure smoke.settle +explain',
    'measure smoke.hot', 'restart', 'measure smoke.restart +explain']);
  assert.equal(measurements.length, 3);
});

test('Stage 1 runs every step once in order, settle only in the settle rounds, no EXPLAIN between cache measurements', async () => {
  const {d, calls} = fake();
  await execute(sequence('1'), d);
  assert.equal(calls.filter(c => c === 'copy').length, 14);
  assert.equal(calls.filter(c => c === 'settle').length, 2);
  assert.equal(calls.filter(c => c.startsWith('measure')).length, 20);
  assert.deepEqual(calls.filter(c => c.startsWith('idle')), [`idle ${30 * 60_000}`]);
  for (const id of ['C1.warm', 'C1.hot1', 'C1.hot2', 'C2.warm']) assert.ok(calls.includes(`measure ${id}`), id);
  for (const id of ['A1.1', 'D.settle2', 'C1.restart']) assert.ok(calls.includes(`measure ${id} +explain`), id);
  const settle = calls.indexOf('settle');
  assert.deepEqual(calls.slice(settle - 1, settle + 4), ['copy', 'settle', 'restart', 'warmup F', 'measure D.settle1 +explain']);
});

test('Stage 2 scans once after its first round', async () => {
  const {d, calls} = fake();
  await execute(sequence('2'), d);
  assert.equal(calls.indexOf('scan'), calls.indexOf('measure B.pre +explain') + 1);
});

test('a capped settle wait makes that round INVALID and the stage goes on', async () => {
  const {d} = fake({settle: async () => false});
  const {measurements, stopped} = await execute(sequence('smoke'), d);
  assert.equal(stopped, null);
  assert.deepEqual(measurements[0].invalid, ['settle wait hit its cap']);
});

test('Docker free under 40 GiB before a copy is a STOP; unreadable is a STOP', async () => {
  let free = 200 * GiB;
  const {d, calls} = fake({dockerFreeBytes: () => free});
  const run = execute(sequence('1'), {...d, measure: async (s, o) => { if (s.id === 'A1.2') free = 39 * GiB; return d.measure(s, o); }});
  const {measurements, stopped} = await run;
  assert.match(stopped!, /^A1\.3: Docker free 39\.0 GiB < 40 GiB$/);
  assert.equal(measurements.length, 2);
  assert.equal(calls.filter(c => c === 'copy').length, 2);
  const unreadable = await execute(sequence('1'), fake({dockerFreeBytes: () => null}).d);
  assert.match(unreadable.stopped!, /unreadable/);
});

test('more than 4 INVALID measurements is a STOP; 4 is not; nothing is rerun', async () => {
  const four = await execute(sequence('1'), fake({invalidIds: ['A1.1', 'A1.2', 'A1.3', 'A1.4']}).d);
  assert.equal(four.stopped, null);
  assert.equal(four.measurements.length, 20);
  const five = fake({invalidIds: ['A1.1', 'A1.2', 'A1.3', 'A1.4', 'A1.5']});
  const r = await execute(sequence('1'), five.d);
  assert.equal(r.stopped, 'more than 4 INVALID measurements');
  assert.deepEqual(r.measurements.map(m => m.id), ['A1.1', 'A1.2', 'A1.3', 'A1.4', 'A1.5']);
});

test('sampler reasons added by revalidate count toward the STOP', async () => {
  const {d} = fake({revalidate: ms => { for (const m of ms) if (!m.invalid.length) m.invalid.push('process sampler gap over 30 s'); }});
  const r = await execute(sequence('1'), d);
  assert.equal(r.stopped, 'more than 4 INVALID measurements');
  assert.equal(r.measurements.length, 5);
});

test('a failing step is a STOP with its id; earlier measurements are kept', async () => {
  const {d} = fake({failOn: 'A1.3'});
  const r = await execute(sequence('1'), d);
  assert.equal(r.stopped, 'A1.3: Error: boom');
  assert.deepEqual(r.measurements.map(m => m.id), ['A1.1', 'A1.2']);
});
