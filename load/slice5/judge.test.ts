import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNight, nights, partA, partC, replayPosition, requireMergedHarness, timelineEnv, type Arm } from './config.ts';
import { judgePartA, judgePartB, judgePartC, judgePartD, parseTimeline, timelineTopics, sustainable, compare, closedLoopNonSuccess, vacuumCost, worst,
  type Counts, type RunA, type RunB, type RunC, type RunD, type StepA } from './judge.ts';

const commit = { B: 'b975ffa0de92a256ffeb82f63af798e4c41f00f4', A: 'f7fe08a000000000000000000000000000000000' };
const counts = (attempted: number, p95: number | null = 5): Counts => ({ attempted, accepted: attempted, rejected429: 0, rejected503: 0,
  otherErrors: 0, clientTimeouts: 0, transportErrors: 0, droppedIterations: 0, p95 });
const identity = (cell: string, arm: Arm, round: number) => ({ cell, arm, round, commit: commit[arm], image: `sha256:${arm}`,
  settingsHash: 'settings', fixtureChecksum: 'fixture', complete: true, smoke: false });
const step = (rate: number, p95 = 5, walPerOp = 1000): StepA => ({ rate, seconds: 60, send: counts(rate * 60, p95), retry: counts(300), reader: counts(142),
  evidence: { samples: 70, maxSampleGapMs: 1100, samplingErrors: 0 },
  wal: { lsnBytes: walPerOp * rate * 60, checkpointsInside: 0, autovacuumInside: [], statsReset: false },
  vacuumAfter: { walBytes: 1e6, ms: 500 }, checkpointAfter: { walBytes: 100, ms: 200, buffersWritten: 1000 } });
const runA = (arm: Arm, round: number, f = 1, edit?: (r: RunA) => void): RunA => {
  const r: RunA = { ...identity('hot-17', arm, round), part: 'A', steps: partA.rates.map(rate => step(rate, 5 * f, 1000 * f)),
    storage: { bytes: 1750 * 60 * 600 * f, accepted: 1750 * 60 } };
  edit?.(r); return r;
};
const setA = (aFactor = 1, edit?: (r: RunA) => void) =>
  [1, 2, 3].flatMap(round => [runA('B', round), runA('A', round, aFactor, edit)]);
const metric = (v: ReturnType<typeof judgePartA>, prefix: string) => v.metrics.find(m => m.name.startsWith(prefix))!;

