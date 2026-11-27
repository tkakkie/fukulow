import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, save } from '../bench.ts';
import { refuseLeftovers } from '../runtime.ts';
import { cleanupCluster, names, type Names } from './cluster.ts';
import { callerLock, checkIdle, hostPlacement } from './host.ts';
import { judge } from './judge.ts';
import { git, loadManifest, verifyPinnedSchema } from './manifest.ts';
import { formalPairs } from './arms.ts';
import { options, rehearsalLabel, smokeLabel } from './options.ts';
import { worker, type Evidence } from './worker.ts';

const workerResources = 'FUKULOW_D3R_LEAK_RESOURCES';

export function finalizeFormalRun(out: string, {cleanupVerified, hostBusy, idle, workerFailed}: {
  cleanupVerified: boolean; hostBusy: boolean; idle: boolean; workerFailed: boolean;
}) {
  const evidencePath = join(out, 'evidence.json');
  let evidence: Evidence;
  try { evidence = JSON.parse(readFileSync(evidencePath, 'utf8')); }
  catch { evidence = {checks: {}, pairs: []}; }
  evidence.checks.cleanup = cleanupVerified;
  if (!hostBusy) evidence.checks.hostBusy = false;
  if (!idle) evidence.checks.idle = false;
  if (workerFailed && evidence.checks.identity !== false) delete evidence.checks.identity;
  save(evidencePath, evidence);
  const verdict = judge(evidence);
  save(join(out, 'verdict.json'), verdict);
  return verdict;
}

async function supervise(args: ReturnType<typeof options>, argv: string[], resources: Names) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
    detached: true, stdio: 'inherit',
    env: {...process.env, [workerResources]: JSON.stringify({resources, parent: process.pid})},
  });
  let interrupted = 0, closed = false;
  const stop = (code: number) => {
    interrupted = code;
    if (child.pid && !closed) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error(String(error)); }
    }
  };
  const sigint = () => stop(130), sigterm = () => stop(143);
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    const workerCode = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1));
      child.once('close', code => resolve(code ?? 1));
    });
    closed = true;
    let cleanupVerified = false;
    try { cleanupCluster(resources); cleanupVerified = true; }
    catch (error) { console.error(String(error)); }
    // Give signals queued while synchronous Docker cleanup was running a chance to be delivered.
    await new Promise<void>(resolve => setImmediate(resolve));
    const exitCode = interrupted || workerCode || Number(!cleanupVerified);
    if (args.mode === 'smoke') {
      save(join(args.out, 'run-status.json'), {label: smokeLabel, cleanupVerified, completed: exitCode === 0});
      return exitCode;
    }
    let hostBusy = true, idle = true;
    try { callerLock(); }
    catch { hostBusy = false; }
    try { checkIdle([], []); }
    catch { idle = false; }
    if (args.mode === 'rehearsal') {
      const completed = exitCode === 0 && hostBusy && idle;
      save(join(args.out, 'run-status.json'), {label: rehearsalLabel, cleanupVerified, hostBusy, idle, completed});
      return exitCode || Number(!completed);
    }
    const verdict = finalizeFormalRun(args.out, {cleanupVerified, hostBusy, idle, workerFailed: Boolean(interrupted || workerCode)});
    console.log(verdict.verdict);
    return exitCode || Number(verdict.verdict !== 'PASS');
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}

async function main(argv: string[]) {
  const args = options(argv);
  const envelope = process.env[workerResources];
  if (envelope) {
    const {resources, parent} = JSON.parse(envelope) as {resources: Names; parent: number};
    assert.equal(parent, process.ppid, 'Worker requires its supervising caller');
    try { await worker(args, resources); }
    catch (error) { console.error(String(error)); process.exitCode = 1; }
    return;
  }
  const manifest = loadManifest();
  verifyPinnedSchema();
  if (args.mode !== 'smoke') {
    formalPairs(manifest.frozen.positiveK, manifest.frozen.reviewedAssignments);
    assert.equal(git('status', '--porcelain'), '', 'Formal checkout must be clean');
    callerLock();
    hostPlacement();
    checkIdle([], []);
  }
  refuseLeftovers(docker);
  mkdirSync(args.out, {mode: 0o700});
  process.exitCode = await supervise(args, argv, names());
}

if (import.meta.main) await main(process.argv.slice(2));
