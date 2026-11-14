// Isolated preliminary Mac measurement. Raw output and disposable credentials stay external.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { outsideCheckout } from './dms-workload.ts';

const output = resolve(process.env.LOAD_RESULT_DIR || `/private/tmp/fukulow-dms-${Date.now()}`);
if (!outsideCheckout(output, resolve('.'))) throw new Error('LOAD_RESULT_DIR must be outside checkout');
mkdirSync(output, { recursive: true });
const project = `fukulow-dms-${Date.now()}`;
const env = { ...process.env, LOAD_PROJECT: project, LOAD_PORT: process.env.LOAD_PORT || '18151', LOAD_DB_PASSWORD: randomUUID(), LOAD_APP_PASSWORD: randomUUID(), LOAD_SETUP_TOKEN: randomUUID(), LOAD_APP_IMAGE: process.env.LOAD_APP_IMAGE || 'fukulow-151m:preliminary' };
const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'load/compose.yml', '-f', `${output}/override.json`];
const run = (args: string[], input?: string) => execFileSync('docker', args, { env, input, encoding: 'utf8', maxBuffer: 64*1024*1024 }).trim();
const sql = (query: string) => run([...compose, 'exec', '-T', 'db', 'psql', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-At'], query);
const dbStats = () => sql("SELECT json_build_object('at',clock_timestamp(),'wal',(SELECT row_to_json(w) FROM pg_stat_wal w),'checkpointer',(SELECT row_to_json(c) FROM pg_stat_checkpointer c),'io',(SELECT json_agg(i) FROM pg_stat_io i),'deadlocks',(SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()),'discovery_bytes',pg_total_relation_size('dm_discovery'),'counter_bytes',pg_total_relation_size('dm_discovery_counters'),'dataset',json_build_object('members',(SELECT count(*) FROM users),'dms',(SELECT count(*) FROM channels WHERE kind='dm'),'dm_grants',(SELECT count(*) FROM channel_members WHERE dm_created_at IS NOT NULL),'messages',(SELECT count(*) FROM messages),'journal_rows',(SELECT count(*) FROM dm_discovery),'counter_rows',(SELECT count(*) FROM dm_discovery_counters)));");
writeFileSync(`${output}/override.json`, JSON.stringify({ services: { db: { command: ['postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=all', '-c', 'max_connections=64'], ports: ['127.0.0.1:55151:5432'] }, app: { environment: { FUKULOW_DB_MAX_CONNECTIONS: '32' } } } }));
// Allows explicit cleanup after interruption without displaying credentials.
writeFileSync(`${output}/private-state.json`, JSON.stringify({ project, env, compose }), { mode: 0o600 });
const children: ReturnType<typeof spawn>[] = [];
let timer: ReturnType<typeof setInterval> | undefined, sampling = false, closing = false;
let failed = false;
const samples: unknown[] = [];
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => {
  closing = true;
  if (timer) clearInterval(timer);
  for (let i = 0; i < 4; i++) spawnSync('docker', ['rm','-f',`${project}-k6-${i}`], { stdio: 'ignore' });
  run([...compose, 'down', '-v', '--remove-orphans']);
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
try {
  run([...compose, 'up', '-d', '--no-build', '--wait']);
  const db = run([...compose, 'ps', '-q', 'db']), app = run([...compose, 'ps', '-q', 'app']);
  sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
  const metadata = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), hostCpu: cpus()[0].model, cpus: cpus().length, ram: totalmem(), node: process.version,
    appImage: run(['inspect', '--format', '{{.Image}}', app]), dbImage: run(['inspect', '--format', '{{.Image}}', db]), docker: JSON.parse(run(['info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}},"kernel":{{json .KernelVersion}}}'])), project };
  const patch = execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 8*1024*1024 });
  writeFileSync(`${output}/source.patch`, patch);
  mkdirSync(`${output}/harness`, { recursive: true });
  const harness = Object.fromEntries(readdirSync('load').filter(f => f.startsWith('dms') && f.endsWith('.ts')).map(f => {
    const source = readFileSync(`load/${f}`); writeFileSync(`${output}/harness/${f}`, source);
    return [f, createHash('sha256').update(source).digest('hex')];
  }));
  writeFileSync(`${output}/main-unread-covering.sql`, readFileSync('server/migrations/202611140387_main_unread_covering.sql'));
  writeFileSync(`${output}/metadata.json`, JSON.stringify({ ...metadata, harness, configuration: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^DM_/.test(k) && !/PASSWORD|TOKEN|SECRET/.test(k))) }, null, 2));
  execFileSync(process.execPath, ['load/dms-seed.ts'], { env: { ...env, DM_DB_CONTAINER: db, DM_SEED_OUT: `${output}/seed.json` }, stdio: 'inherit' });
  execFileSync(process.execPath, ['load/dms-probe.ts'], { env: { ...env, DM_DB_CONTAINER: db, DM_APP_CONTAINER: app, DM_SEED_OUT: `${output}/seed.json`, DM_OUTPUT: output, BASE_URL: `http://127.0.0.1:${env.LOAD_PORT}` }, stdio: 'inherit' });
  writeFileSync(`${output}/before-sockets-rss.txt`, run(['exec', app, 'cat', '/proc/1/status']));
  writeFileSync(`${output}/db-before-load.json`, dbStats());
  if (process.env.DM_SKIP_LOAD !== '1') {
    const count = Number(process.env.DM_SOCKETS || 10000), seconds = process.env.DM_SECONDS || '95';
    if (!Number.isInteger(count) || count < 4 || count > 10000 || count%4) throw new Error('DM_SOCKETS must be a multiple of four in 4..=10000');
    const names = Array.from({ length: 4 }, (_, i) => `${project}-k6-${i}`);
    const sample = () => {
      if (sampling) return; sampling = true;
      const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}', app, db, ...names], { env });
      let data = ''; child.stdout.on('data', b => { data += String(b); });
      child.on('close', () => {
        if (closing) { sampling = false; return; }
        let activity = '', rss = '', dbRssKiB = 0, dbPssKiB = 0;
        try {
          activity = sql("SELECT json_build_object('active',count(*) FILTER(WHERE state='active'),'connections',count(*),'locks',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE usename='fukulow_app';");
          rss = run(['exec', app, 'cat', '/proc/1/status']).match(/^VmRSS:.*$/m)?.[0] || '';
          const maps = run(['exec','-u','postgres',db,'sh','-c','cat /proc/[0-9]*/smaps_rollup 2>/dev/null || true']);
          dbRssKiB = [...maps.matchAll(/^Rss:\s+(\d+)/gm)].reduce((n,m) => n+Number(m[1]),0);
          dbPssKiB = [...maps.matchAll(/^Pss:\s+(\d+)/gm)].reduce((n,m) => n+Number(m[1]),0);
        } catch { /* shutdown sample */ }
        samples.push({ at: Date.now(), stats: data.trim().split('\n').filter(Boolean).map(s => JSON.parse(s)), activity, rss, dbRssKiB, dbPssKiB }); sampling = false;
      });
    };
    timer = setInterval(sample, 1000); sample();
    await Promise.all(names.map((name, i) => new Promise<void>((resolveRun, reject) => {
      mkdirSync(`${output}/shard-${i}`, { recursive: true });
      const args = ['run', '--rm', '--name', name, '--network', `${project}_default`, '--ulimit', 'nofile=65536:65536', '--sysctl', 'net.ipv4.ip_local_port_range=1024 65535',
        '-v', `${resolve('.')}:/work:ro`, '-v', `${output}/seed.json:/seed.json:ro`, '-v', `${output}/shard-${i}:/output`,
        '-e', 'BASE_URL=http://app:8080', '-e', `DM_SOCKETS=${count/4}`, '-e', `DM_OFFSET=${i*2500}`, '-e', `DM_SHARD=${i}`, '-e', `DM_SECONDS=${seconds}`, '-e', `DM_RATE=${process.env.DM_RATE || '500'}`, '-e', `DM_SEND_START=${process.env.DM_SEND_START || '40'}`, '-e', `DM_CONNECT_INTERVAL_MS=${process.env.DM_CONNECT_INTERVAL_MS || '500'}`,
        'grafana/k6:1.8.2', 'run', '--out', 'json=/output/metrics.json', '/work/load/dms.ts'];
      const child = spawn('docker', args, { env }); children.push(child);
      let log = ''; child.stdout.on('data', b => { log += String(b); }); child.stderr.on('data', b => { log += String(b); });
      child.on('error', reject); child.on('close', code => { failed ||= code !== 0; writeFileSync(`${output}/shard-${i}/run.log`, log); writeFileSync(`${output}/shard-${i}/exit.json`, JSON.stringify({ code })); console.log(`Shard ${i} exit ${code}`); resolveRun(); });
    })));
    writeFileSync(`${output}/sql-after.json`, sql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT query,toplevel,calls,total_exec_time,rows FROM pg_stat_statements ORDER BY calls DESC) t;"));
    writeFileSync(`${output}/db-after-load.json`, dbStats());
  }
  if (timer) { clearInterval(timer); timer = undefined; }
  for (const script of ['history', 'recovery', 'storage']) if (process.env[`DM_${script.toUpperCase()}`] === '1') {
    execFileSync(process.execPath, [`load/dms-${script}.ts`], { env: { ...env, DM_DB_CONTAINER: db, DM_SEED_OUT: `${output}/seed.json`, DM_OUTPUT: output, BASE_URL: `http://127.0.0.1:${env.LOAD_PORT}` }, stdio: 'inherit' });
    if (script === 'history' && process.env.DM_HISTORY_SETTLED === '1') execFileSync(process.execPath, ['load/dms-history.ts'], { env: { ...env, DM_DB_CONTAINER: db, DM_SEED_OUT: `${output}/seed.json`, DM_OUTPUT: output, BASE_URL: `http://127.0.0.1:${env.LOAD_PORT}`, DM_HISTORY_SETTLED_ONLY: '1', DM_HISTORY_SAMPLES: process.env.DM_SETTLED_SAMPLES || '1000' }, stdio: 'inherit' });
  }
  for (const [name,id] of [['app',app],['db',db]]) {
    const logs = spawnSync('docker', ['logs','--timestamps',id], { encoding: 'utf8', maxBuffer: 64*1024*1024 });
    if (logs.status !== 0) throw new Error(`Could not capture ${name} logs`);
    writeFileSync(`${output}/${name}.log`, logs.stdout+logs.stderr);
  }
  console.log(`Preliminary artifacts: ${output}`);
  if (failed) process.exitCode = 1;
} finally {
  closing = true;
  if (timer) clearInterval(timer);
  children.forEach(c => { if (c.exitCode === null) c.kill('SIGTERM'); });
  writeFileSync(`${output}/resources.json`, JSON.stringify(samples));
  run([...compose, 'down', '-v', '--remove-orphans']);
}
