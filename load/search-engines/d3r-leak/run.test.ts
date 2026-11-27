import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finalizeFormalRun } from './run.ts';

test('formal finalization preserves an identity failure recorded by the failed worker', t => {
  const out = mkdtempSync(join(tmpdir(), 'd3r-leak-test-'));
  t.after(() => rmSync(out, {recursive: true, force: true}));
  const evidencePath = join(out, 'evidence.json');
  const status = {cleanupVerified: true, hostBusy: true, idle: true, workerFailed: true};
  writeFileSync(evidencePath, JSON.stringify({checks: {identity: false}, pairs: []}));

  const verdict = finalizeFormalRun(out, status);
  assert.deepEqual(verdict, {validity: 'INVALID', verdict: 'NOT EVALUATED', invalid: ['identity']});
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8')), verdict);
  assert.deepEqual(JSON.parse(readFileSync(evidencePath, 'utf8')).checks, {identity: false, cleanup: true});
});

test('formal finalization discards a successful identity check when the worker fails', t => {
  const out = mkdtempSync(join(tmpdir(), 'd3r-leak-test-'));
  t.after(() => rmSync(out, {recursive: true, force: true}));
  const evidencePath = join(out, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify({checks: {identity: true}, pairs: []}));

  const verdict = finalizeFormalRun(out, {cleanupVerified: true, hostBusy: true, idle: true, workerFailed: true});
  assert.deepEqual(verdict, {validity: null, verdict: 'NOT EVALUATED'});
  assert.deepEqual(JSON.parse(readFileSync(evidencePath, 'utf8')).checks, {cleanup: true});
});
