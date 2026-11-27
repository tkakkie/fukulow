import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSnapshots, mapMetrics, parseWalInspection, statementKeys, type AttributionBlock } from './attribution.ts';
import { attributionMarkdown, summarizeAttribution } from './attribution-summary.ts';

function block(order: number, arm: AttributionBlock['arm'], latencyMs: number, walBytesPerSend: number, primaryMs: number, primaryWal: number,
  nestedMs = 0): AttributionBlock {
  const transactions = 100;
  const statement = (query: string, topLevel: boolean, ms: number, bytes: number) => ({
    identity: { queryId: String(order), query, topLevel, statsSince: 'now' },
    counters: { ...mapMetrics(statementKeys, () => 0), calls: transactions, execMs: ms * transactions, walBytes: bytes * transactions },
  });
  const empty = { statements: [], functions: [], statsReset: null, deallocations: 0 };
  const statements = [statement('SELECT proto_send($1)', true, primaryMs, primaryWal)];
  if (nestedMs) statements.push(statement('UPDATE message_append_counts', false, nestedMs, 10));
  const stats = diffSnapshots(empty, { ...empty, statements, functions: [
    { identity: { oid: String(order), name: 'public.proto_send(integer)' },
      counters: { calls: transactions, totalMs: primaryMs * transactions, selfMs: primaryMs * transactions / 2 } },
  ] }, transactions);
  const wal = parseWalInspection(JSON.stringify([
    { label: 'Heap/UPDATE', records: transactions, recordBytes: (primaryWal - 1) * transactions, fpiCount: 0, fpiBytes: 0, countedFpiBytes: null },
    { label: 'Transaction/COMMIT', records: transactions, recordBytes: transactions, fpiCount: 0, fpiBytes: 0, countedFpiBytes: null },
  ]), transactions);
  return { order, arm, transactions, latencyMs, walBytesPerSend, stats, wal, beforeLsn: '1/A', afterLsn: '1/B' };
}

const blocks = [
  block(1, 'current', 4, 110, 3, 100),
  block(2, 'final', 5, 130, 3.5, 115, 0.25),
  block(3, 'final', 10, 500, 9, 470, 5),
  block(4, 'current', 2, 80, 1.5, 60),
  block(5, 'current', 4, 110, 3, 100),
  block(6, 'final', 5, 130, 3.5, 115),
];

test('summary uses per-arm medians, matches churned query IDs by text, and ranks signed deltas', () => {
  const summary = summarizeAttribution(blocks, 6);
  assert.equal(summary.complete, true);
  assert.ok(summary.comparison);
  const { rankings, medians } = summary.comparison;
  assert.deepEqual(summary.comparison.timeMsPerSend, { current: 4, final: 5, delta: 1 });
  assert.deepEqual(summary.comparison.walBytesPerSend, { current: 110, final: 130, delta: 20 });
  assert.deepEqual(rankings.topLevelStatementTime.items, [
    { label: 'SELECT proto_send($1)', current: 3, final: 3.5, delta: 0.5, share: 0.5 },
  ]);
  assert.deepEqual(rankings.nestedStatementTime.items, [
    { label: 'UPDATE message_append_counts', current: 0, final: 0.25, delta: 0.25, share: 0.25 },
  ]);
  assert.equal(rankings.nestedStatementTime.unattributed, null);
  assert.equal(rankings.functionSelfTime.items[0].delta, 0.25);
  assert.equal(rankings.topLevelStatementTime.unattributed?.share, 0.5);
  assert.deepEqual(rankings.walByRecordType?.items.map(r => [r.label, r.delta, r.share]),
    [['Heap/UPDATE', 15, 0.75], ['Transaction/COMMIT', 0, 0]]);
  assert.equal(rankings.walByRecordType?.unattributed?.delta, 5);
  assert.equal(medians.walTypes?.find(w => w.label === 'Heap/UPDATE')?.final.records, 1);
  const report = attributionMarkdown(summary);
  assert.match(report, /DIAGNOSTIC \/ NOT EVALUATED/);
  assert.match(report, /Instrumentation lowers tps/);
  assert.match(report, /\| Unattributed \| 10\.000000 \| 15\.000000 \| 5\.000000 \| 25\.00% \|/);
});

test('rankings retain negative deltas and omit shares when the total delta is zero', () => {
  const current = block(1, 'current', 4, 110, 3, 100);
  const final = block(2, 'final', 4, 110, 3, 90);
  const ranking = summarizeAttribution([current, final], 2).comparison?.rankings.walByRecordType;
  assert.deepEqual(ranking?.items.map(r => [r.label, r.delta, r.share]),
    [['Transaction/COMMIT', 0, null], ['Heap/UPDATE', -10, null]]);
  assert.equal(ranking?.unattributed?.delta, 10);
});

test('F1 attribution compares the candidate blocks and labels the report', () => {
  const candidateBlocks = blocks.map((b): AttributionBlock => b.arm === 'final' ? { ...b, arm: 'final+f1' } : b);
  const original = summarizeAttribution(blocks, 6);
  const candidate = summarizeAttribution(candidateBlocks, 6, true, 'final+f1');
  assert.equal(candidate.finalArm, 'final+f1');
  assert.ok(!Object.hasOwn(original, 'finalArm'));
  assert.equal(candidate.complete, true);
  assert.deepEqual(candidate.comparison, original.comparison);
  assert.match(attributionMarkdown(candidate), /\| Current \| final\+f1 \| final\+f1 − current \|/);
  assert.match(attributionMarkdown(original), /\| Current \| Final \| Final − current \|/);
});

test('missing WAL remains visible while time and statement WAL comparisons are retained', () => {
  const incomplete: AttributionBlock = { ...blocks[0], wal: { complete: false, reason: 'segment missing' } };
  const summary = summarizeAttribution([incomplete, ...blocks.slice(1)], 6);
  assert.equal(summary.complete, false);
  assert.equal(summary.coverage[0].walIssue, 'segment missing');
  assert.equal(summary.comparison?.rankings.walByRecordType, null);
  assert.equal(summary.comparison?.rankings.topLevelStatementWal.items[0].delta, 15);
  const report = attributionMarkdown(summary);
  assert.match(report, /Block 1, current: WAL inspection: segment missing/);
  assert.match(report, /WAL record-type medians and remainder are unavailable/);
});

test('an interrupted run keeps its observed blocks even when the other arm never started', () => {
  const summary = summarizeAttribution(blocks.slice(0, 1), 6);
  assert.equal(summary.complete, false);
  assert.equal(summary.comparison, null);
  assert.match(attributionMarkdown(summary), /1\/6 measured blocks/);
});
