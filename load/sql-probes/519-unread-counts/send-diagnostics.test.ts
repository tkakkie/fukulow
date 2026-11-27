import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import type { DiagnosticBlock } from './disk-wait-summary.ts';
import { logLatenciesMs } from './probe.ts';
import { sendDiagnostics } from './send-diagnostics.ts';

test('WAL query and client-summary errors leave the legacy latencies and raw archive available', async t => {
  const out = mkdtempSync(join(tmpdir(), 'disk-wait-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const report: DiagnosticBlock[] = [];
  const diag = sendDiagnostics(out, 'block1-current', undefined, report);
  diag.wal('before', () => { throw new Error('diagnostic query failed'); });
  diag.start();
  const original = '0 1 1100 0 1700000000 1000000\n';
  const fetched = diag.log('pgbench', () => ['pgbench.12', original, ''].join('\0'));
  assert.deepEqual(logLatenciesMs(fetched), [1.1]);
  await diag.save(() => assert.fail('thread logs already fetched'));
  assert.deepEqual(report[0].errors, [
    'WAL I/O before: diagnostic query failed', 'missing a WAL I/O boundary snapshot',
    'per-client pgbench summary: bad pgbench log line: ' + original.trim(),
  ]);
  const path = join(out, 'disk-wait', 'block1-current');
  assert.equal(gunzipSync(readFileSync(join(path, 'pgbench', 'pgbench.12.gz'))).toString(), original);
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'errors.json'), 'utf8')), report[0].errors);
});
