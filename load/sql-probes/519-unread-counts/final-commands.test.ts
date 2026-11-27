import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sets796 } from '../../harness-core/frequency-layout.ts';
import { postgresSettingsArgs, sendPgbenchArgs, validateAttribution } from './final-commands.ts';

test('the CLI refuses attribution without sends-only before host setup', () => {
  const entry = fileURLToPath(new URL('final.ts', import.meta.url));
  for (const args of [['--smoke'], ['--diagnostic']]) {
    const result = spawnSync(process.execPath, [entry, ...args, '--attribution', '--out', '/unused'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--attribution requires --sends-only with --diagnostic or --smoke/);
  }
});

test('a smoke attribution run takes no frequency stage on any platform', () => {
  assert.doesNotThrow(() => validateAttribution(false, true, true, undefined, true));
  assert.doesNotThrow(() => validateAttribution(false, true, true, undefined, false));
  assert.throws(() => validateAttribution(false, true, true, 'formal', true), /takes no --frequency-v3/);
  assert.throws(() => validateAttribution(false, true, false, undefined, true), /requires --sends-only/);
});

test('attribution preserves six-block formal v3 placement on Linux', () => {
  for (const stage of ['control', 'rehearsal2', '', undefined]) {
    assert.throws(() => validateAttribution(true, false, true, stage, true), /uses --frequency-v3 formal/);
  }
  assert.doesNotThrow(() => validateAttribution(true, false, true, 'formal', true));
  assert.doesNotThrow(() => validateAttribution(true, false, true, undefined, false));
});

test('default startup settings equal the original settings byte for byte', () => {
  const original = ['-c', 'shared_buffers=512MB', '-c', 'jit=off', '-c', 'max_wal_size=64GB',
    '-c', 'checkpoint_timeout=1h', '-c', 'log_checkpoints=on'];
  assert.deepEqual(postgresSettingsArgs(false), original);
  assert.deepEqual(postgresSettingsArgs(true), [...original, '-c', 'shared_preload_libraries=pg_stat_statements',
    '-c', 'pg_stat_statements.track=all', '-c', 'pg_stat_statements.track_planning=off',
    '-c', 'track_functions=all', '-c', 'wal_keep_size=8GB']);
});

test('warm and logged pgbench argv equal the original arrays across smoke and diagnostic paths', () => {
  const pinned = ['taskset', '-c', '1,3,5,9,11,13'];
  const bench = (seconds: number) => ['pgbench', '-U', 'fukulow_app', '-n', '-c', '8', '-j', '4', '-T', String(seconds), '-f', '/work/sql/bench.pgb'];
  assert.deepEqual(sendPgbenchArgs('server', undefined, false, 5, 's1_current'), ['exec', 'server', ...bench(5), 's1_current']);
  assert.deepEqual(sendPgbenchArgs('server', undefined, false, 5, 's1_current', '/tmp/smoke'),
    ['exec', 'server', ...bench(5), '-l', '--log-prefix=/tmp/smoke', 's1_current']);
  assert.deepEqual(sendPgbenchArgs('server', sets796.client, false, 60, 's1_current'),
    ['exec', 'server', ...pinned, ...bench(60), 's1_current']);
  assert.deepEqual(sendPgbenchArgs('server', sets796.client, false, 120, 's1_current', '/tmp/legacy'),
    ['exec', 'server', ...pinned, ...bench(120), '-l', '--log-prefix=/tmp/legacy', 's1_current']);
  assert.deepEqual(sendPgbenchArgs('client', sets796.client, true, 60, 's1_current'),
    ['exec', '--user', 'postgres', 'client', ...pinned, ...bench(60), 's1_current']);
  assert.deepEqual(sendPgbenchArgs('client', sets796.client, true, 120, 's1_current', '/tmp/pgb-block1-current'),
    ['exec', '--user', 'postgres', 'client', ...pinned, ...bench(120), '-l', '--log-prefix=/tmp/pgb-block1-current', 's1_current']);
});
