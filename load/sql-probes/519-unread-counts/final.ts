import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../../proxy-target.ts';
import { bindLiterals, channels, checksumSql, extractListCounts, logLatenciesMs, member, organization, pgbench, planSummary, quantile, stopRule, timings } from './probe.ts';

// #519 §10 step 1: focused SQL probe of the final A3 design (merged triggers and list SQL)
// against the commit before it. DIAGNOSTIC: it chooses nothing formal; only the stop rule applies.
const usage = 'node load/sql-probes/519-unread-counts/final.ts (--smoke | --diagnostic) --out NEW_DIRECTORY_OUTSIDE_CHECKOUT';
const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean' }, diagnostic: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.out || values.smoke === values.diagnostic) throw new Error(usage);
const smoke = values.smoke === true;
type FinalArm = 'current' | 'final';
const pins: Record<FinalArm, string> = { current: '5ef561e5', final: 'fd6a5949' };
const a3Migration = '202611221100_unread_counts.sql';
const image = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
const cuts = smoke ? [75] : [75, 150, 575, 2150];
const samples = smoke ? 5 : 30;
const warmSeconds = smoke ? 5 : 60;
const measuredSeconds = smoke ? 5 : 120;
const benchOrder: FinalArm[][] = smoke ? [['current', 'final']] : [['current', 'final'], ['final', 'current'], ['current', 'final']];

const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
process.chdir(root);
const out = outsideCheckout(values.out);
mkdirSync(out, { mode: 0o700 });
mkdirSync(join(out, 'plans'));
mkdirSync(join(out, 'latency'));
const save = (path: string, value: unknown) => writeFileSync(join(out, path), JSON.stringify(value, null, 2) + '\n');
const run = (cmd: string, args: string[], input?: string) => {
  const child = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${child.stderr.slice(-2000)}`);
  return child.stdout;
};
const git = (...args: string[]) => run('git', args).trim();
const commits = { current: git('rev-parse', pins.current + '^{commit}'), final: git('rev-parse', pins.final + '^{commit}') };
if (git('rev-parse', commits.final + '^') !== commits.current) throw new Error('final pin must be the direct child of current');
const work = mkdtempSync(join(realpathSync(tmpdir()), 'fk519f-'));
const container = 'fk519f-' + randomUUID();

// Schema and roles from the current pin; the final arm adds only the A3 migration from its pin,
// applied after the seed as a deploy would (backfill under its own lock and check).
run('sh', ['-c', `git archive ${commits.current} server/migrations deploy/db-roles.sql deploy/db-grants.sql | tar -x -C "$1"`, 'sh', work]);
const changed = git('diff', '--name-only', commits.current, commits.final, '--', 'server/migrations');
if (changed !== `server/migrations/${a3Migration}`) throw new Error(`unexpected migration diff: ${changed}`);
writeFileSync(join(work, a3Migration), git('show', `${commits.final}:server/migrations/${a3Migration}`) + '\n');
cpSync(join(root, 'load/sql-probes/519-unread-counts/sql'), join(work, 'sql'), { recursive: true });
for (const arm of ['current', 'final'] as FinalArm[]) {
  writeFileSync(join(work, `sql/list-${arm}.sql`), extractListCounts(git('show', `${commits[arm]}:server/src/messages/unread.rs`)) + '\n');
}
const migrations = readdirSync(join(work, 'server/migrations')).filter(f => f.endsWith('.sql')).sort();

const psql = (db: string, script: string, user = 'postgres') =>
  run('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db], script);
const file = (db: string, path: string) => psql(db, `\\i /work/${path}\n`);
const migrateA3 = (db: string) => psql(db, `BEGIN;\n\\i /work/${a3Migration}\nCOMMIT;\n`);

function measure(db: string, arm: FinalArm, cut: number, array: string) {
  const sql = readFileSync(join(work, `sql/list-${arm}.sql`), 'utf8');
  const args = `'${organization}', ${member}, 0, '${array}'`;
  const scope = `SELECT set_config('fukulow.organization_id','${organization}',false) \\g /dev/null\n`;
  const role = JSON.parse(psql(db, `SELECT json_build_object('user', current_user, 'superuser', rolsuper, 'bypassRls', rolbypassrls,
    'rls', row_security_active('messages'), 'planCacheMode', current_setting('plan_cache_mode')) FROM pg_roles WHERE rolname = current_user;`, 'fukulow_app'));
  if (role.user !== 'fukulow_app' || role.superuser || role.bypassRls || !role.rls) throw new Error('Unexpected role or RLS state');
  const explain = psql(db, `${scope}PREPARE q(uuid,uuid,bigint,uuid[]) AS ${sql};
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE q(${args}) \\g /dev/null
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) EXECUTE q(${args});
COMMIT;\n`, 'fukulow_app');
  writeFileSync(join(out, `plans/${arm}-cut${cut}.json`), explain);
  const timed = psql(db, `${scope}PREPARE q(uuid,uuid,bigint,uuid[]) AS ${sql};
