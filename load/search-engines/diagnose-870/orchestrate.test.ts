import assert from 'node:assert/strict';
import test from 'node:test';
import { evidence, type Measurement } from './judge.ts';
import { abortableIdle, diskStop, execute, maxInvalid, minDockerStartBytes, settleWait, startDiskProblems, type Deps } from './orchestrate.ts';
import { sequence, settleCapMs } from './plan.ts';

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
        sharedReads: 0, env: {dirtyWritebackAtStartBytes: null, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: [], autovacuumInsideQueries: []},
        invalid: over.invalidIds?.includes(step.id) ? ['fake'] : [], missingEvidence: [], samplerChecked: false} satisfies Measurement;
    },
    validate: async ms => { for (const m of ms) m.samplerChecked = true; },
    idle: async ms => { calls.push(`idle ${ms}`); },
    scan: async () => { calls.push('scan'); },
    log: () => undefined,
    aborted: () => null,
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
  // 40 GB is decimal: exactly 40e9 bytes passes, though it is under 40 GiB; one byte less is a STOP, on each target.
  assert.equal(diskStop({docker: 40e9, snapshot: 40e9, output: 40e9}), null);
  for (const key of ['docker', 'snapshot', 'output'] as const) {
    assert.equal(diskStop({docker: 40e9, snapshot: 40e9, output: 40e9, [key]: 40e9 - 1}), `${key} free 40.0 GB < 40 GB`);
    assert.equal(diskStop({docker: 40e9, snapshot: 40e9, output: 40e9, [key]: null}), `${key} free unreadable < 40 GB`);
  }
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

test('start disk preflight (§3.3): Docker >= 175 GB, snapshot and output filesystems >= 40 GB, exact decimal boundaries', () => {
  const ok = {docker: 175e9, snapshot: 40e9, output: 40e9};
  assert.equal(minDockerStartBytes, 175e9);
  assert.deepEqual(startDiskProblems(ok), []);
  assert.deepEqual(startDiskProblems({...ok, docker: 175e9 - 1}), [`Docker free ${175e9 - 1} < 175 GB`]);
  assert.deepEqual(startDiskProblems({...ok, docker: null}), ['Docker free unreadable < 175 GB']);
  for (const key of ['snapshot', 'output'] as const) {
    assert.deepEqual(startDiskProblems({...ok, [key]: 40e9 - 1}), [`${key} filesystem free ${40e9 - 1} < 40 GB`]);
    assert.deepEqual(startDiskProblems({...ok, [key]: null}), [`${key} filesystem free unreadable < 40 GB`]);
  }
  // 175 GiB would refuse 180 GB; the approved unit is decimal.
  assert.deepEqual(startDiskProblems({...ok, docker: 180e9}), []);
});

