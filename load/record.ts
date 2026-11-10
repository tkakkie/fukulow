import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus, totalmem, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
const execAsync = promisify(execFile);

// Artifacts belong outside the checkout: they contain machine-specific measurements.
const project = `fukulow-load-${Date.now()}-${randomUUID().slice(0, 8)}`;
const port = process.env.LOAD_PORT || '18057';
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || ['8080', '55432'].includes(port)) {
  throw new Error('LOAD_PORT must be a non-default unprivileged host port');
}
const output = resolve(process.env.LOAD_RESULT_DIR || `/private/tmp/${project}`);
mkdirSync(output, { recursive: true });
const inherited = { ...process.env };
delete inherited.LOAD_ORGANIZATION_ID;
delete inherited.LOAD_SETUP_TOKEN;
const env = { ...inherited, LOAD_PROJECT: project, LOAD_PORT: port, LOAD_DB_PASSWORD: randomUUID(),
  LOAD_CONTAINER_NAME: `${project}-generator`,
  LOAD_DOCKER_NETWORK: process.env.LOAD_DIRECT_NETWORK === '1' ? `${project}_default` : 'bridge',
  BASE_URL: process.env.LOAD_DIRECT_NETWORK === '1' ? 'http://app:8080' : `http://host.docker.internal:${port}`, LOAD_BOOTSTRAP: '1',
  LOAD_APP_IMAGE: process.env.LOAD_APP_IMAGE || `${project}-app`,
  LOAD_SERVER_SOURCE: resolve(process.env.LOAD_SERVER_SOURCE || '.'),
  LOAD_EMAIL: 'baseline@example.invalid', LOAD_PASSWORD: randomUUID(), LOAD_MEASURE: '1' };