test('Part A passes only when every metric passes at the highest common sustainable rate', () => {
  const v = judgePartA(setA(), 'hot-17');
  assert.equal(v.status, 'PASS');
  assert.equal((v.detail as { highestCommonSustainableRate: number }).highestCommonSustainableRate, 1000);
  assert.equal(judgePartA(setA(1.10), 'hot-17').status, 'PASS');
});
test('Part A thresholds fail just above their limits', () => {
  assert.equal(metric(judgePartA(setA(1.11), 'hot-17'), 'send p95').status, 'FAIL');
  const wal = judgePartA(setA(1, r => r.steps.forEach(s => { s.wal.lsnBytes *= 1.16; })), 'hot-17');
  assert.equal(metric(wal, 'creation WAL/op').status, 'FAIL'); assert.equal(wal.status, 'FAIL');
  const storage = judgePartA(setA(1, r => { r.storage.bytes *= 1.26; }), 'hot-17');
  assert.equal(metric(storage, 'storage').status, 'FAIL');
  assert.equal(metric(judgePartA(setA(1, r => { r.storage.bytes *= 1.24; }), 'hot-17'), 'storage').status, 'PASS');
});
test('a step B sustains but A misses in any round is FAIL, even when lower steps pass', () => {
  const v = judgePartA(setA(1, r => { if (r.round === 2) r.steps[2].send.droppedIterations = 1; }), 'hot-17');
  assert.equal(v.status, 'FAIL');
  assert.equal((v.detail as { highestCommonSustainableRate: number }).highestCommonSustainableRate, 500);
});
test('a step B does not sustain is report-only and lowers the judged rate', () => {
  const runs = setA(); runs.filter(r => r.arm === 'B').forEach(r => { r.steps[2].send.rejected503 = 1; r.steps[2].send.accepted -= 1; });
  const v = judgePartA(runs, 'hot-17');
  assert.equal(v.status, 'PASS');
  assert.equal((v.detail as { steps: { status: string }[] }).steps[2].status, 'REPORT ONLY');
  assert.ok(v.metrics.every(m => !m.name.includes('1000/s')));
});
test('no common sustainable step is NOT EVALUATED, never PASS', () => {
  const runs = setA(); runs.forEach(r => r.steps.forEach(s => { s.send.droppedIterations = 1; }));
  assert.equal(judgePartA(runs, 'hot-17').status, 'NOT EVALUATED');
});
test('a checkpoint, autovacuum or stats reset inside the judged step makes WAL INVALID', () => {
  for (const edit of [(s: StepA) => { s.wal.checkpointsInside = 1; }, (s: StepA) => { s.wal.autovacuumInside = ['pg_toast.pg_toast_1']; },
    (s: StepA) => { s.wal.statsReset = true; }]) {
    const v = judgePartA(setA(1, r => { if (r.round === 3) edit(r.steps[2]); }), 'hot-17');
    assert.equal(metric(v, 'creation WAL/op').status, 'INVALID'); assert.equal(v.status, 'INVALID');
  }
});
test('a spread above 10% in either arm is INVALID, not PASS', () => {
  const v = judgePartA(setA(1, r => { if (r.round === 1) r.steps[2].send.p95 = 5.6; }), 'hot-17');
  assert.equal(metric(v, 'send p95').status, 'INVALID'); assert.equal(v.status, 'INVALID');
});
test('missing, duplicate, smoke or mismatched runs make the cell INVALID', () => {
  const cases: [string, (runs: RunA[]) => RunA[]][] = [
    ['missing', runs => runs.slice(1)], ['duplicate', runs => [...runs, runs[0]]],
    ['smoke', runs => runs.map((r, i) => i ? r : { ...r, smoke: true })], ['incomplete', runs => runs.map((r, i) => i ? r : { ...r, complete: false })],
    ['commit', runs => runs.map((r, i) => i ? r : { ...r, commit: commit.A })], ['image', runs => runs.map((r, i) => i ? r : { ...r, image: 'other' })],
    ['settings', runs => runs.map((r, i) => i ? r : { ...r, settingsHash: 'other' })],
    ['fixture', runs => runs.map((r, i) => i ? r : { ...r, fixtureChecksum: 'other' })],
    ['step', runs => runs.map((r, i) => i ? r : { ...r, steps: r.steps.slice(1) })],
  ];
  for (const [name, edit] of cases) assert.equal(judgePartA(edit(setA()), 'hot-17').status, 'INVALID', name);
});
test('explicit VACUUM cost is report-only and asks for a decision above 1.25x', () => {
  assert.equal(vacuumCost(setA(), 'hot-17').status, 'REPORT ONLY');
  assert.equal(vacuumCost(setA(1, r => r.steps.forEach(s => { s.vacuumAfter.walBytes *= 1.3; })), 'hot-17').status, 'NEEDS DECISION');
  assert.equal(judgePartA(setA(1, r => r.steps.forEach(s => { s.vacuumAfter.walBytes *= 3; })), 'hot-17').status, 'PASS');
});

const runB = (arm: Arm, round: number, rate: number, cpu = 50): RunB => ({ ...identity('many-17', arm, round), part: 'B',
  acceptedPerSecond: rate, measured: counts(rate * 60), nonSuccess: 0, hostCpuMeanPercent: cpu, evidence: { samples: 90, maxSampleGapMs: 1000, samplingErrors: 0 } });
