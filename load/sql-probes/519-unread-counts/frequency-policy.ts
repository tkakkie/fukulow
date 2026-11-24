import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { PolicySnapshot } from '../../harness-core/cpu-policy.ts';

const sys = '/sys/devices/system/cpu';
const read = (path: string) => readFileSync(path, 'utf8').trim();
type Limits = Record<string, string>;
export const maxLimits = (p: PolicySnapshot): Limits => Object.fromEntries(p.policies.map(cpu => [cpu.policy, cpu.max]));
const maxPath = (policy: string) => `${sys}/cpufreq/${policy}/scaling_max_freq`;
export async function writeLimits(values: Limits) {
  // The launcher stays unprivileged. Sudo can be scoped to tee with these exact sysfs paths.
  const results = await Promise.allSettled(Object.entries(values).map(([p, value]) => new Promise<void>((resolve, reject) => {
    if (!/^policy\d+$/.test(p) || !/^\d+$/.test(value)) return reject(new Error('invalid cpufreq limit'));
    let stdinError: Error | undefined;
    const child = execFile('sudo', ['-n', '/usr/bin/tee', maxPath(p)], { timeout: 3000, killSignal: 'SIGKILL' }, error => {
      if (error || stdinError) reject(error ?? stdinError); else resolve();
    });
    child.stdin?.on('error', error => { stdinError = error; });
    child.stdin?.end(value + '\n');
  })));
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'cpufreq write failed');
}

export function verifyLimits(values: Limits) {
  const mismatches = Object.entries(values).flatMap(([p, expected]) => {
    try { return read(maxPath(p)) === expected ? [] : [p]; } catch { return [p]; }
  });
  if (mismatches.length) throw new Error(`cpufreq readback failed for ${mismatches.join(',')}`);
}

export async function withCap<T>(saved: Limits, work: () => Promise<T>, io: {
  write(values: Limits): Promise<void>; verify(values: Limits): void; pending(saved: Limits): void; restored(): void;
}) {
  const capped = Object.fromEntries(Object.keys(saved).map(p => [p, '1700000']));
  io.pending(saved);
  try {
    await io.write(capped);
    io.verify(capped);
    const result = await work();
    io.verify(capped);
    return result;
  } finally {
    // Read back every policy even when one write failed. Keep the restoration record on any failure.
    try { await io.write(saved); } finally { io.verify(saved); }
    io.restored();
  }
}

