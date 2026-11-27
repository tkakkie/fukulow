import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, save } from '../bench.ts';
import { callerLock, checkIdle, hostPlacement } from '../d3r-leak/host.ts';
import { guardIdle } from './host-guard.ts';
import { refuseLeftovers } from '../runtime.ts';
import { cleanup, containers, names, type Names } from './cluster.ts';
import { git, loadManifest } from './manifest.ts';
import { options, type Options } from './options.ts';
import { report, type Evidence } from './report.ts';
import { worker } from './worker.ts';

const workerKey = 'FUKULOW_D3R_CHURN_WORKER';

async function supervise(args: Options, argv: string[], resources: Names, lock?: ReturnType<typeof callerLock>) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit', detached: true, env: {...process.env, [workerKey]: JSON.stringify({resources, parent: process.pid})},
  });
  let closed = false;
  let interrupted = 0;
  let hostBusy = true, idle = true;
  const errors: string[] = [];
  const stop = (code: number) => {
    interrupted ||= code;
    if (child.pid && !closed) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push('Failed to stop the Phase A worker group');
      }
    }
  };
  const check = (owned: string[]) => {
    try { assert.deepEqual(callerLock(), lock, 'Launcher identity changed'); }
    catch { hostBusy = false; }
    try { guardIdle(owned, child.pid ? [child.pid] : []); }
    catch { idle = false; }
    try {
      appendFileSync(join(args.out, 'host-guard.jsonl'), JSON.stringify({at: new Date().toISOString(), lock, hostBusy, idle}) + '\n');
    } catch { errors.push('Host guard evidence could not be written'); }
    if (!hostBusy || !idle || errors.length) stop(1);
  };
  const timer = lock && setInterval(() => check(containers(resources)), 10_000);
  const sigint = () => stop(130), sigterm = () => stop(143);
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    const code = await new Promise<number>(resolve => {
      child.once('error', () => resolve(1));
      child.once('close', status => resolve(status ?? 1));
    });
    closed = true;
    clearInterval(timer);
    if (lock) check(containers(resources));
    let cleanupVerified = false;
    try {
      cleanup(resources);
      for (const path of ['staged-backfill', 'fixture-messages.tsv']) rmSync(join(args.out, path), {force: true, recursive: true});
      cleanupVerified = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    if (lock) check([]);
    let evidence: Evidence;
    try { evidence = JSON.parse(readFileSync(join(args.out, 'evidence.json'), 'utf8')); }
    catch { evidence = {snapshots: [], windows: {}, errors: ['Missing worker evidence']}; }
    evidence.errors.push(...errors);
    if (code && !evidence.errors.length) evidence.errors.push('Phase A worker did not complete');
    const result = report(args.mode, args.rows, evidence, {cleanupVerified, hostBusy: lock ? hostBusy : null,
      idle: lock ? idle : null, interrupted: interrupted > 1});
    save(join(args.out, 'report.json'), result);
    console.log(`Phase A ${result.status} (${join(args.out, 'report.json')})`);
    for (const finding of result.findings) console.log(finding);
    return interrupted || code || Number(result.invalid.length > 0);
  } finally {
    clearInterval(timer);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}

async function main(argv: string[]) {
  const args = options(argv);
  const envelope = process.env[workerKey];
  if (envelope) {
    const {resources, parent} = JSON.parse(envelope) as {resources: Names; parent: number};
    assert.equal(parent, process.ppid, 'Worker requires its supervising process');
    await worker(args, resources);
    return;
  }
  const lock = args.mode === 'smoke' ? undefined : callerLock();
  if (lock) {
    hostPlacement();
    checkIdle([], []);
    assert.equal(git('status', '--porcelain'), '', 'Full-size checkout must be clean');
  }
  loadManifest();
  refuseLeftovers(docker);
  mkdirSync(args.out, {mode: 0o700});
  process.exitCode = await supervise(args, argv, names(), lock);
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Phase A INVALID: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
