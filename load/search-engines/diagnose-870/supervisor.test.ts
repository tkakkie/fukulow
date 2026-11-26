import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resourceNames } from './placement.ts';
import { dockerStartMarker, publishRun, verifyAfterWorker } from './supervisor.ts';

test('the supervisor publishes completion only when the worker, cleanup and host readbacks passed', t => {
  const out = mkdtempSync(join(tmpdir(), 'diag870-supervisor-'));
  t.after(() => rmSync(out, {recursive: true}));
  const run = {out, manifestHash: 'v17', stage: 'smoke'} as const;
  const completion = {manifestHash: 'v17', stage: 'smoke'};
  writeFileSync(join(out, 'completed.json'), JSON.stringify(completion));
  const finished = join(out, 'finished.json');
  const status = () => JSON.parse(readFileSync(join(out, 'run-status.json'), 'utf8'));
  assert.equal(publishRun(run, 0, true, [], 0), 0);
  assert.deepEqual(JSON.parse(readFileSync(finished, 'utf8')), completion);
  assert.equal(status().valid, true);

  for (const [workerCode, cleanupVerified, problems, signal, exitCode] of [
    [0, true, [], 143, 143],
    [0, false, [], 0, 1],
    [0, true, ['host drift'], 0, 1],
    [3, true, [], 0, 3],
  ] as const) {
    assert.equal(publishRun(run, workerCode, cleanupVerified, [...problems], signal), exitCode);
    assert.equal(existsSync(finished), false);
    assert.deepEqual(status(), {manifestHash: 'v17', valid: false, cleanupVerified, exitCode, problems});
  }
});

test('the supervisor skips Docker and host readbacks when the worker stops before starting Docker work', async t => {
  const out = mkdtempSync(join(tmpdir(), 'diag870-supervisor-'));
  t.after(() => rmSync(out, {recursive: true}));
  const calls: string[] = [];
  const docker = (...args: string[]) => { calls.push(args.slice(0, 2).join(' ')); return ''; };
  const hostGate = () => { calls.push('host gate'); return {problems: []}; };
  const run = {out, names: resourceNames('test'), env: {FUKULOW_LAUNCH_SESSION: 'test'}};
  assert.deepEqual(await verifyAfterWorker(run, 0, docker, hostGate), {cleanupVerified: false, hostProblems: []});
  assert.deepEqual(calls, []);

  writeFileSync(join(out, dockerStartMarker), '');
  writeFileSync(join(out, 'finish.json'), '{}');
  assert.deepEqual(await verifyAfterWorker(run, 0, docker, hostGate), {cleanupVerified: true, hostProblems: []});
  assert.deepEqual(calls, ['container ls', 'volume ls', 'container ls', 'volume ls', 'host gate']);
});
