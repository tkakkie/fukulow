import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { frequency, hostService } from '../../harness-core/boot-796-files.ts';
import { allowedCpus } from '../../harness-core/cpusets.ts';
import { readCpuPolicy } from '../../harness-core/cpu-policy.ts';
import { cpus796, sets796 } from '../../harness-core/frequency-layout.ts';
import { hostRecord, requirementViolations } from '../../harness-core/host-record.ts';
import { hostAffinityProblems, readHostAffinity } from '../../sql-probes/519-unread-counts/frequency-host-affinity.ts';

const host = {
  os: platform,
  service: () => execFileSync('systemctl', ['show', '--property=ActiveState', '--value', hostService],
    {encoding: 'utf8', timeout: 5_000}).trim(),
  coordinator: () => allowedCpus(readFileSync('/proc/self/status', 'utf8')),
  record: hostRecord,
  policy: readCpuPolicy,
  affinity: readHostAffinity,
};

export function readHostGate(session: string, diskPath: string, io = host) {
  const problems: string[] = [];
  const capture = <T>(what: string, read: () => T) => {
    try { return read(); }
    catch (error) { problems.push(`${what}: ${String(error)}`); return null; }
  };
  if (io.os() !== 'linux' || !session) return {problems: ['The #870 host gate needs a Linux launcher session']};
  const service = capture(hostService, io.service);
  if (service !== 'active') problems.push(`${hostService} must be active`);
  const coordinator = capture('coordinator affinity', io.coordinator);
  if (!coordinator?.length || coordinator.some(cpu => !sets796.housekeeping.includes(cpu))) {
    problems.push('The #870 coordinator must run on housekeeping CPUs');
  }
  const record = capture('host record', () => io.record(diskPath));
  if (record) problems.push(...requirementViolations(record, {boost: frequency.boost, policyBoost: frequency.boost, platformProfile: frequency.profile}));
  const policy = capture('CPU policy', () => io.policy(cpus796));
  if (!policy || policy.policies.length !== cpus796.length ||
      policy.policies.some((p, index) => p.cpu !== cpus796[index] || p.max !== frequency.max_khz)) {
    problems.push(`Every CPU needs an effective scaling_max_freq of ${frequency.max_khz} kHz`);
  }
  const affinity = capture('host affinity', () => io.affinity(session));
  problems.push(...hostAffinityProblems(affinity, session, policy?.bootId));
  return {session, service, coordinator, record, policy, affinity, problems};
}

if (import.meta.main) {
  const result = readHostGate(process.env.FUKULOW_LAUNCH_SESSION ?? '', process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (result.problems.length) process.exitCode = 1;
}
