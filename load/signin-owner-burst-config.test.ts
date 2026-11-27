import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_DB_FLAGS, LOCK_LOG_SETTINGS, PLANS, burstAdmission, disposableOverride, ownerDecision, parseBurstArgs, parseBurstEnv,
  resolveServer } from './signin-owner-burst-config.ts';
import { SHA } from './signin-owner-burst-fixture.ts';

const root = new URL('../', import.meta.url).pathname;

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
