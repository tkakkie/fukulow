import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTrace } from './revocation-holds-trace.ts';
import { parseSendBuffer, spawnMeasuredServer, stopMeasuredServer } from './revocation-measured-server.ts';

for (const events of [true, false]) {
  test(`measured server trace mode ${events ? 'on' : 'off'} waits for graceful exit and the drain watermark`, { timeout: 5_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'revocation-stop-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const script = join(dir, 'server');
    writeFileSync(script, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const trace = process.env.FUKULOW_REVOCATION_TRACE_PATH;
if (process.env.FUKULOW_REVOCATION_MEASUREMENT !== '1') process.exit(4);
if (process.env.FUKULOW_REVOCATION_TRACE_EVENTS !== '${events ? '1' : '0'}') process.exit(5);
if (process.env.FUKULOW_MEASUREMENT_SNDBUF !== ${events ? "'16384'" : 'undefined'}) process.exit(6);
writeFileSync(trace, '', { mode: 0o600, flag: 'wx' });
process.on('SIGTERM', () => setTimeout(() => {
  const fields = { event: 'revocation_trace_watermark', attempted: 0, written: 0, dropped: 0,
    timing_attempted: 0, timing_written: 0, timing_dropped: 0 };
  writeFileSync(trace, JSON.stringify({ target: 'fukulow_revocation_measurement', fields }) + '\\n');
  process.exit(0);
}, 30));
console.log('ready');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const server = spawnMeasuredServer(script, dir, 20000, 'stub', 'stub', events, [], events ? 16_384 : undefined);
    t.after(() => { if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); });
    await once(server.stdout!, 'data');
    assert.equal(readTrace(server.tracePath, false).watermark, undefined);
    assert.equal(await stopMeasuredServer(server, 1000), true);
    assert.equal(server.exitCode, 0);
    assert.deepEqual(readTrace(server.tracePath, true).evidenceErrors, []);
  });
}

test('the measurement runner requires an explicit positive socket option in range', () => {
  assert.equal(parseSendBuffer('16384'), 16_384);
  for (const invalid of [undefined, '', '0', '-1', '+1', '4.5', '1e4', '2147483648']) {
    assert.throws(() => parseSendBuffer(invalid), /FUKULOW_MEASUREMENT_SNDBUF/);
  }
});

test('graceful shutdown has a bounded timeout and a forced stop cannot attest to drainage', { timeout: 5_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-timeout-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const script = join(dir, 'server');
  writeFileSync(script, `#!${process.execPath}
process.on('SIGTERM', () => {});
console.log('ready');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const server = spawnMeasuredServer(script, dir, 20000, 'stub', 'stub');
  t.after(() => { if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); });
  await once(server.stdout!, 'data');
  assert.equal(await stopMeasuredServer(server, 50), false);
  assert.equal(server.signalCode, 'SIGKILL');
  assert.equal(await stopMeasuredServer(server, 50), false);
});