const setB = (a: number, edit?: (r: RunB) => void) => [1, 2, 3].flatMap(round => [runB('B', round, 1000), runB('A', round, a)].map(r => { edit?.(r); return r; }));
test('Part B: accepted/s ratio, non-2xx and host saturation (Q8)', () => {
  assert.equal(judgePartB(setB(900), 'many-17').status, 'PASS');
  assert.equal(judgePartB(setB(890), 'many-17').status, 'FAIL');
  assert.equal(judgePartB(setB(1000, r => { if (r.arm === 'A' && r.round === 1) r.nonSuccess = 1; }), 'many-17').status, 'INVALID');
  assert.equal(judgePartB(setB(1000, r => { if (r.arm === 'A' && r.round === 2) r.hostCpuMeanPercent = 91; }), 'many-17').status, 'INVESTIGATE');
  assert.equal(judgePartB(setB(1000, r => { if (r.arm === 'B') r.hostCpuMeanPercent = 95; }), 'many-17').status, 'NOT EVALUATED');
});

const runC = (arm: Arm, round: number, p95: number): RunC => ({ ...identity('1M-deep', arm, round), part: 'C', p95,
  requests: partC.readers * partC.requests, invalidPages: 0, outsideSender: 0, readerErrors: 0, sender: counts(1000), senderRate: 20, senderSeconds: 50,
  evidence: { samples: 60, maxSampleGapMs: 1000, samplingErrors: 0 } });
const setC = (b: number, a: number, edit?: (r: RunC) => void) => [1, 2, 3].flatMap(round => [runC('B', round, b), runC('A', round, a)].map(r => { edit?.(r); return r; }));
test('Part C: ratio and the 100 ms absolute limit both apply; malformed pages are INVALID', () => {
  assert.equal(judgePartC(setC(20, 22), '1M-deep').status, 'PASS');
  assert.equal(judgePartC(setC(20, 22.4), '1M-deep').status, 'FAIL');
  assert.equal(judgePartC(setC(95, 101), '1M-deep').status, 'FAIL');
  assert.equal(judgePartC(setC(20, 20, r => { if (r.arm === 'A') r.invalidPages = 1; }), '1M-deep').status, 'INVALID');
  assert.equal(judgePartC(setC(20, 20, r => { if (r.arm === 'B') r.sender.otherErrors = 1; }), '1M-deep').status, 'INVALID');
});
test('night 3 reruns only Part C with A moved to the #674 fix and B unchanged', () => {
  assert.deepEqual(nights[3].parts, ['C']);
  assert.equal(nights[3].commits.B, nights[2].commits.B);
  assert.equal(nights[3].commits.A, '4542f545');
  assert.equal(nights[3].hardTimeoutMinutes, nights[2].hardTimeoutMinutes);
  assert.ok(isNight('3') && !isNight('4') && !isNight(undefined));
  const rerun = { B: commit.B, A: '4542f5453ac66103a643be821728b1d7f4118558' };
  const setRerun = (a: string) => setC(20, 22).map(r => r.arm === 'A' ? { ...r, commit: a } : r);
  assert.equal(judgePartC(setRerun(rerun.A), '1M-deep', nights[3].commits).status, 'PASS');
  // The night 2 candidate, or the default commits, can never satisfy a night 3 verdict, and vice versa.
  assert.deepEqual(judgePartC(setRerun(commit.A), '1M-deep', nights[3].commits).reasons, ['commit mismatch']);
  assert.deepEqual(judgePartC(setRerun(rerun.A), '1M-deep').reasons, ['commit mismatch']);
});

const log = (page: number) => `TOPIC_DATA topics=10000\nTOPIC_PAGE boundary=None n=400 p50_ms=1.0 p95_ms=${page} max_ms=9.0\n` +
  `TOPIC_SEND boundary=None n=500 p50_ms=1.0 p95_ms=3.0 max_ms=9.0\nTOPIC_PAGE boundary=Some(190000) n=400 p50_ms=1.0 p95_ms=${page} max_ms=9.0\n` +
  `TOPIC_SEND boundary=Some(190000) n=500 p50_ms=1.0 p95_ms=3.0 max_ms=9.0\n`;
