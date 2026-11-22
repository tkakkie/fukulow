// #668 notice correctness with several sockets per Member. The send record has no socket
// identity, so records are matched to client notices by count per Channel.
import type { SendRecord } from './revocation-burst-judgment.ts';
import type { HoldsRun } from './revocation-holds-judgment.ts';

const count = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

function clientReasons(run: HoldsRun, revoked: Set<string>, clientCounts: Map<string, number>) {
  const reasons: string[] = [];
  const seen = new Set<string>();
  let wrong = run.bystanderNotices > 0, duplicate = false, early = false, afterRestore = false;
  for (const notice of run.notices) {
    const target = run.targets[notice.socket];
    if (!target || notice.channelId === null || !revoked.has(notice.channelId)) { wrong = true; continue; }
    const key = `${notice.socket}/${notice.channelId}`;
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    count(clientCounts, notice.channelId);
    const account = run.accounts[target.account];
    if (account?.revokeStartedAt === undefined || notice.at < account.revokeStartedAt) early = true;
    if (account?.restoredAt !== undefined && notice.at >= account.restoredAt) afterRestore = true;
  }
  if (wrong) reasons.push('a revocation reached a bystander or a Channel that was not revoked');
  if (duplicate) reasons.push('duplicate revocation on a (socket, Channel)');
  if (early) reasons.push('a revocation arrived before its revoke started');
  if (afterRestore) reasons.push('a restored registration received a revocation');
  return reasons;
}

export function noticeCorrectness(run: HoldsRun) {
  const revoked = new Set(run.revokedChannels);
  const clientCounts = new Map<string, number>(), serverCounts = new Map<string, number>();
  const reasons = clientReasons(run, revoked, clientCounts);
  const timing = run.sendTiming;
  const faultSends: (SendRecord & { sentAt: number })[] = [], indeterminate: typeof faultSends = [], wrongRecords: SendRecord[] = [];
  if (!timing) reasons.push('no server send timing');
  else {
    const offset = (timing.offsetBoundsMs[0] + timing.offsetBoundsMs[1]) / 2, u = timing.uncertaintyMs;
    const { fault, recovery } = run.times;
    for (const record of timing.records) {
      if (!revoked.has(record.channelId)) { wrongRecords.push(record); continue; }
      count(serverCounts, record.channelId);
      const sentAt = offset + (record.beforeMs + record.afterMs) / 2;
      if (sentAt + u < fault || sentAt - u >= recovery) continue;
      (sentAt - u >= fault && sentAt + u < recovery ? faultSends : indeterminate).push({ ...record, sentAt });
    }
    if (wrongRecords.length) reasons.push('a revocation send record names a Channel that was not revoked');
    if (faultSends.length) reasons.push('a revocation was sent while the failure was active');
    if (indeterminate.length) reasons.push('a revocation send time is indeterminate at a fault edge');
  }
  const mismatched = timing ? [...revoked].filter(channel => (serverCounts.get(channel) ?? 0) !== (clientCounts.get(channel) ?? 0)) : [];
  if (mismatched.length) reasons.push(`${mismatched.length} Channels whose server send count differs from the client notice count`);
  return { reasons, details: { faultSends, indeterminate, wrongRecords: wrongRecords.length, mismatched, clientNotices: Object.fromEntries(clientCounts), serverSends: Object.fromEntries(serverCounts) } };
}
