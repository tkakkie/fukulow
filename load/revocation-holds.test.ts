import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import { emptyLog, readLogLine, wallMs } from './revocation-holds-log.ts';
import { CELL_NAMES, checkStall, parseOptions, planRuns, potentialHolds, restoreAccount, runId, socketAccount, stallBody, STALL_DEFAULT, targetSockets } from './revocation-holds-plan.ts';
import { holdsEndSamples, retriesWithin, retryPeakPerSecond, timedSamples } from './revocation-holds-samples.ts';
import { bytesBetween, StallProxy } from './revocation-holds-stall.ts';

test('fixture shapes match the pre-registered matrix', () => {
  assert.deepEqual(CELL_NAMES.map(cell => [cell, targetSockets(cell), potentialHolds(cell)]), [
    ['H512', 32, 512], ['H2048', 32, 2048], ['H4096', 64, 4096], ['Hcap', 96, 6144], ['Hfence', 64, 4096],
  ]);
  assert.deepEqual(CELL_NAMES.map(restoreAccount), [undefined, undefined, undefined, undefined, 1]);
  assert.deepEqual([0, 31, 32, 63, 64, 95].map(socketAccount), [0, 0, 1, 1, 2, 2]);
});

test('the default plan has 30 fault runs and 15 controls, interleaved', () => {
  const runs = planRuns(CELL_NAMES, ['short', 'long'], 3, true);
  assert.equal(runs.filter(r => r.kind === 'fault').length, 30);
  assert.equal(runs.filter(r => r.kind === 'control').length, 15);
  assert.equal(new Set(runs.map(runId)).size, 45);
  assert.deepEqual(runs.slice(0, 3).map(runId), ['H512-short-r1', 'H512-long-r1', 'H512-control-r1']);
  assert.deepEqual(runs.slice(15, 18).map(runId), ['Hfence-control-r2', 'Hfence-long-r2', 'Hfence-short-r2']);
  for (const cell of CELL_NAMES) assert.equal(runs.filter(r => r.kind === 'control' && r.cell === cell).length, 3);
  assert.equal(planRuns(['H512'], ['long'], 1, false).map(runId).join(), 'H512-long-r1');
});

test('options validate cells, durations, repeats, controls and the stall', () => {
  const defaults = parseOptions(['--out', '/x']);
  assert.deepEqual(defaults, { out: '/x', cells: CELL_NAMES, durations: ['short', 'long'], repeats: 3, controls: true, rehearsal: false, stall: STALL_DEFAULT });
  const rehearsal = parseOptions(['--out', '/x', '--cells', 'H512,Hcap', '--durations', 'long', '--repeats', '1', '--controls', 'off', '--rehearsal']);
  assert.deepEqual([rehearsal.cells, rehearsal.repeats, rehearsal.controls, rehearsal.rehearsal], [['H512', 'Hcap'], 1, false, true]);
  // A formal run is the registered 3 repeats with controls; a subset of cells is a formal rerun.
  assert.throws(() => parseOptions(['--out', '/x', '--repeats', '1']), /formal run/);
  assert.throws(() => parseOptions(['--out', '/x', '--repeats', '4']), /formal run/);
  assert.throws(() => parseOptions(['--out', '/x', '--controls', 'off']), /formal run/);
  assert.equal(parseOptions(['--out', '/x', '--cells', 'Hcap', '--durations', 'long']).rehearsal, false);
  assert.throws(() => parseOptions([]), /--out/);
  assert.throws(() => parseOptions(['--out', '/x', '--cells', 'H9']), /--cells/);
  assert.throws(() => parseOptions(['--out', '/x', '--durations', 'medium']), /--durations/);
  assert.throws(() => parseOptions(['--out', '/x', '--repeats', '0']), /--repeats/);
  assert.throws(() => parseOptions(['--out', '/x', '--controls', 'yes']), /--controls/);
});

test('stall options stay within the send burst, the body limit and half the live queue', () => {
  assert.equal(STALL_DEFAULT.senders * STALL_DEFAULT.messages, 80);
  assert.deepEqual(checkStall({ senders: 12, messages: 10, chars: 4000 }), { senders: 12, messages: 10, chars: 4000 });
  assert.throws(() => checkStall({ senders: 13, messages: 10, chars: 4000 }), /at most 128/);
  assert.throws(() => checkStall({ senders: 1, messages: 11, chars: 4000 }), /send limit/);
  assert.throws(() => checkStall({ senders: 1, messages: 1, chars: 4001 }), /characters/);
  assert.throws(() => checkStall({ senders: 0, messages: 1, chars: 1 }), /positive/);
  const body = stallBody(4000);
  assert.equal([...body].length, 4000);
  assert.equal(Buffer.byteLength(body), 16_000);
});

