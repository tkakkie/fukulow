import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatHostBusy } from '../../launcher/host-busy.ts';
import { callerLock } from './host.ts';

test('formal HOST-BUSY must name the caller’s launcher job and session', t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-leak-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const runs = join(dir, 'runs');
  mkdirSync(runs);
  const file = join(runs, 'HOST-BUSY');
  const job = '689-item-3', session = 'session-one';
  const env = {FUKULOW_HOST_BUSY: file, FUKULOW_LAUNCH_JOB: job, FUKULOW_LAUNCH_SESSION: session};
  assert.throws(() => callerLock({}));
  assert.throws(() => callerLock(env));
  writeFileSync(file, formatHostBusy('measure', [job], new Date('2026-11-27Z'), session));
  assert.deepEqual(callerLock(env), {file, job, session});
  assert.throws(() => callerLock({...env, FUKULOW_LAUNCH_JOB: 'other-job'}));
  assert.throws(() => callerLock({...env, FUKULOW_LAUNCH_SESSION: 'other-session'}));
});
