import assert from 'node:assert/strict';
import { test } from 'node:test';
import { full, modelLabel, queries, sampleSeconds, stages } from './design.ts';
import { report, type Evidence, type Exit } from './report.ts';
import { snapshots } from './sequence.ts';

const exit: Exit = {cleanupVerified: true, hostBusy: true, idle: true, interrupted: false};
function sampleWindow(seconds: number) {
  const size = seconds / sampleSeconds;
  return {
    samples: Array.from({length: size + 1}, (_, index) => ({
      second: sampleSeconds * index, startedMs: 1000 * sampleSeconds * index,
      completedMs: 1000 * sampleSeconds * index + 1,
    })),
    intervals: Array.from({length: size}, () => ({operations: 5, walBytes: 20, walBytesPerOperation: 4})),
  };
}

function evidence(smoke = false): Evidence {
  const accepted = smoke ? 1 : 180_000;
  const population = full.rows + accepted;
  const edit = Math.floor(population / 10), remove = Math.floor(population / 20);
  const counts = {edit, delete: remove, total: edit + remove};
  const termCheck = {equal: true, actualMessages: population, checked: population, expectedTermRows: 300, termRows: 300,
    mismatches: 0, deletedTermRows: 0};
  const identity = {commit: 'run', manifest: 'manifest', productCommit: 'product', images: {pg: 'pg', app: 'app', k6: 'k6'},
    tables: {}, settingsHash: 'settings', settings: {}, seed: full.seed};
  return {
    initial: identity, final: structuredClone(identity), backfillVerified: true,
    send: {accepted, sustained: smoke ? null : true, step: undefined},
    model: {label: modelLabel, seed: full.seed, population, planned: counts, achieved: {...counts},
      achievedPerSecond: smoke ? null : counts.total / full.modelSeconds,
      plannedPerSecond: smoke ? null : counts.total / full.modelSeconds},
    checks: {W1: {...termCheck}, [modelLabel]: {...termCheck}},
    snapshots: snapshots.map(id => ({
      id, sample: {bytes: {heap: 10, lookup: 20, maintenance: 12}}, physical: {allVisibleShare: 0.5},
      search: smoke ? {untimedQueries: queries.map(([query]) => query)} : {
        latencies: queries.map(([query]) => ({query, n: 100, p95: 800})),
        plans: queries.map(([query]) => ({query, lookupExecuted: true, lookupHeapFetches: [10]})),
        worstP95Ms: 800,
      },
    })) as Evidence['snapshots'],
    windows: {W1: sampleWindow(full.sendSeconds), [modelLabel]: sampleWindow(full.modelSeconds),
      'W3 IDLE': sampleWindow(full.idleSeconds), 'W3 VACUUM': {...sampleWindow(0), seconds: 20},
      'W3 REINDEX': {...sampleWindow(300), seconds: 350}} as Evidence['windows'],
    errors: [],
  };
}

test('Phase A reports all snapshots even when p95 exceeds the Phase B proposal', () => {
  const result = report('formal', full.rows, evidence(), exit);
  assert.equal(result.status, stages.formal);
  assert.deepEqual(result.snapshotted.map(item => item.id), [...snapshots]);
  assert.equal(result.snapshotted[0].p95Ms, 800);
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(JSON.stringify(result), /\b(?:PASS|FAIL)\b/);
});

test('W1 term mismatch is a defect and W2 mismatch invalidates the MODEL only', () => {
  const values = evidence();
  values.checks!.W1!.equal = false;
  values.checks!.W1!.mismatches = 1;
  values.checks![modelLabel]!.equal = false;
  values.checks![modelLabel]!.deletedTermRows = 1;
  const result = report('formal', full.rows, values, exit);
  assert.equal(result.status, stages.formal);
  assert.deepEqual(result.findings, ['W1 DEFECT: real Send term inconsistency', 'W2 MODEL INVALID']);
});

test('formal reports every prerequisite failure explicitly', () => {
  const checks: (readonly [RegExp, (values: Evidence, state: Exit) => void])[] = [
    [/Missing run identity/, values => { delete values.final; }],
    ...(['commit', 'manifest', 'settingsHash'] as const).map(key =>
      [/identity mismatch/, (values: Evidence) => { values.final![key] = 'different'; }] as const),
    [/identity mismatch/, values => { values.final!.images.app = 'different'; }],
    [/identity mismatch/, values => { values.final!.seed++; }],
    [/Backfill verification/, values => { values.backfillVerified = false; }],
    [/not sustained/, values => { values.send!.sustained = false; }],
    [/Missing W1 Send/, values => { delete values.send; }],
    [/Missing snapshot/, values => { values.snapshots.pop(); }],
    [/Missing 5-minute evidence for W3 IDLE/, values => { values.windows['W3 IDLE']!.samples.pop(); }],
    [/missing or other work/, (_values, state) => { state.idle = false; }],
    [/HOST-BUSY/, (_values, state) => { state.hostBusy = false; }],
    [/Cleanup unverified/, (_values, state) => { state.cleanupVerified = false; }],
    [/Run interrupted/, (_values, state) => { state.interrupted = true; }],
    [/MODEL workload evidence/, values => { values.model!.achieved.edit--; }],
    [/Missing term consistency/, values => { delete values.checks!.W1; }],
  ];
  for (const [reason, change] of checks) {
    const values = evidence(), state = {...exit};
    change(values, state);
    const result = report('formal', full.rows, values, state);
    assert.equal(result.status, 'INVALID');
    assert.match(result.invalid.join('\n'), reason);
  }
});

test('smoke and rehearsal labels never confer evidence', () => {
  assert.equal(report('smoke', full.rows, evidence(true), {...exit, hostBusy: null, idle: null}).status, stages.smoke);
  assert.equal(report('rehearsal', full.rows, evidence(), exit).status, stages.rehearsal);
});
