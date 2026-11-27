import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diskWaitMarkdown } from './disk-wait-summary.ts';

test('report-only table renders disk deltas, WAL counts, client percentiles and collection errors', () => {
  const md = diskWaitMarkdown([{
    label: 'block1-pref2', disk: [{ id: '259:0', name: 'nvme0n1', readsCompleted: 1, writesCompleted: 2,
      sectorsWritten: 30, msWriting: 4, flushesCompleted: null, msFlushing: null, ioTicks: 6, weightedMsInQueue: 7 }],
    wal: { wal: { wal_records: 50, wal_fpi: 2, wal_bytes: 3000, wal_buffers_full: 0 },
      backend: { 'client backend': { reads: 0, writes: 3, write_bytes: 4096, fsyncs: 2 } } },
    clients: [{ clientId: 0, count: 42, meanMs: 2.1, p50Ms: 1.1, p99Ms: 3.4 }], errors: ['disk sample | late'],
  }, { label: 'block2-f2', disk: [], clients: [], errors: [] }], { smoke: false });
  assert.match(md, /Report only\./);
  assert.ok(md.includes('| block1-pref2 | nvme0n1 (259:0) | 1 | 2 | 30 | 4 | — | — | 6 | 7 |'));
  assert.ok(md.includes('| block1-pref2 | 50 | 2 | 3000 | 0 |'));
  assert.ok(md.includes('| block1-pref2 | client backend | 0 | 3 | 4096 | 2 |'));
  assert.ok(md.includes('| block1-pref2 | 0 | 42 | 2.100 | 1.100 | 3.400 |'));
  assert.ok(md.includes('| block1-pref2 | disk sample \\| late |'));
  assert.ok(md.includes('| block2-f2 | — | — | — | — | — | — | — | — | — |'));
  assert.doesNotMatch(md, /STOP|PASS|verdict/);
});

test('smoke and setup or log collection failures are explicit', () => {
  const md = diskWaitMarkdown([], { smoke: true, setup: 'skipped in smoke: no /proc/diskstats', serverLogError: 'read failed' });
  assert.match(md, /TRIAL \/ NOT EVIDENCE/);
  assert.match(md, /Diskstats setup: skipped in smoke: no \/proc\/diskstats/);
  assert.match(md, /PostgreSQL log: read failed/);
});
