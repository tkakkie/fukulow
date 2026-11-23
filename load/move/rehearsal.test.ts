import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stages } from '../harness-core/stages.ts';
import { diagnosticMode } from './diagnostic-mode.ts';
import type { Seeded } from './fixture.ts';
import { armInvalid, infrastructureFailure, judge, type Measurement, type Result } from './judge.ts';
import { storage } from './measure.ts';
import type { Lane } from './metrics.ts';
import { moveInterval, plan, rehearsalCell, rehearsalPlan, rehearsalSeconds, rehearsalSteps, stepId, steps, type Plan, type Step } from './plan.ts';
import { render } from './report.ts';
import { canRerun, firstArmInvalid, generator, rehearsalChecks, scheduledWork, selectRun, statusFlags } from './run.ts';
import type { Stack } from '../slice5/stack.ts';
import { workloadOptions } from './workload-options.ts';

const formal = plan(false);
const pair = '9cb1f78c938b72657fe91177f43ca34f65015857';

function lane(attempted: number): Lane {
  return { attempted, accepted: attempted, droppedIterations: 0, otherErrors: 0,
    rejected429: 0, rejected503: 0, clientTimeouts: 0, transportErrors: 0, p95: 10, p99: 20 };
}

// A measurement that passes every per-arm validity check under plan p.
function valid(p: Plan, step: Step): Measurement {
  const { part, size, arm } = step, active = arm === 'move';
  const readerTarget = part === 'A' || part === 'F' ? 4 : p.readerRate * ((part === 'E' ? p.replaySeconds : p.seconds) + p.drain);
  const m: Measurement = { lanes: { reader: lane(readerTarget) }, evidence: { samples: 10, maxSampleGapMs: 1000, samplingErrors: 0 }, readerTarget };
  if (part === 'A' || part === 'F') m.lanes[active ? 'move' : 'create'] = lane(p.moves);
  else if (part === 'E') m.lanes.replay = lane(p.topicReaders * p.replayPerReader);
  else {
    m.lanes.send = lane(p.sendRate * p.seconds);
    if (active) m.lanes.move = lane(p.seconds / moveInterval(size));
    if (part === 'D') {
      m.lanes.channels = lane(p.channelRate * p.seconds);
      m.lanes.topics = lane(20 * p.topicReaders);
      m.topicReaders = Array.from({ length: p.topicReaders }, () => 20);
    }
  }
  if (active && part !== 'E') m.moveVerified = true;
  if (part === 'F') m.wal = { lsnBytes: p.moves * 100 * (active ? size : 1), messagesDelta: active ? 0 : p.moves,
    relationBytesDelta: 0, autovacuumInside: [], checkpointsInside: 0, statsReset: false };
  return m;
}
const rows = (p: Plan, list: Step[]): Result[] => list.map(step => ({ ...step, attempts: [{ measurement: valid(p, step) }] }));

test('without --smoke or --rehearsal the recorded job keeps the formal plan and every step', () => {
  const run = selectRun({ commit: 'c', image: 'i' });
  assert.equal(run.mode, 'recorded');
  assert.deepEqual(run.p, formal);
  assert.equal('rehearsal' in run.p, false);
  assert.deepEqual(run.orderedSteps, steps(formal));
  const smoke = selectRun({ smoke: true });
  assert.equal(smoke.mode, 'smoke');
  assert.deepEqual(smoke.p, plan(true));
  assert.throws(() => selectRun({ smoke: true, rehearsal: true }), /at most one/);
  assert.throws(() => selectRun({ diagnostic: true, smoke: true, rehearsal: true }), /at most one/);
});