const runD = (arm: Arm, round: number, page: number): RunD => ({ part: 'D', arm, round, commit: commit[arm], complete: true, smoke: false, topics: 10000, rows: parseTimeline(log(page)) });
test('Part D: absolute 100 ms target on PAGE rows only; missing rows are INVALID', () => {
  assert.equal(parseTimeline(log(10)).length, 4);
  const ok = judgePartD([1, 2, 3].flatMap(r => [runD('B', r, 10), runD('A', r, 12)]));
  assert.deepEqual(ok.map(v => v.status).sort(), ['PASS', 'PASS', 'REPORT ONLY', 'REPORT ONLY']);
  assert.ok(judgePartD([1, 2, 3].flatMap(r => [runD('B', r, 10), runD('A', r, 101)])).some(v => v.status === 'FAIL'));
  const missing = [1, 2, 3].flatMap(r => [runD('B', r, 10), runD('A', r, 12)]); missing[1].rows = missing[1].rows.slice(1);
  assert.equal(judgePartD(missing)[0].status, 'INVALID');
});
test('any non-pass status dominates PASS', () => {
  for (const s of ['FAIL', 'INVALID', 'NOT EVALUATED', 'INVESTIGATE'] as const) assert.equal(worst(['PASS', s]), s);
  assert.equal(worst([]), 'NOT EVALUATED');
});

