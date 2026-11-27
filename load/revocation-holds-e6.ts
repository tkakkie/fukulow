// Reconcile each stall send with persisted Messages and receipts from the original target sockets.
import { targetSockets, type Cell, type Stall } from './revocation-holds-plan.ts';

export type StallSend = {
  clientMessageId: string; sender: string; startedAt: number; endedAt: number; status: number;
  messageId?: string; error?: string;
};
export type StallRow = { id: string; client_message_id: string; sender: string; seq: number; created_at: string };
export type StallSnapshot = { rows: StallRow[] } | { error: string };
export type StallReceipt = { id: string; at: number; clientMessageId?: string };
export type SocketClose = { at: number; code: number };
type Target = {
  stallMessages: StallReceipt[]; lateStallMessages?: StallReceipt[];
  close?: SocketClose; lateClose?: SocketClose;
};
export type E6Observation = { requestedMs: number; scoredCutoffAt: number; completed: boolean };
type Delivery = 'on-time' | 'late' | 'never' | 'unknown';

const key = (sender: string, clientId: string) => JSON.stringify([sender, clientId]);
const rejection = ({ status, error }: StallSend) => {
  if (status === 0 && (error === 'timeout' || error === 'network')) return error;
  return status === 503 && error === 'send admission unavailable' ? '503 send admission' : 'other';
};

export function reconcileStall(
  { stall, preflightVolume, cell, sends, snapshot, targets, observation }: {
    stall: Stall; preflightVolume?: number; cell: Cell; sends: StallSend[];
    snapshot: StallSnapshot; targets: Target[]; observation: E6Observation;
  },
) {
  const expectedSends = preflightVolume ?? stall.senders * stall.messages;
  const issues: string[] = [];
  if (sends.length !== expectedSends) issues.push(`expected ${expectedSends} send records, got ${sends.length}`);
  const sendKeys = new Set(sends.map(send => key(send.sender, send.clientMessageId)));
  if (sendKeys.size !== sends.length) issues.push('duplicate sender and client Message ID in send records');
  const expectedTargets = targetSockets(cell);
  if (targets.length !== expectedTargets) issues.push(`expected ${expectedTargets} targets, got ${targets.length}`);
  if ('error' in snapshot) {
    issues.push(`snapshot error: ${snapshot.error}`);
    return { status: 'INCONCLUSIVE' as const, expectedSends, issues, messages: [] };
  }

  const rowsByKey = new Map<string, StallRow>(), rowsById = new Map<string, StallRow>();
  for (const row of snapshot.rows) {
    const id = key(row.sender, row.client_message_id);
    rowsByKey.set(id, row);
    rowsById.set(row.id, row);
    if (!sendKeys.has(id)) issues.push(`row ${row.id} has no send for its sender and client Message ID`);
  }
  const receipts = targets.map((target, socket) => {
    const firstReceipts = new Map<string, StallReceipt>();
    for (const records of [target.stallMessages, target.lateStallMessages ?? []]) {
      for (const receipt of records) {
        const row = rowsById.get(receipt.id);
        if (!row) issues.push(`target ${socket} received orphan Message ${receipt.id}`);
        else if (receipt.clientMessageId !== row.client_message_id) issues.push(`target ${socket} received a different client Message ID for ${receipt.id}`);
        const first = firstReceipts.get(receipt.id);
        if (!first || receipt.at < first.at) firstReceipts.set(receipt.id, receipt);
      }
    }
    return { firstReceipts, close: target.close ?? target.lateClose };
  });
  if (issues.length) return { status: 'INCONCLUSIVE' as const, expectedSends, issues, messages: [] };

  let missingAtCutoffOnOpenSocket = false;
  const observedToEnd = observation.requestedMs > 0 && observation.completed;
  const messages = sends.map(send => {
    const row = rowsByKey.get(key(send.sender, send.clientMessageId));
    if (!row && send.status !== 201) return { send, category: 'send-rejected', reason: rejection(send) };
    const category = send.status !== 201 ? 'persisted-client-failure' :
      !row || row.id !== send.messageId ? 'accepted-not-persisted' : 'accepted-persisted';
    if (!row) return { send, category };
    const perTarget = receipts.map(({ firstReceipts, close }, socket) => {
      const first = firstReceipts.get(row.id);
      const receipt = first && (!close || first.at <= close.at) ? first : undefined;
      const scored = receipt && receipt.at <= observation.scoredCutoffAt;
      if (!scored && (!close || close.at > observation.scoredCutoffAt)) missingAtCutoffOnOpenSocket = true;
      const delivery: Delivery = scored ? 'on-time' : receipt ? 'late' : close || observedToEnd ? 'never' : 'unknown';
      return { socket, delivery, receiptAt: receipt?.at, close };
    });
    const outcomes = new Set(perTarget.map(target => target.delivery));
    const delivery = outcomes.has('never') ? 'never' : outcomes.has('unknown') ? 'unknown' : outcomes.has('late') ? 'late' : 'on-time';
    return { send, row, category, delivery, targets: perTarget };
  });
  if (!observedToEnd && missingAtCutoffOnOpenSocket) issues.push('extension did not complete for Messages missing at the scored cut-off on open sockets');
  return { status: issues.length ? 'INCONCLUSIVE' as const : 'CLASSIFIED' as const, expectedSends, issues, messages };
}
