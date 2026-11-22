import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresCommand, redactSeedDbLogs } from './dms-formal-seed-diagnostic.ts';

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

test('DB log keeps checkpoint frequency warnings and checkpoint write/sync timings, not their hints', () => {
  const prefix = '2026-11-22T00:00:00.000000000Z 2026-11-22 00:00:00.000 UTC [7] ';
  const kept = [
    'LOG:  checkpoints are occurring too frequently (24 seconds apart)',
    'LOG:  checkpoint starting: wal',
    'LOG:  checkpoint complete: wrote 16384 buffers (100.0%), wrote 3 SLRU buffers; 0 WAL file(s) added, 0 removed, 33 recycled; write=26.912 s, sync=9.204 s, total=36.301 s; sync files=41, longest=8.771 s, average=0.225 s; distance=540672 kB, estimate=540672 kB; lsn=4/1A000000, redo lsn=4/10000028',
  ].map(line => prefix + line);
  const raw = [kept[0], prefix + 'HINT:  Consider increasing the configuration parameter "max_wal_size".', kept[1], kept[2],
    prefix + 'LOG:  checkpoints are occurring too frequently (24 seconds apart) secret'].join('\n');
  assert.deepEqual(redactSeedDbLogs(raw).split('\n'), kept);
});
