import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresCommand, redactSeedDbLogs, seedDiagnosticSample, startSeedSampler } from './dms-formal-seed-diagnostic.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      assert.match(command.input!, /GROUP BY backend_type, state, wait_event_type, wait_event/);
      assert.deepEqual(command.args.slice(0, 4), ['exec','-i','-e','PGOPTIONS=-c statement_timeout=2000']);
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

test('sampler never overlaps a slow sample and fails when samples are incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-sampler-'));
  let active = 0, maxActive = 0, calls = 0;
  const slow = async (command: { args: string[] }) => {
    active++; maxActive = Math.max(maxActive, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    if (command.args[0] === 'exec') return { code: 0, stdout: JSON.stringify({ checkpointer: {}, bgwriter: {}, wal: {}, io: [], waitEvents: [], vacuum: [] }) };
    return { code: 0, stdout: '1.00%|1MiB / 2MiB|1kB / 2kB' };
  };
  const stop = startSeedSampler(slow as never, 'stub-db', join(dir, 'ok.jsonl'), 5);
  await new Promise(resolve => setTimeout(resolve, 150));
  await stop();
  assert.equal(maxActive, 2, 'only the two commands of one sample run at once');
  const rows = readFileSync(join(dir, 'ok.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length >= 2 && rows.length === calls / 2);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].startedAtMs >= rows[i - 1].startedAtMs);
  const failing = startSeedSampler((async () => ({ code: 1, stdout: '' })) as never, 'stub-db', join(dir, 'bad.jsonl'), 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(failing, /Database samples are incomplete/);
});

test('autovacuum statistics lines are kept only after an autovacuum header and in strict numeric form', () => {
  const ts = '2026-11-22T00:00:00.000000000Z ';
  const header = ts + '2026-11-22 00:00:00.000 UTC [42] LOG:  automatic vacuum of table "fukulow.public.messages": index scans: 1';
  const stats = [
    ts + '\tavg read rate: 1.000 MB/s, avg write rate: 2.000 MB/s',
    ts + '\tbuffer usage: 10 hits, 2 reads, 3 dirtied',
    ts + '\tWAL usage: 5 records, 1 full page images, 900 bytes, 0 buffers full',
    ts + '\tsystem usage: CPU: user: 0.01 s, system: 0.00 s, elapsed: 1.25 s',
  ];
  const raw = [
    header, ts + '\tpages: 0 removed, 10 remain', ts + '\ttuples: 0 removed, 5 remain', ...stats, ts + '\tsecret continuation token',
    ts + '2026-11-22 00:00:01.000 UTC [43] ERROR:  duplicate key secret',
    stats[3],
  ].join('\n');
  assert.deepEqual(redactSeedDbLogs(raw).split('\n'), [
    header, ...stats, ts + '2026-11-22 00:00:01.000 UTC [43] ERROR:  [detail redacted]',
  ]);
});
