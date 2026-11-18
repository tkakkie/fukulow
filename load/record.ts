import { tmpdir } from 'node:os';
import { spawn, spawnSync, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { cpus, totalmem, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createCertificate, domain, outsideCheckout, proxyOverride, recordTls } from './proxy-target.ts';
import type { Proxy } from './proxy-judgment.ts';
import { sampledCpuPeaks, type ResourceSample } from './throughput-summary.ts';
import { requireSuccessfulRun } from './summary.ts';
import { loadRecipe } from './generator.ts';
import { appEvidence, proxyEvidence, type AppEvidence, type ProxyEvidence } from './app-evidence.ts';
const execAsync = promisify(execFile);
const proxy = process.env.LOAD_PROXY as Proxy | undefined;
if (proxy && !['caddy', 'nginx'].includes(proxy)) throw new Error('LOAD_PROXY must be caddy or nginx');
const firstPaint = process.env.LOAD_FIRST_PAINT === '1';
const throughputMode = process.env.LOAD_SCRIPT === 'load/throughput.ts';

// Artifacts belong outside the checkout: they contain machine-specific measurements.
// A caller that may have to clean up after a killed run (load/proxy-compare.ts) chooses the name.
const project = process.env.LOAD_PROJECT_NAME || `fukulow-load-${Date.now()}-${randomUUID().slice(0, 8)}`;
if (!/^fukulow-load-[a-z0-9-]+$/.test(project)) throw new Error('LOAD_PROJECT_NAME must match fukulow-load-[a-z0-9-]+');
const port = process.env.LOAD_PORT || '18057';
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > (proxy ? 65534 : 65535) || ['8080', '55432'].includes(port)) {
  throw new Error('LOAD_PORT must be a non-default unprivileged host port');
}
const output = resolve(process.env.LOAD_RESULT_DIR || `${tmpdir()}/${project}`);
if (proxy) {
  outsideCheckout(output);
  if (existsSync(output) && readdirSync(output).length) throw new Error('LOAD_RESULT_DIR must be a new or empty directory');
}
mkdirSync(output, { recursive: true });
let certificateDir: string | undefined;
let ownsCertificate = false;
let tls: ReturnType<typeof recordTls> | undefined;
const inherited = { ...process.env };
delete inherited.LOAD_ORGANIZATION_ID;
delete inherited.LOAD_SETUP_TOKEN;
const env = { ...inherited, LOAD_PROJECT: project, LOAD_PORT: port, LOAD_DB_PASSWORD: randomUUID(),
  LOAD_APP_PASSWORD: randomUUID(),
  LOAD_SETUP_TOKEN: randomUUID(),
  LOAD_CONTAINER_NAME: `${project}-generator`,
  LOAD_DOCKER_NETWORK: (proxy || process.env.LOAD_DIRECT_NETWORK === '1') ? `${project}_default` : 'bridge',
  GODEBUG: proxy ? 'http2client=0' : process.env.GODEBUG,
  K6_INSECURE_SKIP_TLS_VERIFY: proxy ? 'true' : process.env.K6_INSECURE_SKIP_TLS_VERIFY,
  BASE_URL: proxy ? `https://${domain}` : process.env.LOAD_DIRECT_NETWORK === '1' ? 'http://app:8080' : `http://host.docker.internal:${port}`, LOAD_BOOTSTRAP: '1',
  LOAD_APP_IMAGE: process.env.LOAD_APP_IMAGE || `${project}-app`,
  LOAD_SERVER_SOURCE: resolve(process.env.LOAD_SERVER_SOURCE || '.'),
  LOAD_EMAIL: 'baseline@example.invalid', LOAD_PASSWORD: randomUUID(), LOAD_MEASURE: '1',
  LOAD_RECONNECT_STORM: throughputMode ? '0' : (process.env.LOAD_RECONNECT_STORM || '0') };
