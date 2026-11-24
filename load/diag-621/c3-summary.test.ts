import assert from 'node:assert/strict';
import test from 'node:test';
import { schedule, scheduleReason, deadlineMs, prepareWindow } from './c3-plan.ts';
import { c3ExitCode, metrics, pairedInterval, reading, summarizeC3, type WindowResult } from './c3-summary.ts';
import { evictionReason, statementEvidence, statementReasons } from './c3-statements.ts';
import { bounded, remaining } from './c3-runtime.ts';
import type { Statement } from './validity.ts';

const message = 'INSERT INTO messages (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id';
const create = 'INSERT INTO channel_log (event_seq, kind, message_id, client_message_id) VALUES ($1,$2,$3,$4)';
const fused = `WITH m AS (${message}), l AS (${create.replace(/VALUES.*/, 'SELECT seq, $1, id, client_message_id FROM m')}) SELECT id FROM m`;
const search = 'INSERT INTO message_search_terms SELECT term FROM messages m CROSS JOIN LATERAL public.fukulow_search_terms(m.body) WHERE NOT m.deleted';
const stmt = (query: string, queryid: string, calls = 2000, toplevel = true): Statement =>
  ({ query, queryid, calls, toplevel, total_exec_time: 80, wal_records: 2, wal_bytes: '12', wal_fpi: 0 });
const other = stmt('COMMIT', '5'), indexing = stmt(search, '4'), probe = stmt('SELECT 1', '0');
const standalone = [stmt(message, '1'), stmt(create, '2'), indexing, other, probe];
const combined = [stmt(fused, '3'), indexing, other, probe];
const base = statementEvidence(standalone, 2000), c3 = statementEvidence(combined, 2000);

test('the exact 12 units are published and checked, not just the balance', () => {
  const shorthand = ['bsc', 'bcs', 'sbc', 'scb', 'cbs', 'csb', 'csb', 'cbs', 'scb', 'sbc', 'bcs', 'bsc'];
  const full = schedule(false);
  assert.equal(full.length, 72);
  assert.equal(schedule(true).length, 6);
  shorthand.forEach((permutation, index) => {
    const unit = full.slice(6 * index, 6 * index + 6);
    assert.equal(unit.map(row => row.arm[0]).join(''), permutation.repeat(2));
    assert.deepEqual(unit.map(row => row.shape[0]), (index % 2 ? 'hhhmmm' : 'mmmhhh').split(''));
  });
  assert.equal(scheduleReason(false, full), undefined);
  assert.match(scheduleReason(false, full.slice(6).concat(full.slice(0, 6)))!, /published schedule/);
  assert.match(scheduleReason(true, full)!, /published schedule/);
});

test('each scheduled arm restarts on its own freshly prepared clone; failed preparation cannot start the arm', async () => {
  const calls: string[] = [];
  const operations = { clone: (db: string) => { calls.push(`clone ${db}`); },
    disableMaintenance: (db: string) => { calls.push(`disable ${db}`); }, restart: async (arm: string, db: string) => { calls.push(`start ${arm} ${db}`); } };
  const [first, second, third] = schedule(true);
  assert.equal(await prepareWindow(first, operations), 'diag_1');
  assert.equal(await prepareWindow(second, operations), 'diag_2');
  assert.deepEqual(calls, ['clone diag_1', 'disable diag_1', 'start base diag_1', 'clone diag_2', 'disable diag_2', 'start split diag_2']);
  await assert.rejects(prepareWindow(third, { ...operations, disableMaintenance: () => { throw new Error('cannot prepare clone'); } }), /cannot prepare/);
  assert.equal(calls.at(-1), 'clone diag_3');
});

test('statement signatures reject wrong calls, changing query ID or text, missing families, evictions and total drift', () => {
  assert.deepEqual(base.core, { message: 1, create: 1, fused: 0, search: 1 });
  assert.deepEqual(c3.core, { message: 0, create: 0, fused: 1, search: 1 });
  assert.deepEqual(statementReasons('c3', c3, base), []);
  assert.deepEqual(statementReasons('split', base, base), []);
  assert.throws(() => statementEvidence([], 2000), /missing/);
  assert.throws(() => statementEvidence([other, other], 2000), /duplicate/);
  assert.match(statementReasons('c3', c3).join(), /base is missing or INVALID/);
  for (const [family, index] of [['message', 0], ['create', 1], ['search', 2]] as const) {
    assert.match(statementReasons('base', statementEvidence(standalone.filter((_, position) => index !== position), 2000)).join(), new RegExp(family));
  }
  assert.match(statementReasons('c3', base, base).join(), /fused statement/);
  const vary = (change: Partial<Statement>) => statementEvidence([combined[0], indexing, { ...other, ...change }], 2000);
  assert.deepEqual(statementReasons('c3', vary({ calls: 2100 }), base), []);
  assert.match(statementReasons('c3', vary({ calls: 2101 }), base).join(), /total SQL/);
  for (const change of [{ queryid: '6' }, { query: 'ROLLBACK' }]) assert.match(statementReasons('c3', vary(change), base).join(), /signature changed/);
  const shift = statementEvidence([...combined, stmt('SELECT something', '99', 80), stmt('SELECT extra', '100', 80)], 2000);
  assert.deepEqual(statementReasons('c3', shift, base), ['total SQL calls per send differ from expected delta against base']);
  assert.equal(evictionReason(7, 7), undefined);
  for (const [before, after] of [[7, 8], [7, 0], [NaN, 0], [-1, -1]]) assert.match(evictionReason(before, after)!, /eviction/);
});