EXECUTE q(${args}) \\g /dev/null
\\timing on
${Array.from({ length: samples }, () => `EXECUTE q(${args}) \\g /dev/null`).join('\n')}
\\timing off
SELECT json_build_object('generic', generic_plans, 'custom', custom_plans) FROM pg_prepared_statements WHERE name = 'q';\n`, 'fukulow_app');
  const ms = timings(timed);
  if (ms.length !== samples) throw new Error(`expected ${samples} timings, got ${ms.length}`);
  const checksum = psql(db, `${scope}${checksumSql(bindLiterals(sql, array))}\n`, 'fukulow_app').trim();
  return { arm, cut, ...planSummary(JSON.parse(explain)), samplesMs: ms, p50Ms: quantile(ms, 0.5), p95Ms: quantile(ms, 0.95),
    prepared: JSON.parse(timed.trim().split('\n').at(-1) ?? '{}'), checksum, role };
}

const walStats = (db: string) => JSON.parse(psql(db, `SELECT json_build_object('lsn', pg_current_wal_lsn(), 'records', w.wal_records, 'fpi', w.wal_fpi,
  'checkpoints', c.num_timed + c.num_requested) FROM pg_stat_wal w, pg_stat_checkpointer c;`));
const pgbenchArgs = (db: string, seconds: number) => ['exec', container, 'pgbench', '-U', 'postgres', '-n', '-c', '8', '-j', '4', '-T', String(seconds), '-f', '/work/sql/bench.pgb'];

function bench(db: string, label: string) {
  psql(db, 'CHECKPOINT;');
  pgbench(run('docker', [...pgbenchArgs(db, warmSeconds), db]));
  const before = walStats(db);
  const prefix = `/tmp/pgb-${label}`;
  const output = run('docker', [...pgbenchArgs(db, measuredSeconds), '-l', `--log-prefix=${prefix}`, db]);
  const after = walStats(db);
  const log = run('docker', ['exec', container, 'sh', '-c', `cat ${prefix}.* && rm -f ${prefix}.*`]);
  const latencies = logLatenciesMs(log);
  writeFileSync(join(out, `latency/${label}.txt`), latencies.join('\n') + '\n');
  const result = pgbench(output);
  if (latencies.length !== result.transactions) throw new Error(`${label}: ${latencies.length} log lines for ${result.transactions} transactions`);
  const walBytes = Number(psql(db, `SELECT pg_wal_lsn_diff('${after.lsn}', '${before.lsn}');`).trim());
  const records = after.records - before.records;
  return { ...result, p95Ms: quantile(latencies, 0.95), p99Ms: quantile(latencies, 0.99), walBytes,
    walBytesPerSend: walBytes / result.transactions, fpiShare: records > 0 ? (after.fpi - before.fpi) / records : 0,
    checkpointsDuringMeasure: after.checkpoints - before.checkpoints };
}

const started = new Date().toISOString();
let failed = false;
try {
  run('docker', ['run', '-d', '--rm', '--name', container, '--network', 'none', '-e', 'POSTGRES_PASSWORD=probe',
    '-v', `${work}:/work:ro`, image, '-c', 'shared_buffers=512MB', '-c', 'jit=off']);
  for (let i = 0; spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).status !== 0; i++) {
    if (i > 60) throw new Error('PostgreSQL did not become ready');
    spawnSync('sleep', ['1']);
  }
  psql('postgres', 'CREATE DATABASE p519;');
  psql('p519', migrations.map(m => `BEGIN;\n\\i /work/server/migrations/${m}\nCOMMIT;`).join('\n') + '\n');
  psql('p519', "BEGIN;\nSELECT set_config('fukulow.app_password', 'probe', true) \\g /dev/null\n\\i /work/deploy/db-roles.sql\nCOMMIT;\n");
  file('p519', 'deploy/db-grants.sql');
  file('p519', 'sql/seed.sql');
  const array = psql('p519', `SELECT ${channels};`).trim();
  const metadata = {
    status: 'DIAGNOSTIC / NOT EVALUATED (stop rule only)', mode: smoke ? 'smoke' : 'diagnostic', started, commits, a3Migration,
    harnessCommit: git('rev-parse', 'HEAD'), harnessDirty: git('status', '--porcelain', '--', 'load/sql-probes/519-unread-counts') !== '',
    image, imageId: run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).trim(),
    settings: JSON.parse(psql('p519', `SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN
      ('server_version','shared_buffers','work_mem','jit','plan_cache_mode','synchronous_commit','fsync','autovacuum','default_transaction_isolation','max_wal_size','checkpoint_timeout');`)),
    host: { platform: platform(), release: release(), cpus: cpus().length, memoryBytes: totalmem() },
    cache: 'warm: one discarded EXPLAIN and one discarded EXECUTE per measured cell', samplesPerCell: samples, cuts,
    sends: { clients: 8, threads: 4, warmSeconds, measuredSeconds, benchOrder }, stopRule: stopRule([{ pair: 1, walBytesPerSend: 1, tps: 1 }], [{ pair: 1, walBytesPerSend: 1, tps: 1 }]).limits,
  };
  save('metadata.json', metadata);
  for (const arm of ['current', 'final'] as FinalArm[]) {
    psql('postgres', `CREATE DATABASE r_${arm} TEMPLATE p519;`);
    if (arm === 'final') migrateA3('r_final');
    file(`r_${arm}`, 'sql/current-fresh.sql');
  }
  const reads = [];
  for (const [i, cut] of cuts.entries()) {
    const order: FinalArm[] = i % 2 === 0 ? ['current', 'final'] : ['final', 'current'];
    for (const arm of order) {
      psql(`r_${arm}`, `\\set cut ${cut}\n\\i /work/sql/setcut.sql\n`);
      reads.push(measure(`r_${arm}`, arm, cut, array));
    }
    const sums = new Set(reads.filter(r => r.cut === cut).map(r => r.checksum));
    if (sums.size !== 1) { failed = true; console.error(`checksum mismatch at cut ${cut}`); }
  }
  const drift = psql('r_final', `SELECT count(*) FROM message_counts_check('${organization}');`).trim();
  if (drift !== '0') { failed = true; console.error(`message_counts_check reports ${drift} rows after the read cuts`); }
  save('reads.json', reads);
  for (const arm of ['current', 'final'] as FinalArm[]) {
    psql('postgres', `CREATE DATABASE s_${arm} TEMPLATE p519;`);
    if (arm === 'final') migrateA3('s_final');
    file(`s_${arm}`, 'sql/send-current.sql');
  }
  const sends = benchOrder.flatMap((pair, i) => pair.map(arm => ({ pair: i + 1, arm, ...bench(`s_${arm}`, `pair${i + 1}-${arm}`) })));
  const sendDrift = psql('s_final', `SELECT count(*) FROM message_counts_check('${organization}');`).trim();
  if (sendDrift !== '0') { failed = true; console.error(`message_counts_check reports ${sendDrift} rows after the sends`); }
  save('sends.json', sends);
  const verdict = stopRule(sends.filter(s => s.arm === 'current'), sends.filter(s => s.arm === 'final'));
  save('stop-rule.json', verdict);
  const lines = ['| cut | arm | p50 ms | p95 ms | EXPLAIN ms | blocks | checksum |', '|---:|---|---:|---:|---:|---:|---|',
    ...reads.map(r => `| ${r.cut} | ${r.arm} | ${r.p50Ms} | ${r.p95Ms} | ${r.executionMs} | ${r.sharedBlocks} | ${r.checksum} |`),
    '', '| pair | arm | tps | p95 ms | p99 ms | WAL bytes/send | FPI share | checkpoints |', '|---:|---|---:|---:|---:|---:|---:|---:|',
    ...sends.map(s => `| ${s.pair} | ${s.arm} | ${s.tps.toFixed(0)} | ${s.p95Ms.toFixed(3)} | ${s.p99Ms.toFixed(3)} | ${s.walBytesPerSend.toFixed(0)} | ${s.fpiShare.toFixed(3)} | ${s.checkpointsDuringMeasure} |`),
    '', `Stop rule (${verdict.limits}): median WAL/send ratio ${verdict.medianWalPerSend.toFixed(3)}, median tps ratio ${verdict.medianTps.toFixed(3)} -> ${verdict.stop ? 'STOP' : 'no stop'}`];
  writeFileSync(join(out, 'summary.md'), `# #519 §10 step 1 final-design probe (${metadata.status})\n\n${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  spawnSync('docker', ['rm', '-f', container]);
  rmSync(work, { recursive: true, force: true });
  save('status.json', { complete: !failed, finished: new Date().toISOString() });
}
process.exit(failed ? 1 : 0);
