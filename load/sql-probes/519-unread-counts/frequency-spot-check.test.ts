import assert from 'node:assert/strict';
import test from 'node:test';
import { turbostatArgv } from './frequency-spot-check.ts';

test('turbostat argv has no whitespace inside an element, so sudo-rs can match the scoped sudoers entry', () => {
  for (const arg of turbostatArgv) assert.doesNotMatch(arg, /\s/, arg);
  assert.deepEqual(turbostatArgv.slice(-2), ['--', '/usr/bin/cat']);
});

// #979: drive the real control flow with an unprivileged Node child in place of `sudo -n turbostat ... -- cat`.
// Production argv, sudoers and timing are unchanged; only the spawned command is replaced.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { withSpotCheck, type SpotCheck } from './frequency-spot-check.ts';

const limit = { timeout: 15_000 };
const node = (script: string): [string, ...string[]] => [process.execPath, '-e', script];
function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-979-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function validPid(pid: number) {
  assert.ok(Number.isInteger(pid) && pid > 0, `no child pid: ${pid}`);
  return pid;
}
const pidOf = (raw: SpotCheck | null) => validPid(Number(/pid=(\d+)/.exec(raw?.stderr ?? '')?.[1]));
// True only once the kernel reports no such process; any other error is a test failure, not "gone".
async function gone(pid: number) {
  validPid(pid);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw err;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}
// Wait for a file the child writes once it is running. The test's signal ends the poll on timeout or failure.
async function waitFor(path: string, signal: AbortSignal) {
  while (!existsSync(path)) await sleep(10, undefined, { signal });
  return readFileSync(path, 'utf8');
}

test('work runs only after the echoed ready marker, then stdin reaches EOF and the child exits 0 (#979)', limit, async t => {
  const dir = scratch(t), echoed = join(dir, 'echoed'), eof = join(dir, 'eof');
  // Echo stdin back like cat, but only after a delay, and record the echo and the EOF on disk.
  const child = node(`const fs=require('fs');process.stderr.write('pid='+process.pid+'\\n');
    process.stdin.once('data',d=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(echoed)},'');process.stdout.write(d);},300));
    process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(eof)},'eof');process.exit(0);});process.stdin.resume();`);
  let raw: SpotCheck | null = null, sawEcho = false;
  const result = await withSpotCheck(async () => { sawEcho = existsSync(echoed); return 'done'; },
    new AbortController().signal, r => { raw = r; }, child);
  assert.equal(result, 'done');
  assert.equal(sawEcho, true, 'work started before the ready marker was echoed');
  assert.equal(readFileSync(eof, 'utf8'), 'eof');
  assert.ok(raw!.startNs !== null && raw!.stopNs !== null && BigInt(raw!.startNs) <= BigInt(raw!.stopNs));
  assert.match(raw!.stdout, /FUKULOW_TURBOSTAT_READY/);
  assert.equal(await gone(pidOf(raw)), true);
});

test('a child that exits before echoing the marker is refused and work never runs (#979)', limit, async () => {
  let raw: SpotCheck | null = null, ran = false;
  await assert.rejects(withSpotCheck(async () => { ran = true; }, new AbortController().signal, r => { raw = r; },
    node(`process.stderr.write('pid='+process.pid+'\\n');process.exit(0);`)), /turbostat exited before its opening sample/);
  assert.equal(ran, false);
  assert.equal(raw!.startNs, null);
  assert.equal(await gone(pidOf(raw)), true);
});

test('an abort before the marker ends the child with the existing refusal and leaves no child (#979)', limit, async t => {
  const abort = new AbortController(), dir = scratch(t), pidFile = join(dir, 'pid');
  t.after(() => abort.abort());
  let ran = false;
  // Never echoes: stands in for a turbostat that has not taken its opening sample. The pid file, written
  // atomically once the child runs, is the barrier, so the abort always hits a live child.
  const run = withSpotCheck(async () => { ran = true; }, abort.signal, () => {},
    node(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')},String(process.pid));
      fs.renameSync(${JSON.stringify(pidFile + '.tmp')},${JSON.stringify(pidFile)});process.stdin.resume();setInterval(()=>{},1000);`));
  const pid = validPid(Number(await waitFor(pidFile, t.signal)));
  abort.abort();
  await assert.rejects(run, /turbostat exited before its opening sample/);
  assert.equal(ran, false);
  assert.equal(await gone(pid), true);
});

test('an abort during the work fails the closing sample and leaves no child (#979)', limit, async () => {
  const abort = new AbortController();
  let raw: SpotCheck | null = null;
  const echo = node(`process.stderr.write('pid='+process.pid+'\\n');process.stdin.pipe(process.stdout);`);
  await assert.rejects(withSpotCheck(async () => {
    abort.abort();
    await new Promise(r => setTimeout(r, 200));
  }, abort.signal, r => { raw = r; }, echo), /turbostat failed/);
  assert.ok(raw!.startNs !== null);
  assert.equal(await gone(pidOf(raw)), true);
});