test('a rehearsal keeps the recorded fixture and load and shortens only the window to one cell', () => {
  const run = selectRun({ rehearsal: true });
  assert.equal(run.mode, 'rehearsal');
  assert.deepEqual({ ...run.p, seconds: formal.seconds, rehearsal: undefined }, { ...formal, rehearsal: undefined });
  assert.equal(run.p.seconds, rehearsalSeconds);
  assert.equal(run.p.rehearsal, true);
  assert.deepEqual(rehearsalCell, { part: 'D', size: 100 });
  assert.deepEqual(run.orderedSteps.map(stepId), ['D-100-r1-baseline', 'D-100-r1-move']);
  assert.throws(() => rehearsalSteps(formal), /rehearsal plan/);
  // k6 gets the same lanes, rates and VU limits as the recorded cell; only durations change.
  for (const step of run.orderedSteps) {
    const short = workloadOptions(run.p, step).options.scenarios!, full = workloadOptions(formal, step).options.scenarios!;
    assert.deepEqual(Object.keys(short), Object.keys(full));
    for (const [name, scenario] of Object.entries(full)) {
      const s = short[name] as unknown as Record<string, unknown>, f = scenario as unknown as Record<string, unknown>;
      assert.deepEqual({ ...s, duration: undefined }, { ...f, duration: undefined });
    }
    assert.equal((short.send as { duration: string }).duration, `${rehearsalSeconds}s`);
    assert.equal((short.reader as { duration: string }).duration, `${rehearsalSeconds + formal.drain}s`);
  }
});

test('a DIAGNOSTIC rehearsal runs the job\'s first selected cell, round and read lanes in the short window', () => {
  const job = selectRun({ diagnostic: true, commit: pair });
  const rehearsal = selectRun({ diagnostic: true, rehearsal: true, commit: pair });
  assert.equal(job.mode, 'recorded');
  assert.equal(job.p.seconds, formal.seconds);
  assert.equal('rehearsal' in job.p, false);
  assert.equal(rehearsal.mode, 'rehearsal');
  assert.equal(rehearsal.p.rehearsal, true);
  assert.equal(rehearsal.p.seconds, rehearsalSeconds);
  assert.equal((rehearsal.p as { mode?: string }).mode, diagnosticMode);
  assert.deepEqual(rehearsal.orderedSteps, job.orderedSteps);
  assert.deepEqual({ ...rehearsal.selection, plan: undefined }, { ...job.selection, plan: undefined });
  const both = selectRun({ diagnostic: true, rehearsal: true, commit: pair, sizes: '100,1000', round: '2' });
  assert.deepEqual(both.orderedSteps.map(stepId), ['D-100-r2-move', 'D-100-r2-baseline']);
});

