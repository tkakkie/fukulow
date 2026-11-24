import { cpus796, sets796, type Calibration, type CounterBlock, type FrequencyEvidence, type Identity } from './frequency-evidence.ts';
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

// Four active CPUs in each set, each at 1.4 s of C0 in a 120 s window.
export function block(order: number, options: {
  ratios?: (cpu: number) => [bigint, bigint]; mperf?: (cpu: number) => bigint;
  idleMperf?: (cpu: number) => bigint; slack?: bigint; control?: boolean;
} = {}) {
  const offset = BigInt(order) * 200_000_000_000n;
  const start = offset + 10_000_000n;
  const exit = start + 120_000_000_000n;
  const close = exit + (options.control ? 10_020_000_000n : 10_000_000n) + (options.slack ?? 0n);
  const policy = options.control && order === 2
    ? { ...evidence.before, policies: evidence.before.policies.map(p => ({ ...p, max: '1700000' })) }
    : evidence.before;
  const sweep = (phase: 'open' | 'idle' | 'close', stamp: bigint) => ({
    phase, launchSession: session, order, identity,
    reads: cpus796.map(cpu => {
      const [a, b] = options.ratios?.(cpu) ?? [1n, 1n];
      const work = options.mperf?.(cpu) ?? (cpu < 8 ? 2_800_000_000n : 0n);
      const idle = phase === 'close' ? options.idleMperf?.(cpu) ?? 0n : 0n;
      const count = phase === 'open' ? 0n : work + idle;
      return { cpu, aperfId: String(order * 100 + cpu * 2), mperfId: String(order * 100 + cpu * 2 + 1),
        aperf: String(1n + count * a / b), mperf: String(1n + count), monoNs: String(stamp + BigInt(cpu)),
        running: String(stamp - offset + 500n), enabled: String(stamp - offset + 500n) };
    }),
  });
  const counters: CounterBlock = {
    open: sweep('open', offset), close: sweep('close', close), idle: options.control ? sweep('idle', exit + 10_000_000n) : undefined,
    startNs: String(start), exitNs: String(exit), policyBefore: policy, policyAfter: policy,
  };
  return { order, pgbenchWindow: { startMs: 20_000, endMs: 140_000 }, counters };
}
