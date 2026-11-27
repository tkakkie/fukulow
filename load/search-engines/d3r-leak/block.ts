import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appSessionArguments, docker, SqlStatementTimeoutError } from '../bench.ts';
import { benchmarkScript } from '../d3r/path.ts';
import { timeouts } from '../runtime.ts';
import type { Design } from './design.ts';
import { parseBlock, SampleCountError } from './samples.ts';

export const preBlockGuard = "SELECT current_setting('statement_timeout')::interval = interval '10 seconds' AND current_user = 'fukulow_app';";

export function checkPgbench(output: string, exit: number | null, plannedCount: number) {
  if (/ERROR:\s*57014:|canceling statement due to statement timeout/i.test(output)) {
    throw new SqlStatementTimeoutError('SQL statement_timeout (SQLSTATE 57014)');
  }
  assert.ok(exit === 0 && !/\b(?:FATAL|ERROR):/i.test(output) &&
    /^number of failed transactions: 0\b/m.test(output), 'pgbench failed');
  if (!output.includes(`number of transactions actually processed: ${plannedCount}/${plannedCount}\n`)) {
    throw new SampleCountError('Wrong pgbench sample count');
  }
}

export async function measureBlock(client: string, db: string, page: string, query: string, out: string, design: Design, seed: number) {
  mkdirSync(out);
  const localScript = join(out, 'bench.sql');
  const remote = docker('exec', client, 'mktemp', '-d');
  const script = benchmarkScript(page, query);
  writeFileSync(localScript, script);
  docker('cp', localScript, `${client}:${remote}/bench.sql`);
  docker('exec', client, 'mkdir', `${remote}/logs`);
  const args = ['exec', ...appSessionArguments, client, 'pgbench', '-n', '-U', 'fukulow_app', '-d', db,
    '-c', String(design.clients), '-j', String(design.clients), '-t', String(design.measuredPerClient + 1),
    '-M', 'prepared', '--max-tries=1', `--random-seed=${seed}`, '-l', `--log-prefix=${remote}/logs/run`, '-f', `${remote}/bench.sql`];
  const run = await new Promise<{exit: number | null; output: string}>((resolve, reject) => {
    const child = spawn('docker', args);
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeouts.benchmark);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', exit => { clearTimeout(timer); resolve({exit, output}); });
  });
  writeFileSync(join(out, 'pgbench.txt'), run.output);
  docker('cp', `${client}:${remote}/logs`, out);
  checkPgbench(run.output, run.exit, design.clients * (design.measuredPerClient + 1));
  const logs = readdirSync(join(out, 'logs')).sort().map(name => readFileSync(join(out, 'logs', name), 'utf8'));
  const block = parseBlock(logs, design.clients, design.measuredPerClient);
  docker('exec', client, 'rm', '-r', remote);
  return block;
}