const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'load/compose.yml'];
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
const resources: ResourceSample[] = [];
const hostGeneratorSamples: { at: string; cpuPercent: number; rssKiB: number }[] = [];
const resourceNames: Record<string, string> = { generator: env.LOAD_CONTAINER_NAME };
type Statement = { queryid: string; toplevel: boolean; query: string; calls: number; total_exec_time: number };
type Snapshot = { at: string; completedAt: number; statements: Statement[]; database: unknown };
const snapshots: Record<string, Snapshot> = {};
let timer: ReturnType<typeof setInterval> | undefined;
let sampling: Promise<void> | undefined;
let log = '';
let summary: unknown;
const clientTls = new Set<string>();
let throughput: ReturnType<typeof import('./throughput-summary.ts').throughputReport> | undefined;
let storm: unknown;
let restart: Promise<void> | undefined;
let restartMs: number | undefined;
let progress: unknown;
let setupComplete: unknown;
let rate: { startedAt?: number; offered: number; [key: string]: unknown } | undefined;
let measurementError: unknown;
let exitCode = 1;
let generatorExitCode: number | undefined;
let generatorWindow: { startedAt: number; clientClosingAt?: number; endedAt?: number } | undefined;
let appContainer: string | undefined;
let appSide: AppEvidence | undefined;
let proxySide: ProxyEvidence | undefined;
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
  if (proxy) {
    certificateDir = process.env.LOAD_TLS_DIR || createCertificate();
    ownsCertificate = !process.env.LOAD_TLS_DIR;
    compose.push('-f', proxyOverride(proxy, certificateDir, String(Number(port) + 1)));
  }
  // Build with this checkout; never retag the shared fukulow-app image.
  docker(...compose, 'up', '-d', ...(process.env.LOAD_APP_IMAGE ? ['--no-build'] : ['--build']), '--wait');
  sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  const app = docker(...compose, 'ps', '-q', 'app');
  appContainer = app;
  const db = docker(...compose, 'ps', '-q', 'db');
  if (proxy) {
    resourceNames.proxy = docker('inspect', '--format', '{{.Name}}', docker(...compose, 'ps', '-q', 'proxy')).replace(/^\//, '');
    tls = recordTls(env.LOAD_DOCKER_NETWORK, docker);
    writeFileSync(`${output}/tls.json`, JSON.stringify({ proxy, tls, insecureSkipTlsVerify: true, certificateType: 'ECDSA P-256', probeCipherOffer: 'TLS_AES_128_GCM_SHA256', certificateSha256: createHash('sha256').update(readFileSync(`${certificateDir}/cert.pem`)).digest('hex'), domain }, null, 2));
  }
  resourceNames.app = docker('inspect', '--format', '{{.Name}}', app).replace(/^\//, '');
  resourceNames.db = docker('inspect', '--format', '{{.Name}}', db).replace(/^\//, '');
  writeFileSync(`${output}/server-source.patch`, command('git', ['-C', env.LOAD_SERVER_SOURCE, 'diff', 'HEAD']));
  const metadata = {
    hostNode: process.version,
    harness: Object.fromEntries(['Makefile', 'Dockerfile', 'compose.yml', 'deploy/Caddyfile', 'deploy/nginx.conf', 'deploy/nginx-acme.sh', 'web/scripts/first-paint.ts', 'load/scenario.ts', 'load/record.ts', 'load/scheduler.ts',
      'load/seed.ts', 'load/proxy-target.ts', 'load/proxy-judgment.ts', 'load/proxy-results.ts', 'load/proxy-compare.ts', 'load/proxy-run.ts', 'load/generator.ts', 'load/app-evidence.ts', 'load/throughput.ts', 'load/throughput-summary.ts', 'load/sessions.ts', 'web/src/reconnect.ts', 'load/compat.ts', 'load/delivery.ts', 'load/summary.ts', 'load/compose.yml'].map(path =>
      [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    commit: command('git', ['rev-parse', 'HEAD']), dirty: command('git', ['status', '--porcelain']),
    serverCommit: command('git', ['-C', env.LOAD_SERVER_SOURCE, 'rev-parse', 'HEAD']),
    serverDirty: command('git', ['-C', env.LOAD_SERVER_SOURCE, 'status', '--porcelain']),
    configured: Object.fromEntries(['CHANNELS', 'PUBLISH_CHANNELS', 'SUBSCRIBERS', 'PUBLISHERS', 'DURATION_SECONDS', 'PUBLISH_INTERVAL_MS',
      'SOCKETS_PER_SESSION', 'SOCKETS_PER_ACCOUNT', 'CONNECT_BATCH', 'CONNECT_INTERVAL_MS', 'READY_TIMEOUT_SECONDS', 'DRAIN_TIMEOUT_SECONDS',
      'LOAD_LEGACY', 'LOAD_ALLOW_REJECTIONS', 'LOAD_RECONNECT', 'LOAD_RECONNECT_STORM', 'REQUEST_TIMEOUT_SECONDS',
      'LOAD_CONNECTIONS_ONLY', 'LOAD_SEND_BURST', 'LOAD_SEND_REFILL_PER_SECOND', 'LOAD_SCRIPT', 'THROUGHPUT_SCENARIO', 'THROUGHPUT_RATES', 'THROUGHPUT_STEP_SECONDS', 'THROUGHPUT_MEMBERS', 'THROUGHPUT_VUS', 'THROUGHPUT_MAX_VUS'].map(key => [key, env[key as keyof typeof env] ?? null])),
    proxy, tls, k6HttpVersion: proxy ? 'HTTP/1.1 (GODEBUG=http2client=0; response assertions)' : undefined, insecureSkipTlsVerify: proxy ? true : undefined,
    project, port, started: new Date().toISOString(), platform: platform(), arch: arch(),
    hostCpuModel: cpus()[0]?.model, hostCpus: cpus().length, hostMemory: totalmem(),
    docker: JSON.parse(docker('info', '--format', '{"ServerVersion":{{json .ServerVersion}},"NCPU":{{json .NCPU}},"MemTotal":{{json .MemTotal}},"OperatingSystem":{{json .OperatingSystem}}}')),
    proxyImage: proxy ? docker('inspect', '--format', '{{.Image}}', resourceNames.proxy) : undefined,
    appImage: docker('inspect', '--format', '{{.Image}}', app), dbImage: docker('inspect', '--format', '{{.Image}}', db),
    nofile: process.env.LOAD_NOFILE || '65536', network: env.LOAD_DOCKER_NETWORK, baseUrl: env.BASE_URL,
    k6Image: command('make', ['-s', 'load-image']),
    k6ImageId: docker('image', 'inspect', '--format', '{{.Id}}', command('make', ['-s', 'load-image'])),
  };
  writeFileSync(`${output}/metadata.json`, JSON.stringify(metadata, null, 2));
  const sample = () => {
    if (sampling) return;
    const hostSample = firstPaint && child?.pid ? execAsync('ps', ['-eo', 'pid=,ppid=,pcpu=,rss='], { env }).then(({ stdout }) => {
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([child!.pid]);
      for (let size = -1; size !== descendants.size;) {
        size = descendants.size;
        for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
      }
      const processes = rows.filter(([pid]) => descendants.has(pid));
      if (processes.length) hostGeneratorSamples.push({ at: new Date().toISOString(),
        cpuPercent: processes.reduce((n, row) => n + row[2], 0), rssKiB: processes.reduce((n, row) => n + row[3], 0) });
    }).catch(error => { measurementError = String(error); }) : Promise.resolve();
    sampling = Promise.all([
      execAsync('docker', ['stats', '--no-stream', '--format', '{{json .}}', app, db, ...(resourceNames.proxy ? [resourceNames.proxy] : []), ...(firstPaint ? [] : [env.LOAD_CONTAINER_NAME])], { env }),
      ...[app, ...(firstPaint ? [] : [env.LOAD_CONTAINER_NAME])].map(id => execAsync('docker', ['exec', id, 'cat', '/proc/1/status'], { env })
        .then(({ stdout }) => ({ id, rssKiB: Number(stdout.match(/^VmRSS:\s+(\d+)/m)?.[1]) }), () => ({ id, rssKiB: null }))),
    ]).then(([{ stdout }, ...rss]) => {
        const rows = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        resources.push({ at: new Date().toISOString(), rows, rss });
      }, () => { /* generator may not exist yet, or may already have exited */ })
      .then(() => hostSample)
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
  const generatorEnvironment = firstPaint ? { ...env,
    FIRST_PAINT_EXTERNAL: '1', FIRST_PAINT_COMPOSE: JSON.stringify(compose), FIRST_PAINT_OUT: `${output}/first-paint`,
    FIRST_PAINT_PORT: String(Number(port) + 1), FIRST_PAINT_API: `http://127.0.0.1:${port}`,
    FIRST_PAINT_DOMAIN: domain, FUKULOW_SETUP_TOKEN: env.LOAD_SETUP_TOKEN } : env;
  // Not `make load`: make reports k6's exit 99 (failed thresholds, a capacity result) as its own exit 2.
  const generatorCommand = firstPaint ? { file: process.execPath, args: ['web/scripts/first-paint.ts'] } : loadRecipe(generatorEnvironment);
  generatorWindow = { startedAt: Date.now() };
  const generator = spawn(generatorCommand.file, generatorCommand.args,
    { env: generatorEnvironment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (line.includes('LOAD_RECONNECT_STORM_READY') && env.LOAD_RECONNECT_STORM === '1' && !restart) {
          const started = Date.now();
          restart = execAsync('docker', [...compose, 'restart', 'app'], { env, timeout: 80_000 })
            .then(() => { restartMs = Date.now() - started; }, error => { measurementError = String(error); });
        }
        if (line.includes('LOAD_MEASUREMENT_END')) capture('after');
        // console.log messages are JSON-quoted in k6's text log output.
        const message = line.includes('msg=') ? JSON.parse(line.match(/msg=("(?:[^"\\]|\\.)*")/)?.[1] || 'null') : line;
        if (typeof message === 'string' && message.startsWith('LOAD_RECONNECT_STORM ')) storm = JSON.parse(message.slice(21));
        if (typeof message === 'string' && message.startsWith('LOAD_TLS ')) clientTls.add(message.slice(9));
        if (typeof message === 'string' && message.startsWith('LOAD_RATE ')) rate = JSON.parse(message.slice(10));
        if (typeof message === 'string' && message.startsWith('LOAD_PROGRESS ')) {
          // scenario.ts prints this just before closing its sockets and revoking Sessions (4001 closes): the evidence window ends here.
          generatorWindow!.clientClosingAt ??= Date.now();
          progress = JSON.parse(message.slice(14));
        }
        if (typeof message === 'string' && message.startsWith('LOAD_SETUP_COMPLETE ')) setupComplete = JSON.parse(message.slice(20));
        if (line.startsWith('LOAD_THROUGHPUT ')) {
          throughput = JSON.parse(line.slice(16));
          if (throughput) rate = { offered: throughput.offered, accepted: throughput.accepted };
        }
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
  generatorWindow.endedAt = Date.now();
  generatorExitCode = exitCode;
  await restart;
  if (env.LOAD_RECONNECT_STORM === '1' && (!storm || restartMs === undefined)) throw new Error('Missing storm measurement/restart');
  if (primaryError) throw primaryError;
  if (timer) clearInterval(timer);
  await sampling;
  if (firstPaint) {
    if (exitCode !== 0) throw new Error('First display runner failed');
    if (!resources.length || !hostGeneratorSamples.length || measurementError) throw new Error('Incomplete first-display resource measurement');
    summary = JSON.parse(readFileSync(`${output}/first-paint/results.json`, 'utf8'));
  } else {
    requireSuccessfulRun(exitCode, summary);
    if (!throughputMode && rate && Number(rate.elapsedMs) < Number(rate.duration) * 1000) {
      throw new Error('Scheduling window ended before its configured deadline');
    }
    if (!throughputMode && rate && (rate.startedAt === undefined || snapshots.before?.completedAt >= rate.startedAt)) {
      throw new Error('SQL baseline snapshot missed the start of publishing');
    }
    if (throughputMode && (!throughput || throughput.steps.some(step => step.incomplete !== 0 || step.attempted === 0))) {
      throw new Error('Incomplete throughput steps (interrupted requests or no arrivals)');
    }
    if (!summary || !rate || !snapshots.before || !snapshots.after || !resources.length || measurementError) {
      throw new Error(`Incomplete measurement: ${String(measurementError ?? 'missing artifact')}`);
    }
  }
} catch (error) {
  exitCode = 1;
  measurementError = measurementError ? `${String(measurementError)}; ${String(error)}` : String(error);
  primaryError ??= error;
} finally {
  if (timer) clearInterval(timer);
  try { await restart; await sampling; } catch (error) { cleanupErrors.push(error); }
  const attempt = (action: () => void) => {
    try { action(); } catch (error) { cleanupErrors.push(error); }
  };
  attempt(() => writeFileSync(`${output}/k6.log`, log));
  // Proxy runs never retain app logs (public artifacts); keep only allowlisted aggregates, also after a failure.
  if (proxy && appContainer && generatorWindow) {
    const window = { startedAt: generatorWindow.startedAt, endedAt: generatorWindow.clientClosingAt ?? generatorWindow.endedAt ?? Date.now() };
    try {
      // pool_stats is written every second: wait for the sample that closes the window, at most 5 s.
      for (let attempt = 0; ; attempt++) {
        const read = spawnSync('docker', ['logs', appContainer], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        const failed = read.error ? `app log read failed: ${read.error.message}` : read.status !== 0 ? `docker logs exited ${read.status}` : undefined;
        appSide = appEvidence(`${read.stdout ?? ''}\n${read.stderr ?? ''}`, window.startedAt, window.endedAt, failed);
        if (attempt >= 5 || !appSide.reasons.includes('no pool_stats sample within 2 s after the window')) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (resourceNames.proxy) {
        const read = spawnSync('docker', ['logs', resourceNames.proxy], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        const failed = read.error ? `proxy log read failed: ${read.error.message}` : read.status !== 0 ? `docker logs exited ${read.status}` : undefined;
        proxySide = proxyEvidence(`${read.stdout ?? ''}\n${read.stderr ?? ''}`, proxy, window.startedAt, window.endedAt, failed);
      }
    } catch (error) { cleanupErrors.push(error); }
  }
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
    writeFileSync(`${output}/results.json`, JSON.stringify({ proxy, tls, clientTls: [...clientTls].map(row => JSON.parse(row)), exitCode, generatorExitCode, rate, throughput, storm, restartMs, summary, snapshots, statementDeltas, sqlPerSend,
      resources, hostGeneratorSamples, cpuPeakPercent: { ...sampledCpuPeaks(resources, resourceNames),
        ...(firstPaint ? { generator: hostGeneratorSamples.length ? Math.max(...hostGeneratorSamples.map(s => s.cpuPercent)) : null } : {}) },
      generatorCpuSource: firstPaint ? 'host ps lifetime %CPU summed over runner and browser descendants' : 'docker stats; instantaneous sampled CPU',
      cpuSamplingScope: 'whole generator run including provisioning, boundaries, idle/drain and teardown; 100% is one core',
      progress, setupComplete, appEvidence: appSide, proxyEvidence: proxySide, generatorWindow, measurementError }, null, 2));
  });
  if (!proxy) attempt(() => writeFileSync(`${output}/server.log`, docker(...compose, 'logs', '--no-color', 'app')));
  if (!proxy) attempt(() => writeFileSync(`${output}/database.log`, docker(...compose, 'logs', '--no-color', 'db')));
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
  if (ownsCertificate && certificateDir) attempt(() => rmSync(certificateDir!, { recursive: true, force: true }));
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  console.log('Results: ' + output);
}
if (cleanupErrors.length) console.error(new AggregateError(cleanupErrors, 'Measurement cleanup failed'));
if (primaryError) throw primaryError;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Measurement cleanup failed');
process.exitCode = exitCode;
