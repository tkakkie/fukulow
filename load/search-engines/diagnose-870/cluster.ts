import { spawn } from 'node:child_process';
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
        writeFileSync(`${dest}.txt`, result);
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

// Plan shape without costs, timings or row counts, and the root's shared buffers (hit + read).
export function planShape(explain: [{Plan: Node}]) {
  const shape = (n: Node): unknown => [n['Node Type'], n['Relation Name'] ?? null, n['Index Name'] ?? null,
    n['Join Type'] ?? null, n.Strategy ?? null, (n.Plans ?? []).map(shape)];
  const root = explain[0].Plan;
  return {shapeHash: createHash('sha256').update(JSON.stringify(shape(root))).digest('hex'),
    buffers: (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
    sharedReads: root['Shared Read Blocks'] ?? 0};
}
