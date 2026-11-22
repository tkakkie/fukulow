import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_DB_FLAGS, LOCK_LOG_SETTINGS, PLANS, disposableOverride, parseBurstArgs, parseBurstEnv } from './signin-owner-burst-config.ts';
import { attribute, clockOffset, mergeWaits, parseLockLog, parseSamplerLine, peakSimultaneous, samplerIntervals, xWaits,
  type SamplerRow } from './signin-owner-burst-locks.ts';
import { aggregate, judgeBurst, type BurstOwnerOp, type BurstRun, type OwnerKind } from './signin-owner-burst-judgment.ts';
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
  const rows = ['1000.000|4||0|(0,1)', '1020.500|5|201s,202o|12|(0,1)', '1041.000|5|202o|30|(0,2)', 'garbage', '']
    .map((line, i) => parseSamplerLine(line, 5 + i * 30)).filter((r): r is SamplerRow => r !== null);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].waiting, [{ pid: 201, kind: 'signin' }, { pid: 202, kind: 'owner' }]);
  assert.deepEqual(samplerIntervals(rows), { count: 3, medianMs: 20.5, maxMs: 20.5 });
  assert.equal(clockOffset(rows), -995);
  const wait = { pid: 202, startDbMs: 1010, endDbMs: 1030, waitedMs: 20, parts: ['tuple' as const], tuples: ['(0,1)'], outcome: 'acquired' as const };
  assert.deepEqual(attribute(wait, rows), { who: 'owner', source: 'sampler' });
});

// A run that meets every pre-registered criterion. V = 50 ms; B0 p95 per authenticated kind 80 ms;
// C2 bound 80 + 5 * 50 = 330 ms. Database clock = harness clock + 1e6 ms.
const OFFSET = -1_000_000, SENDS = [60_000, 120_200, 180_400];
function run(): BurstRun {
  const owner: BurstOwnerOp[] = [];
  const op = (kind: OwnerKind, sentMs: number, status: number, ms: number, burst?: number) =>
    owner.push({ kind, sentMs, endMs: sentMs + ms, ms, status, ...(burst ? { burst } : {}) });
  for (let t = 1_000, i = 0; t < 310_000; t += 2_000, i++) op(i % 2 ? 'native_signin' : 'web_signin', t, t >= 60_000 && t < 241_700 ? 429 : 200, t >= 60_000 && t < 241_700 ? 2 : 50);
  for (let t = 2_500, i = 0; t < 310_000; t += 5_000, i++) op(i % 2 ? 'revoke' : 'password', t, 204, t >= 60_000 && t < 241_700 ? 200 : 80);
  SENDS.forEach((s, i) => op(i % 2 ? 'revoke' : 'password', s + 10, 204, 300, i + 1));
  const attack = SENDS.flatMap((s, i) => Array.from({ length: 16 }, (_, k) => ({ burst: i + 1, send: 0, sentMs: s, status: k < 5 ? 401 : 429,
    ms: k < 5 ? 300 : 2, endMs: s + (k < 5 ? 300 : 2) })));
  const reads = Array.from({ length: 620 }, (_, i) => ({ sentMs: i * 500, status: 200, ms: 5 }));
  const samples: SamplerRow[] = [];
  for (let t = 0; t < 311_700; t += 20) {
    const inBurst = SENDS.some(s => t >= s + 40 && t < s + 200);
    samples.push({ dbMs: t - OFFSET, nodeMs: t, connections: inBurst ? 7 : 4, maxWaitMs: 0, ctid: '(0,1)',
      waiting: inBurst ? [{ pid: 101, kind: 'signin' }, { pid: 102, kind: 'signin' }] : [] });
  }
  const waits = SENDS.flatMap(s => [[101, 50, 110], [102, 55, 150], [103, 60, 200]].map(([pid, a, b]) => ({ pid,
    startDbMs: s + a - OFFSET, endDbMs: s + b - OFFSET, waitedMs: b - a, parts: ['transaction' as const], tuples: ['(0,1)'],
    outcome: 'acquired' as const, startMs: s + a, endMs: s + b, who: pid === 103 ? 'owner' as const : 'signin' as const })));
  return { owner, attack, reads, samples, offsetMs: OFFSET, waits, lockLog: { complete: true, reasons: [] },
    bursts: SENDS.map((s, i) => ({ index: i + 1, sends: [{ sentMs: s, statuses: [] }], admittedSend: 0, ownerOp: 'sent' as const, ownerOpSend: 0 })),
    phaseStartMs: { B0: 0, B1: 60_000, B2: 241_700 }, endMs: 311_700, poolMax: 20, server: { poolTimeouts: 0, panics: 0, complete: true } };
}
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
    ['C2', r => { b1Auth(r).ms = 331; }],
    ['C2', r => { r.owner.find(o => o.burst === 1)!.ms = 331; }],
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

test('aggregate: PASS only for 3 evidence runs that hold', () => {
  const holds = { evidence: true, verdict: 'holds' as const };
  assert.equal(aggregate([holds, holds, holds]).outcome, 'PASS');
  assert.equal(aggregate([holds, holds, { evidence: true, verdict: 'fails' }]).outcome, 'FAIL');
  assert.equal(aggregate([holds, holds, { evidence: true, verdict: 'inconclusive' }]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([holds, holds, { evidence: true, verdict: 'invalid' }]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([holds, holds, { evidence: false, verdict: 'holds' }]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([holds, holds, { evidence: true, verdict: null }]).outcome, 'INCONCLUSIVE');
  assert.throws(() => aggregate([holds, holds]));
  assert.throws(() => aggregate([holds, holds, holds, holds]));
});
