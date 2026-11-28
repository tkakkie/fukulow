import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { partD, type Arm } from './config.ts';
import { classifyPartDFailure, parseTimeline, scanPartDPostgresLog, timelineTopics, type PostgresState, type RunD } from './judge.ts';
import { dbCommand, docker as systemDocker, sleep } from './stack.ts';
import type { RunChild } from './child.ts';

type Context = {
  output: string;
  project: string;
  full: Record<Arm, string>;
  smoke: boolean;
  timelineEnvironment: () => NodeJS.ProcessEnv;
  source: (arm: Arm) => string;
  save: (path: string, value: RunD) => void;
  run: RunChild;
  check: () => void;
  interruption: () => string;
  cleanupErrors: string[];
  writePartDArtifact: ReturnType<typeof createPartDArtifactWriter>;
};

type IO = {
  mkdirSync: (path: string, options: { recursive: true }) => void;
  readFileSync: (path: string, encoding: 'utf8') => string;
  writeFileSync: (path: string, data: string) => void;
  randomUUID: () => string;
  docker: typeof systemDocker;
  spawnSync: (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
    { status: number | null; stdout: string; stderr: string; error?: Error };
  sleep: (ms: number) => Promise<unknown>;
};
const systemIO: IO = { mkdirSync, readFileSync, writeFileSync, randomUUID, docker: systemDocker, spawnSync, sleep };

function partDPostgresState(docker: typeof systemDocker, name: string): PostgresState | null {
  try {
    const format = '[{{json .State.Running}},{{json .State.OOMKilled}},{{json .State.ExitCode}},{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}]';
    const [Running, OOMKilled, ExitCode, Health] = JSON.parse(docker('inspect', '--format', format, name));
    if (typeof Running === 'boolean' && typeof OOMKilled === 'boolean' && Number.isInteger(ExitCode)
      && (Health === null || ['starting', 'healthy', 'unhealthy', 'none'].includes(Health))) {
      return { Running, OOMKilled, ExitCode, Health };
    }
  } catch { /* Inspect can fail before Docker has created the container. */ }
  return null;
}

export function createPartDArtifactWriter(cleanupErrors: string[], error = console.error) {
  return (marker: string, write: () => void) => {
    try { write(); } catch {
      const message = `${marker}: artifact write failed`;
      cleanupErrors.push(message);
      error(`slice5: ${message}`);
    }
  };
}

export async function runPartD(arm: Arm, round: number, rerun: boolean, context: Context, io: IO = systemIO): Promise<RunD> {
  const { output, project, full, smoke, timelineEnvironment, source, save, run, check, interruption, cleanupErrors, writePartDArtifact } = context;
  const { mkdirSync, readFileSync, writeFileSync, randomUUID, docker, spawnSync, sleep } = io;
  const id = `D-${round}-${arm}${rerun ? '-rerun' : ''}`, dir = `${output}/runs/${id}`;
  writePartDArtifact(`${id}/`, () => mkdirSync(dir, { recursive: true }));
  const name = `${project}-d-${round}-${arm}`.toLowerCase(), password = randomUUID();
  const result: RunD = { part: 'D', round, arm, commit: full[arm], complete: false, smoke, topics: NaN, rows: [], exitCode: null, failure: null };
  let cargo: Awaited<ReturnType<typeof run>> | undefined;
  let stage = 'PostgreSQL image lookup';
  try {
    const pg = /image: (postgres:[^\s]+)/.exec(readFileSync(`${source(arm)}/load/compose.yml`, 'utf8'))?.[1];
    if (!pg) throw new Error('missing pinned PostgreSQL');
    stage = 'PostgreSQL docker run';
    try { docker('rm', '-f', name); } catch { /* The name is normally absent. */ }
    // Keep an exited container available for inspect, then remove it explicitly.
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '--tmpfs', '/var/lib/postgresql', pg, ...dbCommand().slice(1));
    // TCP readiness twice in a row: the image's init-phase server answers on the socket only.
    stage = 'PostgreSQL readiness';
    let ready = 0;
    for (let i = 0; i < 90 && ready < 2; i++) {
      check();
      ready = docker('exec', name, 'sh', '-c', 'pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && echo ok || echo no') === 'ok' ? ready + 1 : 0;
      await sleep(1000);
    }
    if (ready < 2) throw new Error('PostgreSQL not ready');
    stage = 'PostgreSQL port lookup';
    const port = docker('port', name, '5432/tcp').split(':').at(-1);
    stage = 'Cargo launch';
    cargo = await run('cargo', ['test', '--locked', '--release', '-p', 'fukulow-server', '--lib', partD.target, '--', '--ignored', '--nocapture'], { cwd: source(arm),
      env: { ...timelineEnvironment(), DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/postgres` }, timeoutMs: 30 * 60_000 });
  } catch {
    const interrupted = interruption();
    result.failure = { cause: interrupted === 'hard timeout' ? 'timeout' : interrupted ? 'unknown' : 'infrastructure',
      exitCode: null, signal: null, timedOut: false, evidence: [interrupted === 'hard timeout' ? 'night-deadline' : interrupted || `${stage} failed`] };
  }

  try {
    result.postgres = partDPostgresState(docker, name);
    // Docker forwards PostgreSQL's stdout and stderr separately.
    const pgLog = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    result.postgresLogMarkers = scanPartDPostgresLog(pgLog.status === 0 && !pgLog.error ? `${pgLog.stdout}\n${pgLog.stderr}` : null);
    result.failure?.evidence.push(...result.postgresLogMarkers);
    let log: string | undefined;
    if (cargo) {
      log = `${cargo.stderr}\n${cargo.stdout}`.replaceAll(password, '<redacted>');
      result.exitCode = cargo.code;
      result.failure = classifyPartDFailure({ exitCode: cargo.code, signal: cargo.signal, timedOut: cargo.timedOut, nightDeadline: cargo.nightDeadline },
        log, result.postgres, result.postgresLogMarkers);
      result.topics = timelineTopics(log);
      result.rows = parseTimeline(log);
      result.complete = result.rows.length === 4;
    }
    writePartDArtifact(`${id}/result.json`, () => save(`${dir}/result.json`, result));
    if (log !== undefined) {
      const cargoLog = log;
      writePartDArtifact(`${id}/cargo.log`, () => writeFileSync(`${dir}/cargo.log`, cargoLog));
    }
    return result;
  } finally {
    try { docker('rm', '-f', name); } catch (error) {
      if (!/\bNo such container\b/i.test(String((error as { stderr?: string })?.stderr ?? '')))
        cleanupErrors.push(`${id}: PostgreSQL cleanup failed`);
    }
  }
}
