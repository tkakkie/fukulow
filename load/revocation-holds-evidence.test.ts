import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelsXor, evidence } from './revocation-holds-evidence.ts';
import { channelId, holdsFixture, jsonl, memberId, target, traceLines, watermarkLine } from './revocation-holds-fixture.ts';
import { judgeHolds } from './revocation-holds-judgment.ts';
import { parseTrace } from './revocation-holds-trace.ts';

const rules = (run: ReturnType<typeof holdsFixture>) => [...new Set(evidence(run).issues.map(i => i.rule))];
function withFields(line: string, patch: Record<string, unknown>) {
  const data = JSON.parse(line);
  Object.assign(data.fields, patch);
  return JSON.stringify(data);
}

test('E1 accepts a fault S1 with complete evidence but a control must have S1 outcome ok', () => {
  assert.equal(judgeHolds(holdsFixture()).verdict, 'PASS');
  for (const outcome of ['error', 'timeout', 'late', 'none']) {
    const run = holdsFixture('control');
    assert.equal(judgeHolds(run).verdict, 'CONTROL');
    const lines = traceLines(run);
    lines[3] = withFields(lines[3], { outcome });
    run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
    assert.deepEqual(rules(run), ['E1']);
    assert.equal(judgeHolds(run).verdict, 'INVALID');
    assert.equal(judgeHolds(run).evidenceOnly, true);
  }
});

test('E1 rejects an ambiguous worker pass or an S2/S3 with the wrong check_seq', () => {
  const run = holdsFixture();
  const lines = traceLines(run);
  run.trace = parseTrace(jsonl([...lines, withFields(lines[3], { tick: 2, trace_seq: 5 }), watermarkLine(5)]), true);
  assert.ok(rules(run).includes('E1'));
  lines[1] = withFields(lines[1], { check_seq: 2 });
  run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
  assert.ok(rules(run).includes('E1') && rules(run).includes('E4'));
});

test('E2 requires the full Channel XOR, target membership, queued checks and the gate acknowledgement', () => {
  assert.equal(channelsXor([channelId(0), channelId(1)]), '00000000000000000000000000000003');
  assert.equal(channelsXor(['00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000000']),
    '80000000000000000000000000000000');
  for (const corrupt of [
    (row: string[]) => { row[0] = memberId(1); },
    (row: string[]) => { row[2] = '15'; },
    (row: string[]) => { row[4] = '00000000000000000000000000000000'; },
  ]) {
    const run = holdsFixture();
    const snapshot = run.trace!.events[0];
    assert.equal(snapshot.name, 'revocation_fallback_snapshot');
    const [first, ...rest] = snapshot.records.split(',');
    const row = first.split(':');
    corrupt(row);
    snapshot.records = [row.join(':'), ...rest].join(',');
    assert.ok(rules(run).includes('E2'));
    assert.equal(judgeHolds(run).verdict, 'INVALID');
  }
  const run = holdsFixture();
  run.times.gateOn[1] = 40_010; // snapshot could be at 40_009
  assert.ok(rules(run).includes('E2'));
});

test('E3 requires every chunk to fail in a fault and none in a control', () => {
  for (const kind of ['fault', 'control'] as const) {
    const run = holdsFixture(kind);
    const check = run.trace!.events.find(e => e.name === 'revocation_fallback_check')!;
    check.failed = 1;
    assert.deepEqual(rules(run), [kind === 'fault' ? 'E3' : 'E1']);
    assert.equal(judgeHolds(run).verdict, 'INVALID');
  }
});

test('E4 validates one first-admission disposition for a registration straddling failed chunks', () => {
  const run = holdsFixture();
  run.cell = 'Hcap';
  run.targets = Array.from({ length: 96 }, (_, i) => target(i));
  run.accounts = Array.from({ length: 3 }, (_, i) => ({ memberId: memberId(i) }));
  run.revokedChannels = Array.from({ length: 64 }, (_, i) => channelId(i));
  const lines = traceLines(run);
  const outcome = JSON.parse(lines[1]).fields.records.split(',') as string[];
  // One registration covers 64 checks across two chunks. The first visit accounts for
  // all of them, including 8 cap refusals. A later visit cannot replace that record.
  outcome[7] = `${memberId(0)}:56:8:0:0:0:0:7:40020`;
  run.metrics!.revocation_retired_global_cap = 8;
  const read = (records: string[]) => parseTrace(jsonl([
    lines[0], withFields(lines[1], { records: records.join(',') }), ...lines.slice(2), watermarkLine(4),
  ]), true);
  run.trace = read(outcome);
  assert.deepEqual(rules(run), []);
  assert.equal(evidence(run).refused, 8);
  assert.equal(evidence(run).admissions.length, 96);
  for (const replacement of [
    `${memberId(0)}:112:8:0:0:0:0:7:40020`, // double-counted hold after the second chunk
    `${memberId(0)}:56:0:0:0:0:8:7:40020`, // cap refusal overwritten with gone
    `${memberId(0)}:0:0:0:0:0:64:0:40020`, // a frozen all-gone record is present but cannot pass
    `${memberId(0)}:56:8:0:0:0:0:8:40020`, // wrong check ID XOR
  ]) {
    run.trace = read(outcome.map((record, i) => i === 7 ? replacement : record));
    assert.ok(rules(run).includes('E4'));
  }
  run.trace = read([...outcome, outcome[7]]);
  assert.ok(rules(run).includes('E4'));
  run.trace = read(outcome);
  run.metrics!.revocation_retired_global_cap++;
  assert.ok(rules(run).includes('E4'));
});

