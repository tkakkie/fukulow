import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelId, holdsFixture, jsonl, memberId, target, traceLines, watermarkLine } from './revocation-holds-fixture.ts';
import { BYSTANDERS, STALL_DEFAULT } from './revocation-holds-plan.ts';
import { messagesForSender, preflightPlan, preflightReadback, preflightResult, preflightTrialEvidence, type PreflightTrial, type SessionIdentity } from './revocation-holds-preflight.ts';
import { preflightSession } from './revocation-holds-preflight-session.ts';
import { SetupAbort } from './revocation-holds-setup.ts';
import { parseTrace } from './revocation-holds-trace.ts';

const identity = {
  hostname: 'measurement-host', platform: 'linux', arch: 'x64', cpus: 16, memoryBytes: 32 * 1024 ** 3,
  release: 'test-kernel', node: 'v26.13.1', commit: 'test-commit', session: 'test-session',
} satisfies SessionIdentity;
const after = 32_768;

function trialRun(trial: PreflightTrial) {
  const run = holdsFixture('control');
  run.cell = 'Hcap';
  run.repeat = trial.run.repeat;
  run.revokedChannels = Array.from({ length: 64 }, (_, i) => channelId(i));
  run.accounts = Array.from({ length: 3 }, (_, i) => ({ memberId: memberId(i) }));
  run.targets = Array.from({ length: 96 }, (_, i) => {
    const socket = target(i);
    socket.stallMessages.length = trial.volume;
    return socket;
  });
  run.stallReadbacks = run.targets.map(() => ({ before: after, after }));
  run.trace = parseTrace(jsonl([...traceLines(run), watermarkLine(4)]), true);
  return run;
}

const plan = preflightPlan();
const trial = plan.at(-1)!;
const rows = () => plan.map(trial => ({
  id: trial.id, volume: trial.volume, repeat: trial.run.repeat, ...preflightTrialEvidence(trial, trialRun(trial)),
}));

test('preflight schedules three control repeats per k with Hcap and distributes exactly k Messages across the formal senders', () => {
  assert.deepEqual(plan.map(trial => [trial.volume, trial.run.kind, trial.run.cell, trial.run.repeat]), [20, 40, 60].flatMap(k =>
    [1, 2, 3].map(repeat => [k, 'control', 'Hcap', repeat])));
  assert.equal(new Set(plan.map(trial => trial.id)).size, 9);
  for (const trial of plan) {
    const run = trialRun(trial);
    assert.equal(run.setup.bystanders, BYSTANDERS);
    assert.equal(preflightTrialEvidence(trial, run).passed, true);
    const messages = Array.from({ length: STALL_DEFAULT.senders }, (_, i) => messagesForSender(trial.volume, STALL_DEFAULT.senders, i));
    assert.equal(messages.reduce((sum, n) => sum + n, 0), trial.volume);
    assert.ok(Math.min(...messages) > 0 && Math.max(...messages) <= STALL_DEFAULT.messages);
  }
});

test('preflight requires positive E2, E4c, E6 and E8 evidence at k=60', () => {
  const accepted = preflightTrialEvidence(trial, trialRun(trial));
  assert.deepEqual(accepted, { passed: true, issues: [], snapshotRecords: 96, readback: after });
  for (const [rule, corrupt] of Object.entries({
    E2: (run: ReturnType<typeof trialRun>) => {
      const snapshot = run.trace!.events[0];
      assert.equal(snapshot.name, 'revocation_fallback_snapshot');
      snapshot.records = snapshot.records.replace(':64:64:', ':64:63:');
    },
    E4c: (run: ReturnType<typeof trialRun>) => {
      const outcome = run.trace!.events[1];
      assert.equal(outcome.name, 'revocation_fallback_outcome');
      outcome.records = outcome.records.replace(':0:0:0:64:', ':0:0:1:63:');
    },
    E6: (run: ReturnType<typeof trialRun>) => { run.targets.at(-1)!.stallMessages.pop(); },
    E8: (run: ReturnType<typeof trialRun>) => { run.trace!.evidenceErrors.push('trace watermark reports a dropped line'); },
  })) {
    const run = trialRun(trial);
    corrupt(run);
    const rejected = preflightTrialEvidence(trial, run);
    assert.equal(rejected.passed, false, rule);
    assert.deepEqual(rejected.issues.map(issue => issue.rule), [rule]);
  }
  const empty = trialRun(trial);
  empty.trace!.events = [];
  const rejected = preflightTrialEvidence(trial, empty);
  assert.equal(rejected.snapshotRecords, 0);
  assert.equal(rejected.passed, false);
});

test('preflight acceptance depends on all three k=60 runs and one common readback', () => {
  const results = rows().map(row => row.volume === 60 ? row : { ...row, passed: false });
  assert.equal(preflightResult(identity, results).passed, true);
  for (const patch of [{ passed: false }, { readback: after + 1 }, { snapshotRecords: 0 }, { repeat: 2 }]) {
    assert.equal(preflightResult(identity, [...results.slice(0, -1), { ...results.at(-1)!, ...patch }]).passed, false);
  }
  assert.equal(preflightResult(identity, results.slice(1)).passed, false);
});

test('SA2 validates saved readback provenance and acceptance evidence', () => {
  const saved = JSON.parse(JSON.stringify(preflightResult(identity, rows())));
  assert.equal(preflightReadback(saved, identity), after);
  for (const [field, value] of Object.entries(identity)) {
    const changed = typeof value === 'number' ? value + 1 : value + '-different';
    assert.equal(preflightReadback(saved, { ...identity, [field]: changed }), undefined, field);
  }
  assert.equal(preflightReadback(saved, { ...identity, session: '' }), undefined);
  assert.equal(preflightReadback({ ...saved, passed: false }, identity), undefined);
  assert.equal(preflightReadback({ ...saved, readback: after + 1 }, identity), undefined);
  assert.equal(preflightReadback({ ...saved, runs: saved.runs.slice(0, -1) }, identity), undefined);
});

test('preflight retries one setup abort in place and reports only completed slots as runs', async () => {
  const attempts: string[] = [];
  const seen: unknown[] = [];
  const result = await preflightSession(identity, async (trial, id) => {
    attempts.push(id);
    if (id === plan[0].id) throw new SetupAbort('SA1: wrong readback');
    return trialRun(trial);
  }, saved => seen.push(saved));
  assert.deepEqual(attempts, [plan[0].id, `${plan[0].id}-setup-retry`, ...plan.slice(1).map(trial => trial.id)]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.runs.map(row => row.id), plan.map(trial => trial.id));
  assert.equal(result.runs[0].attemptId, `${plan[0].id}-setup-retry`);
  assert.deepEqual(seen.at(-1), { ...result, setupAborts: [{ id: plan[0].id, message: 'SA1: wrong readback' }] });
});

test('a second preflight setup abort stops the session without running another slot', async () => {
  const attempts: string[] = [];
  const result = await preflightSession(identity, async (_, id) => {
    attempts.push(id);
    throw new SetupAbort('SA1: helper unavailable');
  }, () => {});
  assert.deepEqual(attempts, [plan[0].id, `${plan[0].id}-setup-retry`]);
  assert.deepEqual(result.runs, []);
  assert.equal(result.passed, false);
});
