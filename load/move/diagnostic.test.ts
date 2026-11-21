import assert from 'node:assert/strict';
import test from 'node:test';
import { appEvidence, cgroupSample, dbEvidence, k6CeilingWarnings, k6Evidence, parseDbSample, parseStatements } from './diagnostic-evidence.ts';
import { diagnosticSelection, rejectDiagnosticImage } from './diagnostic-mode.ts';
import { judge } from './judge.ts';
import { plan, type Step } from './plan.ts';

test('diagnostic selection retains the formal Part D fixture and order for the chosen round', () => {
  const selection = diagnosticSelection({ diagnostic: true, sizes: '100,1000', round: '2' })!;
  assert.deepEqual(selection.plan, { ...plan(false), mode: 'DIAGNOSTIC' });
  assert.deepEqual(selection.steps.map(({ part, size, round, arm }) => [part, size, round, arm]),
    [['D', 100, 2, 'move'], ['D', 100, 2, 'baseline'], ['D', 1000, 2, 'move'], ['D', 1000, 2, 'baseline']]);
  assert.deepEqual(diagnosticSelection({ diagnostic: true })!.steps.map(s => [s.size, s.round, s.arm]),
    [[100, 1, 'baseline'], [100, 1, 'move']]);
  const smoke = diagnosticSelection({ diagnostic: true, smoke: true })!;
  assert.equal(smoke.plan.seconds, 3);
  assert.deepEqual(smoke.steps.map(s => [s.part, s.size, s.arm]), [['D', 2, 'baseline'], ['D', 2, 'move']]);
});

test('diagnostic options, image, plan and evidence cannot enter the formal judge path', () => {
  assert.equal(diagnosticSelection({ smoke: true }), undefined);
  assert.throws(() => diagnosticSelection({ sizes: '100' }), /require --diagnostic/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, sizes: '1' }), /Use --sizes/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, round: '4' }), /Use --sizes/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, smoke: true, round: '1' }), /fixed small fixture/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, image: 'test' }), /builds its own/);
  assert.throws(() => rejectDiagnosticImage('true'), /require --diagnostic/);
  assert.doesNotThrow(() => rejectDiagnosticImage(null));
  assert.throws(() => judge(diagnosticSelection({ diagnostic: true })!.plan, [], true), /refuses DIAGNOSTIC/);
  const step: Step = { part: 'D', arm: 'baseline', size: 100, round: 1 };
  const row = { ...step, attempts: [], mode: 'DIAGNOSTIC' };
  assert.throws(() => judge(plan(false), [row], true), /refuses DIAGNOSTIC/);
  const measurement = { mode: 'DIAGNOSTIC', lanes: {} };
  assert.throws(() => judge(plan(false), [{ ...step, attempts: [{ measurement }] }], true), /refuses DIAGNOSTIC/);
});

test('cgroup parser preserves zero throttles and treats missing memory as missing evidence', () => {
  const raw = 'usage_usec 789\nuser_usec 100\nnr_throttled 0\nthrottled_usec 0\nmemory.current 1024\n';
  assert.deepEqual(cgroupSample(raw), { usage_usec: 789, nr_throttled: 0, throttled_usec: 0, memoryBytes: 1024 });
  assert.equal(cgroupSample(raw.replace('memory.current', 'memory.peak')), null);
  assert.equal(cgroupSample(raw.replace('nr_throttled 0', 'nr_throttled -1')), null);
});

