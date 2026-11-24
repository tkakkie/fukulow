import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { allowedCpus, cpuList, pinned, type CpuSets } from '../../harness-core/cpusets.ts';
import { appSessionArguments, docker, percentile } from '../bench.ts';
import { timeouts } from '../runtime.ts';
import { snapshotLaunch } from '../d3r/snapshot.ts';

// The #870 container and client helpers. The frozen d3r files (hashed into manifest-v17) are only
// imported, never changed, so the parts that need a CPU pin are written here.

// The #689 snapshot this diagnosis restores (receipt in the #689 backfill directory).
export const expectedSnapshotSha256 = '087a24f896f7f2e05a9e67b820edd47205c1ca63cad6a741f01a746700edbdac';
// The #796 CPU sets fixed before qualification (2026-11-24): PostgreSQL on the Zen 5 CPUs, the clients on
// the Zen 5c CPUs. A Linux run uses exactly these, so a swapped or other split is refused.
export const qualifiedCpuSets = 'server=0,2,4,6,8,10,12,14;client=1,3,5,7,9,11,13,15';

// Diagnostic logging only; every frozen setting stays as it is and is checked after start.
export const diagnosticSettings = ['-c', 'log_autovacuum_min_duration=0', '-c', 'log_checkpoints=on'];

// The snapshot launch, with taskset in front of its shell when the server has a CPU set, so the
// postmaster and every backend inherit the set (as in the #519 probe).
export function launchArgs(snapshotDirectory: string, server: number[] | undefined) {
  const launch = snapshotLaunch(snapshotDirectory);
  if (launch.options.length !== 4 || launch.options[2] !== '--entrypoint' || launch.options[3] !== 'sh') {
    throw new Error('unexpected snapshot launch options');
  }
  const mount = launch.options.slice(0, 2);
  return server
    ? {options: [...mount, '--entrypoint', 'taskset'], args: ['-c', cpuList(server), 'sh', ...launch.args]}
    : {options: launch.options, args: launch.args};
}

export function checkPins(container: string, sets: CpuSets) {
  const postmaster = allowedCpus(docker('exec', container, 'cat', '/proc/1/status'));
  const client = allowedCpus(docker('exec', container, ...pinned(sets.client, ['cat', '/proc/self/status'])));
  if (cpuList(postmaster) !== cpuList(sets.server) || cpuList(client) !== cpuList(sets.client)) {
    throw new Error(`CPU sets did not take effect: postmaster ${cpuList(postmaster)}, client ${cpuList(client)}`);
  }
  return {postmaster, client};
}

// bench.ts `benchmark`, with pgbench pinned to the client CPU set. Same guard, script, sampling and checks.
export function pinnedBenchmark(client: number[]) {
  return async (container: string, db: string, script: string, dest: string, transactions: number, clients = 5, role = 'fukulow_app') => {
    const guarded = `SELECT 1 / (current_setting('statement_timeout')::interval = interval '10 seconds')::int;\n${script}`;
    writeFileSync(`${dest}.sql`, guarded);
    docker('cp', `${dest}.sql`, `${container}:/tmp/bench.sql`);
    const name = `${dest.split('/').at(-1)}-${createHash('sha256').update(dest).digest('hex').slice(0, 12)}`;
    docker('exec', container, 'mkdir', '-p', `/tmp/${name}`);
    const prefix = `/tmp/${name}/log`;
    const args = ['exec', ...appSessionArguments, container, ...pinned(client, ['pgbench', '-n', '-U', role, '-d', db,
      '-c', String(clients), '-j', String(clients), '-t', String(transactions), '-M', 'prepared', '-l', '--log-prefix', prefix,
      '-f', '/tmp/bench.sql'])];
    const start = performance.now();
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', args); let result = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('docker pgbench timed out')); }, timeouts.benchmark);
      child.stdout.on('data', b => { result += String(b); }); child.stderr.on('data', b => { result += String(b); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        try { writeFileSync(`${dest}.txt`, result); } catch (error) { reject(error); return; }
        if (/ERROR:\s*57014:|canceling statement due to statement timeout/.test(result)) reject(new Error('SQL statement_timeout (SQLSTATE 57014)'));
        else if (code !== 0 || /number of failed transactions:\s+[1-9]/.test(result)) reject(new Error('docker pgbench failed; entire run invalid'));
        else resolve(result);
      });
    });
    const wallMs = performance.now() - start;
    docker('cp', `${container}:/tmp/${name}`, dest);
    const samples: number[] = [];
    for (const file of readdirSync(dest)) for (const row of readFileSync(`${dest}/${file}`, 'utf8').trim().split('\n')) {
      const us = Number(row.trim().split(/\s+/)[2]);
      if (Number.isFinite(us)) samples.push(us / 1000);
    }
    if (samples.length !== transactions * clients) throw new Error(`Invalid benchmark ${dest}: ${output}`);
    return {n: samples.length, p50: percentile(samples, .5), p95: percentile(samples, .95), p99: percentile(samples, .99),
      tps: Number(output.match(/tps = ([\d.]+)/)?.[1]), wallMs};
  };
}

type Node = {'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Join Type'?: string;
  Strategy?: string; 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; Plans?: Node[]};

// Plan shape without costs, timings or row counts, and the root's shared buffers (hit + read, and each).
export function planShape(explain: [{Plan: Node}]) {
  const shape = (n: Node): unknown => [n['Node Type'], n['Relation Name'] ?? null, n['Index Name'] ?? null,
    n['Join Type'] ?? null, n.Strategy ?? null, (n.Plans ?? []).map(shape)];
  const root = explain[0].Plan;
  return {shapeHash: createHash('sha256').update(JSON.stringify(shape(root))).digest('hex'),
    buffers: (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
    sharedHit: root['Shared Hit Blocks'] ?? 0, sharedRead: root['Shared Read Blocks'] ?? 0};
}

// d3r/session.ts `withSession` (frozen), with psql pinned to the client CPU set when one is given, so the
// warm-up, EXPLAIN and the scan run on the client CPUs as pgbench does.
export async function pinnedSession<T>(container: string, db: string, app: boolean, client: number[] | undefined,
  work: (sql: (text: string) => Promise<string>) => Promise<T>) {
  const psql = ['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', app ? 'fukulow_app' : 'fukulow', '-d', db];
  const child = spawn('docker', ['exec', '-i', ...(app ? appSessionArguments : []), container, ...(client ? pinned(client, psql) : psql)]);
  const lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  child.stderr.resume();
  child.stdin.on('error', () => child.kill());
  const done = new Promise<number | null>(resolve => { child.on('error', () => resolve(null)); child.on('close', resolve); });
  const marker = 'D870_QUERY_DONE';
  let completed = false;
  try {
    const result = await work(async text => {
      const timer = setTimeout(() => child.kill('SIGKILL'), timeouts.psql);
      try {
        child.stdin.write(`${text}\n\\echo ${marker}\n`);
        const rows: string[] = [];
        for (;;) {
          const line = await lines.next();
          if (line.done) throw new Error('psql stopped before completing the statement');
          if (line.value === marker) return rows.join('\n');
          rows.push(line.value);
        }
      } finally { clearTimeout(timer); }
    });
    completed = true;
    return result;
  } finally {
    child.stdin.end();
    if (!completed) child.kill();
    const code = await done;
    if (completed && code !== 0) throw new Error('psql did not exit cleanly');
  }
}
