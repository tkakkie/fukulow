import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { command, docker, type Stack } from '../slice5/stack.ts';
import { appEvidence, cgroupSample, dbEvidence, dbSampleIntervalMs, k6Evidence, parseDbSample, parseStatements,
  statementGroupSql, type DbSample, type Organizations, type Window } from './diagnostic-evidence.ts';
import { timestamp } from './diagnostic-stream.ts';
import { diagnosticLabel } from './diagnostic-mode.ts';

const exec = promisify(execFile);
const topStatementTexts = 25;

export async function diagnosticImage(repo: string, scratch: string, tag: string, signal: AbortSignal,
  target: { commit: string; patch: string }) {
  const source = join(scratch, 'source');
  const archive = join(scratch, 'source.tar');
  const patch = join(repo, target.patch);
  mkdirSync(source);
  command('git', ['-C', repo, 'archive', '--format=tar', `--output=${archive}`, target.commit]);
  command('tar', ['-xf', archive, '-C', source]);
  rmSync(archive);
  command('git', ['-C', source, 'apply', '--whitespace=error', patch]);
  signal.throwIfAborted();
  await exec('docker', ['buildx', 'build', '--load', '--tag', tag, '--label', `${diagnosticLabel}=true`,
    '--label', `org.opencontainers.image.revision=${target.commit}`, source],
  { signal, maxBuffer: 16 * 1024 * 1024 });
  const id = docker('image', 'inspect', '--format', '{{.Id}}', tag);
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid DIAGNOSTIC image ID');
  return { id, revision: target.commit, patch: target.patch, patchSha256: createHash('sha256').update(readFileSync(patch)).digest('hex') };
}

const activitySql = `SELECT json_build_object('at', floor(extract(epoch FROM clock_timestamp()) * 1000),
  'waits', COALESCE(json_agg(json_build_object('id', query_id::text, 'type', kind, 'event', event, 'count', n)), '[]'))
FROM (SELECT query_id, coalesce(wait_event_type, 'running') AS kind, coalesce(wait_event, 'none') AS event, count(*) AS n
  FROM pg_stat_activity WHERE datname = current_database() AND usename = 'fukulow_app' AND state = 'active'
  GROUP BY 1, 2, 3) AS activity`;

// Text is kept for the top statements only, and only for DML: normalized $n placeholders carry no values.
const statementsSql = `SELECT json_build_object('id', queryid::text, 'calls', calls, 'execMs', total_exec_time,
  'group', ${statementGroupSql()},
  'text', CASE WHEN rank <= ${topStatementTexts} AND query ~* '^[[:space:]]*(SELECT|WITH|INSERT|UPDATE|DELETE)[[:space:]]'
    THEN left(query, 200) END)
FROM (SELECT queryid, calls, total_exec_time, query, row_number() OVER (ORDER BY total_exec_time DESC, queryid) AS rank
  FROM pg_stat_statements WHERE toplevel AND userid = 'fukulow_app'::regrole
    AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())) AS ranked
ORDER BY rank`;

