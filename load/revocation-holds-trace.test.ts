import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { holdsFixture, jsonl, traceLines, watermarkLine } from './revocation-holds-fixture.ts';
import { judgeHolds } from './revocation-holds-judgment.ts';
import { parseTrace, readTrace, watchTrace } from './revocation-holds-trace.ts';

const e8Cases: [string, string[], RegExp][] = [
  ['missing watermark', [], /missing or unreadable watermark/],
  ['unreadable watermark', [watermarkLine(4, { attempted: '4' })], /missing or unreadable watermark/],
  ['drop at the tail despite contiguous S1–S4', [watermarkLine(4, { attempted: 5, dropped: 1 })], /1 dropped lines/],
  ['bad accounting', [watermarkLine(4, { attempted: 5 })], /attempted != written \+ dropped/],
  ['watermark/record count mismatch', [watermarkLine(5)], /written 5 != records read 4/],
  ['duplicate watermark', [watermarkLine(4), watermarkLine(4)], /unreadable trace line/],
];
for (const [name, tail, reason] of e8Cases) {
  test(`E8 rejects ${name}`, () => {
    const run = holdsFixture();
    run.trace = parseTrace(jsonl([...traceLines(run), ...tail]), true);
    const verdict = judgeHolds(run);
    assert.equal(verdict.verdict, 'INVALID');
    assert.equal(verdict.evidenceOnly, true);
    assert.ok(verdict.evidence.issues.some(issue => issue.rule === 'E8' && reason.test(issue.message)));
  });
}

test('E8 catches non-contiguous trace_seq and an S1 drop report', () => {
  const run = holdsFixture();
  const lines = traceLines(run);
  lines[3] = lines[3].replace('"trace_seq":4', '"trace_seq":5').replace('"trace_dropped":0', '"trace_dropped":1');
  run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
  assert.deepEqual(run.trace.evidenceErrors, ['trace_seq is not contiguous from 1', 'S1 reports dropped trace lines']);
  assert.equal(judgeHolds(run).verdict, 'INVALID');
});

test('a full-looking trace cannot attest to graceful shutdown, and an unreadable file is missing evidence', t => {
  const run = holdsFixture();
  run.trace = parseTrace(jsonl([...traceLines(run), watermarkLine(4)]), false);
  assert.deepEqual(run.trace.evidenceErrors, ['server did not exit gracefully']);
  assert.equal(judgeHolds(run).verdict, 'INVALID');
  const dir = mkdtempSync(join(tmpdir(), 'revocation-trace-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  run.trace = readTrace(join(dir, 'absent.jsonl'), true);
  assert.ok(run.trace.evidenceErrors.includes('trace file is unreadable'));
  assert.equal(judgeHolds(run).verdict, 'INVALID');
});

test('V1 preserves a scored failure even when E8 fails', () => {
  const run = holdsFixture();
  run.trace = parseTrace(jsonl(traceLines(run)), true);
  run.bystanderCloses = [run.times.resume + 10];
  const verdict = judgeHolds(run);
  assert.equal(verdict.verdict, 'FAIL');
  assert.equal(verdict.evidenceOnly, false);
  assert.ok(verdict.evidence.issues.some(issue => issue.rule === 'E8'));
});

test('E8 cross-checks the separately counted timing lines against the file', () => {
  const run = holdsFixture();
  run.trace = parseTrace(jsonl([...traceLines(run), watermarkLine(4, { timing_attempted: 2, timing_written: 2 })]), true);
  assert.deepEqual(run.trace.evidenceErrors, []);
  const judged = judgeHolds(run);
  assert.equal(judged.verdict, 'INVALID');
  assert.deepEqual(judged.evidence.issues, [{ rule: 'E8', message: 'worker timing watermark written 2 != records read 1' }]);
});

test('overhead capture timestamps complete trace lines as they become visible in the dedicated file', { timeout: 3_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-arrivals-'));
  const path = join(dir, 'trace.jsonl');
  let now = 10;
  const observer = watchTrace(path, () => now);
  t.after(() => { observer.stop(); rmSync(dir, { force: true, recursive: true }); });
  const lines = traceLines(holdsFixture());
  appendFileSync(path, jsonl(lines.slice(0, 2)) + lines[2]);
  while (observer.arrivals.length < 2) await sleep(10, undefined, { signal: t.signal });
  assert.deepEqual(observer.arrivals, [10, 10]);
  now = 20;
  appendFileSync(path, '\n' + jsonl([...lines.slice(3), watermarkLine(4)]));
  while (observer.arrivals.length < 6) await sleep(10, undefined, { signal: t.signal });
  const trace = readTrace(path, true, observer.arrivals);
  assert.deepEqual(trace.evidenceErrors, []);
  assert.deepEqual(trace.events.map(event => event.receivedAt), [10, 10, 20, 20]);
});
