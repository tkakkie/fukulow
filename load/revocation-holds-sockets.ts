// Establish the #668 WebSocket fixture before the baseline.
import type { ClientMessage, ServerEvent } from '../web/src/api-schema.d.ts';
import type { SocketClose } from './revocation-holds-e6.ts';
import type { Notice, TargetSocket } from './revocation-holds-judgment.ts';
import { socketAccount, targetSockets, type PlannedRun } from './revocation-holds-plan.ts';
import { SetupAbort } from './revocation-holds-setup.ts';

// Matches the per-Channel watermark Semaphore::new(4) in server/src/messages/admission.rs.
const TARGET_BATCH_SIZE = 4;
const TARGET_BATCH_TIMEOUT_MS = 10_000;

type Phase = 'scored' | 'extension' | 'stopping';
type Member = { id: string; token: string };
type Fixture = { org: string; stallChannel: string; targets: Member[]; bystanders: Member[] };
type Stage = 'queued' | 'opening' | 'activity_ready' | 'subscribe_sent' | 'subscribed' | 'failed';
export type TargetSubscription = {
  socket: number;
  memberId: string;
  channelId: string;
  stages: { stage: Stage; atMs: number; reason?: string }[];
};

function stage(subscription: TargetSubscription, name: Stage, reason?: string) {
  subscription.stages.push({ stage: name, atMs: performance.now(), reason });
}

function targetReason({ socket, memberId, channelId }: TargetSubscription, reason: string) {
  return `socket ${socket}, Member ${memberId}, Channel ${channelId}: ${reason}`;
}

