// Reports verdict disagreements with legacy frequency evidence.
import { setNames, type SetName } from './frequency-evidence.ts';
import type { judgeRun } from './stability-judge.ts';

type Report = ReturnType<typeof judgeRun>['frequency'];

export function legacyDisagreements(legacy: string[], v3: Report, orders: number[]) {
  return orders.flatMap(order => setNames.flatMap(set => {
    const containsSet = (reason: string, s: SetName) => new RegExp(`\\b${s}\\b`).test(reason);
    const fromBlock = (reason: string) => reason.startsWith(`block ${order}:`);
    const old = legacy.filter(r => fromBlock(r) && containsSet(r, set));
    const current = v3.reasons.filter(r => (fromBlock(r) &&
      (containsSet(r, set) || /^block \d+: F[1236]\b/.test(r))) || /^F[1-7]\b/.test(r));
    const verdict = (rs: string[]) => rs.some(r => r.includes('throttled')) ? 'throttled' : rs.length > 0 ? 'invalid evidence' : 'clear';
    return verdict(old) === verdict(current) ? [] : [{ block: order, set, legacy: old, v3: current }];
  }));
}
