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

test('A3 migration timeout fails like the check', async () => {
  const { migrationOutcome } = await import('./probe.ts');
  assert.equal(migrationOutcome(0, '').status, 'ok');
  assert.equal(migrationOutcome(3, 'ERROR:  canceling statement due to statement timeout\n').status, 'timeout');
  assert.equal(migrationOutcome(3, 'ERROR:  relation does not exist\n').status, 'error');
  assert.equal(migrationOutcome(null, '').status, 'error');
});

// Server-log lines as the postgres image writes them (log_line_prefix '%m [%p] ', UTC).
const at = (s: string) => Date.parse(`2026-11-23T10:${s}Z`);
const start = (s: string, flags: string) => `2026-11-23 10:${s} UTC [77] LOG:  checkpoint starting: ${flags}`;
const openReq = at('00:00.000');
const blockEnd = at('03:00.000');
const closeReq = at('03:00.050');
const opening = start('00:00.010', 'fast force wait');
const closing = start('03:00.060', 'fast force wait');

test('checkpoint start lines carry server timestamps; an unreadable stamp is undeterminable', async () => {
  const { checkpointStartLines } = await import('./probe.ts');
  const lines = checkpointStartLines([opening, '2026-11-23 10:00:01.000 UTC [77] LOG:  checkpoint complete: wrote 3 buffers',
    start('01:00.000', 'wal'), start('02:00.000', 'time'), start('02:30.000', 'fast force wait wal'), 'LOG:  statement: SELECT 1'].join('\n'));
  assert.deepEqual(lines.map(l => [l.atMs, l.forced, l.automatic]), [[at('00:00.010'), true, false], [at('01:00.000'), false, true],
    [at('02:00.000'), false, true], [at('02:30.000'), true, false]]);
  assert.deepEqual(checkpointStartLines(''), []);
  assert.throws(() => checkpointStartLines('LOG:  checkpoint starting: wal'), /undeterminable/);
  assert.throws(() => checkpointStartLines('2026-11-23 10:00:00.000 JST [1] LOG:  checkpoint starting: wal'), /undeterminable/);
});

test('only starts inside the measured block cross it; a start after the block is not flagged', async () => {
  const { checkpointStartLines, checkpointWindow } = await import('./probe.ts');
  const judge = (...lines: string[]) => checkpointWindow(checkpointStartLines(lines.join('\n')), openReq, closeReq, blockEnd);
  // An automatic start before the opening request (an earlier block) is outside the window.
  const clean = judge(start('59:00.000', 'wal').replace('10:59', '09:59'), opening, closing);
  assert.deepEqual([clean?.inBlock.length, clean?.afterBlock.length, clean?.openAtMs, clean?.closeAtMs], [0, 0, at('00:00.010'), at('03:00.060')]);
  // Inside: during warm-up, during the measured block, and in the block's last millisecond.
  for (const s of ['00:30.000', '02:00.000', '03:00.000']) assert.equal(judge(opening, start(s, 'wal'), closing)?.inBlock.length, 1, s);
  assert.equal(judge(opening, start('01:00.000', 'time'), closing)?.inBlock.length, 1);
  // After the block but before the closing request: kept, not flagged.
  const after = judge(opening, start('03:00.020', 'wal'), closing);
  assert.deepEqual([after?.inBlock.length, after?.afterBlock.length], [0, 1]);
  // A WAL request merged into the closing request starts as the closing checkpoint, after the block.
  assert.equal(judge(opening, start('03:00.060', 'fast force wait wal'))?.inBlock.length, 0);
});

test('the closing forced start must be logged at or after its request', async () => {
  const { checkpointStartLines, checkpointWindow } = await import('./probe.ts');
  const judge = (...lines: string[]) => checkpointWindow(checkpointStartLines(lines.join('\n')), openReq, closeReq, blockEnd);
  // The opening start alone, or a forced start stamped before the closing request, is not the closing one.
  assert.equal(judge(opening), null);
  assert.equal(judge(opening, start('02:00.000', 'fast force wait')), null);
  // An in-block forced start from elsewhere is a crossing, and the closing start is the later one.
  const w = judge(opening, start('02:00.000', 'fast force wait'), closing);
  assert.deepEqual([w?.inBlock.length, w?.closeAtMs], [1, at('03:00.060')]);
  // Same millisecond as the request counts (%m truncates); no opening start means no decision.
  assert.equal(judge(opening, start('03:00.050', 'fast force wait'))?.closeAtMs, at('03:00.050'));
  assert.equal(judge(start('59:00.000', 'fast force wait').replace('10:59', '09:59'), closing), null);
  assert.throws(() => checkpointWindow([], NaN, closeReq, blockEnd), /undeterminable/);
});

