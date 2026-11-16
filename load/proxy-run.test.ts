import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { deadlineSkip, descendants, dockerCleanup, jobDeadlineMs, runBounded, runBudgetMs, timeoutReason } from './proxy-run.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A fake generator: writes its own and a grandchild's pid, then never exits; `stubborn` ignores SIGTERM.
function fake(stubborn: boolean) {
  const directory = mkdtempSync(`${tmpdir()}/proxy-run-`);
  const script = `${directory}/generator.mjs`;
  writeFileSync(script, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    ${stubborn ? "process.on('SIGTERM', () => {});" : ''}
    // Like record.ts's generator: its own process group, so the runner's group signal misses it.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore', detached: true });
    writeFileSync(${JSON.stringify(`${directory}/pids`)}, process.pid + ' ' + child.pid);
    setInterval(() => {}, 1000);
  `);
  return { directory, script, pids: () => readFileSync(`${directory}/pids`, 'utf8').split(' ').map(Number) };
}
function reap(generator: { pids: () => number[] }) {
  try { for (const pid of generator.pids()) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } catch { /* no pids yet */ }
}
// Never let a broken runBounded hang the suite or leak the fake: fail after 8 s and kill what it wrote.
async function within<T>(promise: Promise<T>, generator: { pids: () => number[] }): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('runBounded did not return')), 8000); })]);
  } catch (error) {
    reap(generator);
    throw error;
  } finally { clearTimeout(timer); }
}
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20)); };

test('a generator that never exits and ignores SIGTERM is killed with its descendants and cleaned up', async () => {
  const generator = fake(true);
  let cleaned = 0;
  try {
    const started = Date.now();
    const result = await within(runBounded({ command: process.execPath, args: [generator.script], env: process.env,
      timeoutMs: 500, graceMs: 300, cleanup: () => { cleaned++; return []; } }), generator);
    assert.equal(result.timedOut, true);
    assert.equal(result.forced, true);
    assert.equal(cleaned, 1);
    assert.ok(Date.now() - started < 5000);
    const pids = generator.pids();
    await waitFor(() => !pids.some(alive));
    assert.deepEqual(pids.filter(alive), [], 'generator and grandchild must be gone');
    assert.match(timeoutReason(result, 500)!, /^hard timeout: run exceeded 1 s and was stopped; SIGTERM ignored; process group killed; Docker resources removed$/);
  } finally { reap(generator); rmSync(generator.directory, { recursive: true, force: true }); }
});

test('a generator that stops on SIGTERM is not force-killed, but its run is still invalid and cleaned up', async () => {
  const generator = fake(false);
  let cleaned = 0;
  try {
    const result = await within(runBounded({ command: process.execPath, args: [generator.script], env: process.env,
      timeoutMs: 500, graceMs: 5000, cleanup: () => { cleaned++; return ['docker unavailable']; } }), generator);
    assert.equal(result.timedOut, true);
    assert.equal(result.forced, false);
    assert.equal(cleaned, 1);
    const pids = generator.pids();
    await waitFor(() => !pids.some(alive));
    assert.deepEqual(pids.filter(alive), [], 'the SIGTERM-ignoring grandchild must not outlive the run');
    assert.match(timeoutReason(result, 500)!, /stopped by SIGTERM; Docker cleanup failed: docker unavailable$/);
  } finally { reap(generator); rmSync(generator.directory, { recursive: true, force: true }); }
});

test('a run that finishes in time is neither stopped nor cleaned up', async () => {
  let cleaned = 0;
  const result = await runBounded({ command: process.execPath, args: ['-e', 'process.exit(3)'], env: process.env,
    timeoutMs: 10_000, graceMs: 100, cleanup: () => { cleaned++; return []; } });
  assert.deepEqual([result.code, result.timedOut, result.forced, cleaned], [3, false, false, 0]);
  assert.equal(timeoutReason(result, 10_000), undefined);
});

test('Docker cleanup removes only the named project and its generator container', () => {
  const calls: string[][] = [];
  const errors = dockerCleanup('fukulow-load-1-abc', args => {
    calls.push(args);
    if (args[0] === 'ps' && args.at(-1)!.startsWith('label=')) return 'app1\ndb1';
    if (args[0] === 'ps' && args.at(-1)!.startsWith('network=')) return 'k6\nprobe';
    if (args[0] === 'ps') return 'k6';
    if (args[0] === 'network' && args[1] === 'ls') return 'net1';
    if (args[0] === 'volume' && args[1] === 'ls') return '';
    return '';
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [
    ['ps', '-aq', '--filter', 'label=com.docker.compose.project=fukulow-load-1-abc'],
    ['ps', '-aq', '--filter', 'name=^/fukulow-load-1-abc-generator$'],
    ['ps', '-aq', '--filter', 'network=fukulow-load-1-abc_default'],
    ['rm', '-f', 'app1', 'db1', 'k6', 'probe'],
    ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=fukulow-load-1-abc'],
    ['network', 'rm', 'net1'],
    ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=fukulow-load-1-abc'],
  ]);
  assert.throws(() => dockerCleanup('other-project', () => ''), /unexpected project/);
});

test('run budget covers k6 limits plus Compose and grows with Accounts', () => {
  const base = { CHANNELS: '1', SUBSCRIBERS: '1000', SOCKETS_PER_ACCOUNT: '32', SOCKETS_PER_SESSION: '32',
    READY_TIMEOUT_SECONDS: '120', DURATION_SECONDS: '60', DRAIN_TIMEOUT_SECONDS: '30', REQUEST_TIMEOUT_SECONDS: '45',
    CONNECT_BATCH: '100', CONNECT_INTERVAL_MS: '100' };
  // 32 Accounts: setup 32*10+5+25, scenario 120+60+30+45+1+10, teardown 32*5+10, Compose 600.
  assert.equal(runBudgetMs(base), (350 + 266 + 170 + 600) * 1000);
  assert.ok(runBudgetMs({ ...base, SUBSCRIBERS: '10000' }) > runBudgetMs(base));
  assert.equal(runBudgetMs({ ...base, LOAD_RECONNECT_STORM: '1' }) - runBudgetMs(base), 120_000);
  assert.equal(runBudgetMs({ LOAD_FIRST_PAINT: '1' }), 2_400_000);
  assert.throws(() => runBudgetMs({ ...base, CHANNELS: 'x' }));
});

test('an interrupted run is stopped, cleaned up and invalid even if it exits on SIGTERM', async () => {
  const generator = fake(false);
  let cleaned = 0;
  try {
    const result = await within(runBounded({ command: process.execPath, args: [generator.script], env: process.env,
      timeoutMs: 60_000, graceMs: 5000, cleanup: () => { cleaned++; return []; },
      onStart: stop => setTimeout(stop, 300) }), generator);
    assert.deepEqual([result.timedOut, result.stopped, cleaned], [false, true, 1]);
    assert.match(timeoutReason(result, 60_000)!, /^run interrupted; stopped by SIGTERM/);
    const pids = generator.pids();
    await waitFor(() => !pids.some(alive));
    assert.deepEqual(pids.filter(alive), []);
  } finally { reap(generator); rmSync(generator.directory, { recursive: true, force: true }); }
});

test('descendants follows the whole tree, not only direct children', () => {
  assert.deepEqual(descendants(10, () => ' 10 1\n 11 10\n 12 11\n 13 12\n 20 1\n').sort(), [11, 12, 13]);
});

test('a run that cannot finish before the job deadline is not started', () => {
  assert.equal(jobDeadlineMs({}), undefined);
  const deadline = jobDeadlineMs({ PROXY_JOB_STARTED: '1000', PROXY_JOB_MINUTES: '60' })!;
  assert.equal(deadline, (1000 + 3600 - 600) * 1000);
  assert.throws(() => jobDeadlineMs({ PROXY_JOB_STARTED: '1000' }));
  assert.equal(deadlineSkip(1_000_000, 1000, 500, undefined), undefined);
  assert.equal(deadlineSkip(deadline - 1500, 1000, 500, deadline), undefined);
  assert.match(deadlineSkip(deadline - 1499, 1000, 500, deadline)!, /^not started: job time left 1 s is below this run's bound 2 s; run invalid$/);
  assert.match(deadlineSkip(deadline + 5000, 1000, 500, deadline)!, /job time left 0 s/);
});
