import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_DB_FLAGS, LOCK_LOG_SETTINGS, PLANS, burstAdmission, disposableOverride, ownerDecision, parseBurstArgs, parseBurstEnv,
  resolveServer } from './signin-owner-burst-config.ts';
import { attribute, clockOffset, mergeWaits, parseLockLog, parseSamplerLine, peakSimultaneous, samplerIntegrity, samplerIntervals,
  samplerQuery, xWaits, type SamplerRow, type Wait } from './signin-owner-burst-locks.ts';
import { a0, aggregate, judgeBurst, workloadGaps, type BurstOwnerOp, type BurstRun, type OwnerKind } from './signin-owner-burst-judgment.ts';
import { runWorkload, type Answer, type WorkloadIo } from './signin-owner-burst-workload.ts';
import { readRuns } from './signin-owner-burst-aggregate.ts';
import { report } from './signin-owner-burst-report.ts';

const root = new URL('../', import.meta.url).pathname;
const SHA = 'a'.repeat(40);

test('options: exactly one mode, an absolute --out, and a pinned commit only for --recorded', () => {
  assert.equal(parseBurstArgs(['--smoke', '--out', '/tmp/x']).mode, 'smoke');
  const rehearsal = parseBurstArgs(['--rehearsal', '--out', '/tmp/x']);
  assert.deepEqual([rehearsal.mode, rehearsal.harnessCommit, rehearsal.plan], ['rehearsal', null, PLANS.rehearsal]);
  const recorded = parseBurstArgs(['--recorded', '--harness-commit', SHA, '--out', '/tmp/x']);
  assert.deepEqual([recorded.harnessCommit, recorded.plan.bursts, recorded.plan.b0Ms], [SHA, 3, 60_000]);
  for (const bad of [[], ['--out', '/tmp/x'], ['--smoke', '--rehearsal', '--out', '/tmp/x'], ['--smoke'], ['--smoke', '--out', 'rel'],
    ['--recorded', '--out', '/tmp/x'], ['--recorded', '--harness-commit', 'abc', '--out', '/tmp/x'],
    ['--smoke', '--harness-commit', SHA, '--out', '/tmp/x'], ['--smoke', '--out', '/tmp/x', 'extra'], ['--smoke', '--burst', '--out', '/tmp/x']])
    assert.throws(() => parseBurstArgs(bad), Error, bad.join(' '));
  assert.deepEqual(parseBurstEnv({}), { port: 18098, serverRef: null, appImage: null });
  for (const env of [{ LOAD_PORT: '8080' }, { LOAD_PORT: '80' }, { LOAD_PORT: 'x' }, { SERVER_REF: 'main', LOAD_APP_IMAGE: 'i' }])
    assert.throws(() => parseBurstEnv(env));
});

test('pre-registered plan: recorded is the only full plan; short cells keep the B0 fail-fast sample count', () => {
  assert.deepEqual(PLANS.recorded, { b0Ms: 60_000, bursts: 3, b1TailMs: 61_000, b2Ms: 70_000, headroom: true, failFast: true });
  // Rehearsal B0 holds 8 authenticated operations (4 per kind) so the post-B0 checks run as recorded.
  assert.equal(Math.floor((PLANS.rehearsal.b0Ms - 2_500) / 5_000) + 1, 8);
  assert.equal(PLANS.rehearsal.headroom, true);
});

test('lock-wait settings live only in the disposable override, which keeps pg_stat_statements', () => {
  const command = disposableOverride().services.db.command;
  for (const flag of [...BASE_DB_FLAGS, ...LOCK_LOG_SETTINGS]) assert.ok(command.includes(flag), flag);
  assert.ok(command.includes('deadlock_timeout=10ms') && command.includes('log_lock_waits=on'));
  const base = readFileSync(join(root, 'load/compose.yml'), 'utf8');
  assert.ok(base.includes(`command: ["postgres", ${BASE_DB_FLAGS.map(f => `"-c", "${f}"`).join(', ')}]`), 'base flags drifted');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
  const production = [join(root, 'compose.yml'), join(root, 'load/compose.yml'), join(root, 'Dockerfile'), ...files(join(root, 'deploy')),
    ...files(join(root, 'server/src'))];
  for (const path of production) assert.doesNotMatch(readFileSync(path, 'utf8'), /deadlock_timeout|log_lock_waits/, path);
});

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

