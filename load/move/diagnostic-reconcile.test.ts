import assert from 'node:assert/strict';
import test from 'node:test';
import { appEvidence, k6Evidence, parseStatements, requiredReadPhases } from './diagnostic-evidence.ts';
import { diagnosticCounters } from './diagnostic-stream.ts';
import { diagnosticRunComplete, reconcileDiagnostic, statementProblems } from './diagnostic-reconcile.ts';
import { appLogAnchor, retainedAppLog } from './diagnostic.ts';
import { rehearsalPlan, type Step } from './plan.ts';
import { remainingArmsSkipped } from './diagnostic-mode.ts';
import { canRerun, statusFlags } from './run.ts';
import { renderDiagnostic } from './report.ts';
import type { DiagnosticSummary } from './diagnostic-integrity.ts';

const p = rehearsalPlan();
const step: Step = { part: 'D', arm: 'move', size: 100, round: 1 };
const baseline: Step = { ...step, arm: 'baseline' };
const selection = { readLanes: 'all', readTimingSampleEvery: 8, sendBreakdown: true } as const;
const at = Date.parse('2026-11-25T00:00:01Z');
const iso = (time: number) => new Date(time).toISOString();
const organizations = { partD: 'a', reader: 'b' };
const phase = (lane: string, name: string, fields = {}) => event({ event: 'move_diag_timing', lane,
  phase: name, us: 10, interrupted: false, ...fields });
const event = (fields: object, more = {}) => JSON.stringify({ timestamp: iso(at + 100), fields, ...more });
const reject = (lane: string, reason = 'channel_queue_full') => event({ event: 'move_diag_503', lane, reason });
const route = { send: ['POST', '/api/v1/orgs/{org}/channels/{id}/messages'],
  move: ['POST', '/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/move'],
  topics: ['GET', '/api/v1/orgs/{org}/channels/{id}/topics'],
  reader: ['GET', '/api/v1/orgs/{org}/channels'], channels: ['GET', '/api/v1/orgs/{org}/channels'] } as const;
const complete = (lane: keyof typeof route, status: number) =>
  event({ event: 'http_completed' }, { span: { method: route[lane][0], route: route[lane][1], status } });

