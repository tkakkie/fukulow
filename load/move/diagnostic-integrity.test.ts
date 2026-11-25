import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticIntegrity, type DiagnosticSummary } from './diagnostic-integrity.ts';
import { diagnosticCounters, type Stream } from './diagnostic-stream.ts';
import { outcomes, type Lane } from './metrics.ts';
import { rehearsalPlan, type Step } from './plan.ts';

const p = rehearsalPlan();
const baseline: Step = { part: 'D', size: 100, round: 1, arm: 'baseline' };
const move: Step = { ...baseline, arm: 'move' };
const row = (attempted: number, droppedIterations = 0, rejected503 = 0): Lane => ({
  attempted, droppedIterations, accepted: attempted - rejected503, rejected503,
  rejected429: 0, otherErrors: 0, clientTimeouts: 0, transportErrors: 0, p95: 1, p99: 2,
});

function fixture(step = move) {
  const summary: DiagnosticSummary = {
    lanes: { send: row(4985, 15, 497), reader: row(62), channels: row(10_002), topics: row(400),
      ...(step.arm === 'move' ? { move: row(15, 5, 8) } : {}) },
    started: 1000, topicReaders: [100, 100, 100, 100],
    scenarioDrops: { send: 15, reader: 0, channels: 0, topic0: 0, topic1: 0, topic2: 0, topic3: 0,
      ...(step.arm === 'move' ? { move: 5 } : {}) },
    committedMoves: step.arm === 'move' ? 7 : undefined, moveVerified: step.arm === 'move' ? true : undefined,
  };
  const stream: Stream = { series: {}, invalidPoints: 0, latencies: {} };
  const points = (sum: number, count = sum) => ({ sum, count, first: 1000, last: 1100 });
  for (const [lane, stats] of Object.entries(summary.lanes)) {
    stream.series[lane] = {
      ...Object.fromEntries(diagnosticCounters.map(key => [`move_${key}`, points(stats[key], stats.attempted)])),
      move_success_ms: points(stats.accepted * 2, stats.accepted),
      ...(lane !== 'topics' && { iterations: points(stats.attempted) }),
      ...(stats.droppedIterations && { dropped_iterations: points(stats.droppedIterations) }),
    };
  }
  for (let i = 0; i < 4; i++) stream.series[`topic${i}`] = { iterations: points(100), move_topic_reads: points(100) };
  return { summary, stream };
}

test('diagnostic integrity allows reconciled queue-full responses and drops in both arms', () => {
  for (const step of [baseline, move]) {
    const { summary, stream } = fixture(step);
    assert.deepEqual(diagnosticIntegrity(p, step, 'all', summary, stream, true, {}), []);
  }
});

test('diagnostic integrity rejects missing or extra lanes and missing summary', () => {
  const { summary, stream } = fixture(baseline);
  delete summary.lanes.channels;
  summary.lanes.move = row(1);
  assert.ok(diagnosticIntegrity(p, baseline, 'all', summary, stream, true, {}).includes('unexpected workload lanes'));
  assert.deepEqual(diagnosticIntegrity(p, baseline, 'all', undefined, stream, true, {}), ['missing workload summary']);
});

test('diagnostic integrity requires four Topic VUs with matching nonzero iteration counts', () => {
  for (const readers of [[100, 100, 100], [100, 100, 100, 100, 1], [100, 100, 100, 0], [99, 101, 100, 100]]) {
    const { summary, stream } = fixture();
    summary.topicReaders = readers;
    assert.ok(diagnosticIntegrity(p, move, 'all', summary, stream, true, {}).includes('Topic-list VUs or iteration counts'));
  }
});

test('diagnostic integrity rejects defaulted counters, missing zero samples and an inconsistent k6 schedule', () => {
  const cases: ((input: ReturnType<typeof fixture>) => void)[] = [
    ({ summary }) => { summary.lanes.send!.otherErrors = -1; },
    ({ summary }) => { summary.scenarioDrops!.reader = null; },
    ({ stream }) => { delete stream.series.send.move_rejected429; },
    ({ stream }) => { stream.series.send.iterations.sum--; },
    ({ stream }) => { stream.series.send.dropped_iterations.sum--; },
    ({ summary, stream }) => {
      const send = summary.lanes.send!;
      send.attempted -= 10;
      send.accepted -= 10;
      stream.series.send.iterations.sum -= 10;
      for (const key of diagnosticCounters) {
        stream.series.send[`move_${key}`].count = send.attempted;
        stream.series.send[`move_${key}`].sum = send[key];
      }
    },
  ];
  for (const change of cases) {
    const input = fixture();
    change(input);
    assert.match(diagnosticIntegrity(p, move, 'all', input.summary, input.stream, true, {}).join(),
      /(?:send|reader): unreconciled k6 counters or schedule/);
  }
});

test('diagnostic integrity rejects missing, nonfinite or unpopulated client latency', () => {
  for (const p95 of [null, NaN, Infinity, -1]) {
    const { summary, stream } = fixture();
    summary.lanes.send!.p95 = p95;
    assert.ok(diagnosticIntegrity(p, move, 'all', summary, stream, true, {}).includes('send: missing usable latency samples'));
  }
  const { summary, stream } = fixture();
  stream.series.send.move_success_ms.count = 0;
  assert.ok(diagnosticIntegrity(p, move, 'all', summary, stream, true, {}).includes('send: missing usable latency samples'));
});

test('diagnostic integrity rejects an unverified Move arm, zero commits and missing Move timing', () => {
  for (const [verified, committed, timed] of [[false, 7, true], [true, 0, true], [true, 7, false], [true, 6, true]] as const) {
    const { summary, stream } = fixture();
    summary.moveVerified = verified;
    summary.committedMoves = committed;
    assert.ok(diagnosticIntegrity(p, move, 'all', summary, stream, timed, {}).includes('missing verified committed Moves or Move timings'));
  }
});

test('diagnostic integrity rejects unexplained Topic and Channel-list failures', () => {
  for (const lane of ['topics', 'channels', 'reader'] as const) {
    for (const error of outcomes.filter(name => name !== 'accepted')) {
      const { summary, stream } = fixture();
      summary.lanes[lane]!.accepted--;
      summary.lanes[lane]![error]++;
      assert.ok(diagnosticIntegrity(p, move, 'all', summary, stream, true, {}).includes(`${lane}: unexplained read failures`));
    }
  }
});
