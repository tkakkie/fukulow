// Settled reference validity, shared by the runner and the offline judge.
import { c0Floor, counterWork, reportWork, setNames, sets796, type Identity, type ReferenceWindow } from './frequency-evidence.ts';
import type { PolicySnapshot } from '../../harness-core/cpu-policy.ts';
import { halfSet } from '../../harness-core/frequency-layout.ts';
import { below, multiply, store, unsigned, type Ratio } from './frequency-ratios.ts';

export const referenceMs = 120_000;
export const settleMs = 30_000;
const referenceNs = BigInt(referenceMs) * 1_000_000n;
const halfFloor = multiply(c0Floor, [1n, 2n]);

export function referenceRequired(order: number, control: boolean) {
  return control || order === 1;
}

export function assessReference(window: ReferenceWindow, order: number, session: string | null, identity: Identity,
  policy: PolicySnapshot, rates: Ratio[]) {
  if (unsigned(window.exitNs) - unsigned(window.startNs) < referenceNs) throw new Error('reference wait shorter than 120 s');
  const { work } = counterWork(window, order, referenceMs, session, identity, policy, rates, false);
  if (unsigned(window.open.reads[0].monoNs) - unsigned(window.checkpointNs) < BigInt(settleMs) * 1_000_000n) {
    throw new Error('reference opened before 30 s checkpoint settle');
  }
  const perCpu = work.map(w => ({ ...w, normalized: multiply(w.c0Ns, [referenceNs, w.interval]) }));
  const reasons: string[] = [];
  const sets = Object.fromEntries(setNames.map(set => {
    const rows = perCpu.filter(w => sets796[set].includes(w.cpu));
    const n_F = rows.filter(w => !below(w.normalized, c0Floor)).length;
    const minimum = halfSet(sets796[set]);
    const max = rows.reduce((a, b) => below(a.normalized, b.normalized) ? b : a);
    const margin = (floor: Ratio) => max.normalized[0] === 0n ? null
      : store(multiply(floor, [max.normalized[1], max.normalized[0]]));
    if (n_F >= minimum) reasons.push(`reference ${order}: ${set} n_F=${n_F}/${rows.length} reached ${minimum}`);
    if (!below(max.normalized, halfFloor)) reasons.push(`reference ${order}: ${set} CPU ${max.cpu} reached 500 ms C0 normalized to 120 s`);
    return [set, { n_F, maxCpu: max.cpu, maxC0Ns: store(max.normalized), floorMargin: margin(c0Floor), halfFloorMargin: margin(halfFloor) }];
  }));
  return { reasons, sets, cpus: perCpu.map(w => ({ ...reportWork(w), normalizedC0Ns: store(w.normalized) })) };
}