// A fake clock: each reading takes `readMs`; the conditions are met from `settledAt` on.
function settleClock(settledAt: number, readMs = 0, checkpointMs = 0) {
  let t = 0;
  const io = {
    checkpoint: () => { t += checkpointMs; },
    reading: () => { t += readMs; return t >= settledAt ? {dirtyWritebackBytes: 0, autovacuumWorkers: 0} : {dirtyWritebackBytes: 100 * 1024 ** 2, autovacuumWorkers: 0}; },
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
  return io;
}

test('the settle wait: settled at 15 min exactly is valid; just over the cap is INVALID', async () => {
  assert.equal(settleCapMs, 15 * 60_000);
  assert.equal(await settleWait(settleClock(0), settleCapMs), true);
  assert.equal(await settleWait(settleClock(settleCapMs), settleCapMs), true);
  assert.equal(await settleWait(settleClock(settleCapMs + 1), settleCapMs), false);
  // A reading that returns after the cap does not count, even when it would have settled.
  let r = 0;
  const slow = {checkpoint: () => undefined, now: () => r, sleep: async () => { r = settleCapMs - 100; },
    reading: () => { const first = r === 0; r += first ? 0 : 200; return {dirtyWritebackBytes: first ? 100 * 1024 ** 2 : 0, autovacuumWorkers: 0}; }};
  assert.equal(await settleWait(slow, settleCapMs), false);
  // The CHECKPOINT counts against the cap.
  assert.equal(await settleWait(settleClock(0, 0, settleCapMs + 1), settleCapMs), false);
  // Autovacuum alone keeps it unsettled; Dirty plus Writeback must be under 64 MiB, not at it.
  let t = 0;
  const busy = {checkpoint: () => undefined, reading: () => ({dirtyWritebackBytes: 64 * 1024 ** 2, autovacuumWorkers: 0}),
    now: () => t, sleep: async (ms: number) => { t += ms; }};
  assert.equal(await settleWait(busy, settleCapMs), false);
  t = 0;
  assert.equal(await settleWait({...busy, reading: () => ({dirtyWritebackBytes: 0, autovacuumWorkers: 1})}, settleCapMs), false);
});

test('the INVALID STOP counts across arms: 4 anywhere is not a STOP, a fifth anywhere is, at once', async () => {
  assert.equal(maxInvalid, 4);
  const spread = ['A1.2', 'A2.1', 'C1.hot1', 'D.settle2'];
  const four = await execute(sequence('1'), fake({invalidIds: spread}).d);
  assert.equal(four.stopped, null);
  assert.equal(four.measurements.length, 20);
  // The fifth is the very last measurement: still a STOP.
  const last = await execute(sequence('1'), fake({invalidIds: [...spread, 'C2.restart']}).d);
  assert.equal(last.stopped, 'more than 4 INVALID measurements');
  // A fifth in the middle stops the stage right after it: nothing later runs.
  const mid = fake({invalidIds: [...spread.slice(0, 3), 'D.current1', 'D.settle1']});
  const r = await execute(sequence('1'), mid.d);
  assert.equal(r.stopped, 'more than 4 INVALID measurements');
  assert.equal(r.measurements.at(-1)!.id, 'D.settle1');
  assert.equal(mid.calls.filter(c => c === 'copy').length, 11);
});

test('a sampler death during the final validation leaves the window unchecked: evidence incomplete', async () => {
  // The validation of C2.restart's window is where the sampler dies, so that window stays unchecked.
  const dying = fake({validate: async ms => {
    if (ms.at(-1)!.id === 'C2.restart') throw new Error('the sampler process exited');
    for (const m of ms) m.samplerChecked = true;
  }});
  const r = await execute(sequence('1'), dying.d);
  assert.match(r.stopped!, /sampler process exited/);
  assert.deepEqual(evidence(r.measurements).missing, ['C2.restart: sampler window not checked']);
});

test('after a CHECKPOINT that overran the cap no reading starts: INVALID, not a STOP', async () => {
  let t = 0;
  const io = {checkpoint: () => { t = settleCapMs + 1; }, now: () => t, sleep: async () => undefined,
    reading: () => { throw new Error('docker exec: container busy'); }};
  assert.equal(await settleWait(io, settleCapMs), false);
});

test('a signal during the idle ends the sequence: no copy, restart or measurement starts after it (review round 6)', async () => {
  let reason: string | null = null;
  const {d, calls} = fake({idle: async ms => { calls.push(`idle ${ms}`); reason = 'SIGTERM'; }, aborted: () => reason});
  const {stopped} = await execute(sequence('1'), d);
  const idle = calls.findIndex(c => c.startsWith('idle'));
  assert.ok(idle > 0);
  assert.deepEqual(calls.slice(idle + 1), []);
  assert.match(stopped ?? '', /aborted by SIGTERM/);
});

test('a signal between a copy and its restart stops before the restart; one after the last step still STOPs', async () => {
  let reason: string | null = null;
  const {d, calls} = fake({copy: async () => { calls.push('copy'); reason = 'SIGINT'; }, aborted: () => reason});
  const r = await execute(sequence('smoke'), d);
  assert.deepEqual(calls, ['copy']);
  assert.match(r.stopped ?? '', /smoke\.1: aborted by SIGINT/);
  let late: string | null = null;
  let validated = 0;
  const after = fake({measure: async (step, opts) => { late = 'SIGTERM'; return fake().d.measure(step, opts); }, aborted: () => late,
    validate: async () => { validated++; }});
  const r2 = await execute(sequence('smoke'), after.d);
  assert.equal(r2.stopped, 'aborted by SIGTERM');
  // The per-step validation ran before the signal was seen; the final coverage wait is skipped after it.
  assert.equal(validated, 1);
});

test('the idle wait ends within one slice of a signal', async () => {
  let t = 0, reason: string | null = null;
  const slept: number[] = [];
  await abortableIdle(30 * 60_000, () => reason, () => t, async ms => { slept.push(ms); t += ms; if (t >= 3_000) reason = 'SIGTERM'; });
  assert.deepEqual(slept, [1_000, 1_000, 1_000]);
  t = 0; reason = null; slept.length = 0;
  await abortableIdle(2_500, () => reason, () => t, async ms => { slept.push(ms); t += ms; });
  assert.deepEqual(slept, [1_000, 1_000, 500]);
});