test('a rehearsal is never evidence: every gate is NOT EVALUATED and status.json says evidence false', () => {
  const p = rehearsalPlan();
  for (const list of [rehearsalSteps(p), steps(p)]) {
    const verdict = judge(p, rows(p, list), true);
    assert.equal(verdict.overall, 'NOT EVALUATED');
    assert.equal(verdict.limit.status, 'NOT EVALUATED');
    for (const row of verdict.rows) for (const round of row.rounds) {
      assert.equal(round.status, 'NOT EVALUATED');
      assert.deepEqual(round.reasons, ['a rehearsal is never evidence']);
    }
  }
  const cell = judge(p, rows(p, rehearsalSteps(p)), true).rows.find(row => row.part === 'D' && row.size === 100)!;
  assert.equal(cell.rounds[0].functional.status, 'PASS');
  assert.match(render(p, rows(p, rehearsalSteps(p)), true).markdown, /REHEARSAL\. Never evidence\./);
  // Rehearsal measurements judged as a recorded run fail the recorded offered-load bounds.
  const asFormal = rows(p, rehearsalSteps(p)).map(row => ({ ...row }));
  assert.match(armInvalid(formal, asFormal[0], asFormal[0].attempts[0]).join(), /offered load outside/);
  const out = mkdtempSync(join(tmpdir(), 'move-rehearsal-'));
  try {
    const status = stages(out, 'rehearsal').write({ failed: false, interrupted: false });
    assert.equal(status.evidence, false);
    assert.equal(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')).evidence, false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('fail fast applies judge()\'s per-arm INVALID rules to the first arm', () => {
  const [first] = rows(formal, steps(formal));
  assert.deepEqual(firstArmInvalid(formal, false, first), []);
  const broken: Result = { ...first, attempts: [{ problem: 'fixture failed (Error)' }] };
  assert.deepEqual(firstArmInvalid(formal, false, broken), ['fixture failed (Error)']);
  assert.deepEqual(firstArmInvalid(formal, true, broken), []);
  const dropped: Result = { ...first, attempts: [{ measurement: { ...valid(formal, first), lanes: {
    ...valid(formal, first).lanes, reader: { ...lane(4), droppedIterations: 1 } } } }] };
  assert.deepEqual(firstArmInvalid(formal, false, dropped), ['reader: dropped iterations']);
  // Same decision as judge(): INVALID there exactly when fail fast stops.
  for (const row of [first, broken, dropped]) {
    const verdict = judge(formal, [row], true).rows.find(r => r.part === row.part && r.size === row.size)!;
    assert.equal(verdict.rounds[0].functional.status === 'INVALID', firstArmInvalid(formal, false, row).length > 0);
  }
  const p = rehearsalPlan();
  const checks = rehearsalChecks(p, [...rows(p, rehearsalSteps(p)).slice(0, 1), { ...rehearsalSteps(p)[1], attempts: [] }]);
  assert.deepEqual(checks, [{ step: 'D-100-r1-baseline', problems: [] }, { step: 'D-100-r1-move', problems: ['missing step'] },
    { step: 'D-100-r1-functional', problems: ['unauthorized rerun'] }]);
});

// status.json as main() writes it after sampling, from the verdict of a complete run.
function recordedStatus(results: Result[]) {
  const verdict = render(formal, results, true).verdict;
  const passed = verdict.overall === 'PASS';
  const out = mkdtempSync(join(tmpdir(), 'move-status-'));
  try {
    const run = stages(out, 'recorded');
    run.startSampling();
    const status = run.finish(() => {}, { ...statusFlags({ passed, finished: true, cleanupIssues: 0, stoppedEarly: false, armProblem: false,
      diagnosticIncomplete: false, verdict }), interrupted: false, summaryInvalidates: true });
    return { verdict, passed, status };
  } finally { rmSync(out, { recursive: true, force: true }); }
}
const withLane = (row: Result, name: keyof Measurement['lanes'], change: Partial<ReturnType<typeof lane>>): Result => {
  const m = row.attempts[0].measurement!;
  return { ...row, attempts: [{ measurement: { ...m, lanes: { ...m.lanes, [name]: { ...m.lanes[name]!, ...change } } } }] };
};

test('status.json follows the verdict: INVALID is never evidence, a valid FAIL is a result-failure that stays evidence', () => {
  const all = rows(formal, steps(formal));
  const pass = recordedStatus(all);
  assert.equal(pass.verdict.overall, 'PASS');
  assert.deepEqual([pass.status.outcome, pass.status.evidence], ['success', true]);
  // A later arm with dropped iterations and no problem string: judge() says INVALID.
  const last = all.length - 1;
  const invalid = recordedStatus(all.map((row, i) => i === last ? withLane(row, 'reader', { droppedIterations: 1 }) : row));
  assert.equal(invalid.verdict.overall, 'INVALID');
  assert.equal(invalid.status.evidence, false);
  assert.equal(invalid.status.outcome, 'result-failure');
  // Missing resource samples, again without a problem string.
  const unsampled = recordedStatus(all.map((row, i) => i === last
    ? { ...row, attempts: [{ measurement: { ...row.attempts[0].measurement!, evidence: undefined } }] } : row));
  assert.equal(unsampled.status.evidence, false);
  // A valid threshold FAIL: exit 1, so never success, but still evidence.
  const slow = all.findIndex(row => row.part === 'D' && row.arm === 'move');
  const fail = recordedStatus(all.map((row, i) => i === slow ? withLane(row, 'channels', { p95: 10_000, p99: 20_000 }) : row));
  assert.equal(fail.verdict.overall, 'FAIL');
  assert.equal(fail.passed, false);
  assert.deepEqual([fail.status.outcome, fail.status.evidence], ['result-failure', true]);
  // A FAIL that hides an INVALID round elsewhere is not evidence.
  const mixed = recordedStatus(all.map((row, i) => i === slow ? withLane(row, 'channels', { p95: 10_000, p99: 20_000 })
    : i === last ? withLane(row, 'reader', { droppedIterations: 1 }) : row));
  assert.equal(mixed.verdict.overall, 'FAIL');
  assert.equal(mixed.status.evidence, false);
});

const fakeStack = (sql: (query: string) => string) => ({ env: { LOAD_PROJECT: 'move-test' }, network: 'none', sql }) as unknown as Stack;
const fakeSeeded = { data: { organization: 'o', otherOrganization: 'x', chain: { channel: 'c', topics: [], version: 0 } }, tokens: [] } as unknown as Seeded;

test('sampling starts at the measurement boundary: fixture files, start position and capture setup are setup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'move-boundary-'));
  try {
    const [, move] = rehearsalSteps(rehearsalPlan());
    const fail = () => { throw new Error('setup'); };
    let sampled = 0;
    const mark = () => { sampled++; };
    const signal = new AbortController().signal;
    // Start position query fails.
    await assert.rejects(generator(fakeStack(fail), fakeSeeded, formal, move, dir, {}, 'k6', signal, mark));
    // Diagnostic capture initialization fails after the start position is read.
    const capture = fakeStack(query => { if (query.includes('pg_stat_statements')) throw new Error('setup'); return '5'; });
    await assert.rejects(generator(capture, fakeSeeded, formal, move, join(dir, 'diag'), {}, 'k6', signal, mark, true));
    // Part F storage snapshots before the measured window fail.
    const f = steps(formal).find(step => step.part === 'F' && step.arm === 'move')!;
    await assert.rejects(storage(fakeStack(fail), fakeSeeded, formal, f, signal, mark));
    assert.equal(sampled, 0);
    const run = stages(dir, 'recorded');
    assert.equal(run.write({ failed: true, interrupted: false }).outcome, 'setup-failure');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an arm never reruns after its sampling started, even when Docker was unreachable', () => {
  const docker = { infrastructure: infrastructureFailure, problem: 'measurement failed (Error)' } as const;
  assert.equal(canRerun(docker, false, false, false, false), true);
  assert.equal(canRerun(docker, false, false, false, true), false);
  assert.equal(canRerun(docker, true, false, false, false), false);
});

test('a formal rehearsal is not clean when the measured cell fails its functional checks', () => {
  const p = rehearsalPlan();
  const [baseline, move] = rows(p, rehearsalSteps(p));
  const unverified: Result = { ...move, attempts: [{ measurement: { ...move.attempts[0].measurement!, moveVerified: false } }] };
  const checks = rehearsalChecks(p, [baseline, unverified]);
  assert.deepEqual(checks.filter(check => check.problems.length), [{ step: 'D-100-r1-functional', problems: ['Move failed or did not commit as expected'] }]);
  assert.ok(rehearsalChecks(p, [baseline, move]).every(check => !check.problems.length));
  // Performance gates stay NOT EVALUATED.
  for (const round of judge(p, [baseline, unverified], true).rows.flatMap(row => row.rounds)) assert.equal(round.status, 'NOT EVALUATED');
});

test('an early stop says the scheduled work was incomplete without changing the verdict', () => {
  const all = rows(formal, steps(formal));
  const first: Result = withLane(all[0], 'reader', { droppedIterations: 1 });
  assert.deepEqual(scheduledWork(true, steps(formal), 1), { complete: false, skipped: steps(formal).slice(1).map(stepId) });
  assert.deepEqual(scheduledWork(true, steps(formal), all.length), { complete: true, skipped: [] });
  assert.deepEqual(scheduledWork(false, steps(formal), all.length), { complete: false, skipped: [] });
  // The verdict is still judged with the run's own completeness: the first arm stays INVALID.
  assert.equal(render(formal, [first], true).verdict.overall, 'INVALID');
  const flags = statusFlags({ passed: false, finished: true, cleanupIssues: 0, stoppedEarly: true, armProblem: false, diagnosticIncomplete: false,
    verdict: render(formal, [first], true).verdict });
  assert.deepEqual(flags, { failed: true, invalidEvidence: true });
});
