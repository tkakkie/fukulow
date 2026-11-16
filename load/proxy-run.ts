// #469 B: one measurement run under a hard deadline. On expiry (or interruption) the run is invalid:
// SIGTERM its process tree, SIGKILL it after a grace period, then remove its Docker resources by name.
import { spawn, execFileSync } from 'node:child_process';

export type Bounded = { code: number; timedOut: boolean; forced: boolean; stopped?: boolean; elapsedMs: number; cleanupErrors: string[] };
type Options = { command: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; graceMs: number;
  cleanup: () => string[]; onStart?: (stop: () => void) => void };

// Live descendants of `root`. record.ts starts its generator in a process group of its own, so
// signalling only the runner's group would miss it; orphans are re-parented, so collect them early.
export function descendants(root: number, list = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })): number[] {
  const rows = list().trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found = new Set([root]);
  for (let size = 0; size !== found.size;) {
    size = found.size;
    for (const [pid, parent] of rows) if (found.has(parent)) found.add(pid);
  }
  found.delete(root);
  return [...found];
}

export function runBounded(options: Options): Promise<Bounded> {
  const started = Date.now();
  const child = spawn(options.command, options.args, { env: options.env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  let timedOut = false;
  let forced = false;
  let stopped = false;
  const tree = new Set<number>();
  const track = () => { try { if (child.pid) for (const pid of descendants(child.pid)) tree.add(pid); } catch { /* ps unavailable */ } };
  const signal = (name: NodeJS.Signals) => {
    track();
    for (const target of [child.pid && -child.pid, child.pid, ...tree]) {
      try { if (target) process.kill(target, name); } catch { /* already gone */ }
    }
    if (name === 'SIGKILL') for (const pid of tree) try { process.kill(-pid, name); } catch { /* not a group leader */ }
  };
  let kill: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (kill) return;
    stopped = true;
    signal('SIGTERM');
    kill = setTimeout(() => { forced = true; signal('SIGKILL'); }, options.graceMs);
  };
  options.onStart?.(terminate);
  const deadline = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  return new Promise((resolve) => {
    const finish = (code: number) => {
      clearTimeout(deadline);
      if (kill) clearTimeout(kill);
      // A survivor of the tree (e.g. a grandchild ignoring SIGTERM) must not outlive the run.
      if (stopped) signal('SIGKILL');
      const cleanupErrors = stopped ? options.cleanup() : [];
      resolve({ code, timedOut, forced, stopped, elapsedMs: Date.now() - started, cleanupErrors });
    };
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}

// Every container, network and volume of one record.ts project, plus its named k6 container.
// Only these exact names/labels: never prune or touch other projects.
export function dockerCleanup(project: string, run: (args: string[]) => string = args =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim()): string[] {
  if (!/^fukulow-load-[a-z0-9-]+$/.test(project)) throw new Error('Refusing to clean an unexpected project name');
  const errors: string[] = [];
  const attempt = (args: string[]) => { try { return run(args); } catch (error) { errors.push(String(error)); return ''; } };
  const label = `label=com.docker.compose.project=${project}`;
  const ids = (kind: 'ps' | 'network ls' | 'volume ls', filter: string) =>
    attempt([...kind.split(' '), ...(kind === 'ps' ? ['-aq'] : ['-q']), '--filter', filter]).split('\n').filter(Boolean);
  // The network filter also catches the unnamed TLS probe container that joins the project network.
  const containers = [...new Set([...ids('ps', label), ...ids('ps', `name=^/${project}-generator$`),
    ...ids('ps', `network=${project}_default`)])];
  if (containers.length) attempt(['rm', '-f', ...containers]);
  const networks = ids('network ls', label);
  if (networks.length) attempt(['network', 'rm', ...networks]);
  const volumes = ids('volume ls', label);
  if (volumes.length) attempt(['volume', 'rm', '-f', ...volumes]);
  return errors;
}

const number = (env: Record<string, string | undefined>, key: string) => {
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
};
// The hard deadline for one record.ts run: k6's own setup + scenario + teardown limits (as load/scenario.ts
// computes them) plus Compose start/stop. A run that honours its limits never reaches it.
export const composeAllowanceSeconds = 600;
export const firstPaintBudgetSeconds = 1800;
export function runBudgetMs(env: Record<string, string | undefined>): number {
  if (env.LOAD_FIRST_PAINT === '1') return (firstPaintBudgetSeconds + composeAllowanceSeconds) * 1000;
  const channels = number(env, 'CHANNELS');
  const sockets = channels * number(env, 'SUBSCRIBERS');
  const perAccount = env.SOCKETS_PER_ACCOUNT ? number(env, 'SOCKETS_PER_ACCOUNT') : 0;
  const sessions = Math.max(1, Math.ceil(sockets / (perAccount || number(env, 'SOCKETS_PER_SESSION'))));
  const storm = env.LOAD_RECONNECT_STORM === '1';
  const scenario = number(env, 'READY_TIMEOUT_SECONDS') * (storm ? 2 : 1) + number(env, 'DURATION_SECONDS')
    + number(env, 'DRAIN_TIMEOUT_SECONDS') + number(env, 'REQUEST_TIMEOUT_SECONDS')
    + Math.ceil(sockets / number(env, 'CONNECT_BATCH')) * number(env, 'CONNECT_INTERVAL_MS') / 1000 + 10;
  const setup = sessions * 10 + channels * 5 + 25;
  const teardown = sessions * 5 + 10;
  return Math.ceil(setup + scenario + teardown + composeAllowanceSeconds) * 1000;
}

export function timeoutReason(result: Bounded, budgetMs: number): string | undefined {
  if (!result.timedOut && !result.forced && !result.stopped) return undefined;
  return [result.timedOut ? `hard timeout: run exceeded ${Math.round(budgetMs / 1000)} s and was stopped` : 'run interrupted',
    result.forced ? 'SIGTERM ignored; process group killed' : 'stopped by SIGTERM',
    result.cleanupErrors.length ? `Docker cleanup failed: ${result.cleanupErrors.join('; ')}` : 'Docker resources removed'].join('; ');
}
