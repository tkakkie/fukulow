import test from 'node:test';
import assert from 'node:assert/strict';
import { attribute, clockOffset, mergeWaits, parseLockLog, parseSamplerLine, peakSimultaneous, samplerIntegrity, samplerIntervals,
  samplerQuery, xWaits, type SamplerRow, type Wait } from './signin-owner-burst-locks.ts';

const at = (ms: number) => { const d = new Date(Date.UTC(2026, 10, 22, 10, 0, 0) + ms).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 23)} UTC`; };
const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);
const LOG = [
  'PostgreSQL init process complete; ready for start up.',
  `${at(100)} [201] LOG:  process 201 still waiting for ShareLock on transaction 900 after 10.051 ms`,
  `${at(100)} [201] DETAIL:  Process holding the lock: 200. Wait queue: 201.`,
  `${at(100)} [201] CONTEXT:  while locking tuple (0,1) in relation "accounts"`,
  `${at(100)} [201] STATEMENT:  SELECT id, password_hash FROM accounts WHERE email = $1 FOR UPDATE`,
  `${at(105)} [202] LOG:  process 202 still waiting for AccessExclusiveLock on tuple (0,1) of relation 16400 of database 16384 after 10.010 ms`,
  `${at(105)} [202] STATEMENT:  SELECT password_hash FROM accounts WHERE id = $1 FOR UPDATE`,
  `${at(150)} [201] LOG:  process 201 acquired ShareLock on transaction 900 after 60.000 ms`,
  `${at(150)} [201] CONTEXT:  while locking tuple (0,1) in relation "accounts"`,
  `${at(150)} [202] LOG:  process 202 acquired AccessExclusiveLock on tuple (0,1) of relation 16400 of database 16384 after 55.000 ms`,
  `${at(200)} [202] LOG:  process 202 acquired ShareLock on transaction 901 after 49.500 ms`,
  `${at(200)} [202] CONTEXT:  while locking tuple (0,1) in relation "accounts"`,
  `${at(200)} [202] STATEMENT:  SELECT password_hash FROM accounts WHERE id = $1 FOR UPDATE`,
  // Not X's row: another relation, and an accounts tuple outside X's versions.
  `${at(300)} [203] LOG:  process 203 acquired ShareLock on transaction 902 after 20.000 ms`,
  `${at(300)} [203] CONTEXT:  while locking tuple (3,4) in relation "channels"`,
].join('\n');
const X = { accountsOid: 16400, databaseOid: 16384, ctids: new Set(['(0,1)']) };

test('lock log: both waiter forms on X\'s row become one merged interval per pid', () => {
  const parsed = parseLockLog(LOG);
  assert.equal(parsed.unparsed, 0);
  assert.equal(parsed.events.length, 6);
  const x = xWaits(parsed.events, X);
  assert.deepEqual([x.waits.length, x.unmatched, x.foreign, x.other], [3, 0, 0, 1]);
  const merged = mergeWaits(x.waits);
  assert.deepEqual(merged.map(m => [m.pid, m.startDbMs - T0, m.endDbMs - T0, m.parts]),
    [[201, 90, 150, ['transaction']], [202, 95, 200, ['tuple', 'transaction']]]);
  assert.equal(merged[1].waitedMs, 105);
  assert.deepEqual(peakSimultaneous(merged).peak, 2);
  // Statement fallback attributes each wait when no sampler row falls inside it.
  assert.deepEqual(merged.map(m => attribute(m, []).who), ['signin', 'owner']);
});

test('lock log: unknown tuples, unmatched waits and unparseable wait lines are reported, never dropped', () => {
  const x = xWaits(parseLockLog(LOG).events, { ...X, ctids: new Set(['(0,2)']) });
  assert.deepEqual([x.waits.length, x.foreign], [0, 3]);
  const open = parseLockLog(`${at(10)} [301] LOG:  process 301 still waiting for ShareLock on transaction 5 after 10.0 ms\n`
    + `${at(10)} [301] CONTEXT:  while locking tuple (0,1) in relation "accounts"`);
  assert.equal(xWaits(open.events, X).unmatched, 1);
  assert.equal(parseLockLog(`${at(10)} [301] LOG:  process 301 acquired ShareLock on transaction 5 after soon`).unparsed, 1);
  assert.equal(parseLockLog(`2026-11-22 10:00:00.010 JST [301] LOG:  process 301 acquired ShareLock on transaction 5 after 1.0 ms`).unparsed, 1);
  // Touching intervals are not simultaneous; a merged pid counts once.
  const touching = mergeWaits([{ pid: 1, lock: 'transaction', tuple: '(0,1)', startDbMs: 0, endDbMs: 10, waitedMs: 10, outcome: 'acquired' },
    { pid: 2, lock: 'tuple', tuple: '(0,1)', startDbMs: 10, endDbMs: 20, waitedMs: 10, outcome: 'acquired' }]);
  assert.equal(peakSimultaneous(touching).peak, 1);
});

test('sampler rows: database-clock intervals, clock offset and pid attribution', () => {
  const parsed = ['1000.000|4||0|(0,1)', '1020.500|5|201s,202o|12|(0,1)', '1041.000|5|202o|30|(0,2)', 'garbage', '']
    .map((line, i) => parseSamplerLine(line, 5 + i * 30));
  assert.deepEqual(parsed.slice(3), ['malformed', null]);
  const rows = parsed.filter((r): r is SamplerRow => r !== null && r !== 'malformed');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].waiting, [{ pid: 201, kind: 'signin' }, { pid: 202, kind: 'owner' }]);
  assert.deepEqual(samplerIntervals(rows), { count: 3, medianMs: 20.5, maxMs: 20.5 });
  assert.equal(clockOffset(rows), -995);
  const wait = { pid: 202, startDbMs: 1010, endDbMs: 1030, waitedMs: 20, parts: ['tuple' as const], tuples: ['(0,1)'], outcome: 'acquired' as const };
  assert.deepEqual(attribute(wait, rows), { who: 'owner', source: 'sampler' });
  // Half-open: a sample at the exclusive end (the pid's next operation) is not used.
  const next = [{ ...rows[0], dbMs: 1030, waiting: [{ pid: 202, kind: 'signin' as const }] }];
  assert.deepEqual(attribute({ ...wait, statementKind: 'owner' }, next), { who: 'owner', source: 'statement' });
  // Disagreeing evidence is unknown, never a guess.
  assert.deepEqual(attribute({ ...wait, statementKind: 'signin' }, rows), { who: 'unknown', source: 'conflict' });
  const mixed = [rows[1], { ...rows[2], dbMs: 1025, waiting: [{ pid: 202, kind: 'signin' as const }] }];
  assert.equal(attribute(wait, mixed).who, 'unknown');
});

test('lock log: every PostgreSQL tuple CONTEXT form on accounts is parsed; anything else about accounts is unparsed', () => {
  const ctx = (pid: number, ms: number, context: string) => [
    `${at(ms)} [${pid}] LOG:  process ${pid} acquired ShareLock on transaction 9${pid} after 20.000 ms`,
    `${at(ms)} [${pid}] CONTEXT:  ${context}`].join('\n');
  const forms = ['while locking updated version (0,2) of tuple in relation "accounts"', 'while updating tuple (0,2) in relation "accounts"',
    'while deleting tuple (0,2) in relation "accounts"', 'while rechecking updated tuple (0,2) in relation "accounts"'];
  const parsed = parseLockLog(forms.map((f, i) => ctx(400 + i, 100 + i * 50, f)).join('\n'));
  assert.equal(parsed.unparsed, 0);
  const x = xWaits(parsed.events, { ...X, ctids: new Set(['(0,1)', '(0,2)']) });
  assert.deepEqual([x.waits.length, x.unparsed, x.other, x.foreign], [4, 0, 0, 0]);
  // An updated version that is not one of X's known tuples is foreign (incomplete), never other.
  assert.equal(xWaits(parsed.events, X).foreign, 4);
  // An accounts CONTEXT in an unknown form.
  const odd = parseLockLog(ctx(410, 100, 'while frobbing row 7 of relation "accounts"'));
  assert.equal(odd.unparsed, 1);
  assert.deepEqual([xWaits(odd.events, X).unparsed, xWaits(odd.events, X).other], [1, 0]);
  // A still-waiting line whose CONTEXT and completion are both missing.
  const lost = parseLockLog([`${at(10)} [411] LOG:  process 411 still waiting for ShareLock on transaction 5 after 10.020 ms`,
    `${at(10)} [411] STATEMENT:  SELECT id, password_hash FROM accounts WHERE email = $1 FOR UPDATE`].join('\n'));
  assert.deepEqual([xWaits(lost.events, X).unparsed, xWaits(lost.events, X).unmatched, xWaits(lost.events, X).other], [1, 0, 0]);
  // A completed transaction wait without any CONTEXT cannot be placed either.
  const bare = parseLockLog(`${at(10)} [412] LOG:  process 412 acquired ShareLock on transaction 5 after 30.000 ms`);
  assert.equal(xWaits(bare.events, X).unparsed, 1);
  // Malformed tuple or transaction targets, and a zero wait, are unparsed lines.
  for (const target of ['tuple (0,1) of relation 16400', 'tuple (0,x) of relation 16400 of database 16384', 'transaction abc'])
    assert.equal(parseLockLog(`${at(10)} [413] LOG:  process 413 acquired AccessExclusiveLock on ${target} after 20.000 ms`).unparsed, 1, target);
  assert.equal(parseLockLog(`${at(10)} [414] LOG:  process 414 acquired AccessExclusiveLock on tuple (0,1) of relation 16400 of database 16384 after 0.000 ms`).unparsed, 1);
  // Raw STATEMENT text is never kept, only its kind.
  assert.equal(JSON.stringify(parseLockLog(LOG).events).includes('FOR UPDATE'), false);
});

test('lock intervals: merge only one lock attempt; half-open and empty intervals never overlap', () => {
  const w = (o: Partial<Wait>): Wait => ({ pid: 1, lock: 'tuple', tuple: '(0,1)', startDbMs: 0, endDbMs: 50, waitedMs: 50, outcome: 'acquired',
    statementKind: 'signin', ...o });
  const tx = (startDbMs: number, o: Partial<Wait> = {}) => w({ lock: 'transaction', startDbMs, endDbMs: startDbMs + 40, waitedMs: 40, ...o });
  assert.equal(mergeWaits([w({}), tx(52)]).length, 1);
  assert.equal(mergeWaits([w({}), tx(48)]).length, 1);
  assert.equal(mergeWaits([w({}), tx(53)]).length, 2);
  // PID reuse: a failed tuple wait, then a new transaction wait on another tuple 2 ms later.
  const reused = mergeWaits([w({ outcome: 'failed' }), tx(52, { tuple: '(0,2)' })]);
  assert.deepEqual(reused.map(r => [r.parts, r.outcome]), [[['tuple'], 'failed'], [['transaction'], 'acquired']]);
  assert.equal(mergeWaits([w({ outcome: 'failed' }), tx(52)]).length, 2);
  assert.equal(mergeWaits([w({}), tx(52, { tuple: '(0,2)' })]).length, 2);
  assert.equal(mergeWaits([w({}), tx(52, { statementKind: 'owner' })]).length, 2);
  // transaction -> tuple is never one attempt.
  assert.equal(mergeWaits([w({ lock: 'transaction' }), w({ startDbMs: 51, endDbMs: 90 })]).length, 2);
  // Empty intervals are dropped and never counted as active.
  assert.equal(mergeWaits([w({ startDbMs: 10, endDbMs: 10, waitedMs: 0 })]).length, 0);
  assert.equal(peakSimultaneous([{ pid: 1, startDbMs: 10, endDbMs: 10 }, { pid: 2, startDbMs: 5, endDbMs: 15 }]).peak, 1);
  assert.equal(peakSimultaneous([{ pid: 1, startDbMs: 10, endDbMs: 10 }]).peak, 0);
});

test('sampler: integrity counts malformed rows and repeated or backward database timestamps; query checks pg_locks', () => {
  const row = (dbMs: number): SamplerRow => ({ dbMs, nodeMs: 0, connections: 1, waiting: [], maxWaitMs: 0, ctid: null });
  assert.equal(samplerIntegrity([row(0), row(20), row(40)], 0).ok, true);
  assert.deepEqual(samplerIntegrity([row(0), row(20), row(20), row(10)], 1), { malformed: 1, duplicate: 1, backward: 1, ok: false });
  const q = samplerQuery('owner@example.invalid');
  assert.match(q, /FROM pg_locks l WHERE l\.pid = a\.pid AND NOT l\.granted/);
  assert.match(q, /wait_event IN \('tuple', 'transactionid'\)/);
  assert.match(q, /l\.locktype = 'tuple' AND l\.relation = 'accounts'::regclass/);
});

test('round 2: a wait whose start and completion name different places is unparsed; a missing statement kind never merges', () => {
  const log = [`${at(10)} [501] LOG:  process 501 still waiting for ShareLock on transaction 7 after 10.010 ms`,
    `${at(10)} [501] CONTEXT:  while locking tuple (0,1) in relation "accounts"`,
    `${at(40)} [501] LOG:  process 501 acquired ShareLock on transaction 7 after 40.000 ms`,
    `${at(40)} [501] CONTEXT:  while locking tuple (0,1) in relation "account_sessions"`].join('\n');
  const x = xWaits(parseLockLog(log).events, X);
  assert.deepEqual([x.unparsed, x.unmatched, x.other, x.waits.length], [1, 0, 0, 0]);
  const tuple: Wait = { pid: 1, lock: 'tuple', tuple: '(0,1)', startDbMs: 0, endDbMs: 100, waitedMs: 100, outcome: 'acquired' };
  const tx: Wait = { ...tuple, lock: 'transaction', startDbMs: 102, endDbMs: 150, waitedMs: 48, statementKind: 'signin' };
  assert.equal(mergeWaits([tuple, tx]).length, 2);
  assert.equal(mergeWaits([{ ...tuple, statementKind: 'signin' }, { ...tx, statementKind: undefined }]).length, 2);
  assert.equal(mergeWaits([{ ...tuple, statementKind: 'signin' }, tx]).length, 1);
});
