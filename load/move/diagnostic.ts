import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { command, docker, type Stack } from '../slice5/stack.ts';
import { appEvidence, cgroupSample, dbEvidence, dbSampleIntervalMs, k6Evidence, parseDbSample, parseStatements,
  statementGroupSql, type DbSample } from './diagnostic-evidence.ts';
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
  return { async stop() {
    clearInterval(timer);
    await pending;
    const summary = Object.fromEntries(names.map(name => {
      const present = samples.flatMap(s => s.containers[name] ?? []);
      const first = present[0], last = present.at(-1);
      return [name, { samples: present.length, missing: samples.length - present.length,
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

export function captureDiagnostic(stack: Stack, name: string, metricsFile: string) {
  stack.sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();');
  const since = new Date().toISOString();
  const db = samplePostgres(stack);
  const resources = sampleContainers(stack, name);
  return { async finish() {
    const [postgres, containers] = await Promise.all([db.stop(), resources.stop()]);
    const [app, generator, statements] = await Promise.allSettled([
      exec('docker', ['logs', '--since', since, stack.app], { timeout: 15000, maxBuffer: 128 * 1024 * 1024 })
        .then(result => appEvidence(result.stderr)),
      readK6(metricsFile),
      exec('docker', ['exec', stack.db, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow',
        '-c', statementsSql], { timeout: 5000 }).then(result => parseStatements(result.stdout.trim())),
    ]);
    const value = <T>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : null;
    return { since, app: value(app), k6: value(generator), containers, postgres: {
      ...postgres, ...dbEvidence(postgres.samples, value(statements) ?? []), statementsAvailable: statements.status === 'fulfilled',
    } };
  } };
}

async function readK6(file: string) {
  // Propagate errors from the source through the decompressor to the line reader.
  const input = createReadStream(file);
  const gz = createGunzip();
  input.on('error', error => gz.destroy(error));
  return k6Evidence(createInterface({ input: input.pipe(gz), crlfDelay: Infinity }));
}
