import assert from 'node:assert/strict';
import test from 'node:test';
import type { Measurement } from './judge.ts';
import { diskStop, execute, type Deps } from './orchestrate.ts';
import { sequence } from './plan.ts';

const GiB = 1024 ** 3;

function fake(over: Partial<Deps> & {invalidIds?: string[]; failOn?: string} = {}) {
  const calls: string[] = [];
  let current = '';
  const d: Deps = {
    freeBytes: () => ({docker: 200 * GiB, snapshot: 200 * GiB, output: 200 * GiB}),
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
    validate: async () => undefined,
    idle: async ms => { calls.push(`idle ${ms}`); },
    scan: async () => { calls.push('scan'); },
    log: () => undefined,
    ...over,
  };
  return {d, calls, current: () => current};
}

test('the smoke is copy, settle, restart, warm-up, measure with EXPLAIN', async () => {
  const {d, calls} = fake();
  const {measurements, stopped} = await execute(sequence('smoke'), d);
  assert.equal(stopped, null);
  assert.deepEqual(calls, ['copy', 'settle', 'restart', 'warmup F', 'measure smoke.1 +explain']);
  assert.equal(measurements.length, 1);
});

test('hot only measures; restart-only restarts and skips the warm-up; no EXPLAIN between warm, hot 1 and hot 2', async () => {
  const {d, calls} = fake();
  await execute(sequence('1'), d);
  const c1 = calls.slice(calls.indexOf('measure C1.warm') - 3, calls.indexOf('measure C1.restart +explain') + 1);
  assert.deepEqual(c1, ['copy', 'restart', 'warmup F', 'measure C1.warm', 'measure C1.hot1', 'measure C1.hot2 +explain',
    'restart', 'measure C1.restart +explain']);
});

test('Stage 1 runs every step once in order, settle only in the settle rounds, no EXPLAIN between cache measurements', async () => {
  const {d, calls} = fake();
  await execute(sequence('1'), d);
  assert.equal(calls.filter(c => c === 'copy').length, 14);
  assert.equal(calls.filter(c => c === 'settle').length, 2);
  assert.equal(calls.filter(c => c.startsWith('measure')).length, 20);
  assert.deepEqual(calls.filter(c => c.startsWith('idle')), [`idle ${30 * 60_000}`]);
  assert.deepEqual(calls.filter(c => c.startsWith('measure') && !c.endsWith('+explain')),
    ['measure C1.warm', 'measure C1.hot1', 'measure C2.warm', 'measure C2.hot1']);
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

test('any filesystem under 40 GB (decimal) before a copy is a STOP; unreadable is a STOP', async () => {
  for (const key of ['docker', 'snapshot', 'output'] as const) {
    let free = 200 * GiB;
    const {d, calls} = fake({freeBytes: () => ({docker: 200 * GiB, snapshot: 200 * GiB, output: 200 * GiB, [key]: free})});
    const run = execute(sequence('1'), {...d, measure: async (s, o) => { if (s.id === 'A1.2') free = 39.9e9; return d.measure(s, o); }});
    const {measurements, stopped} = await run;
    assert.equal(stopped, `A1.3: ${key} free 39.9 GB < 40 GB`);
    assert.equal(measurements.length, 2);
    assert.equal(calls.filter(c => c === 'copy').length, 2);
  }
  // 40 GB is decimal: exactly 40e9 bytes passes, though it is under 40 GiB.
  assert.equal(diskStop({docker: 40e9, snapshot: 40e9, output: 40e9}), null);
  assert.equal(diskStop({docker: 40e9 - 1, snapshot: 40e9, output: 40e9}), 'docker free 40.0 GB < 40 GB');
  const unreadable = await execute(sequence('1'), fake({freeBytes: () => ({docker: 200 * GiB, snapshot: null, output: 200 * GiB})}).d);
  assert.equal(unreadable.stopped, 'A1.1: snapshot free unreadable < 40 GB');
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
  const {d} = fake({validate: async ms => { for (const m of ms) if (!m.invalid.length) m.invalid.push('process sampler gap over 30 s'); }});
  const r = await execute(sequence('1'), d);
  assert.equal(r.stopped, 'more than 4 INVALID measurements');
  assert.equal(r.measurements.length, 5);
});

test('no step starts before the sampler check of the previous measurement has resolved', async () => {
  // The samplers cover each window only later; the fifth INVALID must stop the stage before step 6.
  const pending: (() => void)[] = [];
  const {d, calls} = fake();
  const delayed: Deps = {...d, validate: ms => new Promise<void>(resolve => pending.push(() => {
    for (const m of ms) if (m.id.startsWith('A1.') && !m.invalid.length) m.invalid.push('fast sampler gap over 30 s');
    resolve();
  }))};
  const run = execute(sequence('1'), delayed);
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5));
    const before = calls.length;
    await new Promise(r => setTimeout(r, 5));
    assert.equal(calls.length, before, 'a step ran while validation was pending');
    pending.shift()?.();
  }
  const r = await run;
  assert.equal(r.stopped, 'more than 4 INVALID measurements');
  assert.deepEqual(r.measurements.map(m => m.id), ['A1.1', 'A1.2', 'A1.3', 'A1.4', 'A1.5']);
  assert.equal(calls.filter(c => c === 'copy').length, 5);
});

test('a failing step is a STOP with its id; earlier measurements are kept', async () => {
  const {d} = fake({failOn: 'A1.3'});
  const r = await execute(sequence('1'), d);
  assert.equal(r.stopped, 'A1.3: Error: boom');
  assert.deepEqual(r.measurements.map(m => m.id), ['A1.1', 'A1.2']);
});
