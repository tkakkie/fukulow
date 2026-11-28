import type { ChildProcess, SpawnOptionsWithStdioTuple } from 'node:child_process';

type ProcessEvents = {
  error: [error: Error];
  exit: [code: number | null, signal: NodeJS.Signals | null];
  close: [code: number | null, signal: NodeJS.Signals | null];
};
type OutputStream = { on(event: 'data', listener: (chunk: Buffer) => void): void };
type Child = Pick<ChildProcess, 'pid'> & {
  kill(signal: 'SIGTERM'): boolean;
  stdout: OutputStream;
  stderr: OutputStream;
  on<Event extends keyof ProcessEvents>(event: Event, listener: (...args: ProcessEvents[Event]) => void): void;
};
type Dependencies<Timer> = {
  spawn: (file: string, args: string[], options: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'>) => Child;
  setTimeout: (fire: () => void, ms: number) => Timer;
  clearTimeout: (timer: Timer) => void;
  docker: (...args: string[]) => string;
};
export type ChildResult = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; nightDeadline: boolean; stdout: string; stderr: string };

export function createChildRunner<Timer>({ spawn, docker, setTimeout, clearTimeout }: Dependencies<Timer>) {
  let child: Child | undefined, childName: string | undefined, interrupted = '';
  let deadlineChild: Child | undefined;
  function stop(why: string) {
    interrupted ||= why;
    if (child?.kill('SIGTERM') && why === 'hard timeout') deadlineChild = child;
    if (childName) try { docker('rm', '-f', childName); } catch { /* retried */ }
  }
  const check = () => { if (interrupted) throw new Error(interrupted); };
  function run(file: string, argv: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; name?: string; timeoutMs: number }) {
    return new Promise<ChildResult>((done, reject) => {
      check();
      const proc = spawn(file, argv, { env: o.env ?? process.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      child = proc; childName = o.name;
      let stdout = '', stderr = '', timedOut = false;
      proc.stdout.on('data', (c: Buffer) => { stdout += c; });
      proc.stderr.on('data', (c: Buffer) => { stderr += c; });
      const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, o.timeoutMs);
      proc.on('error', error => { if (proc.pid === undefined) reject(error); });
      proc.on('exit', () => clearTimeout(timer));
      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        if (child === proc) { child = undefined; childName = undefined; }
        done({ code, signal, timedOut, nightDeadline: deadlineChild === proc, stdout, stderr });
      });
    });
  }
  return { run, stop, check, interruption: () => interrupted,
    startDeadline: (minutes: number) => setTimeout(() => stop('hard timeout'), minutes * 60_000) };
}

export type RunChild = ReturnType<typeof createChildRunner>['run'];
