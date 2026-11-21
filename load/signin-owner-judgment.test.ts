import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, type Run, type OwnerOp } from './signin-owner-judgment.ts';

// B0 owner: sign-in p50 V = 50 ms, p95 60 ms -> B1 bound 60 + 5 * 50 = 310 ms.
function run(): Run {
  const owner: OwnerOp[] = [];
  for (let i = 0; i < 15; i++) owner.push({ kind: 'signin', phase: 'B0', status: 200, ms: i < 14 ? 50 : 60, endMs: i * 2000 });
  owner.push({ kind: 'password', phase: 'B0', status: 204, ms: 60, endMs: 10_000 });
  owner.push({ kind: 'signin', phase: 'B1', status: 429, ms: 2, endMs: 40_000 });
  owner.push({ kind: 'signin', phase: 'B1', status: 200, ms: 300, endMs: 42_000 });
  owner.push({ kind: 'password', phase: 'B1', status: 503, ms: 1, endMs: 50_000 });
  for (let i = 0; i < 10; i++) owner.push({ kind: i % 5 ? 'signin' : 'password', phase: 'B2', status: i % 5 ? 200 : 204, ms: 70, endMs: 100_000 + i * 2000 });
  const locks = [0, 1, 2].flatMap(p => Array.from({ length: 5 }, (_, i) => ({ atMs: [0, 30_000, 90_000][p] + i * 200,
    waiters: p === 1 ? 6 : 0, maxWaitMs: 0, connections: p === 1 ? 9 : 3 })));
  return { owner, attack: [{ phase: 'B1', status: 401, ms: 50, endMs: 35_000 }, { phase: 'B1', status: 429, ms: 1, endMs: 36_000 }],
    reads: [{ phase: 'B0', status: 200, ms: 5 }, { phase: 'B1', status: 200, ms: 9 }, { phase: 'B2', status: 200, ms: 5 }],
    locks, phaseStartMs: { B0: 0, B1: 30_000, B2: 90_000 }, endMs: 160_000, poolMax: 20,
    server: { poolTimeouts: 0, panics: 0, complete: true } };
}
const fails = (r: Run) => Object.entries(judge(r).checks).filter(([, c]) => !c.pass).map(([k]) => k);

test('a run within every pre-registered bound passes B1-B5 but is never formal', () => {
  const result = judge(run());
  assert.deepEqual(fails(run()), []);
  assert.equal(result.allPass, true);
  assert.equal(result.formal, false);
  assert.equal(result.bounds.ownerMs, 310);
  assert.equal(result.bounds.readMs, 12.8);
});

test('each criterion fails on its own violation', () => {
  const cases: [string, (r: Run) => void][] = [
    ['B1', r => { r.owner.find(o => o.phase === 'B1' && o.status === 200)!.ms = 311; }],
    ['B1', r => { r.owner.find(o => o.phase === 'B1')!.status = 403; }],
    ['B2', r => { r.owner.find(o => o.phase === 'B2')!.status = 429; }],
    ['B2', r => { for (const o of r.owner) if (o.phase === 'B2') o.ms = 121; }],
    ['B3', r => { r.locks[6].waiters = 8; }],
    ['B3', r => { r.locks[12].waiters = 8; }],
    ['B3', r => { r.locks[6].connections = 11; }],
    ['B3', r => { r.poolMax = 9; }],
    ['B4', r => { r.reads[1].status = 503; }],
    ['B4', r => { r.reads[1].ms = 12.9; }],
    ['B4', r => { r.reads[2].ms = 12.9; }],
    ['B5', r => { r.server.poolTimeouts = 1; }],
    ['B5', r => { r.server.panics = 1; }],
    ['B2', r => { r.owner.find(o => o.phase === 'B2')!.status = 403; }],
  ];
  for (const [check, mutate] of cases) {
    const r = run(); mutate(r);
    assert.ok(fails(r).includes(check), `${check} should fail`);
  }
});

test('B2 counts 429 only when later than 60 s after the last counted attacker failure', () => {
  const allowed = run();
  allowed.owner.find(o => o.phase === 'B2')!.status = 429;
  allowed.owner.find(o => o.phase === 'B2')!.endMs = 95_000;
  assert.ok(judge(allowed).checks.B2.detail.includes('0 late 429'));
  assert.equal(judge(allowed).checks.B2.pass, true);
  assert.equal(judge(allowed).b2Strict, false);
  assert.equal(judge(run()).b2Strict, true);
  const late = run();
  late.owner.find(o => o.phase === 'B2')!.status = 429;
  assert.ok(judge(late).checks.B2.detail.includes('1 late 429'));
  assert.equal(judge(late).checks.B2.pass, false);
});

test('client timeouts and non-admission 5xx fail B5 on any route', () => {
  for (const mutate of [(r: Run) => { r.attack[1].status = 0; }, (r: Run) => { r.reads[0].status = 500; }]) {
    const r = run(); mutate(r);
    assert.ok(fails(r).includes('B5'));
  }
});

test('missing baseline or samples make the run incomplete, not a pass', () => {
  const r = run(); r.owner = r.owner.filter(o => o.phase !== 'B0');
  assert.equal(judge(r).incomplete, true);
  assert.equal(judge(r).allPass, false);
  const s = run(); s.locks = s.locks.filter(l => l.atMs < 90_000);
  assert.equal(judge(s).allPass, false);
  const e = run(); e.server.complete = false;
  assert.equal(judge(e).allPass, false);
  const a = run(); a.attack = [];
  assert.equal(judge(a).incomplete, true);
  for (const phase of ['B0', 'B1', 'B2']) {
    const m = run(); m.reads = m.reads.filter(x => x.phase !== phase);
    assert.equal(judge(m).incomplete, true, `${phase} reads missing`);
  }
});
