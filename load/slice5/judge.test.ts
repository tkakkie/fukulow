import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partA, partC, type Arm } from './config.ts';
import { judgePartA, judgePartB, judgePartC, judgePartD, parseTimeline, vacuumCost, worst,
  type Counts, type RunA, type RunB, type RunC, type RunD, type StepA } from './judge.ts';

const commit = { B: 'b975ffa0de92a256ffeb82f63af798e4c41f00f4', A: 'f7fe08a000000000000000000000000000000000' };
const counts = (attempted: number, p95: number | null = 5): Counts => ({ attempted, accepted: attempted, rejected429: 0, rejected503: 0,
  otherErrors: 0, clientTimeouts: 0, transportErrors: 0, droppedIterations: 0, p95 });
const identity = (cell: string, arm: Arm, round: number) => ({ cell, arm, round, commit: commit[arm], image: `sha256:${arm}`,
  settingsHash: 'settings', fixtureChecksum: 'fixture', complete: true, smoke: false });
const step = (rate: number, p95 = 5, walPerOp = 1000): StepA => ({ rate, seconds: 60, send: counts(rate * 60, p95), retry: counts(300),
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
  const runs = setA(); runs.forEach(r => r.steps.forEach(s => { s.evidence.maxSampleGapMs = 2600; }));
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
  requests: partC.readers * partC.requests, invalidPages: 0, readerErrors: 0, sender: counts(1000), senderRate: 20, senderSeconds: 50,
  evidence: { samples: 60, maxSampleGapMs: 1000, samplingErrors: 0 } });
const setC = (b: number, a: number, edit?: (r: RunC) => void) => [1, 2, 3].flatMap(round => [runC('B', round, b), runC('A', round, a)].map(r => { edit?.(r); return r; }));
test('Part C: ratio and the 100 ms absolute limit both apply; malformed pages are INVALID', () => {
  assert.equal(judgePartC(setC(20, 22), '1M-deep').status, 'PASS');
  assert.equal(judgePartC(setC(20, 22.4), '1M-deep').status, 'FAIL');
  assert.equal(judgePartC(setC(95, 101), '1M-deep').status, 'FAIL');
  assert.equal(judgePartC(setC(20, 20, r => { if (r.arm === 'A') r.invalidPages = 1; }), '1M-deep').status, 'INVALID');
  assert.equal(judgePartC(setC(20, 20, r => { if (r.arm === 'B') r.sender.otherErrors = 1; }), '1M-deep').status, 'INVALID');
});

const log = (page: number) => `TOPIC_DATA topics=10000\nTOPIC_PAGE boundary=None n=1000 p50_ms=1.0 p95_ms=${page} max_ms=9.0\n` +
  `TOPIC_SEND boundary=None n=500 p50_ms=1.0 p95_ms=3.0 max_ms=9.0\nTOPIC_PAGE boundary=Some(190000) n=1000 p50_ms=1.0 p95_ms=${page} max_ms=9.0\n` +
  `TOPIC_SEND boundary=Some(190000) n=500 p50_ms=1.0 p95_ms=3.0 max_ms=9.0\n`;
const runD = (arm: Arm, round: number, page: number): RunD => ({ part: 'D', arm, round, commit: commit[arm], complete: true, smoke: false, rows: parseTimeline(log(page)) });
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
