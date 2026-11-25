import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { hrtime } from 'node:process';
import { promisify } from 'node:util';
import { controlIdleMs, cpus796, type Calibration, type CounterWindow, type Sweep } from './frequency-evidence.ts';
import { readCpuPolicy } from '../../harness-core/cpu-policy.ts';
import type { housekeepingSampler } from './frequency-housekeeping.ts';

const exec = promisify(execFile);
export async function calibrate(helper: string, signal: AbortSignal): Promise<Calibration> {
  return JSON.parse((await exec(helper, ['calibrate'], { timeout: 5000, signal })).stdout);
}

export async function waitUntil(deadline: bigint, signal: AbortSignal) {
  let remaining = deadline - hrtime.bigint();
  while (remaining > 0n) {
    await wait(Number((remaining + 999_999n) / 1_000_000n), undefined, { signal });
    remaining = deadline - hrtime.bigint();
  }
}

export async function timedCounters<T>(helper: string, session: string, order: number, control: boolean,
  signal: AbortSignal, pgbench: () => Promise<T>, sampler?: ReturnType<typeof housekeepingSampler>) {
  signal.throwIfAborted();
  const policyBefore = readCpuPolicy(cpus796);
  const child = spawn(helper, [control ? 'control' : 'block', session, String(order)], { stdio: ['pipe', 'pipe', 'inherit'], signal });
  child.stdin.on('error', () => {}); // The reader and exit status report helper failure.
  const exited = new Promise<boolean>(resolve => {
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const rows = lines[Symbol.asyncIterator]();
  async function receive() {
    const timer = new AbortController();
    try {
      const row = await Promise.race([rows.next(),
        wait(2500, undefined, { signal: timer.signal }).then(() => { throw new Error('F6 perf helper response timed out'); })]);
      if (row.done) throw new Error('F6 perf helper exited before sending evidence');
      return JSON.parse(row.value);
    } finally { timer.abort(); }
  }
  async function sample(command: Sweep['phase']): Promise<Sweep> {
    child.stdin.write(command + '\n');
    return receive();
  }
  try {
    if ((await receive()).ready !== true) throw new Error('F6 perf helper readiness missing');
    const openSample = sampler?.sample();
    const open = await sample('open');
    const startMs = Date.now(), start = hrtime.bigint();
    const output = await pgbench();
    const exit = hrtime.bigint(), endMs = Date.now();
    const idle = control ? await sample('idle') : undefined;
    const idleSample = idle && sampler?.sample();
    if (idle) await waitUntil(BigInt(idle.reads.at(-1)!.monoNs) + BigInt(controlIdleMs) * 1_000_000n, signal);
    const close = await sample('close');
    const closeSample = sampler?.sample();
    if (!await exited) throw new Error('F6 perf helper failed');
    const policyAfter = readCpuPolicy(cpus796);
    const housekeeping = sampler && openSample && closeSample ? {
      workload: sampler.workload, ticksPerSecond: sampler.ticksPerSecond, open: openSample, idle: idleSample, close: closeSample,
    } : undefined;
    const counters: CounterWindow = { open, close, idle, startNs: String(start), exitNs: String(exit), policyBefore, policyAfter, housekeeping };
    return { output, measuredWindow: { startMs, endMs, monoMs: Number(exit - start) / 1e6 }, counters };
  } finally {
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}