export async function openSockets(
  active: { sockets?: WebSocket[] }, fixture: Fixture, run: PlannedRun, appPort: number, proxyPorts: number[],
  recordSubscriptions: (subscriptions: TargetSubscription[]) => void,
) {
  const targets: TargetSocket[] = [], notices: Notice[] = [], sockets: WebSocket[] = [];
  const state = { bystandersReady: 0, bystanderNotices: 0, bystanderCloses: [] as number[], lateBystanderCloses: [] as SocketClose[], phase: 'scored' as Phase, receiptsFrozen: false };
  const open = (port: number, token: string, onMessage: (socket: WebSocket, message: ServerEvent) => void, onClose: (code: number, phase: 'scored' | 'extension') => void) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/orgs/${fixture.org}/ws`, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
    socket.onmessage = event => onMessage(socket, JSON.parse(String(event.data)) as ServerEvent);
    socket.onclose = event => { if (state.phase !== 'stopping') onClose(event.code, state.phase); };
    sockets.push(socket);
    return socket;
  };
  active.sockets = sockets;

  // queued and opening timestamp the harness batch queue on the same clock as the baseline.
  const subscriptions: TargetSubscription[] = Array.from({ length: targetSockets(run.cell) }, (_, socket) => ({
    socket, memberId: fixture.targets[socketAccount(socket)].id, channelId: fixture.stallChannel,
    stages: [{ stage: 'queued', atMs: performance.now() }],
  }));
  let settingUp = true;
  let setupFailure: string | undefined;
  let failBatch: ((reason: string) => void) | undefined;
  const failSubscribed = (subscription: TargetSubscription, reason: string) => {
    if (!settingUp || setupFailure !== undefined) return;
    setupFailure = targetReason(subscription, reason);
    failBatch?.(setupFailure);
  };
  const requireTargetsOpen = () => {
    if (!settingUp) return;
    if (setupFailure !== undefined) throw new SetupAbort(`target WebSocket setup: ${setupFailure}`);
    for (const subscription of subscriptions) {
      const { readyState } = sockets[subscription.socket];
      if (readyState !== WebSocket.OPEN) {
        const reason = targetReason(subscription, `not open after subscribed (readyState ${readyState})`);
        throw new SetupAbort(`target WebSocket setup: ${reason}`);
      }
    }
  };
  const endSetup = () => {
    requireTargetsOpen();
    settingUp = false;
  };

  try {
    for (let first = 0; first < subscriptions.length; first += TARGET_BATCH_SIZE) {
      if (setupFailure !== undefined) throw new SetupAbort(`target WebSocket setup: ${setupFailure}`);
      const batch = subscriptions.slice(first, first + TARGET_BATCH_SIZE);
      await new Promise<void>((resolve, reject) => {
        const pending = new Set(batch);
        const fail = (reason: string) => {
          failBatch = undefined;
          clearTimeout(timer);
          for (const subscription of pending) stage(subscription, 'failed', reason);
          pending.clear();
          reject(new SetupAbort(`target WebSocket setup: ${reason}`));
        };
        const timer = setTimeout(() => {
          const missing = [...pending].map(row => row.socket).join(', ');
          fail(`Channel ${fixture.stallChannel} missing subscribed acknowledgment after ${TARGET_BATCH_TIMEOUT_MS} ms for sockets ${missing}`);
        }, TARGET_BATCH_TIMEOUT_MS);
        failBatch = fail;
        for (const subscription of batch) {
          const i = subscription.socket;
          const target: TargetSocket = { account: socketAccount(i), ready: false, subscribed: false, stall: { reads: [], closes: [], pausedAt: [], resumedAt: [] }, stallMessages: [] };
          targets.push(target);
          const failSocket = (reason: string) => {
            if (pending.has(subscription)) fail(targetReason(subscription, reason));
          };
          stage(subscription, 'opening');
          try {
            const socket = open(proxyPorts[i], fixture.targets[target.account].token, (socket, message) => {
              if (message.type === 'message' && message.kind === 'create' && message.message.channel_id === fixture.stallChannel) {
                const receipt = { id: message.message.id, clientMessageId: message.message.client_message_id, at: performance.now() };
                if (!state.receiptsFrozen) target.stallMessages.push(receipt);
                else if (state.phase === 'extension') (target.lateStallMessages ??= []).push(receipt);
                return;
              }
              if (state.receiptsFrozen) return;
              if (message.type === 'activity_ready' && !target.ready && pending.has(subscription)) {
                target.ready = true;
                stage(subscription, 'activity_ready');
                const subscribe: ClientMessage = { type: 'subscribe', channel_id: fixture.stallChannel, after_seq: 0 };
                try {
                  socket.send(JSON.stringify(subscribe));
                  stage(subscription, 'subscribe_sent');
                } catch { failSocket('could not send subscribe'); }
              } else if (message.type === 'subscribed' && message.channel_id === fixture.stallChannel && target.ready && pending.delete(subscription)) {
                target.subscribed = true;
                stage(subscription, 'subscribed');
                if (pending.size === 0) {
                  failBatch = undefined;
                  clearTimeout(timer);
                  resolve();
                }
              } else if (message.type === 'error' && message.channel_id === fixture.stallChannel) {
                failSocket(`subscribe rejected (${message.code})`);
              } else if (message.type === 'channel_access_revoked') {
                notices.push({ socket: i, channelId: message.channel_id ?? null, at: performance.now() });
              }
            }, (code, phase) => {
              const close = { at: performance.now(), code };
              if (phase === 'extension') {
                target.lateClose = close;
                return;
              }
              target.close = close;
              if (target.subscribed) failSubscribed(subscription, `closed after subscribed (code ${code})`);
              else failSocket(`closed before subscribed (code ${code})`);
            });
            socket.onerror = () => {
              if (state.phase !== 'scored') return;
              if (target.subscribed) failSubscribed(subscription, 'WebSocket error after subscribed');
              else failSocket('WebSocket error before subscribed');
            };
          } catch {
            failSocket('could not open WebSocket');
            break;
          }
        }
      });
      if (setupFailure !== undefined) throw new SetupAbort(`target WebSocket setup: ${setupFailure}`);
    }
  } finally {
    recordSubscriptions(subscriptions);
  }
  for (const member of fixture.bystanders) {
    open(appPort, member.token, (_, message) => {
      if (state.receiptsFrozen) return;
      if (message.type === 'activity_ready') state.bystandersReady++;
      else if (message.type === 'channel_access_revoked') state.bystanderNotices++;
    }, (code, phase) => {
      const at = performance.now();
      if (phase === 'extension') state.lateBystanderCloses.push({ at, code });
      else state.bystanderCloses.push(at);
    });
    if (sockets.length % 100 === 0) await new Promise(resolve => setTimeout(resolve, 100)); // match #592 upgrade pacing
  }
  const endScoredCloses = (observeMs: number) => { state.phase = observeMs > 0 ? 'extension' : 'stopping'; };
  const freezeScoredReceipts = () => { state.receiptsFrozen = state.phase === 'extension'; };
  const stop = () => { state.phase = 'stopping'; };
  return { targets, notices, state, requireTargetsOpen, endSetup, endScoredCloses, freezeScoredReceipts, stop };
}