function evidence(smoke = false): WindowResult[] {
  return schedule(smoke).map(window => ({ window, reasons: [], late: false, statements: window.arm === 'c3' ? c3 : base,
    metrics: Object.fromEntries(metrics.map(metric => [metric, 100 + window.position + (window.arm === 'c3' ? -40 : 0)])) as WindowResult['metrics'] }));
}

test('paired means use 12 deltas and the 11 df t critical value; medians never affect the reading', () => {
  const interval = pairedInterval([10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  assert.equal(interval.mean, 1);
  assert.equal(interval.median, 0);
  assert.equal(interval.df, 11);
  assert.ok(Math.abs(interval.upper - (1 + 2.200985160082949 * Math.sqrt(92 / 132))) < 1e-12);
  assert.throws(() => pairedInterval([1, 2]), /12/);
  assert.equal(reading([{ lower: -40, upper: -20 }, { lower: -40, upper: -20 }], 20), 'shown');
  assert.equal(reading([{ lower: -19, upper: 5 }, { lower: -18, upper: 5 }], 20), 'not shown');
  assert.equal(reading([{ lower: -20, upper: 5 }, { lower: -18, upper: 5 }], 20), 'inconclusive');
  assert.equal(reading([{ lower: -40, upper: -22 }, { lower: -18, upper: 5 }], 20), 'inconclusive');
  assert.throws(() => reading([{ lower: -40, upper: -25 }], 20), /both shapes/);
  const result = summarizeC3(false, evidence(), []);
  assert.ok('pairs' in result && result.pairs && result.primary && result.orderPosition);
  assert.equal(result.pairs.length, 48);
  assert.ok(result.pairs.every(pair => pair.deltas.length === 12));
  assert.deepEqual(result.orderPosition[0].residualsByPosition, [-1, 0, 1]);
  assert.deepEqual(result.primary, { dbCpuUsec: { meaningful: 20, reading: 'shown' }, latencyP50Usec: { meaningful: 30, reading: 'shown' } });
  assert.doesNotMatch(JSON.stringify(result), /\b(?:PASS|FAIL)\b/);
});

test('smoke selects a single warm-up without a reading; full runs reject late, missing or invalid base windows', () => {
  const smoke = evidence(true);
  const short = summarizeC3(true, smoke, []);
  assert.ok('warmSeconds' in short);
  assert.equal(short.warmSeconds, 3);
  smoke[0].late = true;
  const selected = summarizeC3(true, smoke, []);
  assert.ok('warmSeconds' in selected);
  assert.equal(selected.warmSeconds, 10);
  assert.ok(!('primary' in selected));
  const full = evidence();
  full[0].late = true;
  const invalid = summarizeC3(false, full, []);
  assert.equal(c3ExitCode(invalid), 1);
  assert.match(invalid.windows[0].reasons.join(), /late app backend/);
  assert.match(invalid.windows[1].reasons.join(), /base is missing or INVALID/);
  assert.ok(!('primary' in invalid));
  const missing = summarizeC3(false, full.slice(1), ['deadline expired']);
  assert.equal(c3ExitCode(missing), 1);
  assert.match(missing.reasons.join(), /deadline expired.*published schedule/);
  assert.match(missing.windows[0].reasons.join(), /base is missing or INVALID/);
  assert.equal(c3ExitCode(summarizeC3(false, evidence(), [])), 0);
});

test('window defects and fatal setup reasons propagate to INVALID without replacement windows', () => {
  for (const reason of ['eviction', 'terms', 'maintenance', 'tmpfs', 'samples', 'drain', 'checkpoint']) {
    const full = evidence(); full[2].reasons.push(reason);
    const result = summarizeC3(false, full, []);
    assert.equal(c3ExitCode(result), 1);
    assert.equal(result.windows.length, 72);
    assert.ok(result.windows[2].reasons.includes(reason));
    assert.ok(!('primary' in result));
  }
  assert.equal(c3ExitCode(summarizeC3(true, [], ['image ID mismatch'])), 1);
  assert.equal(deadlineMs, 3_600_000);
  assert.equal(remaining(1000, 999), 1);
  assert.throws(() => remaining(1000, 1000), /hard stop/);
});

test('bounded stages reject on timeout or interruption without waiting for stuck work', async () => {
  const signal = new AbortController();
  const stuck = new Promise<never>(() => {});
  assert.equal(await bounded(Promise.resolve(1), 1000, signal.signal, 'timed out'), 1);
  await assert.rejects(bounded(stuck, 1, signal.signal, 'timed out'), /timed out/);
  const stage = bounded(stuck, 1000, signal.signal, 'timed out');
  signal.abort(new Error('interrupted'));
  await assert.rejects(stage, /interrupted/);
});