const compose = ['compose', '-p', project, '-f', 'load/compose.yml'];
const command = (file: string, args: string[]) => execFileSync(file, args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const docker = (...args: string[]) => command('docker', args);
const sql = (query: string) => docker(...compose, 'exec', '-T', 'db', 'psql', '-U', 'fukulow', '-d', 'fukulow', '-Atc', query);
const statsQuery = `SELECT coalesce(json_agg(t), '[]') FROM (
  SELECT queryid::text, toplevel, query, calls, total_exec_time, rows FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query NOT LIKE '%pg_stat_statements%' AND query NOT LIKE '%pg_stat_database%'
  ORDER BY queryid) t`;
const databaseQuery = `SELECT row_to_json(t) FROM (SELECT numbackends, xact_commit, xact_rollback,
  blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
  temp_bytes, deadlocks FROM pg_stat_database WHERE datname = current_database()) t`;
const resources: unknown[] = [];
type Statement = { queryid: string; toplevel: boolean; query: string; calls: number; total_exec_time: number };
type Snapshot = { at: string; completedAt: number; statements: Statement[]; database: unknown };
const snapshots: Record<string, Snapshot> = {};
let timer: ReturnType<typeof setInterval> | undefined;
let sampling: Promise<void> | undefined;
let log = '';
let summary: unknown;
let progress: unknown;
let rate: { startedAt: number; offered: number; [key: string]: unknown } | undefined;
let measurementError: unknown;
let exitCode = 1;
let primaryError: unknown;
let child: ChildProcess | undefined;
const cleanupErrors: unknown[] = [];
const onSignal = (signal: NodeJS.Signals) => {
  primaryError ??= new Error(`Measurement interrupted by ${signal}`);
  // Stop our make/shell/docker CLI group; finally removes the named container itself.
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { cleanupErrors.push(error); }
  }
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
try {
  console.log(`Measurement project: ${project}; artifacts: ${output}`);
  // Build with this checkout; never retag the shared fukulow-app image.
  docker(...compose, 'up', '-d', ...(process.env.LOAD_APP_IMAGE ? ['--no-build'] : ['--build']), '--wait');
  sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  const app = docker(...compose, 'ps', '-q', 'app');
  const db = docker(...compose, 'ps', '-q', 'db');
  writeFileSync(`${output}/server-source.patch`, command('git', ['-C', env.LOAD_SERVER_SOURCE, 'diff', 'HEAD']));
  const metadata = {
    hostNode: process.version,
    harness: Object.fromEntries(['Makefile', 'load/scenario.ts', 'load/record.ts', 'load/scheduler.ts',
      'load/sessions.ts', 'load/compat.ts', 'load/delivery.ts', 'load/summary.ts', 'load/compose.yml'].map(path =>
      [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    commit: command('git', ['rev-parse', 'HEAD']), dirty: command('git', ['status', '--porcelain']),
    serverCommit: command('git', ['-C', env.LOAD_SERVER_SOURCE, 'rev-parse', 'HEAD']),
    serverDirty: command('git', ['-C', env.LOAD_SERVER_SOURCE, 'status', '--porcelain']),
    configured: Object.fromEntries(['CHANNELS', 'PUBLISH_CHANNELS', 'SUBSCRIBERS', 'PUBLISHERS', 'DURATION_SECONDS', 'PUBLISH_INTERVAL_MS',
      'SOCKETS_PER_SESSION', 'CONNECT_BATCH', 'CONNECT_INTERVAL_MS', 'READY_TIMEOUT_SECONDS', 'DRAIN_TIMEOUT_SECONDS',
      'LOAD_LEGACY', 'LOAD_ALLOW_REJECTIONS', 'LOAD_RECONNECT', 'REQUEST_TIMEOUT_SECONDS'].map(key => [key, env[key as keyof typeof env] ?? null])),
    project, port, started: new Date().toISOString(), platform: platform(), arch: arch(),
    hostCpuModel: cpus()[0]?.model, hostCpus: cpus().length, hostMemory: totalmem(),
    docker: JSON.parse(docker('info', '--format', '{"ServerVersion":{{json .ServerVersion}},"NCPU":{{json .NCPU}},"MemTotal":{{json .MemTotal}},"OperatingSystem":{{json .OperatingSystem}}}')),
    appImage: docker('inspect', '--format', '{{.Image}}', app), dbImage: docker('inspect', '--format', '{{.Image}}', db),
    nofile: process.env.LOAD_NOFILE || '65536', network: env.LOAD_DOCKER_NETWORK, baseUrl: env.BASE_URL,
    k6Image: command('make', ['-s', 'load-image']),
    k6ImageId: docker('image', 'inspect', '--format', '{{.Id}}', command('make', ['-s', 'load-image'])),
  };
  writeFileSync(`${output}/metadata.json`, JSON.stringify(metadata, null, 2));
  const sample = () => {
    if (sampling) return;
    sampling = Promise.all([
      execAsync('docker', ['stats', '--no-stream', '--format', '{{json .}}', app, db, env.LOAD_CONTAINER_NAME], { env }),
      ...[app, env.LOAD_CONTAINER_NAME].map(id => execAsync('docker', ['exec', id, 'cat', '/proc/1/status'], { env })
        .then(({ stdout }) => ({ id, rssKiB: Number(stdout.match(/^VmRSS:\s+(\d+)/m)?.[1]) }), () => ({ id, rssKiB: null }))),
    ]).then(([{ stdout }, ...rss]) => {
        const rows = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        resources.push({ at: new Date().toISOString(), rows, rss });
      }, () => { /* generator may not exist yet, or may already have exited */ })
      .finally(() => { sampling = undefined; });
  };
  const capture = (phase: string) => {
    snapshots[phase] = { at: new Date().toISOString(), statements: JSON.parse(sql(statsQuery)),
      database: JSON.parse(sql(databaseQuery)), completedAt: Date.now() };
    if (snapshots[phase].completedAt - Date.parse(snapshots[phase].at) >= 1000) {
      throw new Error('SQL snapshot exceeded the measurement boundary pause');
    }
  };
  if (primaryError) throw primaryError; // a signal arrived during build/setup: do not start the measurement
  const generator = spawn('make', ['load'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = generator;
  let buffered = '';
  const consume = (chunk: Buffer) => {
    const value = chunk.toString();
    log += value;
    process.stdout.write(value);
    buffered += value;
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      try {
        if (line.includes('LOAD_MEASUREMENT_START')) capture('before');
        if (line.includes('LOAD_MEASUREMENT_END')) capture('after');
        // console.log messages are JSON-quoted in k6's text log output.
        const message = line.includes('msg=') ? JSON.parse(line.match(/msg=("(?:[^"\\]|\\.)*")/)?.[1] || 'null') : line;
        if (typeof message === 'string' && message.startsWith('LOAD_RATE ')) rate = JSON.parse(message.slice(10));
        if (typeof message === 'string' && message.startsWith('LOAD_PROGRESS ')) progress = JSON.parse(message.slice(14));
        if (line.startsWith('LOAD_SUMMARY ')) summary = JSON.parse(line.slice(13));
      } catch (error) { measurementError = String(error); }
    }
  };
  generator.stdout.on('data', consume);
  generator.stderr.on('data', consume);
  timer = setInterval(sample, 1000);
  exitCode = await new Promise<number>((done, reject) => {
    generator.on('error', reject);
    generator.on('close', (code) => done(code ?? 1));
  });
  if (primaryError) throw primaryError;
  if (timer) clearInterval(timer);
  await sampling;
  if (rate && Number(rate.elapsedMs) < Number(rate.duration) * 1000) {
    throw new Error('Scheduling window ended before its configured deadline');
  }
  if (rate && snapshots.before?.completedAt >= rate.startedAt) {
    throw new Error('SQL baseline snapshot missed the start of publishing');
  }
  if (!summary || !rate || !snapshots.before || !snapshots.after || !resources.length || measurementError) {
    throw new Error(`Incomplete measurement: ${String(measurementError ?? 'missing artifact')}`);
  }
} catch (error) {
  exitCode = 1;
  measurementError = String(error);
  primaryError ??= error;
} finally {
  if (timer) clearInterval(timer);
  try { await sampling; } catch (error) { cleanupErrors.push(error); }
  const attempt = (action: () => void) => {
    try { action(); } catch (error) { cleanupErrors.push(error); }
  };
  attempt(() => writeFileSync(`${output}/k6.log`, log));
  attempt(() => {
    const previous = new Map(snapshots.before?.statements.map((s) => [s.queryid + ':' + s.toplevel, s]));
    const statementDeltas = snapshots.after?.statements.map((s) => ({ ...s,
      calls: s.calls - (previous.get(s.queryid + ':' + s.toplevel)?.calls ?? 0),
      total_exec_time: s.total_exec_time - (previous.get(s.queryid + ':' + s.toplevel)?.total_exec_time ?? 0),
    })).filter((s) => s.calls > 0);
    const calls = statementDeltas?.reduce((sum, s) => sum + s.calls, 0);
    const topLevelCalls = statementDeltas?.filter((s) => s.toplevel).reduce((sum, s) => sum + s.calls, 0);
    const queries = statementDeltas?.filter((s) => s.toplevel && !/^(BEGIN|COMMIT|ROLLBACK)\b/.test(s.query))
      .reduce((sum, s) => sum + s.calls, 0);
    const sqlPerSend = rate && { calls, topLevelCalls, queries,
      allStatementsPerSend: (calls ?? 0) / rate.offered,
      topLevelStatementsPerSend: (topLevelCalls ?? 0) / rate.offered,
      topLevelQueriesPerSend: (queries ?? 0) / rate.offered,
      topLevelQueriesPerAcceptedSend: (queries ?? 0) / Number(rate.accepted ?? rate.offered) };
    writeFileSync(`${output}/results.json`, JSON.stringify({ exitCode, rate, summary, snapshots, statementDeltas, sqlPerSend,
      resources, progress, measurementError }, null, 2));
  });
  attempt(() => writeFileSync(`${output}/server.log`, docker(...compose, 'logs', '--no-color', 'app')));
  attempt(() => writeFileSync(`${output}/database.log`, docker(...compose, 'logs', '--no-color', 'db')));
  attempt(() => writeFileSync(`${output}/container-state.json`, docker(...compose, 'ps', '-aq').split('\n').filter(Boolean)
    .map(id => docker('inspect', '--format', '{{json .State}}', id)).join('\n')));
  // These exact names/project were created above; never prune or touch other projects.
  attempt(() => {
    if (docker('ps', '-aq', '--filter', 'name=^/' + env.LOAD_CONTAINER_NAME + '$')) {
      docker('rm', '-f', env.LOAD_CONTAINER_NAME);
    }
  });
  attempt(() => { docker(...compose, 'down', '--volumes'); });
  // Compose --rmi local excludes our explicitly tagged image; remove its unique tag only.
  attempt(() => {
    if (!process.env.LOAD_APP_IMAGE && docker('image', 'ls', '-q', `${project}-app`)) docker('image', 'rm', `${project}-app`);
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  console.log('Results: ' + output);
}
if (cleanupErrors.length) console.error(new AggregateError(cleanupErrors, 'Measurement cleanup failed'));
if (primaryError) throw primaryError;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Measurement cleanup failed');
process.exitCode = exitCode;
