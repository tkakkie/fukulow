import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NativeStall } from './revocation-holds-native-stall.ts';
import { emptyLog, readLogLine } from './revocation-holds-log.ts';
import { requirePreflight, requireReadbacks, requireSendBuffers, SetupAbort, startStall, targetSendBuffers } from './revocation-holds-setup.ts';

const readback = (after: number) => ({ before: 32_768, after });

test('SA1 reports an absent native helper as a setup abort', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-no-helper-'));
  const helper = new NativeStall(join(dir, 'missing'), 1, 2);
  t.after(async () => { await helper.close(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(startStall(() => helper.listening()), SetupAbort);
});

test('SA1 requires a started helper and a post-connect value per target matching the host preflight', async () => {
  const expected = [readback(32_768), readback(32_768)];
  assert.deepEqual(await requireReadbacks(async () => expected, 2, 32_768), expected);
  for (const rows of [expected.slice(0, 1), [expected[0], readback(16_384)], [expected[0], readback(32_767)]]) {
    await assert.rejects(requireReadbacks(async () => rows, 2, 32_768), SetupAbort);
  }
  await assert.rejects(startStall(async () => { throw new Error('ENOENT'); }),
    error => error instanceof SetupAbort && error.message === 'SA1: stall helper did not start: ENOENT');
});

test('SA1 aborts when all targets agree on a value different from the recorded preflight', async () => {
  const rows = [readback(16_384), readback(16_384)];
  await assert.rejects(requireReadbacks(async () => rows, 2, 32_768), SetupAbort);
});

test('preflight discovers a positive post-connect value shared by all targets', async () => {
  assert.equal(requirePreflight({ kind: 'preflight', sendBuffer: 16_384 }), undefined);
  const rows = [readback(55_555), readback(55_555)];
  assert.deepEqual(await requireReadbacks(async () => rows, 2), rows);
  for (const bad of [[], [readback(0), readback(0)], [readback(55_555), readback(55_556)]]) {
    await assert.rejects(requireReadbacks(async () => bad, 2), SetupAbort);
  }
});

test('SA1 requires exactly one matching server SO_SNDBUF per target upstream port', () => {
  const log = emptyLog();
  const targets = [{ upstreamPort: 1000, ...readback(32_768) }, { upstreamPort: 2000, ...readback(32_768) }];
  const record = (peer_port: number, effective: unknown) =>
    readLogLine(log, JSON.stringify({ target: 'fukulow', fields: { event: 'measurement_send_buffer', peer_port, effective } }), 0);
  record(3000, 32_768); // An unrelated accepted connection cannot fill a missing target slot.
  record(2000, 32_768);
  record(1000, '32768');
  assert.throws(() => requireSendBuffers(targetSendBuffers(targets, log.sendBuffers)), SetupAbort);
  record(1000, 32_768);
  const rows = targetSendBuffers(targets, log.sendBuffers);
  assert.equal(requireSendBuffers(rows, 32_768), 32_768);
  assert.throws(() => requireSendBuffers([], 32_768), SetupAbort);
  assert.throws(() => requireSendBuffers(rows, 16_384), SetupAbort);
  assert.throws(() => requireSendBuffers(targetSendBuffers([targets[0], targets[0]], log.sendBuffers)), SetupAbort);
  record(2000, 32_768);
  assert.throws(() => requireSendBuffers(targetSendBuffers(targets, log.sendBuffers)), SetupAbort);
});
