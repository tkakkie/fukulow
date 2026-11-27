import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { allowedCpus } from '../../harness-core/cpusets.ts';
import { sets796 } from '../../harness-core/frequency-layout.ts';
import { parseHostBusy } from '../../launcher/host-busy.ts';
import { workers } from '../../launcher/launcher.ts';
import { command, docker } from '../bench.ts';

export function callerLock(env = process.env) {
  const {FUKULOW_HOST_BUSY: file, FUKULOW_LAUNCH_JOB: job, FUKULOW_LAUNCH_SESSION: session} = env;
  assert.ok(file && basename(file) === 'HOST-BUSY' && basename(dirname(file)) === 'runs' && job && session,
    'Caller must hold runs/HOST-BUSY for this launch');
  const marker = parseHostBusy(readFileSync(file, 'utf8'));
  assert.ok(marker?.session === session && marker.jobs.includes(job), 'Caller does not hold runs/HOST-BUSY for this launch');
  return {file, job, session};
}

export function hostPlacement() {
  assert.equal(process.platform, 'linux', 'Formal runs require Ubuntu #796 placement');
  assert.match(readFileSync('/etc/os-release', 'utf8'), /^ID=(?:"ubuntu"|ubuntu)$/m, 'Formal runs require Ubuntu');
  const cpus = allowedCpus(readFileSync('/proc/self/status', 'utf8'));
  assert.ok(cpus.length && cpus.every(cpu => sets796.housekeeping.includes(cpu)), 'Run the coordinator on #796 housekeeping CPUs');
  return cpus;
}

export function checkIdle(excludedContainers: string[], excludedPids: number[]) {
  const containerNames = docker('ps', '--format', '{{.Names}}').split('\n').filter(Boolean);
  assert.ok(containerNames.every(name => excludedContainers.includes(name)), 'Other containers are running');
  const busy = workers(command('ps', ['-Ao', 'pid=,command=']), process.pid)
    .map(row => Number(row.split(/\s+/)[0]))
    .filter(pid => !excludedPids.includes(pid));
  assert.equal(busy.length, 0, 'Other workers are running');
}