// A run that meets every pre-registered criterion. V = 50 ms; B0 p95 per authenticated kind 80 ms;
// C2 bound 80 + 5 * 50 = 330 ms. Database clock = harness clock + 1e6 ms.
const OFFSET = -1_000_000, SENDS = [60_000, 120_200, 180_400];
function run(): BurstRun {
  const owner: BurstOwnerOp[] = [];
  const op = (kind: OwnerKind, sentMs: number, status: number, ms: number, burst?: number) =>
    owner.push({ kind, sentMs, endMs: sentMs + ms, ms, status, ...(burst ? { burst, burstSend: 0 } : { dueMs: sentMs }) });
  for (let t = 1_000, i = 0; t < 311_700; t += 2_000, i++) op(i % 2 ? 'native_signin' : 'web_signin', t, t >= 60_000 && t < 241_700 ? 429 : 200, t >= 60_000 && t < 241_700 ? 2 : 50);
  for (let t = 2_500, i = 0; t < 311_700; t += 5_000, i++) op(i % 2 ? 'revoke' : 'password', t, 204, t >= 60_000 && t < 241_700 ? 200 : 80);
  SENDS.forEach((s, i) => op(i % 2 ? 'revoke' : 'password', s + 10, 204, 300, i + 1));
  const attack: BurstRun['attack'] = SENDS.flatMap((s, i) => Array.from({ length: 16 }, (_, k) => ({ burst: i + 1, send: 0, sentMs: s, status: k < 5 ? 401 : 429,
    ms: k < 5 ? 300 : 2, endMs: s + (k < 5 ? 300 : 2) })));
  const reads = Array.from({ length: 624 }, (_, i) => ({ sentMs: i * 500, status: 200, ms: 5, dueMs: i * 500 }));
  const samples: SamplerRow[] = [];
  for (let t = 0; t < 311_700; t += 20) {
    const inBurst = SENDS.some(s => t >= s + 40 && t < s + 200);
    samples.push({ dbMs: t - OFFSET, nodeMs: t, connections: inBurst ? 7 : 4, maxWaitMs: 0, ctid: '(0,1)',
      waiting: inBurst ? [{ pid: 101, kind: 'signin' }, { pid: 102, kind: 'signin' }] : [] });
  }
  const waits = SENDS.flatMap(s => [[101, 50, 110], [102, 55, 150], [103, 60, 200]].map(([pid, a, b]) => ({ pid,
    startDbMs: s + a - OFFSET, endDbMs: s + b - OFFSET, waitedMs: b - a, parts: ['transaction' as const], tuples: ['(0,1)'],
    outcome: 'acquired' as const, startMs: s + a, endMs: s + b, who: pid === 103 ? 'owner' as const : 'signin' as const })));
  return { owner, attack, reads, samples, samplerMalformed: 0, skipped: { reads: 0, web_signin: 0, native_signin: 0, password: 0, revoke: 0 },
    offsetMs: OFFSET, waits, lockLog: { complete: true, reasons: [] },
    bursts: SENDS.map((s, i) => ({ index: i + 1, sends: [{ sentMs: s, statuses: attack.filter(a => a.burst === i + 1).map(a => a.status) }],
      admittedSend: 0, ownerOp: 'sent' as const, ownerOpSend: 0, wastedOwnerOpSends: [] })),
    phaseStartMs: { B0: 0, B1: 60_000, B2: 241_700 }, endMs: 311_700, scheduleEndMs: 311_700, poolMax: 20,
    plan: { b0Ms: 60_000, bursts: 3, b1TailMs: 61_000, b2Ms: 70_000 }, server: { poolTimeouts: 0, panics: 0, complete: true } };
}
// Records keep `ms === endMs - sentMs`, as the harness writes them.
const setMs = (o: { sentMs: number; endMs: number; ms: number }, ms: number) => { o.ms = ms; o.endMs = o.sentMs + ms; };
const moveTo = (o: { sentMs: number; endMs: number; ms: number }, sentMs: number) => { o.sentMs = sentMs; o.endMs = sentMs + o.ms; };
const failing = (r: BurstRun) => Object.entries(judgeBurst(r).checks).filter(([, c]) => !c.pass).map(([k]) => k);
const b1Auth = (r: BurstRun) => r.owner.find(o => o.kind === 'password' && o.sentMs > 60_000 && o.sentMs < 241_700 && o.burst === undefined)!;

test('a run within every bound holds; A0 passes; C2 bounds use the B0 p95 of the same kind', () => {
  const result = judgeBurst(run());
  assert.deepEqual([result.verdict, result.reasons, failing(run())], ['holds', [], []]);
  assert.equal(result.a0.pass, true);
  assert.deepEqual(result.c2.bounds, { password: 330, revoke: 330 });
  assert.deepEqual(result.waiters, { log: 3, sampler: 2 });
  assert.equal(result.sampler.medianMs, 20);
  const r = report(run());
  assert.deepEqual(r.bursts.map(b => [b.counted401, b.refused429, b.lockLog.owner]), [[5, 11, [140]], [5, 11, [140]], [5, 11, [140]]]);
  assert.equal(r.phases.B1.sampler.waitingShareAtPeak, 2 / 7);
});

test('C1, C2 and B1-B5 failures in a valid run are `fails`', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['C1', r => { b1Auth(r).status = 429; }],
    ['C1', r => { r.owner.find(o => o.burst === 2)!.status = 503; }],
    ['C2', r => { setMs(b1Auth(r), 331); }],
    ['C2', r => { setMs(r.owner.find(o => o.burst === 1)!, 331); }],
    ['B3', r => { for (const pid of [104, 105, 106, 107, 108]) r.waits.push({ ...r.waits[0], pid }); }],
    ['B3', r => { r.samples[3_100].connections = 20; }],
    ['B4', r => { r.reads[300].status = 500; }],
  ];
  for (const [check, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'fails', check);
    assert.ok(failing(r).includes(check), `${check}: ${failing(r)}`);
  }
});

test('A0, sample-count and evidence gaps are inconclusive, and a bad sampler is invalid: never holds', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['four counted attempts', r => { r.attack.find(a => a.burst === 2 && a.status === 401)!.status = 429; }],
    ['owner op skipped', r => { r.bursts[1].ownerOp = 'skipped'; }],
    ['owner op on a refused send', r => { r.bursts[2].ownerOpSend = 0; r.bursts[2].admittedSend = 1; }],
    ['two bursts only', r => { r.bursts.pop(); }],
    ['overlap in one burst only', r => { r.waits = r.waits.filter(w => w.startMs < 100_000 || w.pid === 101); }],
    ['lock log incomplete', r => { r.lockLog = { complete: false, reasons: ['1 unmatched waits'] }; }],
    ['three B0 revoke successes', r => { for (const o of r.owner.filter(o => o.kind === 'revoke' && o.sentMs < 60_000).slice(0, 3)) o.status = 429; }],
    ['server evidence incomplete', r => { r.server.complete = false; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    assert.equal(judgeBurst(r).verdict, 'inconclusive', name);
  }
  // An A0 failure is never upgraded to a fail by an outcome failure either.
  const both = run(); both.bursts[0].ownerOp = 'skipped'; b1Auth(both).status = 429;
  assert.equal(judgeBurst(both).verdict, 'inconclusive');
  const slow = run(); slow.samples = slow.samples.filter((_, i) => i % 2 === 0);
  assert.deepEqual([judgeBurst(slow).verdict, judgeBurst(slow).sampler.medianMs], ['invalid', 40]);
});

