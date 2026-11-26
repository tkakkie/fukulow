import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dockerPollMs, dockerSettleMs } from '../../launcher/launcher.ts';
import { boundedCommand, save } from '../bench.ts';
import { timeouts } from '../runtime.ts';
import { cleanupResources } from './cleanup.ts';
import { readHostGate } from './host-gate.ts';
import type { Resources } from './placement.ts';
import type { Stage } from './plan.ts';

type Completion = {manifestHash: string; stage: Stage};
type Run = {entry: string; out: string; manifestHash: string; stage: Stage; names: Resources; env: NodeJS.ProcessEnv};
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const cleanupDocker = (...argv: string[]) => boundedCommand('docker', argv, timeouts.cleanup);
export const dockerStartMarker = 'docker-started';

export function publishRun(run: Pick<Run, 'out' | 'manifestHash' | 'stage'>, workerCode: number,
  cleanupVerified: boolean, hostProblems: string[], interrupted: number) {
  const {out, manifestHash, stage} = run;
  const problems = [...hostProblems];
  let completion: Completion | null = null;
  let exitCode = interrupted || workerCode;
  if (!cleanupVerified || problems.length) exitCode = interrupted || 1;
  if (exitCode === 0) {
    try {
      completion = read(`${out}/completed.json`);
      if (completion?.manifestHash !== manifestHash || completion.stage !== stage) throw new Error('Completion identity mismatch');
    } catch (error) {
      problems.push(String(error));
      completion = null;
      exitCode = 1;
    }
  }
  if (!completion) rmSync(`${out}/finished.json`, {force: true});
  save(`${out}/run-status.json`, {manifestHash, valid: exitCode === 0, cleanupVerified, exitCode, problems});
  if (completion) save(`${out}/finished.json`, completion);
  return exitCode;
}

export async function verifyAfterWorker({out, names, env}: Pick<Run, 'out' | 'names' | 'env'>, interrupted: number,
  docker = cleanupDocker, hostGate = readHostGate) {
  // A worker that stopped before the marker could not have created a resource.
  if (!existsSync(`${out}/${dockerStartMarker}`)) return {cleanupVerified: false, hostProblems: []};
  const expected = [{kind: 'container', name: names.server}, {kind: 'container', name: names.client},
    {kind: 'volume', name: names.data}, {kind: 'volume', name: names.socket}] as const;
  let cleanupVerified = false;
  let hostProblems: string[] = [];
  try {
    const cleanup = () => cleanupResources(docker, [...expected]);
    const result = cleanup();
    // An interrupted Docker CLI can leave a create in flight in the daemon.
    if (interrupted || !existsSync(`${out}/finish.json`)) {
      const deadline = performance.now() + dockerSettleMs;
      while (!result.failures.length && performance.now() < deadline) {
        await pause(Math.min(dockerPollMs, Math.max(0, deadline - performance.now())));
        const late = cleanup();
        result.found.push(...late.found);
        result.failures.push(...late.failures);
      }
    }
    cleanupVerified = result.failures.length === 0;
    save(`${out}/leftover-cleanup.json`, {...result, verified: cleanupVerified});
    const hostAfter = hostGate(env.FUKULOW_LAUNCH_SESSION ?? '', out);
    save(`${out}/host-after-cleanup.json`, hostAfter);
    hostProblems = hostAfter.problems;
    for (const problem of [...result.failures, ...hostProblems]) console.error(problem);
  } catch (error) {
    hostProblems.push(String(error));
    console.error(String(error));
  }
  return {cleanupVerified, hostProblems};
}

export async function superviseStage({entry, out, manifestHash, stage, names, env}: Run) {
  let interrupted = 0;
  let workerClosed = false;
  let terminal = false;
  let workerCode = 1;
  let cleanupVerified = false;
  let hostProblems: string[] = [];
  const publish = () => { process.exitCode = publishRun({out, manifestHash, stage}, workerCode, cleanupVerified, hostProblems, interrupted); };
  const worker = spawn(process.execPath, [fileURLToPath(entry)], {stdio: 'inherit', detached: true, env: {...env, SEARCH_WORKER: '1'}});
  const stop = (code: number) => {
    interrupted ||= code;
    // Stop the worker and its in-flight Docker CLIs. The sampler exits on IPC disconnect.
    if (!workerClosed && worker.pid) {
      try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* worker already exited */ }
    }
    if (terminal) publish();
  };
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  workerCode = await new Promise<number>(resolve => {
    worker.on('error', error => console.error(String(error)));
    worker.on('close', code => resolve(code ?? 1));
  });
  workerClosed = true;
  ({cleanupVerified, hostProblems} = await verifyAfterWorker({out, names, env}, interrupted));
  // Drain signals queued during the synchronous cleanup and host reads before publishing a finish.
  await pause(0);
  publish();
  terminal = true;
  process.once('beforeExit', () => { setTimeout(() => {}, 0); });
}
