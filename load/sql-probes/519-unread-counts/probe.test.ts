import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindLiterals, extractListCounts, pgbench, quantile, timings } from './probe.ts';

test('extracts LIST_COUNTS_SQL exactly once and refuses other shapes', () => {
  const source = 'x\npub(super) const LIST_COUNTS_SQL: &str = r#"\nSELECT $1\n"#;\nrest';
  assert.equal(extractListCounts(source), 'SELECT $1');
  assert.throws(() => extractListCounts('no constant'));
  assert.throws(() => extractListCounts(source + source));
});

test('binds only $1..$4 and rejects any other parameter', () => {
  const bound = bindLiterals('a=$1 b=$2 c=$3 d=ANY($4)', '{x}');
  assert.equal(bound.includes('$'), false);
  assert.match(bound, /ANY\('\{x\}'::uuid\[\]\)/);
  assert.throws(() => bindLiterals('$5', '{}'));
  assert.throws(() => bindLiterals('$10', '{}'));
});

test('parses psql timings, nearest-rank quantiles and pgbench output', () => {
  assert.deepEqual(timings('Time: 1.5 ms\nnoise\nTime: 2.25 ms\n'), [1.5, 2.25]);
  assert.equal(quantile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(quantile([5, 1, 4, 2, 3], 0.95), 5);
  assert.throws(() => quantile([], 0.5));
  const out = 'number of transactions actually processed: 1200\nlatency average = 0.412 ms\ntps = 19431.2 (without initial connection time)\n';
  assert.deepEqual(pgbench(out), { transactions: 1200, tps: 19431.2, latencyMs: 0.412 });
  assert.throws(() => pgbench('nothing'));
});

test('parses pgbench per-transaction logs and applies the step 1 stop rule', async () => {
  const { logLatenciesMs, stopRule } = await import('./probe.ts');
  assert.deepEqual(logLatenciesMs('0 1 1500 0 1700000000 12\n3 9 250 0 1700000001 5\n'), [1.5, 0.25]);
  assert.throws(() => logLatenciesMs('0 1 x 0 1 2\n'));
  assert.throws(() => logLatenciesMs('0 1 5\n'));
  const cur = [1, 2, 3].map(pair => ({ pair, walBytesPerSend: 1000, tps: 100 }));
  assert.equal(stopRule(cur, cur.map(c => ({ ...c, walBytesPerSend: 1200 }))).stop, false);
  assert.equal(stopRule(cur, cur.map(c => ({ ...c, walBytesPerSend: 1201 }))).stop, true);
  assert.equal(stopRule(cur, cur.map(c => ({ ...c, tps: 90 }))).stop, false);
  assert.equal(stopRule(cur, cur.map(c => ({ ...c, tps: 89.9 }))).stop, true);
  // One outlier pair does not decide alone; the median does.
  assert.equal(stopRule(cur, [{ pair: 1, walBytesPerSend: 5000, tps: 10 }, cur[1], cur[2]]).stop, false);
  assert.throws(() => stopRule(cur, cur.slice(1)));
});

test('message_counts_check: only exactly 0 rows passes; a timeout fails', async () => {
  const { countsCheckOutcome } = await import('./probe.ts');
  assert.deepEqual(countsCheckOutcome(0, '0\n', ''), { status: 'ok', rows: 0, detail: null });
  assert.equal(countsCheckOutcome(0, '3\n', '').status, 'drift');
  assert.equal(countsCheckOutcome(0, '', '').status, 'error');
  assert.equal(countsCheckOutcome(0, 'SET\n0\n', '').status, 'error');
  const timeout = countsCheckOutcome(3, '', 'ERROR:  canceling statement due to statement timeout\n');
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.rows, null);
  assert.equal(countsCheckOutcome(1, '', 'ERROR:  function message_counts_check(unknown) does not exist').status, 'error');
  assert.equal(countsCheckOutcome(null, '', '').status, 'error');
});

test('send blocks keep the fixed order and one fresh database per block', async () => {
  const { sendBlocks } = await import('./probe.ts');
  const blocks = sendBlocks([['current', 'final'], ['final', 'current'], ['current', 'final']]);
  assert.deepEqual(blocks.map(b => `${b.order}:${b.pair}:${b.arm}`), ['1:1:current', '2:1:final', '3:2:final', '4:2:current', '5:3:current', '6:3:final']);
  assert.equal(new Set(blocks.map(b => b.db)).size, 6);
  assert.throws(() => sendBlocks([['current', 'current']]));
  assert.throws(() => sendBlocks([['current']]));
});