function samplePostgres(stack: Stack) {
  const child = spawn('docker', ['exec', '-i', stack.db, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
    '-U', 'fukulow', '-d', 'fukulow', '-f', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const samples: DbSample[] = [];
  let pending = false, exited = false, failures = 0, skippedTicks = 0;
  const closed = new Promise<void>(done => {
    child.once('error', () => { failures++; });
    child.once('close', code => {
      if (code !== 0) failures++;
      exited = true;
      done();
    });
  });
  child.stdin.on('error', () => { failures++; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { samples.push(parseDbSample(line)); } catch { failures++; }
    pending = false;
  });
  const timer = setInterval(() => {
    if (exited) return;
    if (pending) {
      skippedTicks++;
      return;
    }
    pending = true;
    child.stdin.write(activitySql + ';\n');
  }, dbSampleIntervalMs);
  return { async stop() {
    clearInterval(timer);
    child.stdin.end();
    const deadline = setTimeout(() => child.kill(), 3000);
    await closed;
    clearTimeout(deadline);
    return { samples, failures, skippedTicks };
  } };
}

function sampleContainers(stack: Stack, k6: string) {
  const containers = { app: stack.app, postgres: stack.db, k6 };
  const names = Object.keys(containers) as (keyof typeof containers)[];
  const collect = async (id: string) => {
    try {
      const { stdout } = await exec('docker', ['exec', id, 'sh', '-c',
        'cat /sys/fs/cgroup/cpu.stat && printf "memory.current " && cat /sys/fs/cgroup/memory.current'],
      { timeout: 2000 });
      return cgroupSample(stdout);
    } catch { return null; }
  };
  const samples: { at: number; containers: Record<keyof typeof containers, ReturnType<typeof cgroupSample>> }[] = [];
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending) return;
    const at = Date.now();
    pending = Promise.all(names.map(async name => [name, await collect(containers[name])] as const))
      .then(rows => { samples.push({ at, containers: Object.fromEntries(rows) as typeof samples[number]['containers'] }); })
      .finally(() => { pending = undefined; });
  };
  tick();
  const timer = setInterval(tick, 1000);
  const pause = async () => {
    clearInterval(timer);
    await pending;
  };
  return { pause, async stop(window: Window) {
    await pause();
    const scoped = samples.filter(sample => sample.at >= window.start && sample.at <= window.end);
    const summary = Object.fromEntries(names.map(name => {
      const present = scoped.flatMap(s => s.containers[name] ?? []);
      const first = present[0], last = present.at(-1);
      return [name, { samples: present.length, missing: scoped.length - present.length,
        peakMemoryBytes: first ? Math.max(...present.map(s => s.memoryBytes)) : null,
        nrThrottledDelta: first && last && present.length > 1 ? last.nr_throttled - first.nr_throttled : null,
        throttledUsecDelta: first && last && present.length > 1 ? last.throttled_usec - first.throttled_usec : null }];
    }));
    return { samples, summary };
  } };
}

export function diagnosticOutput(dir: string) {
  const metricsDir = join(dir, 'metrics');
  mkdirSync(metricsDir, { mode: 0o700 });
  return { dockerArgs: ['-v', `${metricsDir}:/diagnostic`], k6Args: ['--out', 'json=/diagnostic/k6.json.gz'],
    file: join(metricsDir, 'k6.json.gz') };
}

export function appLogAnchor(stdout: string, stderr: string) {
  return [stdout.trimEnd().split('\n').at(-1), stderr.trimEnd().split('\n').at(-1)]
    .flatMap(line => {
      const at = timestamp(line?.split(' ', 1)[0]);
      return line && Number.isFinite(at) ? [{ line, at }] : [];
    }).sort((a, b) => b.at - a.at)[0];
}

export function retainedAppLog(log: string, anchor: ReturnType<typeof appLogAnchor>, window: Window, organizations: Organizations) {
  const lines = log.split('\n');
  const anchorRetained = anchor !== undefined && lines.includes(anchor.line);
  const body = lines.flatMap(line => {
    const split = line.indexOf(' ');
    const at = timestamp(line.slice(0, split));
    return at >= window.start ? [line.slice(split + 1)] : [];
  });
  const truncationSigns = lines.filter(line => {
    const split = line.indexOf(' ');
    const prefixed = Number.isFinite(timestamp(line.slice(0, split)));
    const message = prefixed ? line.slice(split + 1) : line;
    return (!prefixed || !message.startsWith('{')) &&
      /move_diag_|http_completed|truncat|error (?:from daemon|while reading)|error grabbing logs|corrupt/i.test(message);
  }).length;
  return { ...appEvidence(body.join('\n'), organizations, window), anchorRetained, truncationSigns };
}

function collectorFailure(name: string, error: unknown) {
  // Preserve the failure class without Docker stderr, SQL arguments or request data.
  const { code, killed } = (error ?? {}) as { code?: unknown; killed?: boolean };
  const reason = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output buffer limit'
    : killed ? 'timeout or termination'
    : typeof code === 'number' ? `exit ${code}`
    : error instanceof Error ? error.name : 'unknown error';
  return `${name}: ${reason}`;
}

type VmClockReading = { hostBeforeMs: number; hostAfterMs: number; vmMs: number };

