import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appSessionArguments, docker, percentile } from '../bench.ts';
import { timeouts } from '../runtime.ts';

// The Docker commands the benchmark runs; the worker passes its gated set (io.ts), so after a signal no
// further docker cp, exec or pgbench starts inside a benchmark either (review round 8).
export type DockerLayer = {docker: (...args: string[]) => string; spawn: (command: string, args: string[]) => ChildProcessWithoutNullStreams};

// The client runs the same guard, script, sampling and checks as bench.ts.
export function clientBenchmark(layer: DockerLayer = {docker, spawn}) {
  const {docker: run} = layer;
  return async (container: string, db: string, script: string, dest: string, transactions: number, clients = 5, role = 'fukulow_app') => {
    const guarded = `SELECT 1 / (current_setting('statement_timeout')::interval = interval '10 seconds')::int;\n${script}`;
    writeFileSync(`${dest}.sql`, guarded);
    run('cp', `${dest}.sql`, `${container}:/tmp/bench.sql`);
    const name = `${dest.split('/').at(-1)}-${createHash('sha256').update(dest).digest('hex').slice(0, 12)}`;
    run('exec', container, 'mkdir', '-p', `/tmp/${name}`);
    const prefix = `/tmp/${name}/log`;
    const pgbench = ['pgbench', '-n', '-U', role, '-d', db, '-c', String(clients), '-j', String(clients), '-t', String(transactions),
      '-M', 'prepared', '-l', '--log-prefix', prefix, '-f', '/tmp/bench.sql'];
    const args = ['exec', ...appSessionArguments, container, ...pgbench];
    const start = performance.now();
    const output = await new Promise<string>((resolve, reject) => {
      const child = layer.spawn('docker', args); let result = '';
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
    run('cp', `${container}:/tmp/${name}`, dest);
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

// Warm-up, EXPLAIN and the scan share a psql session in the client container.
export async function clientSession<T>(container: string, db: string, app: boolean,
  work: (sql: (text: string) => Promise<string>) => Promise<T>) {
  const psql = ['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', app ? 'fukulow_app' : 'fukulow', '-d', db];
  const child = spawn('docker', ['exec', '-i', ...(app ? appSessionArguments : []), container, ...psql]);
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
