import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPinned, freeBytes, headroom } from './host.ts';
import { setupOptions, sqlState, tcpReadinessArgs, waitReady } from './postgres.ts';
import { modeOf, outcome, stages } from './stages.ts';

test('a failure before sampling is a setup failure; after sampling it is a result', () => {
  assert.equal(outcome({ failed: true, interrupted: false, sampling: false }), 'setup-failure');
  assert.equal(outcome({ failed: true, interrupted: false, sampling: true }), 'result-failure');
  assert.equal(outcome({ failed: false, interrupted: false, sampling: true }), 'success');
  assert.equal(outcome({ failed: true, interrupted: true, sampling: false }), 'interrupted');
});

test('status.json records the stage, sampling state and whether the run is evidence', () => {
  const out = mkdtempSync(join(tmpdir(), 'harness-core-'));
  const s = stages(out, 'rehearsal');
  s.enter('B fixture and first settle');
  s.write({ failed: true, interrupted: false });
  let status = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
  assert.deepEqual([status.outcome, status.sampling, status.evidence, status.lastStage],
    ['setup-failure', false, false, 'B fixture and first settle']);
  s.startSampling();
  s.write({ failed: true, interrupted: false });
  status = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
  assert.equal(status.outcome, 'result-failure');
  assert.equal(stages(out, 'recorded').write({ failed: false, interrupted: false }).evidence, true);
});

test('a recorded run is evidence only once sampling started and it was not interrupted', () => {
  const out = mkdtempSync(join(tmpdir(), 'harness-core-'));
  const setupFailed = stages(out, 'recorded').write({ failed: true, interrupted: false });
  assert.deepEqual([setupFailed.outcome, setupFailed.evidence], ['setup-failure', false]);
  assert.equal(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')).evidence, false);
  const sampled = stages(out, 'recorded');
  sampled.startSampling();
  assert.deepEqual([sampled.write({ failed: true, interrupted: false }).evidence,
    sampled.write({ failed: false, interrupted: true }).evidence], [true, false]);
  assert.equal(stages(out, 'rehearsal').write({ failed: false, interrupted: false }).evidence, false);
});

test('status.json is written even when the summary throws', () => {
  const out = mkdtempSync(join(tmpdir(), 'harness-core-'));
  const s = stages(out, 'recorded');
  s.startSampling();
  const status = s.finish(() => { throw new Error('Invalid latency samples'); }, { failed: false, interrupted: false });
  const saved = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
  assert.deepEqual([status.summaryFailed, saved.summaryFailed, saved.outcome], [true, true, 'result-failure']);
});

test('exactly one mode flag is accepted', () => {
  assert.equal(modeOf({ rehearsal: true }), 'rehearsal');
  assert.throws(() => modeOf({}), /exactly one/);
  assert.throws(() => modeOf({ smoke: true, recorded: true }), /exactly one/);
});

test('readiness goes over TCP, never the socket-only init server', () => {
  const args = tcpReadinessArgs(['exec', 'db']);
  assert.deepEqual(args.slice(0, 5), ['exec', 'db', 'pg_isready', '-h', '127.0.0.1']);
});

test('readiness needs consecutive successes, so a passing init server that then stops is not ready', async () => {
  // Init server answers once, shuts down, then the final server comes up.
  const answers = [true, false, false, true, true];
  let calls = 0;
  await waitReady(() => answers[calls++] ?? true, { delayMs: 0 });
  assert.equal(calls, 5);
  await assert.rejects(waitReady(() => false, { tries: 3, delayMs: 0 }), /not ready over TCP/);
});

test('setup sessions turn the measurement statement_timeout off; the last setting wins', () => {
  assert.equal(setupOptions('-c statement_timeout=10s -c jit=off'), '-c statement_timeout=10s -c jit=off -c statement_timeout=0');
  assert.equal(sqlState('psql:<stdin>:3: ERROR:  57014: canceling statement due to statement timeout'), '57014');
  assert.equal(sqlState('no sqlstate here'), undefined);
});

test('disk headroom parses df and fails when free space is short', () => {
  const df = 'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 61202244 40000000 18000000 69% /\n';
  assert.equal(freeBytes(df), 18_000_000 * 1024);
  assert.equal(headroom(freeBytes(df), 20 * 1024 ** 3).ok, false);
  assert.equal(headroom(freeBytes(df), 10 * 1024 ** 3).ok, true);
  assert.throws(() => freeBytes('garbage'), /Unreadable df output/);
});

test('a harness at another commit or with local edits is refused', () => {
  const git = (state: Record<string, string>) => (args: string[]) => state[args[0]];
  assert.doesNotThrow(() => assertPinned(git({ 'rev-parse': 'abc', status: '' }), 'abc'));
  assert.throws(() => assertPinned(git({ 'rev-parse': 'def', status: '' }), 'abc'), /pinned commit/);
  assert.throws(() => assertPinned(git({ 'rev-parse': 'abc', status: ' M run.ts' }), 'abc'), /dirty/);
});