export function selectVmClockReading(readings: readonly VmClockReading[]) {
  const roundTrip = (reading: VmClockReading) => reading.hostAfterMs - reading.hostBeforeMs;
  let best = readings[0];
  if (!best) return null;
  for (const reading of readings.slice(1)) {
    if (roundTrip(reading) < roundTrip(best)) best = reading;
  }
  const roundTripMs = roundTrip(best);
  return { ...best, offsetMs: best.vmMs - (best.hostBeforeMs + roundTripMs / 2),
    roundTripMs, readingCount: readings.length };
}

async function sampleVmClock(app: string, boundary: 'start' | 'end', failures: string[]) {
  const readings: VmClockReading[] = [];
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const hostBeforeMs = Date.now();
      const { stdout } = await exec('docker', ['exec', app, 'date', '+%s%3N'], { timeout: 5000 });
      const hostAfterMs = Date.now();
      const raw = stdout.trim();
      const vmMs = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(vmMs) || hostAfterMs < hostBeforeMs) {
        failures.push(`Docker VM clock at arm ${boundary}: invalid clock reading`);
        return null;
      }
      readings.push({ hostBeforeMs, hostAfterMs, vmMs });
    }
    return selectVmClockReading(readings);
  } catch (error) {
    failures.push(collectorFailure(`Docker VM clock at arm ${boundary}`, error));
    return null;
  }
}

export async function captureDiagnostic(stack: Stack, name: string, metricsFile: string, organizations: Organizations, fusedRank: boolean) {
  stack.sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();');
  let anchor: ReturnType<typeof appLogAnchor>;
  const failures: string[] = [];
  try {
    const { stdout, stderr } = await exec('docker', ['logs', '--timestamps', '--tail', '1', stack.app], { timeout: 5000 });
    anchor = appLogAnchor(stdout, stderr);
  } catch (error) {
    failures.push(collectorFailure('Docker log anchor', error));
  }
  const start = await sampleVmClock(stack.app, 'start', failures);
  const db = samplePostgres(stack);
  const resources = sampleContainers(stack, name);
  return { async finish(window: Window, monotonicMs: number, steady?: Window) {
    // Let any in-flight cgroup docker exec finish before timing the clock commands.
    await resources.pause();
    const end = await sampleVmClock(stack.app, 'end', failures);
    const [postgres, containers] = await Promise.all([db.stop(), resources.stop(window)]);
    const since = new Date((anchor?.at ?? window.start) - 1000).toISOString();
    const [app, generator, statements] = await Promise.allSettled([
      exec('docker', ['logs', '--timestamps', '--since', since, stack.app], { timeout: 15000, maxBuffer: 128 * 1024 * 1024 })
        .then(({ stdout, stderr }) => retainedAppLog(stdout + '\n' + stderr, anchor, window, organizations)),
      readK6(metricsFile, fusedRank),
      exec('docker', ['exec', stack.db, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow',
        '-c', statementsSql], { timeout: 5000 }).then(result => parseStatements(result.stdout.trim())),
    ]);
    const value = <T>(result: PromiseSettledResult<T>, name: string) => {
      if (result.status === 'fulfilled') return result.value;
      failures.push(collectorFailure(name, result.reason));
      return null;
    };
    const statementRows = value(statements, 'PostgreSQL statements') ?? [];
    const waited = steady ? postgres.samples.filter(sample => sample.at >= steady.start && sample.at <= steady.end) : [];
    // Keep analyzed waits on the same scope as the statement totals (startup through drain).
    const armSamples = postgres.samples.filter(sample => sample.at >= window.start && sample.at <= window.end);
    const wallMs = window.end - window.start;
    return { since, window, clock: { wallMs, monotonicMs, driftMs: wallMs - monotonicMs, start, end },
      app: value(app, 'Docker app logs'), k6: value(generator, 'k6 stream'), failures, containers, postgres: {
        ...postgres, ...dbEvidence(armSamples, statementRows), steadyCoverageMs: dbEvidence(waited, []).coveredMs,
        statementsAvailable: statementRows.some(row => row.calls > 0),
      } };
  } };
}

async function readK6(file: string, fusedRank: boolean) {
  // Pipeline also validates the gzip trailer, even if the parsed points looked complete.
  return pipeline(createReadStream(file), createGunzip(), source =>
    k6Evidence(createInterface({ input: source, crlfDelay: Infinity }), fusedRank));
}