test('aggregate: PASS only for 3 distinct valid runs that hold; fewer than 3 valid is INCONCLUSIVE even with a fail', () => {
  const run = (id: string, verdict: 'holds' | 'fails' | 'inconclusive' | 'invalid' | null, evidence = true) => ({ id, evidence, verdict });
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'holds')]).outcome, 'PASS');
  assert.deepEqual(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'fails')]), { outcome: 'FAIL', valid: 3, failures: ['c'],
    verdicts: ['holds', 'holds', 'fails'] });
  // The approved rule: fewer than 3 valid runs is INCONCLUSIVE; the individual failure stays listed.
  const mixed = aggregate([run('a', 'fails'), run('b', 'holds'), run('c', 'invalid')]);
  assert.deepEqual([mixed.outcome, mixed.valid, mixed.failures], ['INCONCLUSIVE', 2, ['a']]);
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'inconclusive')]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'holds', false)]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', null)]).outcome, 'INCONCLUSIVE');
  // One run three times is one run.
  const same = aggregate([run('a', 'holds'), run('a', 'holds'), run('a', 'holds')]);
  assert.deepEqual([same.outcome, same.valid], ['INCONCLUSIVE', 1]);
  assert.equal(aggregate([{ id: null, evidence: true, verdict: 'holds' }, run('b', 'holds'), run('c', 'holds')]).outcome, 'INCONCLUSIVE');
  assert.throws(() => aggregate([run('a', 'holds'), run('b', 'holds')]));
  assert.throws(() => aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'holds'), run('d', 'holds')]));
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

test('burst admission: fire only on a send that shows admission; an all-429 send answered late is refused', () => {
  const n = (count: number, status = 429) => Array.from({ length: count }, () => status);
  assert.equal(burstAdmission(n(15)), 'pending');
  assert.equal(burstAdmission(n(16)), 'refused');
  assert.equal(burstAdmission(n(11)), 'provisional');
  assert.equal(burstAdmission([...n(11), 401]), 'admitted');
  assert.equal(burstAdmission(n(12)), 'pending');
  assert.equal(burstAdmission(n(9)), 'pending');
  assert.equal(burstAdmission([...n(11), 503]), 'pending');
});

test('recorded runs test origin/main at run time; a prebuilt image or another SERVER_REF is rejected', () => {
  const MAIN = 'b'.repeat(40), OTHER = 'c'.repeat(40);
  const calls: string[][] = [];
  let fetched = MAIN;
  const git = (args: string[]) => { calls.push(args); return args[0] === 'fetch' ? '' : args.at(-1) === 'refs/remotes/origin/main^{commit}' ? MAIN
    : args.at(-1) === 'FETCH_HEAD^{commit}' ? fetched : args.at(-1) === 'main^{commit}' ? MAIN : OTHER; };
  assert.deepEqual(resolveServer('recorded', { serverRef: null, appImage: null }, git), { serverCommit: MAIN, archive: true, source: 'origin/main' });
  // An explicit forced refspec, whatever the checkout's own fetch refspec tracks.
  assert.deepEqual(calls[0], ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  // A remote-tracking ref that is not the fetched tip (stale) is refused.
  fetched = OTHER;
  assert.throws(() => resolveServer('recorded', { serverRef: null, appImage: null }, git), /fetched tip/);
  fetched = MAIN;
  assert.equal(resolveServer('recorded', { serverRef: 'main', appImage: null }, git).serverCommit, MAIN);
  assert.throws(() => resolveServer('recorded', { serverRef: 'topic', appImage: null }, git), /origin\/main/);
  assert.throws(() => resolveServer('recorded', { serverRef: null, appImage: 'local:tag' }, git), /LOAD_APP_IMAGE/);
  assert.deepEqual(resolveServer('rehearsal', { serverRef: null, appImage: 'local:tag' }, git), { serverCommit: null, archive: false, source: 'LOAD_APP_IMAGE' });
  assert.equal(resolveServer('smoke', { serverRef: null, appImage: null }, git).source, 'checkout');
});

test('burst timing: the owner operation belongs to the admitted send after a 429 retry, and must leave on time', () => {
  const retried = () => {
    const r = run(), s = SENDS[1];
    r.bursts[1] = { index: 2, sends: [{ sentMs: s - 250, statuses: Array(16).fill(429) }, { sentMs: s, statuses: r.bursts[1].sends[0].statuses }],
      admittedSend: 1, ownerOp: 'sent', ownerOpSend: 1, wastedOwnerOpSends: [] };
    r.owner.find(o => o.burst === 2)!.burstSend = 1;
    for (const a of r.attack.filter(a => a.burst === 2)) a.send = 1;
    r.attack.push(...Array.from({ length: 16 }, () => ({ burst: 2, send: 0, sentMs: s - 250, endMs: s - 238, ms: 12, status: 429 })));
    return r;
  };
  assert.equal(judgeBurst(retried()).verdict, 'holds');
  const late = retried();
  moveTo(late.owner.find(o => o.burst === 2)!, SENDS[1] + 40);
  const result = judgeBurst(late);
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.evidence.checks.ownerOpTiming.pass, false);
  // +14 ms is inside the approved 5 ms owner lateness (maintainer, 2026-11-22); +16 ms is not.
  const at14 = run(); moveTo(at14.owner.find(o => o.burst === 1)!, SENDS[0] + 14);
  assert.equal(judgeBurst(at14).verdict, 'holds');
  const at16 = run(); moveTo(at16.owner.find(o => o.burst === 1)!, SENDS[0] + 16);
  assert.equal(judgeBurst(at16).verdict, 'inconclusive');
  const early = run(); moveTo(early.owner.find(o => o.burst === 1)!, SENDS[0] + 5);
  assert.equal(judgeBurst(early).verdict, 'inconclusive');
  const undecided = run(); undecided.bursts[0].ownerOp = 'undecided';
  assert.equal(judgeBurst(undecided).verdict, 'inconclusive');
});

