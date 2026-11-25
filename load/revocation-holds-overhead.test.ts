import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdsFixture, jsonl, traceLine, traceLines, watermarkLine } from './revocation-holds-fixture.ts';
import { overheadPlan, overheadReport, overheadSample, workerTiming, type TraceMode } from './revocation-holds-overhead.ts';
import { parseTrace } from './revocation-holds-trace.ts';

test('overhead alternates three on and three off in each Hcap arm', () => {
  const plan = overheadPlan();
  assert.deepEqual(plan.map(p => p.mode), ['on', 'off', 'on', 'off', 'on', 'off']);
  assert.ok(plan.every(({ runs }) => runs.length === 2 && runs[0].kind === 'fault' && runs[0].cell === 'Hcap' &&
    runs[0].duration === 'short' && runs[1].kind === 'control' && runs[1].cell === 'Hcap'));
});

const timedRun = (kind: 'fault' | 'control', mode: TraceMode, completion: number, admission?: number) => {
  const run = holdsFixture(kind);
  const timed = traceLine('subscription_fallback_timing', { tick: 1, started_ms: 40_000, session_ms: 40_004,
    final_admission_ms: admission === undefined ? null : 40_000 + admission, completed_ms: 40_000 + completion });
  const records = mode === 'on' ? traceLines(run).slice(0, 4) : [];
  run.trace = parseTrace(jsonl([...records, timed, watermarkLine(records.length)]), true,
    [40_012, 40_027, 40_027, 40_031]);
  return run;
};

test('worker endpoints include the final admission and actual completion in both tracing modes', () => {
  for (const mode of ['on', 'off'] as const) {
    const run = timedRun('fault', mode, 67, 55);
    run.statements = [
      { at: 40_004, ms: 1, fallback: true, recheck: false, error: false },
      { at: 40_006, ms: 1, fallback: false, recheck: true, error: true },
    ];
    assert.deepEqual(workerTiming(run), { tick: 1, completionMs: 67, admissionMs: 55 });
    assert.equal(workerTiming(timedRun('fault', mode, 67)), undefined);
    assert.deepEqual(workerTiming(timedRun('control', mode, 55)), { tick: 1, completionMs: 55, admissionMs: undefined });
    run.trace!.timingErrors.push('watermark timing count mismatch');
    assert.equal(workerTiming(run), undefined);
  }
});

const repeats = (kind: 'fault' | 'control', mode: TraceMode, rss: number, completion: number, admission?: number) =>
  Array.from({ length: 3 }, () => {
    const run = timedRun(kind, mode, completion, admission);
    run.rss = [{ at: 30_000, kb: 1000 }, { at: 40_500, kb: 1000 + rss }];
    return overheadSample(run, mode);
  });

test('median timing bounds apply per arm to worker completion and final admission', () => {
  const compare = (faultDone: number, faultAdmitted: number, controlDone: number) => overheadReport([
    ...repeats('fault', 'on', 500, faultDone, faultAdmitted), ...repeats('fault', 'off', 500, 40, 15),
    ...repeats('control', 'on', 0, controlDone), ...repeats('control', 'off', 0, 50),
  ]);
  const exact = compare(44, 17, 55);
  assert.equal(exact.timing.fault?.bound, 4);
  assert.equal(exact.timing.finalAdmission?.bound, 2);
  assert.equal(exact.timing.control?.bound, 5);
  assert.equal(exact.withinBounds, true);
  assert.equal(compare(45, 17, 55).timing.fault?.within, false);
  assert.equal(compare(44, 18, 55).timing.finalAdmission?.within, false);
  assert.equal(compare(44, 17, 56).timing.control?.within, false);
});

test('RSS differential can be inconclusive even when both per-arm overhead limits pass', () => {
  // H512 fixture has B = 1024 KiB. Tracing adds +30 KiB to fault, +0 to control.
  // N_off = N_on = 0; the corrected difference of 1010 crosses the FAIL threshold.
  const report = overheadReport([
    ...repeats('fault', 'on', 1040, 40, 24), ...repeats('fault', 'off', 1010, 40, 24),
    ...repeats('control', 'on', 0, 40), ...repeats('control', 'off', 0, 40),
  ]);
  assert.equal(report.rss.fault?.within, true);
  assert.equal(report.rss.control?.within, true);
  assert.equal(report.rss.changeKb, 30);
  assert.equal(report.rss.on.result, 'FAIL');
  assert.equal(report.rss.verdict, 'inconclusive');
  assert.equal(report.withinBounds, false);
});

test('RSS screen includes the spread of the observed differential and requires complete inputs', () => {
  const samples = [
    ...repeats('fault', 'on', 1000, 40, 24), ...repeats('fault', 'off', 1000, 40, 24),
    ...repeats('control', 'on', 0, 40), ...repeats('control', 'off', 0, 40),
  ];
  samples[0].deltaKb = 1040;
  const report = overheadReport(samples);
  assert.equal(report.rss.changeKb, 0);
  assert.deepEqual(report.rss.correctionKb, [0, 40]);
  assert.equal(report.rss.verdict, 'stable');
  samples[0].deltaKb = 950;
  assert.equal(overheadReport(samples).rss.verdict, 'inconclusive');
  assert.equal(overheadReport(samples.slice(1)).rss.verdict, 'inconclusive');
});

test('overhead enforces event bytes, arrival lag, completeness and the off switch', () => {
  const run = timedRun('fault', 'on', 40, 24);
  run.trace!.events[0].bytes = 65_536;
  run.trace!.events[0].receivedAt = 40_080;
  run.trace!.evidenceErrors.push('watermark reports dropped lines');
  const sample = overheadSample(run, 'on');
  assert.ok(sample.problems.some(problem => /64 KiB/.test(problem)));
  assert.ok(sample.problems.some(problem => /50 ms/.test(problem)));
  assert.equal(sample.passCounts, undefined);
  assert.ok(overheadSample(run, 'off').problems.includes('tracing-off run emitted S1–S4'));
  const off = timedRun('fault', 'off', 40, 24);
  off.trace = parseTrace(jsonl([traceLine('subscription_fallback_timing', {
    tick: 1, started_ms: 40_000, session_ms: 40_004, final_admission_ms: 40_024, completed_ms: 40_040,
  }), watermarkLine(0, { timing_attempted: 2, timing_dropped: 1 })]), true);
  assert.equal(workerTiming(off), undefined);
  const unscored = overheadSample(off, 'off');
  assert.ok(unscored.problems.some(problem => /dropped/.test(problem)));
  assert.equal(unscored.evidence, undefined);
  assert.equal('verdict' in unscored, false);
});
