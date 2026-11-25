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
import { withSpotCheck, type SpotCheck } from './frequency-spot-check.ts';

const limit = { timeout: 15_000 };
const node = (script: string): [string, ...string[]] => [process.execPath, '-e', script];
function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-979-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const pidOf = (raw: SpotCheck | null) => Number(/pid=(\d+)/.exec(raw?.stderr ?? '')?.[1]);
async function gone(pid: number) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
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

test('an abort before the marker ends the child with the existing refusal and leaves no child (#979)', limit, async () => {
  const abort = new AbortController();
  let raw: SpotCheck | null = null, ran = false;
  // Never echoes: stands in for a turbostat that has not taken its opening sample.
  const run = withSpotCheck(async () => { ran = true; }, abort.signal, r => { raw = r; },
    node(`process.stderr.write('pid='+process.pid+'\\n');process.stdin.resume();setInterval(()=>{},1000);`));
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(run, /turbostat exited before its opening sample/);
  assert.equal(ran, false);
  assert.equal(await gone(pidOf(raw)), true);
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