test('overlap evidence is bound to each burst window; recovery waits never count', () => {
  const r = run();
  // Burst 2 loses its overlap; burst 3's overlapping waits move into B2 recovery.
  r.waits = r.waits.filter(w => !(w.startMs > 100_000 && w.startMs < 130_000 && w.pid !== 101));
  for (const w of r.waits.filter(w => w.startMs > 170_000)) { w.startMs += 65_000; w.endMs += 65_000; w.startDbMs += 65_000; w.endDbMs += 65_000; }
  const result = judgeBurst(r);
  assert.deepEqual([result.verdict, result.a0.checks.lockOverlap.pass, result.a0.locks.map(l => l.peakPids)], ['inconclusive', false, [3, 1, 0]]);
});

test('sampler loss around the bursts, malformed rows, bad timestamps and skipped reads are inconclusive', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['no samples within 2 s of any burst', r => { r.samples = r.samples.filter(s => SENDS.every(b => Math.abs(s.dbMs + OFFSET - b) > 2_000)); }],
    ['a 300 ms hole inside a burst', r => { r.samples = r.samples.filter(s => !(s.dbMs + OFFSET > SENDS[0] && s.dbMs + OFFSET < SENDS[0] + 300)); }],
    ['malformed sampler rows', r => { r.samplerMalformed = 1; }],
    ['duplicate database timestamp', r => { r.samples[5].dbMs = r.samples[4].dbMs; }],
    ['backward database timestamp', r => { r.samples[5].dbMs = r.samples[4].dbMs - 1; }],
    ['skipped Organization B reads', r => { r.skipped.reads = 1; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'inconclusive', name);
    assert.ok(result.sampler.valid, name);
  }
  // The legacy B4 calculation itself is unchanged by skipped reads.
  const skipped = run(); skipped.skipped.reads = 1;
  assert.equal(judgeBurst(skipped).checks.B4.pass, true);
});

test('invalid takes precedence over inconclusive and fails together', () => {
  const r = run();
  r.samples = r.samples.filter((_, i) => i % 2 === 0);
  r.bursts[0].ownerOp = 'skipped';
  b1Auth(r).status = 429;
  assert.equal(judgeBurst(r).verdict, 'invalid');
});

test('per-burst report carries the sampler peaks and the owner operation offset', () => {
  const r = report(run());
  assert.deepEqual(r.bursts.map(b => [b.sampler.peakWaiters, b.sampler.peakConnections, b.sampler.waitingShareAtPeak, b.ownerOp?.afterAdmittedSendMs]),
    [[2, 7, 2 / 7, 10], [2, 7, 2 / 7, 10], [2, 7, 2 / 7, 10]]);
});

test('aggregate reader: only three distinct, self-consistent, completed recorded runs count', () => {
  const base = mkdtempSync(join(tmpdir(), 'burst-aggregate-'));
  const write = (name: string, o: { status?: object; results?: object | null; meta?: object } = {}) => {
    const dir = join(base, name), r = run(), judgment = judgeBurst(r);
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, outcome: 'success', ...o.status }));
    if (o.results !== null) writeFileSync(join(dir, 'results.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, complete: true,
      stoppedEarly: null, harnessCommit: SHA, serverCommit: SHA, ...r, judgment, ...o.results }));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ project: name, harnessCommit: SHA, serverCommit: SHA, ...o.meta }));
    return dir;
  };
  const [a, b, c] = ['a', 'b', 'c'].map(n => write(n));
  const outcome = (dirs: string[]) => aggregate(readRuns(dirs)).outcome;
  assert.equal(outcome([a, b, c]), 'PASS');
  assert.equal(outcome([a, a, a]), 'INCONCLUSIVE');
  assert.equal(outcome([a, b, join(base, 'b', '.')]), 'INCONCLUSIVE');
  const problems: [string, Parameters<typeof write>[1]][] = [
    ['verdict only', { results: { judgment: { verdict: 'holds' }, owner: undefined, samples: undefined } }],
    ['forged verdict', { results: { judgment: { verdict: 'holds' }, skipped: { reads: 3 } } }],
    ['other run results', { results: { runId: 'zzz' } }],
    ['other run metadata', { meta: { project: 'zzz' } }],
    ['rehearsal', { status: { mode: 'rehearsal' } }],
    ['not evidence', { status: { evidence: false } }],
    ['result failure', { status: { outcome: 'result-failure' } }],
    ['stopped early', { results: { stoppedEarly: 'inconclusive: B0' } }],
    ['results evidence false', { results: { evidence: false } }],
    ['missing results', { results: null }],
    ['no server commit', { meta: { serverCommit: null } }],
  ];
  for (const [name, o] of problems) {
    const dir = write(name.replace(/ /g, '-'), o);
    const runs = readRuns([a, b, dir]);
    assert.equal(runs[2].evidence, false, name);
    assert.equal(aggregate(runs).outcome, 'INCONCLUSIVE', name);
  }
  // A failing third run is FAIL only when all three are valid.
  const failing = write('failing', { results: { judgment: { verdict: 'fails' } } });
  assert.equal(readRuns([a, b, failing])[2].evidence, false, 'a stored verdict the samples do not reproduce');
  const other = write('other-harness', { meta: { harnessCommit: 'd'.repeat(40) }, results: { harnessCommit: 'd'.repeat(40) } });
  assert.equal(outcome([a, b, other]), 'INCONCLUSIVE');
});

