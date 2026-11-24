import { execFile, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { dockerFreeBytes, freeBytes } from './harness-core/host.ts';
import { launch, type Child } from './launcher/launcher.ts';
import { currentPlatform } from './launcher/platform.ts';
import { parseQueue } from './launcher/queue.ts';

// Runs an approved queue of measurement jobs (#867). See load/launcher/launcher.ts.
const usage = 'node load/launch.ts --queue FILE';
const { values } = parseArgs({ options: { queue: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.queue) throw new Error(usage);
const queue = parseQueue(readFileSync(values.queue, 'utf8'));
if (!existsSync(queue.chainDir)) throw new Error(`chainDir does not exist: ${queue.chainDir}`);

const exec = (argv: string[], cwd?: string) => {
  const c = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  return { status: c.error || c.signal ? null : c.status, stdout: c.stdout ?? '' };
};

// The job runs in its own process group (detached), so a stop reaches every process it started,
// for example a `docker exec` client, and alive() can tell when the whole group has ended.
function run(argv: string[], opts: { cwd: string; log: string; env?: Record<string, string> }): Child {
  const fd = openSync(opts.log, 'a');
  const c = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', fd, fd], detached: true });
  const done = new Promise<number>(resolve => {
    c.on('error', e => { writeSync(fd, `spawn failed: ${e.message}\n`); resolve(127); });
    c.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  }).finally(() => closeSync(fd));
  const group = (signal: NodeJS.Signals | 0) => {
    if (c.pid === undefined) return false;
    try { process.kill(-c.pid, signal); return true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw e;
    }
  };
  return { done, kill: (signal = 'SIGTERM') => { group(signal); }, alive: () => group(0) };
}

const execAsync = promisify(execFile);
// Polls for a container with the label and follows its logs; a new container is picked up after the last one ends.
// Asynchronous and abortable, so a stalled Docker daemon never blocks signals or the job's exit.
function captureLogs(label: string, file: string) {
  const stop = new AbortController();
  let follower: ReturnType<typeof spawn> | null = null;
  const follow = (id: string) => {
    const fd = openSync(file, 'a');
    let closed = false;
    const done = () => { if (!closed) { closed = true; closeSync(fd); } follower = null; };
    try {
      follower = spawn('docker', ['logs', '-f', id], { stdio: ['ignore', fd, fd] });
      follower.on('error', done);
      follower.on('exit', done);
    } catch { done(); }
  };
  const loop = async () => {
    while (!stop.signal.aborted) {
      if (follower === null) {
        try {
          const { stdout } = await execAsync('docker', ['ps', '--filter', `label=${label}`, '--format', '{{.ID}}'], { timeout: 30_000, killSignal: 'SIGKILL', signal: stop.signal });
          const id = stdout.trim().split('\n')[0];
          if (id && !stop.signal.aborted) follow(id);
        } catch { /* retried on the next poll */ }
      }
      await sleep(5_000, undefined, { signal: stop.signal }).catch(() => {});
    }
  };
  void loop();
  return () => { stop.abort(); follower?.kill('SIGTERM'); };
}

const claim = (path: string, text: string) => {
  try { writeFileSync(path, text, { flag: 'wx' }); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
};
const safe = <T>(f: () => T) => { try { return f(); } catch { return null; } };

// A signal also ends the idle wait at once instead of after the current poll.
const signalled = new AbortController();
const result = await launch(queue, {
  platform: currentPlatform(), exec, spawn: run, captureLogs,
  exists: existsSync, claim, remove: p => rmSync(p, { force: true }), append: appendFileSync, write: writeFileSync,
  freeBytes: p => safe(() => freeBytes(exec(['df', '-Pk', p]).stdout)), dockerFreeBytes: image => safe(() => dockerFreeBytes(image)),
  nodeVersion: process.version, pid: process.pid, now: () => new Date(), sleep: ms => sleep(ms, undefined, { signal: signalled.signal }).catch(() => {}),
  pause: ms => sleep(ms),
  every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
  onSignal: handler => { for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => { signalled.abort(); handler(s); }); },
});
console.log(JSON.stringify(result));
process.exit(result.outcome === 'done' ? 0 : 3);
