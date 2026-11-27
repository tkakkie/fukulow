import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileStall, type StallReceipt, type StallRow, type StallSend } from './revocation-holds-e6.ts';
import { targetSockets } from './revocation-holds-plan.ts';

type Input = Parameters<typeof reconcileStall>[0];
const send = (id: string, status = 201, error?: string): StallSend => ({
  clientMessageId: `client-${id}`, sender: 'sender', startedAt: 5, endedAt: 6, status,
  ...(status === 201 ? { messageId: id } : { error }),
});
const row = (id: string): StallRow => ({ id, client_message_id: `client-${id}`, sender: 'sender', seq: 1, created_at: '2026-11-27T00:00:00Z' });
const receipt = (id: string, at = 10): StallReceipt => ({ id, clientMessageId: `client-${id}`, at });
const fixture = (sends = [send('a')], rows = [row('a')]): Input => ({
  stall: { senders: 1, messages: sends.length, chars: 1 },
  cell: 'H512', sends, snapshot: { rows },
  targets: Array.from({ length: targetSockets('H512') }, () => ({ stallMessages: rows.map(r => receipt(r.id)) })),
  observation: { scoredCutoffAt: 10, requestedMs: 60_000, completed: true },
});

test('E6 classifies sends by sender and client ID, then uses the worst target delivery', () => {
  const sends = [
    send('reject', 503, 'send admission unavailable'), send('timeout', 0, 'timeout'), send('network', 0, 'network'),
    send('other', 503, 'send limiter unavailable'), send('absent'), send('mismatch'), send('on-time'),
    send('late'), send('never'), send('c-ontime', 500), send('c-late', 0, 'timeout'), send('c-never', 0, 'network'),
    { ...send('on-time', 503), sender: 'other-sender' },
  ];
  const rows = [{ ...row('mismatch'), id: 'canonical' }, ...['on-time', 'late', 'never', 'c-ontime', 'c-late', 'c-never'].map(row)];
  const input = fixture(sends, rows);
  input.targets.forEach(target => { target.stallMessages = target.stallMessages.map(r => r.id === 'canonical' ? { ...r, clientMessageId: 'client-mismatch' } : r); });
  const lagging = input.targets[0];
  lagging.stallMessages = lagging.stallMessages.filter(r => !['late', 'never', 'c-late', 'c-never'].includes(r.id));
  lagging.lateStallMessages = [receipt('late', 11), receipt('c-late', 12)];
  lagging.lateClose = { at: 15, code: 1011 };
  const result = reconcileStall(input);
  assert.equal(result.status, 'CLASSIFIED');
  assert.deepEqual(result.messages.map(message => [
    message.send.clientMessageId, message.category, 'delivery' in message ? message.delivery : message.reason,
  ]), [
    ['client-reject', 'send-rejected', '503 send admission'], ['client-timeout', 'send-rejected', 'timeout'],
    ['client-network', 'send-rejected', 'network'], ['client-other', 'send-rejected', 'other'],
    ['client-absent', 'accepted-not-persisted', undefined], ['client-mismatch', 'accepted-not-persisted', 'on-time'],
    ['client-on-time', 'accepted-persisted', 'on-time'], ['client-late', 'accepted-persisted', 'late'],
    ['client-never', 'accepted-persisted', 'never'], ['client-c-ontime', 'persisted-client-failure', 'on-time'],
    ['client-c-late', 'persisted-client-failure', 'late'], ['client-c-never', 'persisted-client-failure', 'never'],
    ['client-on-time', 'send-rejected', 'other'],
  ]);
  assert.deepEqual(result.messages.find(m => m.send.clientMessageId === 'client-c-never')?.targets?.[0], {
    socket: 0, delivery: 'never', receiptAt: undefined, close: { at: 15, code: 1011 },
  });
  assert.equal(result.messages.find(m => m.send.clientMessageId === 'client-never')?.targets?.[1].receiptAt, 10);
});

test('E6 requires the configured stall volume or preflight volume, unique keys and every target', () => {
  const input = fixture();
  input.stall = { senders: 2, messages: 3, chars: 1 };
  input.targets.pop();
  assert.deepEqual(reconcileStall(input).issues, ['expected 6 send records, got 1', 'expected 32 targets, got 31']);
  input.preflightVolume = 1;
  input.targets.push({ stallMessages: [receipt('a')] });
  assert.equal(reconcileStall(input).status, 'CLASSIFIED');
  input.sends.push(send('a'));
  input.preflightVolume = 2;
  assert.match(reconcileStall(input).issues[0], /duplicate/);
});

test('E6 rejects a snapshot error, orphan rows, orphan receipts in either phase and wrong client IDs', () => {
  const input = fixture();
  const readFailed = reconcileStall({ ...input, snapshot: { error: 'query failed' } });
  assert.equal(readFailed.status, 'INCONCLUSIVE');
  assert.deepEqual(readFailed.messages, []);
  assert.match(readFailed.issues[0], /snapshot error: query failed/);

  input.snapshot = { rows: [row('a'), { ...row('a'), id: 'other-row', sender: 'other-sender' }] };
  input.targets[0].stallMessages.push(receipt('orphan-scored'));
  input.targets[0].lateStallMessages = [receipt('orphan-late'), { ...receipt('a'), clientMessageId: 'wrong' }];
  const invalid = reconcileStall(input);
  assert.equal(invalid.status, 'INCONCLUSIVE');
  assert.match(invalid.issues.join('\n'), /row other-row has no send.*\n.*orphan-scored.*\n.*orphan-late.*\n.*different client Message ID/);
});

test('E6 distinguishes an open missing socket from a close at or before the cut-off', () => {
  const input = fixture();
  input.targets[0].stallMessages = [];
  assert.equal(reconcileStall(input).messages[0].delivery, 'never');

  input.observation = { scoredCutoffAt: 10, requestedMs: 0, completed: false };
  assert.equal(reconcileStall(input).status, 'INCONCLUSIVE');
  assert.equal(reconcileStall(input).messages[0].delivery, 'unknown');
  input.targets[0].close = { at: 10, code: 4008 };
  assert.equal(reconcileStall(input).status, 'CLASSIFIED');
  assert.equal(reconcileStall(input).messages[0].delivery, 'never');

  delete input.targets[0].close;
  input.observation.requestedMs = 60_000;
  input.targets[0].lateClose = { at: 11, code: 4008 };
  assert.equal(reconcileStall(input).status, 'INCONCLUSIVE');
  input.targets[0].lateClose.at = 9;
  assert.equal(reconcileStall(input).status, 'CLASSIFIED');

  delete input.targets[0].lateClose;
  input.targets[0].stallMessages = [receipt('a')];
  assert.equal(reconcileStall(input).status, 'CLASSIFIED');
  assert.equal(reconcileStall(input).messages[0].delivery, 'on-time');
});
