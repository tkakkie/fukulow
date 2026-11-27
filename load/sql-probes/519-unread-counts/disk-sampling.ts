import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allowedCpus, type CpuSets } from '../../harness-core/cpusets.ts';
import { measurementSlice } from '../../harness-core/frequency-layout.ts';
import type { Device } from './diskstats.ts';
import type { DiskSeries, SamplerCommand, SamplerMessage, SamplerPlacement } from './diskstats-worker.ts';

export function samplerCpu(sets: CpuSets, allowed: number[]) {
  const cpu = allowed.find(candidate => !sets.server.includes(candidate) && !sets.client.includes(candidate) &&
    (!sets.housekeeping || sets.housekeeping.includes(candidate)));
  if (cpu === undefined) throw new Error('no allowed host CPU outside both workload CPU sets for diskstats');
  return cpu;
}

export async function startDiskSampler(sets: CpuSets, devices: Device[]) {
  const cpu = samplerCpu(sets, allowedCpus(readFileSync('/proc/self/status', 'utf8')));
  const worker = fileURLToPath(new URL('./diskstats-worker.ts', import.meta.url));
  const child = spawn('taskset', ['-c', String(cpu), process.execPath, worker, ...devices.map(device => device.id)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });

  let failure: Error | undefined;
  let waiting: { resolve: (message: SamplerMessage) => void; reject: (reason: Error) => void } | undefined;
  const fail = (reason: Error) => {
    failure ??= reason;
    waiting?.reject(failure);
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`diskstats sampler exited (${signal ?? code}): ${stderr.trim()}`)));
  child.on('disconnect', () => fail(new Error(`diskstats sampler disconnected: ${stderr.trim()}`)));
  child.on('message', (message: SamplerMessage) => waiting?.resolve(message));
  function receive(command?: SamplerCommand) {
    return new Promise<SamplerMessage>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const cleanup = () => { waiting = undefined; };
      waiting = {
        resolve: message => { cleanup(); resolve(message); },
        reject: reason => { cleanup(); reject(reason); },
      };
      if (command) send(command);
    });
  }
  async function bounded<T>(response: Promise<T>) {
    const timer = setTimeout(() => fail(new Error('diskstats sampler response timed out')), 5000);
    try { return await response; }
    finally { clearTimeout(timer); }
  }
  function send(command: SamplerCommand) {
    if (failure) return;
    try { child.send(command, error => { if (error) fail(error); }); }
    catch (error) { fail(new Error(String(error))); }
  }

  let placement: SamplerPlacement;
  try {
    const ready = await bounded(receive());
    if (!('placement' in ready) || ready.placement.cpus.length !== 1 || ready.placement.cpus[0] !== cpu ||
        ready.placement.cgroup.includes(`/${measurementSlice}`)) {
      throw new Error('diskstats sampler affinity or cgroup verification failed');
    }
    placement = ready.placement;
  } catch (error) { child.kill(); throw error; }

  return {
    placement: { ...placement, location: 'Linux Docker host', periodMs: 1000, procFile: '/proc/diskstats' },
    block(label: string) {
      let started = false;
      let result: Promise<DiskSeries> | undefined;
      return {
        start() { started = true; send({ phase: 'start', label }); },
        stop() {
          if (!started || result) return;
          result = receive({ phase: 'end', label }).then(message => {
            if (!('series' in message) || message.label !== label) throw new Error('diskstats sampler returned the wrong block');
            return message.series;
          }).catch(error => ({ samples: [], deltas: [], errors: [String(error)] }));
        },
        result: async () => result && bounded(result),
      };
    },
    close: () => child.kill(),
  };
}
