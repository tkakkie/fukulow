import { cappedPolicy, cpus796, sets796, type Calibration, type CounterBlock, type FrequencyEvidence, type Identity, type ReferenceWindow } from './frequency-evidence.ts';
import type { PolicySnapshot } from '../../harness-core/cpu-policy.ts';
import type { Floors } from './frequency-judge.ts';

export const session = 'fixture-session';
export { sets796 };
export const floors: Floors = { server: ['1900000000', '1'], client: ['1900000000', '1'] };
const identity: Identity = { bootId: 'boot-test', kernel: 'kernel-test', version: 'test', online: '0-15', pmuType: 13,
  topology: cpus796.map(cpu => ({ cpu, package: '0', core: String(cpu), siblings: String(cpu) })) };
export const policy: PolicySnapshot = { bootId: identity.bootId, kernel: identity.kernel, online: identity.online,
  profile: 'performance', boost: '0', paranoid: '4',
  policies: cpus796.map(cpu => ({ cpu, policy: `policy${cpu}`, related: String(cpu), affected: String(cpu), driver: 'amd-pstate-epp',
    governor: 'performance', epp: 'performance', boost: '0', min: '623377', max: '2000000' })) };
const calReads = (offset: bigint): Calibration['open'] => cpus796.map(cpu => ({
  cpu, id: String(cpu + 1), beforeNs: String(offset + 1n), afterNs: String(offset + 101n),
  count: String(offset * 2n + 7n), enabled: String(offset + 1000n), running: String(offset + 1000n),
}));
export const evidence: FrequencyEvidence = {
  calibration: { identity, open: calReads(1_000_000_000n), close: calReads(2_000_000_000n) }, before: policy, after: policy, startSession: session, endSession: session,
};

type FixtureOptions = {
  ratios?: (cpu: number) => [bigint, bigint]; mperf?: (cpu: number) => bigint;
  idleMperf?: (cpu: number) => bigint; idleRatios?: (cpu: number) => [bigint, bigint];
  slack?: bigint; control?: boolean; launchSession?: string;
};

function fixtureCounters(order: number, options: FixtureOptions, offset: bigint, eventBase: number): CounterBlock {
  const start = offset + 10_000_000n;
  const exit = start + 120_000_000_000n;
  const close = exit + (options.control ? 10_010_000_000n : 10_000_000n) + (options.slack ?? 0n);
  const sweep = (phase: 'open' | 'idle' | 'close', stamp: bigint) => ({
    phase, launchSession: options.launchSession ?? session, order, identity,
    reads: cpus796.map(cpu => {
      const [a, b] = options.ratios?.(cpu) ?? [1n, 1n];
      const work = options.mperf?.(cpu) ?? (cpu < 8 ? 2_800_000_000n : 0n);
      const idle = phase === 'close' ? options.idleMperf?.(cpu) ?? 0n : 0n;
      const [ia, ib] = options.idleRatios?.(cpu) ?? [a, b];
      const count = phase === 'open' ? 0n : work + idle;
      const aperf = phase === 'open' ? 0n : work * a / b + idle * ia / ib;
      return { cpu, aperfId: String(eventBase + cpu * 2), mperfId: String(eventBase + cpu * 2 + 1),
        aperf: String(1n + aperf), mperf: String(1n + count), monoNs: String(stamp + (options.control && phase !== 'open' ? 0n : BigInt(cpu))),
        rawNs: String(stamp), running: String(stamp - offset + 500n), enabled: String(stamp - offset + 500n) };
    }),
  });
  const scope = options.control && order === 2 ? cappedPolicy(policy) : policy;
  return {
    open: sweep('open', offset), close: sweep('close', close), idle: options.control ? sweep('idle', exit + 10_000_000n) : undefined,
    startNs: String(start), exitNs: String(exit), policyBefore: scope, policyAfter: scope,
  };
}

const offset = (order: number) => 200_000_000_000n + BigInt(order - 1) * 400_000_000_000n;

export function referenceWindow(order: number, options: FixtureOptions = {}): ReferenceWindow {
  const start = offset(order) - 160_000_000_000n;
  const counters = fixtureCounters(order, { ...options, control: false, mperf: options.mperf ?? (() => 0n) }, start, order * 100 + 100_000);
  const scope = options.control && order === 2 ? cappedPolicy(policy) : policy;
  return { ...counters, policyBefore: scope, policyAfter: scope, checkpointNs: String(start - 30_000_000_000n) };
}

// Four active CPUs in each set, each at 1.4 s of C0 in a 120 s window.
export function block(order: number, options: FixtureOptions = {}) {
  const counters = fixtureCounters(order, options, offset(order), order * 100);
  if (options.control || order === 1) {
    counters.reference = referenceWindow(order, { control: options.control, launchSession: options.launchSession });
  }
  return { order, pgbenchWindow: { startMs: 20_000, endMs: 140_000 }, counters };
}