async function fixture(arm = step) {
  // Small arrival rates keep unit fixtures short. D0's production plan still uses the existing rates.
  const plan = { ...p, sendRate: 1, channelRate: 1, readerRate: 1 };
  const lane = (attempted: number, rejected503 = 0, droppedIterations = 0) => ({
    attempted, rejected503, droppedIterations, accepted: attempted - rejected503,
    rejected429: 0, otherErrors: 0, clientTimeouts: 0, transportErrors: 0, p95: 1, p99: 1,
  });
  const summary: DiagnosticSummary = {
    lanes: { send: lane(19, 2, 1), reader: lane(31), channels: lane(20), topics: lane(8),
      ...(arm.arm === 'move' && { move: lane(19, 1, 1) }) },
    started: at, topicReaders: [2, 2, 2, 2],
    scenarioDrops: { send: 1, ...(arm.arm === 'move' && { move: 1 }), reader: 0, channels: 0, topic0: 0, topic1: 0, topic2: 0, topic3: 0 },
    committedMoves: arm.arm === 'move' ? 18 : undefined, moveVerified: arm.arm === 'move' ? true : undefined,
  };
  const points: string[] = [];
  const log: string[] = [];
  const point = (metric: string, value: number, scenario?: string, status?: string, when = at + 100) => {
    points.push(JSON.stringify({ type: 'Point', metric, data: { time: iso(when), value, tags: { scenario, status } } }));
  };
  const attempts = (scenario: string, n: number, code: string) => {
    for (let i = 0; i < n; i++) {
      point('iterations', 1, scenario);
      point('iteration_duration', 1, scenario);
      point('http_reqs', 1, scenario, code);
      if (scenario.startsWith('topic')) point('move_topic_reads', 1, scenario);
    }
  };
  for (const [name, row] of Object.entries(summary.lanes)) {
    const label = name as keyof typeof route;
    const code = label === 'send' ? '201' : '200';
    if (label !== 'topics') {
      point('move_scenario_start_ms', at, label, undefined, at);
      attempts(label, row.accepted, code);
      attempts(label, row.rejected503, '503');
    }
    if (row.droppedIterations) point('dropped_iterations', row.droppedIterations, label);
    for (const counter of diagnosticCounters) {
      for (let i = 0; i < row.attempted; i++) point(`move_${counter}`, Number(i < row[counter]), label);
    }
    for (let i = 0; i < row.accepted; i++) {
      point('move_success_ms', 1, label);
      log.push(complete(label, Number(code)));
    }
    for (let i = 0; i < row.rejected503; i++) log.push(reject(label), complete(label, 503));
  }
  for (let i = 0; i < 4; i++) {
    point('move_scenario_start_ms', at, `topic${i}`, undefined, at);
    attempts(`topic${i}`, 2, '200');
  }
  point('vus', 3);
  point('vus_max', 10);
  log.push(phase('send', 'before_admission'), phase('send', 'channel_admission_wait'),
    phase('send', 'admitted_work', { us: 20, request_id: 32, send_children: 1 }),
    phase('send', 'send_topic_record', { request_id: 32 }),
    ...requiredReadPhases.topics.map(name => phase('topics', name)),
    ...requiredReadPhases.channels.map(name => phase('channels', name, { organization: 'a' })),
    phase('channels', 'channel_list_total', { organization: 'b' }),
    ...Array.from({ length: 5 }, () => phase('channels', 'channel_list_total', { organization: 'a' })));
  if (arm.arm === 'move') log.push(phase('move', 'move_access_sql'), phase('move', 'move_chain_lookup'),
    ...Array.from({ length: 18 }, () => phase('move', 'move_apply')));
  const app = { ...appEvidence(log.join('\n'), organizations), anchorRetained: true, truncationSigns: 0 };
  async function* lines() { yield* points; }
  const groups = ['send_insert', 'channel_advisory_write', 'move_update', 'move_chain_lookup',
    'channel_list_visible', 'channel_list_counts', 'topic_page', 'dm_check', 'channel_advisory_read'];
  const capture = {
    since: iso(at - 500), window: { start: at - 500, end: at + 45_000 },
    clock: { wallMs: 45_500, monotonicMs: 45_500, driftMs: 0 }, app, k6: await k6Evidence(lines()), failures: [] as string[],
    postgres: { statementsAvailable: true, statements: groups.map((group, i) => ({ group, queryId: String(i), calls: 2,
      execMs: 1, text: null, estimatedLockMs: 0, estimatedExecExcludingLockMs: 1 })),
    failures: 0, samples: [], skippedTicks: 0, coveredMs: 10_000, steadyCoverageMs: 10_000, waits: [] },
    containers: { samples: [], summary: Object.fromEntries(['app', 'postgres', 'k6'].map(name => [name, {
      samples: 2, missing: 1, peakMemoryBytes: 10, nrThrottledDelta: 0, throttledUsecDelta: 0 }])) },
  };
  return { plan, summary, capture, check: () => reconcileDiagnostic(plan, arm, selection, summary, capture) };
}

test('diagnostic collectors reconcile summary, stream and app through each lane window', async () => {
  const { check } = await fixture();
  assert.deepEqual(check().problems, []);
  assert.equal(check().windows.reader.offered.end - check().windows.send.offered.end, p.drain * 1000);
  assert.equal(check().windows.reader.drained.end - check().windows.reader.offered.end, p.drain * 1000);
});

test('per-lane 503 reconciliation rejects equal aggregate totals that hide a missing write-lane event', async () => {
  const { capture, check } = await fixture();
  capture.app.unavailable.find(sample => sample.lane === 'move')!.lane = 'send';
  assert.match(check().problems.join(), /app HTTP 503 count or window disagrees \(app 3, k6 2\)/);
  assert.match(check().problems.join(), /app HTTP 503 count or window disagrees \(app 0, k6 1\)/);
  assert.ok(check().checks.some(row => row.metric.startsWith('Main-timeline sends client') && row.status === 'NOT EVALUATED'));
});

test('collector reconciliation rejects out-of-window points and incomplete app completion traces', async () => {
  const { capture, check } = await fixture();
  capture.k6.stream.series.move.iteration_duration.count--;
  capture.k6.stream.series.send.dropped_iterations.last = at + (p.seconds + 1) * 1000;
  capture.app.unavailable[0].at = at + 45_000;
  capture.app.completed.channelLists['200']--;
  assert.match(check().problems.join(), /dropped_iterations outside its window/);
  assert.match(check().problems.join(), /move: HTTP requests, completed iterations, durations or Topic reads disagree/);
  assert.match(check().problems.join(), /app HTTP 503 count or window disagrees/);
  assert.match(check().problems.join(), /app completion trace disagrees with k6 for the shared Channel-list route/);
});

