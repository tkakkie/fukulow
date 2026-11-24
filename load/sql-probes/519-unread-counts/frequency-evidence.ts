import type { PolicySnapshot } from '../../harness-core/cpu-policy.ts';
import { below, multiply, store, unsigned, type Ratio } from './frequency-ratios.ts';

export const cpus796 = Array.from({ length: 16 }, (_, cpu) => cpu);
export const sets796 = { server: cpus796.filter(cpu => cpu % 2 === 0), client: cpus796.filter(cpu => cpu % 2 === 1) };
export const setNames = ['server', 'client'] as const;
export type SetName = typeof setNames[number];
export const controlIdleMs = 10_000;
const slackNs = 3_000_000_000n;
const million = 1_000_000n;

export type Identity = {
  bootId: string; kernel: string; version: string; pmuType: number; online: string;
  topology: { cpu: number; package: string; core: string; siblings: string }[];
};
type ClockCount = { cpu: number; id: string; beforeNs: string; afterNs: string; count: string; enabled: string; running: string };
export type Calibration = { identity: Identity; open: ClockCount[]; close: ClockCount[] };
type PerfRead = { cpu: number; monoNs: string; aperfId: string; mperfId: string; aperf: string; mperf: string; enabled: string; running: string };
export type Sweep = { phase: 'open' | 'idle' | 'close'; identity: Identity; launchSession: string; order: number; reads: PerfRead[] };
export type CounterBlock = {
  open: Sweep; close: Sweep; idle?: Sweep; startNs: string; exitNs: string;
  policyBefore: PolicySnapshot; policyAfter: PolicySnapshot;
};
export type FrequencyEvidence = {
  calibration: Calibration; before: PolicySnapshot; after: PolicySnapshot; startSession: string; endSession: string;
  permissionCheck?: { go: { exit: number }; identity: Identity } | null;
};
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const requireEvidence = (ok: boolean, reason: string) => { if (!ok) throw new Error(reason); };
const cpuListMatches = (rows: { cpu: number }[]) => same(rows.map(r => r.cpu), cpus796);

export function validatePolicy(policy: PolicySnapshot, identity: Identity) {
  requireEvidence(policy.bootId === identity.bootId && policy.kernel === identity.kernel && policy.online === identity.online &&
    policy.boost === '0' && policy.profile === 'performance' && policy.paranoid === '4' && cpuListMatches(policy.policies) &&
    new Set(policy.policies.map(p => p.policy)).size === 16 && policy.policies.every(p =>
      /^policy\d+$/.test(p.policy) && p.related === String(p.cpu) && p.affected === String(p.cpu) &&
      p.driver.length > 0 && p.governor === 'performance' && p.epp === 'performance' && p.boost === '0' &&
      unsigned(p.min) > 0n && unsigned(p.max) >= unsigned(p.min)), 'F1 invalid CPU policies or changed host settings');
}

function validateIdentity(i: Identity) {
  requireEvidence(Boolean(i.bootId && i.kernel && i.version) && Number.isSafeInteger(i.pmuType) && i.pmuType > 0 &&
    i.online === '0-15' && cpuListMatches(i.topology) && i.topology.every(t => Boolean(t.package && t.core && t.siblings)), 'F1 invalid collector identity');
}

export function referenceRates(cal: Calibration): Ratio[] {
  validateIdentity(cal.identity);
  requireEvidence(cpuListMatches(cal.open) && cpuListMatches(cal.close), 'F6 missing TSC calibration pair');
  requireEvidence(new Set(cal.open.map(c => unsigned(c.id))).size === 16, 'F1 repeated TSC event ID');
  return cal.open.map((a, cpu) => {
    const b = cal.close[cpu];
    const stamp = (r: ClockCount) => {
      const lo = unsigned(r.beforeNs), hi = unsigned(r.afterNs);
      requireEvidence(hi >= lo && hi - lo <= million, 'F1 TSC calibration bracket exceeds 1 ms');
      return lo + hi;
    };
    const ticks = unsigned(b.count) - unsigned(a.count);
    const elapsedTwice = stamp(b) - stamp(a);
    const enabled = unsigned(b.enabled) - unsigned(a.enabled);
    requireEvidence(a.id === b.id && enabled > 0n && enabled === unsigned(b.running) - unsigned(a.running) &&
      unsigned(a.running) === unsigned(a.enabled) && unsigned(b.running) === unsigned(b.enabled) &&
      ticks > 0n && elapsedTwice >= 1_998_000_000n && elapsedTwice <= 2_200_000_000n,
    'F1 invalid TSC calibration interval');
    return [ticks * 2_000_000_000n, elapsedTwice];
  });
}

function validateSweep(s: Sweep, phase: Sweep['phase'], id: Identity, session: string | null, order: number) {
  requireEvidence(session !== null && s.launchSession === session && s.order === order && s.phase === phase && same(s.identity, id),
    'F1 foreign or stale counter sweep');
  requireEvidence(cpuListMatches(s.reads), 'F6 missing, duplicate or unordered CPU pair');
  const ids = s.reads.flatMap(r => [unsigned(r.aperfId), unsigned(r.mperfId)]);
  requireEvidence(new Set(ids).size === 32 && ids.every(x => x > 0n), 'F1 duplicate or invalid event ID');
  requireEvidence(s.reads.every((r, i) => i === 0 || unsigned(r.monoNs) >= unsigned(s.reads[i - 1].monoNs)), 'F2 counter timestamps out of order');
}

