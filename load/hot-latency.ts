// #314 History / Replay latency percentiles on the hot-plans dataset (load/hot-plans).
// Runs pgbench inside the throwaway PostgreSQL container as the app role, with
// prepared statements (like SQLx) and per-transaction logs, then prints p50/p95/p99.
// ctx=1 runs each query in a transaction that sets the Organization first; the
// per-statement averages separate that cost from the measured SQL.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('no samples');
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(rank, 1)) - 1];
}

// pgbench --log line: client_id transaction_no time_us script_no time_epoch time_us_frac
export function logLatenciesMs(log: string): number[] {
  return log.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const fields = line.trim().split(/\s+/);
    const micros = Number(fields[2]);
    if (fields.length < 6 || !Number.isFinite(micros)) throw new Error(`bad pgbench log line: ${line}`);
    return micros / 1000;
  });
}

// pgbench -r lines: "<avg ms> <failures> <command>"; keep the SQL commands only.
export function statementAveragesMs(report: string): { ms: number; command: string }[] {
  return report.split('\n').flatMap((line) => {
    const match = /^\s+(\d+\.\d+)\s+\d+\s+(.+)$/.exec(line);
    if (!match || match[2].startsWith('\\')) return [];
    return [{ ms: Number(match[1]), command: match[2].slice(0, 60) }];
  });
}

function main() {
  const container = process.env.HOTPLANS_CONTAINER;
  if (!container || !process.env.PGPASSWORD) throw new Error('set HOTPLANS_CONTAINER and PGPASSWORD (app role, test only)');
  const database = process.env.HOTPLANS_DB || 'hotplans';
  const seconds = process.env.LATENCY_SECONDS || '30';
  const clients = (process.env.LATENCY_CLIENTS || '1,8').split(',');
  const contexts = (process.env.LATENCY_CTX || '0,1').split(',');
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ids = docker('exec', container, 'psql', '-U', 'postgres', '-d', database, '-Atc',
    "SELECT md5('chan-a-1')::uuid || ' ' || md5('user-a-2')::uuid").trim().split(' ');
  const here = fileURLToPath(new URL('./hot-plans/latency/', import.meta.url));
  for (const script of ['history', 'replay']) {
    docker('cp', `${here}${script}.sql`, `${container}:/tmp/hot-latency-${script}.sql`);
    for (const ctx of contexts) for (const c of clients) {
      const prefix = `/tmp/hot-latency-${script}-${ctx}-${c}`;
      docker('exec', container, 'sh', '-c', `rm -f ${prefix}*`);
      const report = docker('exec', '-e', 'PGPASSWORD', container, 'pgbench', '-n', '-h', '127.0.0.1', '-U', 'fukulow_app',
        '-M', 'prepared', '-c', c, '-j', c, '-T', seconds, '-r', '--random-seed=1', '--log', `--log-prefix=${prefix}`,
        '-D', `ctx=${ctx}`, '-D', 'org=00000000-0000-4000-8000-00000000000a', '-D', `chan=${ids[0]}`, '-D', `member=${ids[1]}`,
        '-f', `/tmp/hot-latency-${script}.sql`, database);
      if (!/number of failed transactions: 0 /.test(report)) throw new Error(`${script}: pgbench reported failures\n${report}`);
      const samples = logLatenciesMs(docker('exec', container, 'sh', '-c', `cat ${prefix}*`)).sort((a, b) => a - b);
      const row = [50, 95, 99].map((p) => percentile(samples, p).toFixed(3)).join(' / ');
      const statements = statementAveragesMs(report).filter((s) => s.ms > 0).map((s) => `${s.ms.toFixed(3)} ${s.command}`).join('; ');
      console.log(`${script} ctx=${ctx} clients=${c} n=${samples.length} p50/p95/p99 ms ${row} | avg: ${statements}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