test('collector reconciliation detects a mismatched trend and loss of sampled read phases despite complete HTTP logs', async () => {
  const { capture, summary, check } = await fixture();
  summary.lanes.send!.p99 = 3;
  capture.app.byLane.channels.phasesUs.channel_list_total.count = 2;
  assert.match(check().problems.join(), /summary and stream latency percentiles disagree/);
  assert.match(check().problems.join(), /channel_list_total sample coverage/);
});

test('required SQL groups need positive-call rows, and an empty result disables statement attribution', async () => {
  assert.deepEqual(statementProblems(['topic_page'], parseStatements('')), ['topic_page']);
  assert.deepEqual(statementProblems(['topic_page'], parseStatements('{"id":"1","group":"topic_page","calls":0,"execMs":0}')), ['topic_page']);
  const { capture, check } = await fixture();
  capture.postgres.statements = [];
  capture.postgres.statementsAvailable = false;
  const rows = check().checks;
  assert.match(rows.find(row => row.metric === 'PostgreSQL statements')?.reasons.join() ?? '', /empty or missing statement result.*topic_page/);
  assert.equal(rows.find(row => row.metric.startsWith('PostgreSQL waits'))?.status, 'NOT EVALUATED');
});

test('missing Docker anchors, malformed log output, collector errors and clock drift stay reportable', async () => {
  const line = `${iso(at - 1)} last log`;
  const anchor = appLogAnchor('', line + '\n');
  const window = { start: at, end: at + 1000 };
  assert.equal(retainedAppLog(line, anchor, window, organizations).anchorRetained, true);
  const damaged = retainedAppLog('Error grabbing logs: truncated', anchor, window, organizations);
  assert.deepEqual([damaged.anchorRetained, damaged.truncationSigns], [false, 1]);
  const { capture, check } = await fixture();
  capture.app = damaged;
  capture.failures.push('k6 stream: output buffer limit');
  capture.postgres.failures = 1;
  capture.clock.driftMs = 300;
  const result = check();
  assert.match(result.problems.join(), /possible rotation/);
  assert.match(result.problems.join(), /truncated, malformed or unreadable/);
  assert.match(result.problems.join(), /PostgreSQL activity collector failure/);
  assert.match(result.problems.join(), /k6 stream: output buffer limit/);
  assert.match(result.problems.join(), /wall-clock vs monotonic elapsed drift/);
});

test('diagnostic report labels main-timeline sends and excludes Topic sends and topics_last_seq maintenance', async () => {
  const { check } = await fixture();
  const markdown = renderDiagnostic([{ step, checks: check().checks }], [], true);
  assert.match(markdown, /Main-timeline sends send_topic_record hook on the main timeline/);
  assert.match(markdown, /NOT EVALUATED\*\* — send into a Topic/);
  assert.match(markdown, /NOT EVALUATED\*\* — send-time topics_last_seq update/);
  assert.match(markdown, /Topic record operation is a no-op/);
});

test('a failed baseline stops before Move and an incomplete diagnostic arm cannot produce success or retry', async () => {
  const head = await fixture(baseline);
  const tail = await fixture(step);
  assert.equal(diagnosticRunComplete(true, 2, [head.check(), tail.check()]), true);
  head.summary.topicReaders!.pop();
  const arm = head.check();
  const problem = arm.problems.join(', ');
  assert.equal(remainingArmsSkipped(true, problem), true);
  assert.equal(canRerun({ problem }, false, false, false, true), false);
  const complete = diagnosticRunComplete(true, 2, [arm]);
  assert.equal(complete, false);
  assert.equal(diagnosticRunComplete(true, 2, [arm, tail.check()]), false);
  tail.summary.committedMoves = 0;
  assert.equal(diagnosticRunComplete(true, 2, [{ checks: [{ metric: 'test', status: 'EVALUATED', reasons: [] }] }, tail.check()]), false);
  assert.deepEqual(statusFlags({ passed: complete, finished: true, cleanupIssues: 0, stoppedEarly: true, armProblem: true,
    diagnostic: true, diagnosticIncomplete: !complete }), { failed: true, invalidEvidence: true });
});