test('the log reader keeps holds samples, send records, clock samples and 60 s events', () => {
  const log = emptyLog();
  const line = (target: string, fields: Record<string, unknown>) => JSON.stringify({ target, fields });
  const measurement = 'fukulow_revocation_measurement';
  readLogLine(log, line(measurement, { event: 'revocation_holds_sample', server_ms: 12.5, active_holds: 3, high_water_mark: 9, retry_attempts: 40 }), 1);
  readLogLine(log, line(measurement, { event: 'revocation_holds_sample', server_ms: 13, active_holds: 'x', high_water_mark: 9, retry_attempts: 40 }), 1);
  readLogLine(log, line(measurement, { event: 'channel_access_revoked_sent', channel_id: 'c', before_ms: 5, after_ms: 6, after_hold: true }), 1);
  readLogLine(log, line(measurement, { event: 'channel_access_revoked_sent', channel_id: 'c', before_ms: 7, after_ms: 6 }), 1);
  readLogLine(log, JSON.stringify({ timestamp: '2026-11-22T00:00:01.123456Z', target: measurement, fields: { event: 'revocation_clock_sample', server_ms: 4 } }), 1);
  readLogLine(log, line('fukulow', { event: 'metrics', revocation_held: 2, label: 'x' }), 7);
  readLogLine(log, JSON.stringify({ timestamp: '2026-11-22T00:00:02.5Z', target: 'fukulow', fields: { event: 'pool_stats', waiting: 1 } }), 8);
  readLogLine(log, line('fukulow', { event: 'websocket_closed', reason: 'revoked' }), 8.5);
  readLogLine(log, 'not json', 9);
  assert.deepEqual(log, {
    clock: [4], clockWall: [Date.parse('2026-11-22T00:00:01Z') + 123.456], sends: [{ channelId: 'c', beforeMs: 5, afterMs: 6, afterHold: true }],
    holds: [{ serverMs: 12.5, activeHolds: 3, highWaterMark: 9, retryAttempts: 40 }],
    pool: [{ at: 8, fields: { waiting: 1 }, wallMs: Date.parse('2026-11-22T00:00:02.500Z') }], metrics: [{ at: 7, fields: { revocation_held: 2 } }], closes: [{ at: 8.5, wallMs: undefined }],
  });
});

test('tracing timestamps parse to epoch ms with microseconds', () => {
  assert.equal(wallMs('2026-11-22T10:20:30.000001Z'), Date.parse('2026-11-22T10:20:30Z') + 0.001);
  assert.equal(wallMs('2026-11-22T10:20:30Z'), Date.parse('2026-11-22T10:20:30Z'));
  for (const bad of [undefined, 5, '2026-11-22 10:20:30Z', '2026-11-22T10:20:30.5+09:00', 'x']) assert.equal(wallMs(bad), undefined);
});

test('samples convert to the harness clock and bracket windows conservatively', () => {
  const samples = timedSamples({ sendTiming: { offsetBoundsMs: [100, 110], uncertaintyMs: 5, records: [] }, samples: [
    { serverMs: 1_250, activeHolds: 0, highWaterMark: 0, retryAttempts: 50 },
    { serverMs: 1_000, activeHolds: 0, highWaterMark: 0, retryAttempts: 0 },
    { serverMs: 1_500, activeHolds: 0, highWaterMark: 0, retryAttempts: 400 },
    { serverMs: 1_750, activeHolds: 0, highWaterMark: 0, retryAttempts: 900 },
  ] });
  assert.deepEqual(samples.map(s => [s.low, s.at, s.high]), [[1_100, 1_105, 1_110], [1_350, 1_355, 1_360], [1_600, 1_605, 1_610], [1_850, 1_855, 1_860]]);
  // From 1_100: the 1_000 sample is certainly at or after it. To 1_610: the 1_500 sample is certainly before.
  assert.equal(retriesWithin(samples, 1_100, 1_610).retries, 400);
  assert.equal(retriesWithin(samples, 1_101, 1_609).retries, 0);
  assert.equal(retriesWithin(samples, 1_101, 1_860).retries, 850);
  const end = (earliest: number, latest: number) => holdsEndSamples(samples, earliest - 10_000, latest - 10_000).map(s => s.serverMs);
  assert.deepEqual(end(1_350, 1_350), [1_250]);
  // 1_250 (high 1_360) may lie after 1_351; 1_500 (low 1_600) certainly does.
  assert.deepEqual(end(1_351, 1_351), [1_250, 1_500]);
  assert.deepEqual(end(1_361, 1_361), [1_500]);
  // A release anywhere in [1_100, 1_351]: every sample that may be the first after it.
  assert.deepEqual(end(1_100, 1_351), [1_000, 1_250, 1_500]);
  assert.deepEqual(end(1_100, 1_851), []);
  assert.equal(retryPeakPerSecond(samples, 0, 2_000), 900);
  assert.equal(retryPeakPerSecond(samples, 1_200, 2_000), 850);
  assert.deepEqual(timedSamples({ samples: [], sendTiming: undefined }), []);
});

