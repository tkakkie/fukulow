import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresCommand, redactSeedDbLogs, seedDiagnosticSample } from './dms-formal-seed-diagnostic.ts';

const formal = '["postgres","-c","shared_preload_libraries=pg_stat_statements","-c","pg_stat_statements.track=all","-c","max_connections=64"]';
test('formal DB command keeps the existing bytes', () => {
  assert.equal(JSON.stringify(postgresCommand()), formal);
});

test('diagnostic DB command appends only the six requested flags', () => {
  assert.deepEqual(postgresCommand(true), [
    ...JSON.parse(formal),
    '-c','log_checkpoints=on','-c','log_autovacuum_min_duration=0','-c','track_io_timing=on',
    '-c','track_wal_io_timing=on','-c','log_lock_waits=on','-c','log_temp_files=0',
  ]);
});

test('sampler records PostgreSQL and Docker stats with the seed wall clock', async () => {
  const stats = {
    checkpointer: { num_timed: 1 }, bgwriter: { buffers_clean: 2 }, wal: { wal_bytes: 8192 },
    io: [{ object: null, reads: 3, write_time: 4 }], vacuum: [{ relid: 20, phase: 'scanning heap' }],
    waitEvents: [{ wait_event_type: 'IO', wait_event: 'WALSync', count: 1 }],
  };
  let now = 1760000000000;
  const row = await seedDiagnosticSample(async command => {
    assert.equal(command.program, 'docker');
    if (command.args[0] === 'exec') {
      for (const view of ['checkpointer', 'bgwriter', 'wal', 'io', 'activity', 'progress_vacuum']) {
        assert.match(command.input!, new RegExp('FROM pg_stat_' + view + '\\b'));
      }
      assert.match(command.input!, /GROUP BY wait_event_type, wait_event/);
      assert.match(command.input!, /sum\(fsync_time\)/);
      assert.doesNotMatch(command.input!, /\b(query|query_id|usename)\b/);
      return { code: 0, stdout: JSON.stringify(stats) };
    }
    assert.deepEqual(command.args, ['stats','--no-stream','--format','{{.CPUPerc}}|{{.MemUsage}}|{{.BlockIO}}','stub-db']);
    return { code: 0, stdout: '75.00%|3.2GiB / 4GiB|12MB / 18MB' };
  }, 'stub-db', () => now++);
  assert.deepEqual(row, {
    startedAtMs: 1760000000000, postgres: { atMs: 1760000000001, stats },
    docker: { atMs: 1760000000002, cpuPercent: '75.00%', memoryUsage: '3.2GiB / 4GiB', blockIo: '12MB / 18MB' },
  });
  const missing = await seedDiagnosticSample(async () => ({ code: 1, stdout: 'private error' }), 'stub-db', () => 3);
  assert.deepEqual(missing, { startedAtMs: 3, postgres: null, docker: null });
});

test('DB log retention keeps diagnostic events and discards SQL, details and credentials', () => {
  const prefix = '2026-11-22T00:00:00.000000000Z 2026-11-22 00:00:00.000 UTC [42] ';
  const lines = [
    'LOG:  checkpoint starting: time',
    'LOG:  checkpoint complete: wrote 5 buffers; total=0.891 s',
    'LOG:  automatic vacuum of table "fukulow.public.messages": index scans: 1',
    'LOG:  automatic analyze of table "fukulow.public.messages": avg read rate: 1 MB/s',
    'LOG:  process 42 still waiting for ShareLock on transaction 123 after 1000.100 ms',
    'LOG:  temporary file: path "base/pgsql_tmp/pgsql_tmp42.0", size 24576',
    'ERROR:  duplicate key token secret',
    'DETAIL:  Key contains secret',
    'STATEMENT:  INSERT INTO account_sessions example-token',
    'secret on continuation',
  ];
  assert.deepEqual(redactSeedDbLogs(lines.map(line => prefix + line).join('\n')).split('\n'), [
    ...lines.slice(0, 4).map(line => prefix + line),
    prefix + 'LOG:  process 42 still waiting for ShareLock after 1000.100 ms',
    prefix + lines[5],
    prefix + 'ERROR:  [detail redacted]',
  ]);
});