test('Part A missing evidence at or above the judged rate cannot hide a regression', () => {
  for (const arm of ['A', 'B'] as const) for (const edit of [
    (s: StepA) => { s.evidence.maxSampleGapMs = 2600; },
    (s: StepA) => { s.send.p95 = null; },
    (s: StepA) => { s.send.attempted = -1; },
    (s: StepA) => { s.reader.attempted = -1; },
  ]) {
    const runs = setA(); edit(runs.find(r => r.arm === arm)!.steps[2]);
    assert.equal(judgePartA(runs, 'hot-17').status, 'INVALID');
  }
});
test('Part A scores a never-started second-Organization reader as INVALID', () => {
  for (const arm of ['A', 'B'] as const) {
    const runs = setA();
    runs.find(r => r.arm === arm)!.steps[2].reader = counts(0, null);
    assert.equal(judgePartA(runs, 'hot-17').status, 'INVALID', arm);
  }
});
test('Part A enforces offered bounds and the second-Organization reader, while retry is report-only', () => {
  for (const n of [14249, 15002]) {
    const s = step(250); s.send = counts(n);
    assert.ok(sustainable(s).includes('offered load not generated'));
  }
  for (const edit of [
    (s: StepA) => { s.reader.droppedIterations = 1; },
    (s: StepA) => { s.reader.accepted--; s.reader.otherErrors++; },
    (s: StepA) => { s.reader = { ...counts(0, null), droppedIterations: 142 }; },
    (s: StepA) => { s.reader = counts(134); },
  ]) {
    const runs = setA(1, r => edit(r.steps[2]));
    assert.equal(judgePartA(runs, 'hot-17').status, 'FAIL');
  }
  assert.equal(judgePartA(setA(1, r => { r.steps[2].retry = counts(0); }), 'hot-17').status, 'PASS');
});
test('accepted/s comparison rejects below 90 percent; B spread and missing LSN are invalid', () => {
  // With identical rates/durations and sustainable steps, accepted A/B is at least .95;
  // test the comparison directly because an integrated .90 negative is unreachable.
  assert.equal(compare('accepted/s', [1000,1000,1000], [899,899,899], r => r >= .9).status, 'FAIL');
  const b = setA(); b[0].steps[2].send.p95 = 6;
  assert.equal(judgePartA(b, 'hot-17').status, 'INVALID');
  assert.equal(metric(judgePartA(setA(1, r => { r.steps[2].wal.lsnBytes = NaN; }), 'hot-17'), 'creation WAL').status, 'INVALID');
});
test('missing explicit-VACUUM values are NOT EVALUATED', () => {
  for (const v of [NaN, null]) {
    const runs = setA(); runs[0].steps[0].vacuumAfter.walBytes = v as number;
    assert.equal(vacuumCost(runs, 'hot-17').status, 'NOT EVALUATED');
  }
});
test('Part B rejects inconsistent measured errors, drops, missing evidence and spread', () => {
  for (const edit of [
    (r: RunB) => { r.measured.accepted--; r.measured.rejected503++; },
    (r: RunB) => { r.measured.droppedIterations++; },
    (r: RunB) => { r.measured.attempted = -1; },
    (r: RunB) => { r.evidence.samplingErrors++; },
    (r: RunB) => { r.hostCpuMeanPercent = NaN; },
  ]) assert.equal(judgePartB(setB(1000, edit), 'many-17').status, 'INVALID');
  const runs = setB(1000); runs[0].acceptedPerSecond = 1200;
  assert.equal(judgePartB(runs, 'many-17').status, 'INVALID');
});
test('Part C rejects missing counters, wrong counts, sender drops, low offers and missing evidence', () => {
  for (const edit of [
    (r: RunC) => { r.requests--; }, (r: RunC) => { r.readerErrors++; },
    (r: RunC) => { r.invalidPages = -1; r.outsideSender = 1; },
    (r: RunC) => { r.outsideSender = -1; }, (r: RunC) => { r.outsideSender = 1; },
    (r: RunC) => { r.sender.droppedIterations++; }, (r: RunC) => { r.sender = counts(940); },
    (r: RunC) => { r.sender.attempted = -1; }, (r: RunC) => { r.evidence.samplingErrors++; },
  ]) assert.equal(judgePartC(setC(20,20,edit), '1M-deep').status, 'INVALID');
  const runs = setC(20,20); runs[0].p95 = 23;
  assert.equal(judgePartC(runs, '1M-deep').status, 'INVALID');
});
const setD = () => [1,2,3].flatMap(r => [runD('B',r,10),runD('A',r,10)]);
test('Part D rejects zero/negative latency, either spread, wrong samples, fixture and row keys', () => {
  for (const edit of [
    (r: RunD) => { r.rows[0].p95 = 0; }, (r: RunD) => { r.rows[0].p95 = -1; },
    (r: RunD) => { r.rows[0].p95 = 12; }, (r: RunD) => { r.rows[0].n = 0; },
    (r: RunD) => { r.rows[0].n = 10; }, (r: RunD) => { r.rows[0].key = 'PAGE boundary=wrong'; },
    (r: RunD) => { r.smoke = true; }, (r: RunD) => { r.complete = false; },
    (r: RunD) => { r.commit = 'wrong'; }, (r: RunD) => { r.topics = 500; },
    (r: RunD) => { r.topics = NaN; }, (r: RunD) => { r.rows = r.rows.slice(0,2); },
  ]) for (const arm of ['A','B'] as const) {
    const runs = setD(); edit(runs.find(r => r.arm === arm)!);
    assert.ok(judgePartD(runs).some(v => v.status === 'INVALID'));
  }
});
test('formal Part D clears smoke override and requires exactly one TOPIC_DATA', () => {
  assert.equal(timelineEnv({ MEASURE_TOPICS: '500' }).MEASURE_TOPICS, undefined);
  assert.equal(timelineEnv({ MEASURE_TOPICS: '1' }, '500').MEASURE_TOPICS, '500');
  assert.equal(timelineTopics(log(10)),10000);
  assert.ok(Number.isNaN(timelineTopics(log(10).replace('TOPIC_DATA','IGNORED'))));
  assert.ok(Number.isNaN(timelineTopics(log(10)+log(10))));
});
test('formal runs require merged harness; smoke remains allowed', () => {
  assert.throws(() => requireMergedHarness(false,false));
  assert.doesNotThrow(() => requireMergedHarness(false,true));
  assert.doesNotThrow(() => requireMergedHarness(true,false));
});
test('replay cursors are fixed per reader and independent of global VU allocation', () => {
  const positions = Array.from({length:4}, (_,i) => replayPosition(1e6,1000,50,'recent',i,10));
  assert.equal(new Set(positions).size,4);
  assert.deepEqual(positions,[999390,999709,999078,999397]);
});

