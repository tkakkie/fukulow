import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { CELLS, targetSockets, type PlannedRun } from './revocation-holds-plan.ts';
import { SetupAbort } from './revocation-holds-setup.ts';
import { openSockets, type TargetSubscription } from './revocation-holds-sockets.ts';

const slot = { kind: 'fault', cell: 'H512', duration: 'short', repeat: 1 } as const;

function fakeSockets(t: TestContext, run: PlannedRun) {
  const count = targetSockets(run.cell);
  const appPort = 20000;
  const proxyPorts = Array.from({ length: count }, (_, i) => appPort + i + 1);
  const member = (i: number) => ({ id: `member-${i}`, token: `token-${i}` });
  const fixture = {
    org: 'org', stallChannel: 'stall',
    targets: Array.from({ length: CELLS[run.cell].accounts }, (_, i) => member(i)),
    bystanders: [member(count), member(count + 1)],
  };
  const opened: FakeWebSocket[] = [];
  class FakeWebSocket {
    readonly port: number;
    readonly sent: unknown[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;

    constructor(url: string) {
      this.port = Number(new URL(url).port);
      opened.push(this);
    }

    send(data: string) { this.sent.push(JSON.parse(data)); }
    receive(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
    close(code: number) { this.onclose?.({ code }); }
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  return { fixture, appPort, proxyPorts, opened };
}

test('all 96 target subscriptions acknowledge in batches before bystanders and baseline', { timeout: 1_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = { ...slot, cell: 'Hcap' } as const;
  const { fixture, appPort, proxyPorts, opened } = fakeSockets(t, run);
  const count = proxyPorts.length;
  assert.equal(count, 96);

  let acknowledged = 0;
  let acknowledgmentsAtBaseline: number | undefined;
  const setup = openSockets({}, fixture, run, appPort, proxyPorts, () => {}).then(result => {
    acknowledgmentsAtBaseline = acknowledged;
    return result;
  });
  void setup.catch(() => {});
  const acknowledge = (socket: typeof opened[number]) => {
    acknowledged++;
    socket.receive({ type: 'subscribed', channel_id: fixture.stallChannel });
  };
  for (let first = 0; first < count; first += 4) {
    const end = first + 4;
    await setImmediate();
    assert.deepEqual(opened.map(socket => socket.port), proxyPorts.slice(0, end));
    const batch = opened.slice(first);
    for (const socket of batch) {
      socket.receive({ type: 'activity_ready' });
      assert.deepEqual(socket.sent, [{ type: 'subscribe', channel_id: fixture.stallChannel, after_seq: 0 }]);
    }
    for (const socket of batch.slice(0, -1)) acknowledge(socket);
    await setImmediate();
    assert.equal(opened.length, end);
    assert.equal(acknowledgmentsAtBaseline, undefined);
    acknowledge(batch[batch.length - 1]);
  }
  const result = await setup;
  assert.deepEqual(opened.map(socket => socket.port), [...proxyPorts, appPort, appPort]);
  assert.equal(acknowledgmentsAtBaseline, 96);
  assert.equal(result.targets.filter(target => target.subscribed).length, 96);
});

test('a missing target acknowledgment aborts setup at the batch deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fixture, appPort, proxyPorts, opened } = fakeSockets(t, slot);
  const setup = openSockets({}, fixture, slot, appPort, proxyPorts, () => {});
  const rejected = assert.rejects(setup, (error: unknown) =>
    error instanceof SetupAbort && /missing subscribed acknowledgment .* for sockets 3$/.test(error.message));
  for (const socket of opened) socket.receive({ type: 'activity_ready' });
  for (const socket of opened.slice(0, 3)) socket.receive({ type: 'subscribed', channel_id: fixture.stallChannel });
  opened[3].receive({ type: 'subscribed', channel_id: 'another-channel' });
  t.mock.timers.runAll();
  await rejected;
  assert.equal(opened.length, 4);
});

test('a target closing before acknowledgment aborts setup and records its stages', async t => {
  const { fixture, appPort, proxyPorts, opened } = fakeSockets(t, slot);
  let recorded: TargetSubscription[] = [];
  const setup = openSockets({}, fixture, slot, appPort, proxyPorts, rows => { recorded = rows; });
  opened[0].receive({ type: 'activity_ready' });
  opened[0].close(1011);
  await assert.rejects(setup, (error: unknown) =>
    error instanceof SetupAbort && /socket 0, Member member-0, Channel stall: closed before subscribed \(code 1011\)/.test(error.message));
  assert.equal(opened.length, 4);
  const { memberId, channelId, stages } = recorded[0];
  assert.equal(memberId, 'member-0');
  assert.equal(channelId, 'stall');
  assert.deepEqual(stages.map(stage => stage.stage), ['queued', 'opening', 'activity_ready', 'subscribe_sent', 'failed']);
  const times = stages.map(stage => stage.atMs);
  assert.deepEqual(times, times.toSorted((a, b) => a - b));
});