test('round 2: owner decision never fires on 11 refusals at +10 ms whose last 5 are 429s at +12 ms', () => {
  const n = (count: number, status = 429) => Array.from({ length: count }, () => status);
  // The sol case: 11 x 429 back at +10 ms, the other five 429s at +12 ms.
  assert.equal(ownerDecision(burstAdmission(n(11)), 10), 'wait');
  assert.equal(ownerDecision(burstAdmission(n(11)), 11.9), 'wait');
  assert.equal(ownerDecision(burstAdmission(n(16)), 12), 'refused');
  // An admitted send: 11 refusals, 5 still verifying, trusted only at the last poll inside +10..+15 ms.
  assert.equal(ownerDecision(burstAdmission(n(11)), 13), 'fire');
  assert.equal(ownerDecision(burstAdmission(n(11)), 15), 'fire');
  assert.equal(ownerDecision(burstAdmission(n(11)), 15.1), 'undecided');
  // A 401 is proof: fire at once from +10 ms, never before.
  assert.equal(ownerDecision(burstAdmission([...n(11), 401]), 9), 'wait');
  assert.equal(ownerDecision(burstAdmission([...n(11), 401]), 10), 'fire');
  assert.equal(ownerDecision(burstAdmission(n(12)), 14), 'wait');
  assert.equal(ownerDecision(burstAdmission(n(12)), 16), 'undecided');
});

test('condition a: a lock wait unrelated to the burst inside the +-1 s window is never A0 evidence', () => {
  // The sol fixture: every interval 500 ms later, so all begin after the last attack and owner answers.
  const shifted = run();
  for (const w of shifted.waits) { w.startMs += 500; w.endMs += 500; w.startDbMs += 500; w.endDbMs += 500; }
  const result = judgeBurst(shifted);
  assert.notEqual(result.verdict, 'holds');
  assert.deepEqual([result.a0.checks.lockOverlap.pass, result.a0.locks.map(l => l.peakPids)], [false, [0, 0, 0]]);
  // Overlapping waits just before the admitted send, inside the padded window, are not evidence either.
  const before = run();
  for (const w of before.waits) { w.startMs -= 300; w.endMs -= 300; }
  assert.equal(judgeBurst(before).a0.checks.lockOverlap.pass, false);
  // Inside the span but with unknown attribution: not evidence.
  const unknown = run();
  for (const w of unknown.waits) w.who = 'unknown';
  assert.equal(judgeBurst(unknown).a0.checks.lockOverlap.pass, false);
  // A wait that runs past the end of every request of the burst has no link to one: it never counts.
  const edge = run();
  edge.waits = edge.waits.filter(w => w.pid !== 103).map(w => w.pid === 102 ? { ...w, startMs: w.startMs + 300, endMs: w.endMs + 300 } : w);
  assert.deepEqual(judgeBurst(edge).a0.locks.map(l => l.peakPids), [1, 1, 1]);
});

test('round 2: a stripped workload record never holds, also through the aggregate reader', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['refused attack answers removed', r => { r.attack = r.attack.filter(a => a.status !== 429); }],
    ['one Organization B read per phase', r => { r.reads = [r.reads[0], r.reads[200], r.reads[500]]; }],
    ['one owner sign-in slot missing', r => { r.owner.splice(r.owner.findIndex(o => o.kind === 'web_signin' && o.sentMs === 5_000), 1); }],
    ['a read recorded twice', r => { r.reads[1] = { ...r.reads[0] }; }],
    ['wrong kind in an authenticated slot', r => { r.owner.find(o => o.kind === 'password' && o.dueMs === 2_500)!.kind = 'revoke'; }],
    ['burst-time owner operation missing', r => { r.owner = r.owner.filter(o => o.burst !== 2); }],
    ['schedule ended before B2', r => { r.scheduleEndMs = 200_000; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'inconclusive', name);
    assert.equal(result.evidence.checks.workloadComplete.pass, false, name);
  }
});