test('server parsing aggregates timing and 503 causes by lane and retains only allowed fields', () => {
  const event = (fields: object) => JSON.stringify({ timestamp: '2026-11-20T00:00:01Z', fields: { ...fields, unrelated: 'discard' } });
  const timing = (us: number, interrupted = false) =>
    event({ event: 'move_diag_timing', lane: 'send', phase: 'channel_admission_wait', us, interrupted });
  const app = appEvidence([timing(12), timing(5), timing(1000, true),
    event({ event: 'move_diag_503', lane: 'move', reason: 'channel_queue_full' }),
    event({ event: 'move_diag_503', lane: 'send', reason: 'limiter_pending_cap' }),
    event({ event: 'move_diag_503', lane: 'send', reason: 'not-a-known-reason' }),
    'unrelated line'].join('\n'));
  assert.deepEqual(app.byLane.send.phasesUs.channel_admission_wait, { count: 2, p50: 5, p95: 12, p99: 12, max: 12, interrupted: 1 });
  assert.equal(app.byLane.move.reasons.channel_queue_full, 1);
  assert.equal(app.byLane.send.reasons.limiter_pending_cap, 1);
  assert.equal(app.unavailable.length, 2);
  assert.doesNotMatch(JSON.stringify(app), /discard/);
});

test('k6 parser pairs VU gauges and uses full iterations to reconstruct write occupancy at drops', async () => {
  const point = (metric: string, sec: string, value: number, tags: object = {}) =>
    JSON.stringify({ type: 'Point', metric, data: { time: '2026-11-20T00:00:' + sec + 'Z', value, tags } });
  async function* lines() {
    yield point('iteration_duration', '02.500', 1000, { scenario: 'send' });
    yield point('dropped_iterations', '02.000001', 1, { scenario: 'send' });
    yield point('vus_max', '02', 800);
    yield point('vus', '02', 500);
    yield point('dropped_iterations', '02.500', 1, { scenario: 'send' });
    yield point('http_reqs', '02', 1, { scenario: 'move', status: '503', other: 'discard' });
    yield point('dropped_iterations', '03', 1, { scenario: 'topic0' });
    yield point('dropped_iterations', '03', 1, { scenario: 'unknown' });
  }
  const evidence = await k6Evidence(lines());
  assert.deepEqual(evidence.vus, [{ at: Date.parse('2026-11-20T00:00:02Z'), active: 500, allocated: 800 }]);
  assert.deepEqual(evidence.drops.map(d => [d.scenario, d.reconstructedWriteIterationsInFlight]), [['send', 1], ['send', 0], ['topic0', null]]);
  assert.equal(evidence.completed503.move, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /discard/);
  assert.deepEqual(k6CeilingWarnings('time="2026-11-20T00:00:02Z" level=warning msg="Insufficient VUs, reached 2000 active VUs and cannot initialize more" executor=constant-arrival-rate scenario=send'),
    [{ scenario: 'send', at: Date.parse('2026-11-20T00:00:02Z'), maxVUs: 2000 }]);
});

test('PostgreSQL aggregation keeps query IDs precise and leaves sampling gaps unweighted', () => {
  const id = '-9223372036854775808';
  const waits = [{ id, type: 'Lock', event: 'advisory', count: 2 }, { id, type: 'IO', event: 'WALSync', count: 1 }];
  const sample = (at: number, rows = waits) => parseDbSample(JSON.stringify({ at, waits: rows }));
  const stats = parseStatements(JSON.stringify({ id, group: 'channel_advisory_write', calls: 3, execMs: 250, ignored: 'discard' }));
  const evidence = dbEvidence([sample(100), sample(200), sample(700, [])], stats);
  assert.equal(evidence.coveredMs, 100);
  assert.deepEqual(evidence.waits.map(row => [row.event, row.observations, row.estimatedBackendMs]), [['advisory', 4, 200], ['WALSync', 2, 100]]);
  assert.deepEqual(evidence.statements[0], { queryId: id, group: 'channel_advisory_write', calls: 3,
    execMs: 250, estimatedLockMs: 200, estimatedExecExcludingLockMs: 50 });
  assert.equal(dbEvidence([sample(100), sample(200)], [{ ...stats[0], execMs: 50 }]).statements[0].estimatedExecExcludingLockMs, null);
  assert.equal(dbEvidence([], stats).statements[0].estimatedExecExcludingLockMs, null);
  assert.throws(() => parseStatements(JSON.stringify({ id: 10, group: 'other', calls: 3, execMs: 4 })), /Invalid PostgreSQL statement/);
});
