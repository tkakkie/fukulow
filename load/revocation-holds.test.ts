import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import { emptyLog, readLogLine } from './revocation-holds-log.ts';
import { CELL_NAMES, checkStall, parseOptions, planRuns, potentialHolds, restoreAccount, runId, socketAccount, stallBody, STALL_DEFAULT, targetSockets } from './revocation-holds-plan.ts';
import { holdsEndSample, retriesWithin, retryPeakPerSecond, timedSamples } from './revocation-holds-samples.ts';
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
  assert.deepEqual(defaults, { out: '/x', cells: CELL_NAMES, durations: ['short', 'long'], repeats: 3, controls: true, stall: STALL_DEFAULT });
  assert.deepEqual(parseOptions(['--out', '/x', '--cells', 'H512,Hcap', '--durations', 'long', '--repeats', '1', '--controls', 'off']).cells, ['H512', 'Hcap']);
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
  readLogLine(log, line(measurement, { event: 'revocation_clock_sample', server_ms: 4 }), 1);
  readLogLine(log, line('fukulow', { event: 'metrics', revocation_held: 2, label: 'x' }), 7);
  readLogLine(log, line('fukulow', { event: 'pool_stats', waiting: 1 }), 8);
  readLogLine(log, 'not json', 9);
  assert.deepEqual(log, {
    clock: [4], sends: [{ channelId: 'c', beforeMs: 5, afterMs: 6, afterHold: true }],
    holds: [{ serverMs: 12.5, activeHolds: 3, highWaterMark: 9, retryAttempts: 40 }],
    pool: [{ at: 8, fields: { waiting: 1 } }], metrics: [{ at: 7, fields: { revocation_held: 2 } }],
  });
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
  assert.equal(holdsEndSample(samples, 1_350 - 10_000)?.serverMs, 1_250);
  assert.equal(holdsEndSample(samples, 1_351 - 10_000)?.serverMs, 1_500);
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

test('a paused proxy lets the server-side send buffer fill', { timeout: 10_000 }, async t => {
  const { proxy, upstream } = await proxied(t);
  proxy.pause();
  const chunk = Buffer.alloc(64 * 1024);
  let written = 0;
  while (upstream.write(chunk) && written < 256 * 1024 * 1024) { written += chunk.length; await new Promise(r => setImmediate(r)); }
  assert.ok(upstream.writableNeedDrain, 'the server-side write must report backpressure');
  const drained = once(upstream, 'drain');
  proxy.resume();
  await drained;
});

test('the stall proxy records closes and serves one WebSocket only', { timeout: 5000 }, async t => {
  const { proxy, port, client, upstream, setNow } = await proxied(t);
  const second = connect(port, '127.0.0.1');
  await once(second, 'close');
  setNow(30); upstream.destroy();
  await once(client, 'close');
  assert.deepEqual(proxy.record.closes, [{ at: 30, side: 'upstream' }]);
});