test('log lag: polling waits for the closing start; a timeout or read failure is never clean', async () => {
  const { waitForCheckpointWindow } = await import('./probe.ts');
  // The capture lags: the in-block start and the closing start appear only on the third read.
  const reads = [[opening], [opening], [opening, start('02:00.000', 'wal'), closing]];
  let slept = 0;
  const w = waitForCheckpointWindow(() => (reads.shift() ?? []).join('\n'), openReq, closeReq, blockEnd, 10, () => { slept++; });
  assert.deepEqual([w.inBlock.length, slept], [1, 2]);
  assert.throws(() => waitForCheckpointWindow(() => opening, openReq, closeReq, blockEnd, 3, () => {}), /not logged after 3 polls/);
  assert.throws(() => waitForCheckpointWindow(() => { throw new Error('server log read failed'); }, openReq, closeReq, blockEnd, 3, () => {}), /read failed/);
});

test('a block is kept before its closing CHECKPOINT or docker events failure is raised', async () => {
  const { runBlock, eventsSince } = await import('./probe.ts');
  const clean = { openAtMs: 1, closeAtMs: 3, blockEndMs: 2, inBlock: [], afterBlock: [] };
  const block = (overrides: Partial<Parameters<typeof runBlock>[0]>) => {
    const kept: Record<string, unknown>[] = [];
    let error: unknown = null;
    try {
      runBlock({ label: 'block 6', measure: () => ({ crossed: false, errors: [], tps: 1234 }), closeCheckpoint: () => clean,
        hostAfter: () => ({ busy: false }), keep: row => { kept.push(row); }, ...overrides });
    } catch (e) { error = e; }
    return { kept, error };
  };
  const ok = block({});
  assert.deepEqual([ok.kept.length, ok.error], [1, null]);
  const timeout = block({ closeCheckpoint: () => { throw new Error('closing CHECKPOINT start not logged after 120 polls (undeterminable)'); } });
  assert.equal(timeout.kept.length, 1);
  assert.equal(timeout.kept[0].tps, 1234);
  assert.match(String((timeout.kept[0].errors as string[])[0]), /closing CHECKPOINT: .*not logged/);
  assert.match(String(timeout.error), /block 6: closing CHECKPOINT/);
  const events = block({ hostAfter: () => { throw new Error('docker events --since failed: daemon error'); } });
  assert.deepEqual([events.kept.length, events.kept[0].tps, events.kept[0].hostAfter], [1, 1234, null]);
  assert.match(String((events.kept[0].errors as string[])[0]), /host probe .*docker events/);
  assert.match(String(events.error), /block 6: host probe/);
  // Both failures land on the same row; a crossing or a busy host also fails after the row is kept.
  const both = block({ closeCheckpoint: () => { throw new Error('x'); }, hostAfter: () => { throw new Error('y'); } });
  assert.equal((both.kept[0].errors as string[]).length, 2);
  const crossed = block({ closeCheckpoint: () => ({ ...clean, inBlock: [{ atMs: 2, forced: false, automatic: true, line: 'wal' }] }) });
  assert.deepEqual([crossed.kept.length, crossed.kept[0].crossed], [1, true]);
  assert.match(String(crossed.error), /checkpoint inside a send block/);
  const busy = block({ hostAfter: () => ({ busy: true }) });
  assert.deepEqual([busy.kept.length, /host not idle/.test(String(busy.error))], [1, true]);
  // A pgbench failure has no row to keep.
  assert.equal(block({ measure: () => { throw new Error('pgbench failed'); } }).kept.length, 0);
  // The events window opens at least 1 s before the pre-block docker ps.
  assert.equal(eventsSince(10_999), 9);
  assert.equal(eventsSince(11_000), 10);
  assert.ok(eventsSince(11_500) * 1000 <= 11_500 - 1000);
});