test('round 2: sampler gaps anywhere in the run are inconclusive', () => {
  const r = run();
  r.samples = r.samples.filter(s => !(s.dbMs + OFFSET > 250_000 && s.dbMs + OFFSET < 306_000));
  const result = judgeBurst(r);
  assert.deepEqual([result.verdict, result.sampler.valid, result.evidence.checks.samplerCoverage.pass,
    result.evidence.checks.samplerRunCoverage.pass], ['inconclusive', true, true, false]);
  const b0 = run(); b0.samples = b0.samples.filter(s => !(s.dbMs + OFFSET > 10_000 && s.dbMs + OFFSET < 10_200));
  assert.equal(judgeBurst(b0).verdict, 'inconclusive');
  // The approved 100 ms bound itself: a 100 ms gap is accepted.
  const edge = run(); edge.samples = edge.samples.filter(s => !(s.dbMs + OFFSET > 10_000 && s.dbMs + OFFSET < 10_100));
  assert.equal(judgeBurst(edge).verdict, 'holds');
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

test('report: per-burst pool timeouts and waits over 1 s', () => {
  const r = run();
  r.server.burstPoolTimeouts = [0, 2, null];
  r.waits[3] = { ...r.waits[3], waitedMs: 1_200 };
  setMs(r.attack.find(a => a.burst === 3 && a.status === 401)!, 1_500);
  const bursts = report(r).bursts;
  assert.deepEqual(bursts.map(b => [b.poolTimeouts, b.lockLog.over1s, b.operationsOver1s]), [[0, 0, 0], [2, 1, 0], [null, 0, 1]]);
});

test('condition b: the 3 runs must share the server commit as well as the harness commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'burst-commits-'));
  const write = (name: string, serverCommit: string) => {
    const dir = join(base, name), r = run();
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, outcome: 'success' }));
    writeFileSync(join(dir, 'results.json'), JSON.stringify({ runId: name, mode: 'recorded', evidence: true, complete: true, stoppedEarly: null,
      harnessCommit: SHA, serverCommit, ...r, judgment: judgeBurst(r) }));
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ project: name, harnessCommit: SHA, serverCommit }));
    return dir;
  };
  const same = ['a', 'b', 'c'].map(n => write(n, SHA));
  assert.equal(aggregate(readRuns(same)).outcome, 'PASS');
  const mixed = readRuns([same[0], same[1], write('d', 'e'.repeat(40))]);
  assert.equal(aggregate(mixed).outcome, 'INCONCLUSIVE');
  assert.ok(mixed.every(r => r.problem === 'runs tested different server commits'));
});

// Round 3. A virtual clock drives the real scheduler loop (runWorkload): timers fire in time order, and
// every promise chain settles before the clock moves on.
type Reply = { status: number; ms: number };
function virtual(script: { attack?: (call: number) => Reply; owner?: (kind: OwnerKind, t: number) => Reply; stopAt?: number }) {
  let t = 0, seq = 0, calls = 0;
  const timers: { at: number; seq: number; fire: () => void }[] = [];
  const after = <T>(ms: number, value: () => T) => new Promise<T>(resolve => timers.push({ at: t + ms, seq: seq++, fire: () => resolve(value()) }));
  const reply = ({ status, ms }: Reply) => { const start = t; return after<Answer>(ms, () => ({ status, start, end: start + ms })); };
  const io: WorkloadIo = {
    now: () => t, sleep: ms => after(ms, () => undefined), aborted: () => script.stopAt !== undefined && t >= script.stopAt,
    attack: () => reply(script.attack?.(calls++) ?? (calls++ % 16 < 5 ? { status: 401, ms: 300 } : { status: 429, ms: 2 })),
    owner: kind => reply(script.owner?.(kind, t) ?? { status: kind === 'web_signin' || kind === 'native_signin' ? 200 : 204, ms: 50 }),
    read: () => reply({ status: 200, ms: 5 }),
    sampler: () => ({ exited: false, medianMs: 20 }),
  };
  const drive = async <T>(work: Promise<T>) => {
    let done = false;
    void work.finally(() => { done = true; });
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (done) return work;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!timers.length) throw new Error('scheduler stalled');
      t = timers[0].at;
      while (timers.length && timers[0].at === t) timers.shift()!.fire();
    }
  };
  return { io, drive };
}
const asRun = (w: Awaited<ReturnType<typeof runWorkload>>): BurstRun => ({ ...w, samples: [], samplerMalformed: 0, offsetMs: null, waits: [],
  lockLog: { complete: true, reasons: [] }, poolMax: 20, server: { poolTimeouts: 0, panics: 0, complete: true },
  plan: { b0Ms: PLANS.recorded.b0Ms, bursts: PLANS.recorded.bursts, b1TailMs: PLANS.recorded.b1TailMs, b2Ms: PLANS.recorded.b2Ms } });

test('round 3: the real scheduler loop runs the pre-registered cadence once per slot and passes workloadComplete', async () => {
  const { io, drive } = virtual({});
  const w = await drive(runWorkload(PLANS.recorded, io));
  assert.deepEqual([w.completed, w.stoppedEarly, w.b0Checkpoint], [true, null, 'complete']);
  assert.deepEqual([w.phaseStartMs.B2, w.scheduleEndMs], [241_700, 311_700]);
  assert.deepEqual(workloadGaps(asRun(w)), []);
  assert.deepEqual(w.skipped, { web_signin: 0, native_signin: 0, password: 0, revoke: 0, reads: 0 });
  const periodic = (kinds: OwnerKind[]) => w.owner.filter(o => o.burst === undefined && kinds.includes(o.kind)).sort((a, b) => a.dueMs! - b.dueMs!);
  const signins = periodic(['web_signin', 'native_signin']), auth = periodic(['password', 'revoke']);
  // Every 2 s from 1 s and every 5 s from 2.5 s up to the end of B2, alternating kinds, each sent at its slot.
  assert.deepEqual(signins.map(o => o.dueMs), Array.from({ length: 156 }, (_, i) => 1_000 + i * 2_000));
  assert.deepEqual(signins.map(o => o.kind), signins.map((_, i) => i % 2 ? 'native_signin' : 'web_signin'));
  assert.deepEqual(auth.map(o => o.dueMs), Array.from({ length: 62 }, (_, i) => 2_500 + i * 5_000));
  assert.deepEqual(auth.map(o => o.kind), auth.map((_, i) => i % 2 ? 'revoke' : 'password'));
  assert.ok([...signins, ...auth].every(o => o.sentMs >= o.dueMs! && o.sentMs - o.dueMs! <= 2));
  assert.deepEqual(w.reads.map(r => r.dueMs).sort((a, b) => a - b), Array.from({ length: 624 }, (_, i) => i * 500));
  // Three admitted bursts 60.2 s apart, each with its owner operation inside +10..+15 ms of the admitted send.
  assert.deepEqual(w.bursts.map(b => [b.sends.map(x => x.sentMs), b.admittedSend, b.ownerOp, b.ownerOpSend]),
    [[[60_000], 0, 'sent', 0], [[120_200], 0, 'sent', 0], [[180_400], 0, 'sent', 0]]);
  assert.deepEqual(w.owner.filter(o => o.burst !== undefined).map(o => [o.kind, o.sentMs - SENDS[o.burst! - 1], o.burstSend]),
    [['password', 13, 0], ['revoke', 13, 0], ['password', 13, 0]]);
});