test('E4/E5 reject a missing S3, a missing disposition, and admission at the release boundary', () => {
  const run = holdsFixture();
  const lines = traceLines(run);
  const withoutS3 = [lines[0], withFields(lines[2], { trace_seq: 2 }), withFields(lines[3], { trace_seq: 3 }), lines[4]];
  run.trace = parseTrace(jsonl([...withoutS3, watermarkLine(3)]), true);
  assert.equal(judgeHolds(run).verdict, 'INVALID');
  assert.deepEqual(rules(run), ['E4']);
  run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
  const outcome = run.trace.events.find(e => e.name === 'revocation_fallback_outcome')!;
  outcome.records = outcome.records.split(',').slice(0, -1).join(',');
  assert.deepEqual(rules(run), ['E4']);
  run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
  run.times.resume = 40_021;
  assert.deepEqual(rules(run), ['E4']);
  assert.equal(evidence(run).admissions[0].marginMs, 0);
  assert.equal(evidence(run).q2AdmissionReview, true);
});

test('E4c accepts accounted gone checks and rejects an unverified control check', () => {
  const run = holdsFixture('control');
  const outcome = run.trace!.events.find(e => e.name === 'revocation_fallback_outcome')!;
  const [, ...rest] = outcome.records.split(',');
  outcome.records = [`${memberId(0)}:0:0:0:15:0:1:81:-`, ...rest].join(',');
  assert.equal(judgeHolds(run).verdict, 'CONTROL');
  outcome.records = [`${memberId(0)}:0:0:0:15:1:0:0:-`, ...rest].join(',');
  assert.deepEqual(rules(run), ['E4c']);
});

test('zero registrations or zero trace records cannot pass', () => {
  const run = holdsFixture('control');
  const lines = traceLines(run);
  lines[0] = withFields(lines[0], { records: '', registrations: 0 });
  lines[1] = withFields(lines[1], { records: '' });
  run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
  assert.deepEqual(rules(run), ['E2', 'E4c']);
  assert.equal(judgeHolds(run).verdict, 'INVALID');
  run.trace = parseTrace(jsonl([lines[4], watermarkLine(0)]), true);
  assert.ok(rules(run).includes('E8'));
  assert.equal(judgeHolds(run).verdict, 'INVALID');
});

test('E6 requires all 120 Messages after release on every target, while late E7 is diagnostic', () => {
  const run = holdsFixture();
  run.times.resume += 51;
  run.targets.forEach(t => {
    t.stall.resumedAt[0] += 51;
    t.stall.reads[1].at += 51;
    t.stallMessages.forEach(message => { message.at += 51; });
  });
  assert.equal(judgeHolds(run).verdict, 'PASS');
  assert.equal(evidence(run).e7ResumeLagMs, 51);
  assert.equal(evidence(run).q8Over50Ms, true);
  run.targets.at(-1)!.stallMessages[0].at = run.times.resume - 1;
  assert.deepEqual(rules(run), ['E6']);
  assert.equal(judgeHolds(run).verdict, 'INVALID');
  const messages = run.targets.at(-1)!.stallMessages;
  messages[0] = { ...messages[1] };
  assert.deepEqual(rules(run), ['E6']); // a duplicate cannot replace a missed Message
});

test('Q2 reports late admission without changing release or adding a verdict rule', () => {
  const run = holdsFixture();
  const lines = traceLines(run);
  const fields = JSON.parse(lines[1]).fields;
  lines[1] = withFields(lines[1], { server_ms: 40_065, records: fields.records.replaceAll(':40020', ':40060') });
  lines[2] = withFields(lines[2], { finished_ms: 40_065 });
  lines[3] = withFields(lines[3], { completed_ms: 40_066 });
  run.trace = parseTrace(jsonl([...lines, watermarkLine(4)]), true);
  assert.equal(evidence(run).q2AdmissionReview, true);
  assert.equal(run.times.resume - run.times.pass, 100);
  assert.equal(judgeHolds(run).verdict, 'PASS');
});

test('Q2 requests review when a target registration lacks a finite admission margin', () => {
  const run = holdsFixture();
  assert.equal(evidence(run).q2AdmissionReview, false);
  const outcome = run.trace!.events.find(event => event.name === 'revocation_fallback_outcome')!;
  const records = outcome.records.split(',');
  for (const first of [records[0].replace(/:40020$/, ':-'), records[0].replace(/:40020$/, ':Infinity')]) {
    outcome.records = [first, ...records.slice(1)].join(',');
    const result = evidence(run);
    assert.equal(result.admissions.length, 31);
    assert.equal(result.q2AdmissionReview, true);
  }
  outcome.records = records.slice(0, -1).join(',');
  assert.equal(evidence(run).q2AdmissionReview, true);
});

test('Q2 requests review for a fault with no matching S4', () => {
  for (const kind of ['fault', 'control'] as const) {
    const run = holdsFixture(kind);
    run.trace!.events = run.trace!.events.filter(event => event.name !== 'revocation_fallback_check');
    const result = evidence(run);
    assert.equal(result.s4FinishAfterPassMs, undefined);
    assert.equal(result.q2AdmissionReview, kind === 'fault');
  }
});

test('V1 preserves a certain in-fault send failure when E4 reports gone checks', () => {
  const run = holdsFixture();
  const outcome = run.trace!.events.find(event => event.name === 'revocation_fallback_outcome')!;
  const [, ...rest] = outcome.records.split(',');
  outcome.records = [`${memberId(0)}:15:0:0:0:0:1:1:40020`, ...rest].join(',');
  run.sendTiming!.records[0].beforeMs = run.sendTiming!.records[0].afterMs = 41_000;
  const judged = judgeHolds(run);
  assert.equal(judged.verdict, 'FAIL');
  assert.ok(judged.reasons.includes('a revocation was sent while the failure was active'));
  assert.ok(judged.evidence.issues.some(issue => issue.rule === 'E4'));
});