function workBetween(a: Sweep, b: Sweep, hz: Ratio[]) {
  return a.reads.map((open, cpu) => {
    const close = b.reads[cpu];
    const interval = unsigned(close.monoNs) - unsigned(open.monoNs);
    const enabled = unsigned(close.enabled) - unsigned(open.enabled);
    const running = unsigned(close.running) - unsigned(open.running);
    requireEvidence(open.aperfId === close.aperfId && open.mperfId === close.mperfId &&
      interval > 0n && enabled > 0n && enabled === running && unsigned(open.running) === unsigned(open.enabled) &&
      unsigned(close.running) === unsigned(close.enabled) &&
      enabled >= interval - million && enabled <= interval + million,
    `F1 CPU ${cpu}: counter identity or counting time changed`);
    const aperf = unsigned(close.aperf) - unsigned(open.aperf);
    const mperf = unsigned(close.mperf) - unsigned(open.mperf);
    requireEvidence(aperf >= 0n && mperf >= 0n && (aperf === 0n) === (mperf === 0n), `F3 CPU ${cpu}: negative or inconsistent counter deltas`);
    const c0Ns = multiply([mperf * 1_000_000_000n, 1n], [hz[cpu][1], hz[cpu][0]]);
    return { cpu, aperf, mperf, c0Ns, busyHz: mperf === 0n ? null : multiply(hz[cpu], [aperf, mperf]),
      qualifies: !below(c0Ns, [20_000_000n, 1n]) };
  });
}

export function checkPermissionEvidence(record: { mode: string; identity: Identity; open: PerfRead[]; close: PerfRead[] }) {
  requireEvidence(record.mode === 'check', 'missing permission-check mode');
  const { identity } = record;
  validateIdentity(identity);
  const bind = (phase: 'open' | 'close', reads: PerfRead[]): Sweep => ({ phase, reads, identity, launchSession: 'check', order: 0 });
  const open = bind('open', record.open), close = bind('close', record.close);
  validateSweep(open, 'open', identity, 'check', 0);
  validateSweep(close, 'close', identity, 'check', 0);
  requireEvidence(open.reads.every((r, cpu) => {
    const ns = unsigned(close.reads[cpu].monoNs) - unsigned(r.monoNs);
    return ns >= 999_000_000n && ns <= 1_100_000_000n;
  }), 'permission check did not span one second');
  workBetween(open, close, open.reads.map(() => [1n, 1n]));
  return identity;
}

export function counterWork(block: CounterBlock, order: number, pgbenchMs: number, session: string | null, identity: Identity,
  policy: PolicySnapshot, rates: Ratio[], control: boolean) {
  validatePolicy(policy, identity);
  requireEvidence(same(policy, block.policyBefore) && same(policy, block.policyAfter), 'F1 policy changed around block');
  validateSweep(block.open, 'open', identity, session, order);
  validateSweep(block.close, 'close', identity, session, order);
  const first = (s: Sweep) => unsigned(s.reads[0].monoNs);
  const last = (s: Sweep) => unsigned(s.reads.at(-1)?.monoNs);
  const start = unsigned(block.startNs), exit = unsigned(block.exitNs);
  const pgbenchNs = BigInt(Math.round(pgbenchMs * 1e6));
  const idleNs = control ? BigInt(controlIdleMs) * million : 0n;
  requireEvidence(pgbenchNs > 0n && last(block.open) <= start && exit >= start + pgbenchNs - million &&
    first(block.close) >= exit + idleNs && last(block.close) - first(block.open) <= pgbenchNs + idleNs + slackNs,
  'F2 perf span fails pgbench boundaries or 3 s slack limit');
  const work = workBetween(block.open, block.close, rates);
  if (!control) {
    requireEvidence(block.idle === undefined, 'F2 unexpected idle sweep');
    return { work, idle: null };
  }
  const idle = block.idle;
  if (!idle) throw new Error('F6 missing idle-only sweep');
  validateSweep(idle, 'idle', identity, session, order);
  requireEvidence(first(idle) >= exit && first(block.close) >= last(idle) + idleNs &&
    last(block.close) <= first(idle) + idleNs + 100_000_000n,
    'F2 idle tail did not start after pgbench or missed its 10 s target');
  // Validate both intervals independently so a reset at the extra sweep also fails.
  workBetween(block.open, idle, rates);
  return { work, idle: workBetween(idle, block.close, rates) };
}

type CpuWork = ReturnType<typeof workBetween>[number];
export const reportWork = (w: CpuWork) => ({
  cpu: w.cpu, aperf: String(w.aperf), mperf: String(w.mperf), c0Ns: store(w.c0Ns),
  busyHz: w.busyHz && store(w.busyHz), qualifies: w.qualifies,
});
export function idleCoverage(work: CpuWork[]) {
  const cpus = work.filter(w => w.qualifies).map(w => w.cpu);
  return { perCpu: work.map(reportWork), cpusAtFloor: cpus,
    couldQualify: Object.fromEntries(setNames.map(set => [set, sets796[set].filter(cpu => cpus.includes(cpu)).length >= 4])) };
}