test('round 3: a send refused after its owner operation fired never credits it; the retry decides afresh', async () => {
  // The sol case on burst 1: 11 x 429 at +13 ms (provisional: the owner operation fires), the last five 429s at +14 ms.
  const { io, drive } = virtual({ stopAt: 70_000, attack: n => n < 16 ? { status: 429, ms: n < 11 ? 13 : 14 }
    : (n - 16) % 16 < 5 ? { status: 401, ms: 300 } : { status: 429, ms: 2 } });
  const w = await drive(runWorkload(PLANS.recorded, io));
  const b = w.bursts[0];
  assert.deepEqual([b.sends.length, b.admittedSend, b.wastedOwnerOpSends, b.ownerOp, b.ownerOpSend], [2, 1, [0], 'sent', 1]);
  assert.deepEqual(w.owner.filter(o => o.burst === 1).map(o => [o.burstSend, o.sentMs - b.sends[o.burstSend!].sentMs]), [[0, 13], [1, 13]]);
  // The judgment: never credited, A0 fails, so the run can only be INCONCLUSIVE (never PASS).
  const r = run();
  r.bursts[0] = { index: 1, sends: [{ sentMs: SENDS[0] - 250, statuses: Array(16).fill(429) }, { sentMs: SENDS[0], statuses: r.bursts[0].sends[0].statuses }],
    admittedSend: 1, ownerOp: 'sent', ownerOpSend: 1, wastedOwnerOpSends: [0] };
  for (const a of r.attack.filter(a => a.burst === 1)) a.send = 1;
  r.attack.push(...Array.from({ length: 16 }, (_, k) => ({ burst: 1, send: 0, sentMs: SENDS[0] - 250, endMs: SENDS[0] - 250 + (k < 11 ? 13 : 14),
    ms: k < 11 ? 13 : 14, status: 429 })));
  r.owner.find(o => o.burst === 1)!.burstSend = 1;
  r.owner.push({ kind: 'password', burst: 1, burstSend: 0, sentMs: SENDS[0] - 237, endMs: SENDS[0] - 187, ms: 50, status: 204 });
  const result = judgeBurst(r);
  assert.deepEqual([result.verdict, result.a0.checks.ownerOps.pass, result.evidence.checks.workloadComplete.pass], ['inconclusive', false, true]);
  assert.equal(report(r).bursts[0].ownerOp?.afterAdmittedSendMs, 10);
  // Dropping the wasted list, or claiming the wasted operation as the credited one, is a workload gap.
  const stripped = structuredClone(r); stripped.bursts[0].wastedOwnerOpSends = [];
  assert.equal(judgeBurst(stripped).evidence.checks.workloadComplete.pass, false);
});

test('round 3: A0 needs a recorded link to a request of that burst; unrelated or unattributed waits never hold A0', () => {
  // The sol case: two unrelated sign-in waits from -25 ms to +5 ms around each admitted send.
  const early = run();
  early.waits = SENDS.flatMap(s => [201, 202].map(pid => ({ ...early.waits[0], pid, startMs: s - 25, endMs: s + 5,
    startDbMs: s - 25 - OFFSET, endDbMs: s + 5 - OFFSET, waitedMs: 30, who: 'signin' as const })));
  const unlinked = judgeBurst(early);
  assert.deepEqual([unlinked.verdict, unlinked.a0.checks.lockOverlap.pass, unlinked.a0.locks.map(l => l.peakPids)], ['inconclusive', false, [0, 0, 0]]);
  // A missing `who` never counts.
  const missing = run();
  for (const w of missing.waits) delete (w as Partial<typeof w>).who;
  assert.deepEqual([judgeBurst(missing).verdict, judgeBurst(missing).a0.checks.lockOverlap.pass], ['inconclusive', false]);
  // A sign-in wait that an owner sign-in outside the burst could explain is ambiguous: not counted.
  const ambiguous = run();
  const signin = ambiguous.owner.find(o => o.kind === 'web_signin' && o.dueMs === 61_000)!;
  moveTo(signin, SENDS[0] + 20); setMs(signin, 200);
  assert.deepEqual(a0(ambiguous).locks.map(l => l.peakPids), [1, 3, 3]);
  // Through the aggregate reader: three such runs are never PASS.
  for (const r of [early, missing]) assert.equal(aggregate(readRuns(['x', 'y', 'z'].map(n => writeRun(n, r)))).outcome, 'INCONCLUSIVE');
});

const runsDir = mkdtempSync(join(tmpdir(), 'burst-round3-'));
let runCount = 0;
function writeRun(name: string, r: BurstRun) {
  const dir = join(runsDir, `${name}-${runCount++}`), id = `run-${runCount}`;
  mkdirSync(dir);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: id, mode: 'recorded', evidence: true, outcome: 'success' }));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ runId: id, mode: 'recorded', evidence: true, complete: true, stoppedEarly: null,
    harnessCommit: SHA, serverCommit: SHA, ...r, judgment: judgeBurst(r) }));
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ project: id, harnessCommit: SHA, serverCommit: SHA }));
  return dir;
}

