import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishRun } from './supervisor.ts';

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