test('Part B validates warmup, measured, drain and reader outcomes without trusting a scalar', () => {
  const lanes = () => ({ send: { warmup: counts(10), measured: counts(100), after: counts(0) },
    reader: { warmup: counts(60), measured: counts(120), after: counts(22) } });
  assert.equal(closedLoopNonSuccess(lanes()),0);
  for (const lane of ['send','reader'] as const) for (const window of ['warmup','measured','after'] as const) {
    const bad = lanes(); bad[lane][window] = { ...counts(1), accepted: 0, otherErrors: 1 };
    assert.equal(closedLoopNonSuccess(bad),1);
    const dropped = lanes(); dropped[lane][window].droppedIterations = 1;
    assert.ok(Number.isNaN(closedLoopNonSuccess(dropped)));
    const absent = lanes(); absent[lane][window].accepted = -1;
    assert.ok(Number.isNaN(closedLoopNonSuccess(absent)));
  }
  const neverStarted = lanes(); neverStarted.reader = { warmup: counts(0), measured: counts(0), after: counts(0) };
  assert.ok(Number.isNaN(closedLoopNonSuccess(neverStarted)));
  const unexpected: Record<string, Record<string, Counts>> = lanes(); unexpected.send.surprise = counts(0);
  assert.ok(Number.isNaN(closedLoopNonSuccess(unexpected)));
  const missing: Record<string, Record<string, Counts>> = lanes(); delete missing.send.after;
  assert.ok(Number.isNaN(closedLoopNonSuccess(missing)));
});

test('Part A: A round 1 429s plus A round 2 sampler gap remains FAIL (B3)', () => {
  for (const sameRun of [false, true]) {
    const runs = setA();
    const first = runs.find(r => r.arm === 'A' && r.round === 1)!.steps[2];
    first.send.accepted--; first.send.rejected429++;
    runs.find(r => r.arm === 'A' && r.round === (sameRun ? 1 : 2))!.steps[2].evidence.maxSampleGapMs = 2600;
    const v = judgePartA(runs, 'hot-17');
    assert.equal(v.status, 'FAIL');
    assert.equal((v.detail as { steps: { status: string }[] }).steps[2].status, 'FAIL');
  }
});
test('Part A: sampler gap alone remains INVALID in either arm', () => {
  for (const arm of ['A', 'B'] as const) {
    const runs = setA(); runs.find(r => r.arm === arm)!.steps[2].evidence.maxSampleGapMs = 2600;
    assert.equal(judgePartA(runs, 'hot-17').status, 'INVALID');
  }
});
test('Part A: B sampler gap with A definite failure remains INVALID', () => {
  const runs = setA(); runs.find(r => r.arm === 'B')!.steps[2].evidence.maxSampleGapMs = 2600;
  const a = runs.find(r => r.arm === 'A')!.steps[2]; a.send.accepted--; a.send.rejected429++;
  assert.equal(judgePartA(runs, 'hot-17').status, 'INVALID');
});
test('Part A: definite B failure remains REPORT ONLY despite gaps in either arm', () => {
  for (const arm of ['A', 'B'] as const) {
    const runs = setA(), b = runs.find(r => r.arm === 'B')!.steps[2];
    b.send.accepted--; b.send.rejected429++;
    runs.find(r => r.arm === arm && r.round === 2)!.steps[2].evidence.maxSampleGapMs = 2600;
    const v = judgePartA(runs, 'hot-17');
    assert.equal(v.status, 'PASS');
    assert.equal((v.detail as { steps: { status: string }[] }).steps[2].status, 'REPORT ONLY');
    assert.equal((v.detail as { highestCommonSustainableRate: number }).highestCommonSustainableRate, 500);
  }
});
test('Part D A assertions remain FAIL with zero, partial or complete rows, even with missing rounds', () => {
  for (const n of [0, 2, 4]) {
    const runs = setD(), a = runs[1];
    a.failure = { cause: 'assertion', exitCode: 101, signal: null, timedOut: false, evidence: ['target test panicked at'] };
    a.rows = a.rows.slice(0, n); a.complete = n === 4;
    assert.equal(judgePartD(runs)[0].status, 'FAIL');
    assert.equal(judgePartD([a])[0].status, 'FAIL');
  }
});
test('Part D artifacts with only a nonzero exit are INVALID and require investigation', () => {
  const runs = setD();
  runs[1].exitCode = 101;
  const verdict = judgePartD(runs)[0];
  assert.equal(verdict.status, 'INVALID');
  assert.match(verdict.reasons[0], /A1: unknown.*investigate.*101/);
});