test('round 3: completeness covers all of B2; a truncated recovery or another plan never passes', () => {
  assert.equal(aggregate(readRuns(['a', 'b', 'c'].map(n => writeRun(n, run())))).outcome, 'PASS');
  // The sol case: the run stops 8.3 s into B2, with everything after that dropped.
  const cut = 241_700 + 8_300, truncated = run();
  truncated.owner = truncated.owner.filter(o => o.sentMs < cut); truncated.reads = truncated.reads.filter(x => x.dueMs < cut);
  truncated.samples = truncated.samples.filter(x => x.dbMs + OFFSET < cut);
  // scheduleEndMs as the 6dd20b70 runner recorded it: the last scheduler tick before the stop.
  truncated.scheduleEndMs = cut - 1; truncated.endMs = cut;
  const result = judgeBurst(truncated);
  assert.deepEqual([result.verdict, result.evidence.checks.workloadComplete.pass], ['inconclusive', false]);
  assert.equal(aggregate(readRuns(['a', 'b', 'c'].map(n => writeRun(n, truncated)))).outcome, 'INCONCLUSIVE');
  // B2 started early, or a short plan recorded as if it were the recorded one.
  const early = run(); early.phaseStartMs.B2 = 200_000; early.scheduleEndMs = 270_000;
  assert.equal(judgeBurst(early).evidence.checks.workloadComplete.pass, false);
  const rehearsalPlan = run(); rehearsalPlan.plan = { ...rehearsalPlan.plan, b2Ms: 5_000 };
  assert.equal(readRuns([writeRun('a', run()), writeRun('b', run()), writeRun('p', rehearsalPlan)])[2].evidence, false);
  const noPlan = run(); delete (noPlan as Partial<BurstRun>).plan;
  assert.equal(judgeBurst(noPlan).verdict, 'inconclusive');
});

test('round 3: relabelled or stripped operation records never hold', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    // The sol cases: a 429 password change relabelled as a sign-in (C1 would not see it), and a password change without `ms`.
    ['burst-time 429 password change relabelled native_signin', r => { const o = r.owner.find(o => o.burst === 1)!; o.status = 429; o.kind = 'native_signin'; }],
    ['periodic 429 password change relabelled native_signin', r => { const o = r.owner.find(o => o.kind === 'password' && o.dueMs === 62_500)!; o.status = 429; o.kind = 'native_signin'; }],
    ['password change without ms', r => { delete (r.owner.find(o => o.burst === 1)! as Partial<BurstOwnerOp>).ms; }],
    ['periodic password change without ms', r => { delete (r.owner.find(o => o.kind === 'password' && o.dueMs === 62_500)! as Partial<BurstOwnerOp>).ms; }],
    ['ms rewritten below endMs - sentMs', r => { r.owner.find(o => o.burst === 2)!.ms = 1; }],
    ['owner record without status', r => { delete (r.owner[3] as Partial<BurstOwnerOp>).status; }],
    ['unknown kind', r => { (r.owner[3] as { kind: string }).kind = 'signin'; }],
    ['attack answer without endMs', r => { delete (r.attack[0] as Partial<BurstRun['attack'][number]>).endMs; }],
    ['read without ms', r => { delete (r.reads[10] as Partial<BurstRun['reads'][number]>).ms; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'inconclusive', name);
    assert.equal(result.evidence.checks.workloadComplete.pass, false, name);
  }
});

test('round 3: the B0 checkpoint stops before burst 1 when B0 provably cannot reach the counts', async () => {
  // Revoke-others in B0 at 7.5, 17.5, ... 57.5 s; the one at 57.5 s is still in flight at 60 s.
  const b0 = (ok: number[]) => virtual({ stopAt: 61_000, owner: (kind, t) => kind !== 'revoke' || t >= 60_000 ? { status: kind.endsWith('signin') ? 200 : 204, ms: 50 }
    : t >= 57_500 ? { status: 204, ms: 5_000 } : { status: ok.includes(t) ? 204 : 429, ms: 50 } });
  // 3 successes + 1 in flight can still reach 4: left to the final judgment, the bursts go on.
  const reachable = b0([7_500, 17_500, 27_500]);
  const go = await reachable.drive(runWorkload(PLANS.recorded, reachable.io));
  assert.equal(go.stoppedEarly, null);
  assert.match(String(go.b0Checkpoint), /left to the final judgment \(revoke in flight\)/);
  assert.ok(go.attack.length > 0);
  // 2 successes + 1 in flight can reach at most 3: stopped at the checkpoint, burst 1 never sent.
  const short = b0([7_500, 17_500]);
  const stop = await short.drive(runWorkload(PLANS.recorded, short.io));
  assert.match(String(stop.stoppedEarly), /^inconclusive: B0 cannot reach 4 successes .*in flight revoke/);
  assert.deepEqual([stop.attack.length, stop.bursts.length, stop.b0CheckAtMs], [0, 0, 60_000]);
  // No sign-in success and none in flight: V is undefined, stopped.
  const noV = virtual({ owner: kind => ({ status: kind.endsWith('signin') ? 401 : 204, ms: 50 }) });
  const v = await noV.drive(runWorkload(PLANS.recorded, noV.io));
  assert.deepEqual([v.stoppedEarly, v.attack.length], ['inconclusive: no B0 owner sign-in success (V undefined)', 0]);
});
