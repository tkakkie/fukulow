import { spawnSync } from 'node:child_process';
import { loadavg, platform } from 'node:os';
import { hostRecord, linuxViolations, type HostRecord } from '../harness-core/host-record.ts';

// The platform parts of a measurement launch (#867). Everything else in the launcher is shared.
export type Platform = {
  name: string;
  // Wraps the job's argv so the host cannot sleep while it runs.
  inhibit(argv: string[]): string[];
  // STOP reasons for host conditions on this platform (AC, governor, update jobs, sleep, ...).
  violations(record: HostRecord): string[];
  load15(): number;
  record(diskPath: string): HostRecord;
};

const macAc = () => {
  const out = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  return out.status === 0 && /AC Power/.test(out.stdout.split('\n')[0] ?? '');
};

export const darwin: Platform = {
  name: 'darwin',
  inhibit: argv => ['caffeinate', '-dimsu', ...argv],
  violations: () => (macAc() ? [] : ['not on AC power']),
  load15: () => loadavg()[2],
  record: hostRecord,
};

// On Linux the sleep targets are masked (a preflight condition), so no inhibitor lock is taken:
// `systemd-inhibit` needs interactive polkit authentication over SSH.
export const linux: Platform = {
  name: 'linux',
  inhibit: argv => argv,
  violations: linuxViolations,
  load15: () => loadavg()[2],
  record: hostRecord,
};

export function currentPlatform(): Platform {
  if (platform() === 'darwin') return darwin;
  if (platform() === 'linux') return linux;
  throw new Error(`unsupported platform: ${platform()}`);
}