async function proxied(t: { after: (fn: () => Promise<void> | void) => void }) {
  const server = createServer();
  const accepted = once(server, 'connection') as Promise<[Socket]>;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let now = 0;
  const proxy = new StallProxy({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }, () => now);
  const port = await proxy.listen();
  const client = connect(port, '127.0.0.1');
  await once(client, 'connect');
  const [upstream] = await accepted;
  t.after(async () => { client.destroy(); upstream.destroy(); await proxy.close(); await new Promise<void>(r => server.close(() => r())); });
  return { proxy, port, client, upstream, setNow: (value: number) => { now = value; } };
}
const settle = () => new Promise(r => setTimeout(r, 50));

test('the stall proxy stops reading upstream while paused and records the backlog after resume', { timeout: 5000 }, async t => {
  const { proxy, client, upstream, setNow } = await proxied(t);
  let received = 0;
  client.on('data', (chunk: Buffer) => { received += chunk.length; });
  upstream.write(Buffer.alloc(1000)); await settle();
  assert.equal(received, 1000);
  setNow(10); proxy.pause();
  upstream.write(Buffer.alloc(5000)); await settle();
  assert.equal(received, 1000);
  assert.equal(bytesBetween(proxy.record, 10, Infinity), 0);
  // Client-to-server bytes keep flowing during the pause.
  const toServer = once(upstream, 'data') as Promise<[Buffer]>;
  client.write('pong');
  assert.equal(String((await toServer)[0]), 'pong');
  setNow(20); proxy.resume(); await settle();
  assert.equal(received, 6000);
  assert.equal(bytesBetween(proxy.record, 20, Infinity), 5000);
  assert.equal(bytesBetween(proxy.record, 0, 10), 1000);
  assert.deepEqual([proxy.record.pausedAt, proxy.record.resumedAt], [[10], [20]]);
});

test('a paused proxy backs up into the kernel: the server-side write stays queued, then every byte arrives', { timeout: 15_000 }, async t => {
  const { proxy, client, upstream, setNow } = await proxied(t);
  let received = 0;
  client.on('data', (chunk: Buffer) => { received += chunk.length; });
  setNow(10); proxy.pause();
  const chunk = Buffer.alloc(64 * 1024);
  let written = 0;
  // Write until the bytes stay queued in user space after a pause of 200 ms: the kernel send and
  // receive buffers are then full, because nothing reads the proxy's upstream socket.
  for (let stuck = false; !stuck && written < 256 * 1024 * 1024;) {
    upstream.write(chunk); written += chunk.length;
    if (upstream.writableLength > 0) { await new Promise(r => setTimeout(r, 200)); stuck = upstream.writableLength > 0; }
  }
  assert.ok(upstream.writableLength > 0, 'the server-side write must stay queued while paused');
  assert.equal(bytesBetween(proxy.record, 10, Infinity), 0, 'the proxy must not read while paused');
  assert.equal(received, 0);
  setNow(20); proxy.resume();
  if (upstream.writableLength > 0) await once(upstream, 'drain');
  while (received < written) await new Promise(r => setTimeout(r, 20));
  assert.equal(received, written);
  assert.equal(bytesBetween(proxy.record, 20, Infinity), written);
});

test('the stall proxy records closes and serves one WebSocket only', { timeout: 5000 }, async t => {
  const { proxy, port, client, upstream, setNow } = await proxied(t);
  const second = connect(port, '127.0.0.1');
  await once(second, 'close');
  setNow(30); upstream.destroy();
  await once(client, 'close');
  assert.deepEqual(proxy.record.closes, [{ at: 30, side: 'upstream' }]);
});
