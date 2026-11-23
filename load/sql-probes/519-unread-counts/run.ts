import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../../proxy-target.ts';
import { bindLiterals, channels, checksumSql, extractListCounts, member, organization, pgbench, planSummary, quantile, timings, type Arm } from './probe.ts';

// DIAGNOSTIC only: no PASS/FAIL. Reproduces the #519 A3 prototype comment on the commit it was measured at.
const usage = 'node load/sql-probes/519-unread-counts/run.ts (--smoke | --diagnostic) --out NEW_DIRECTORY_OUTSIDE_CHECKOUT';
const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean' }, diagnostic: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.out || values.smoke === values.diagnostic) throw new Error(usage);
const smoke = values.smoke === true;
const pinned = '65f63307';
const image = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
const cuts = smoke ? [75] : [75, 150, 575, 2150];
const samples = smoke ? 5 : 30;
const benchSeconds = smoke ? 5 : 30;
const benchOrder: Arm[][] = smoke ? [['current', 'a3']] : [['current', 'a3'], ['a3', 'current'], ['current', 'a3']];

const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
process.chdir(root);
const out = outsideCheckout(values.out);
mkdirSync(out, { mode: 0o700 });
mkdirSync(join(out, 'plans'));
const save = (path: string, value: unknown) => writeFileSync(join(out, path), JSON.stringify(value, null, 2) + '\n');
const run = (cmd: string, args: string[], input?: string) => {
  const child = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${child.stderr.slice(-2000)}`);
  return child.stdout;
};
const git = (...args: string[]) => run('git', args).trim();
const commit = git('rev-parse', pinned + '^{commit}');
const work = mkdtempSync(join(realpathSync(tmpdir()), 'fk519p-'));
const container = 'fk519p-' + randomUUID();

// Migrations, role scripts and the counts SQL come from the pinned commit; probe SQL from this checkout.
run('sh', ['-c', `git archive ${commit} server/migrations deploy/db-roles.sql deploy/db-grants.sql | tar -x -C "$1"`, 'sh', work]);
cpSync(join(root, 'load/sql-probes/519-unread-counts/sql'), join(work, 'sql'), { recursive: true });
writeFileSync(join(work, 'sql/current.sql'), extractListCounts(git('show', `${commit}:server/src/messages/unread.rs`)) + '\n');
const migrations = readdirSync(join(work, 'server/migrations')).filter(f => f.endsWith('.sql')).sort();

const psql = (db: string, script: string, user = 'postgres') =>
  run('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db], script);
const file = (db: string, path: string) => psql(db, `\\i /work/${path}\n`);

function measure(db: string, arm: Arm, cut: number, array: string) {
  const sql = readFileSync(join(work, `sql/${arm}.sql`), 'utf8');
  const args = `'${organization}', ${member}, 0, '${array}'`;
  const scope = `SELECT set_config('fukulow.organization_id','${organization}',false) \\g /dev/null\n`;
  const role = JSON.parse(psql(db, `SELECT json_build_object('user', current_user, 'superuser', rolsuper, 'bypassRls', rolbypassrls,
    'rls', row_security_active('messages'), 'planCacheMode', current_setting('plan_cache_mode')) FROM pg_roles WHERE rolname = current_user;`, 'fukulow_app'));
  if (role.user !== 'fukulow_app' || role.superuser || role.bypassRls || !role.rls) throw new Error('Unexpected role or RLS state');
  // Read-only REPEATABLE READ like organization_read_only; the second (warm) execution is kept.
  const explain = psql(db, `${scope}PREPARE q(uuid,uuid,bigint,uuid[]) AS ${sql};
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE q(${args}) \\g /dev/null
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) EXECUTE q(${args});
COMMIT;\n`, 'fukulow_app');
  const plan = JSON.parse(explain);
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
  return { arm, cut, ...planSummary(plan), samplesMs: ms, p50Ms: quantile(ms, 0.5), p95Ms: quantile(ms, 0.95),
    prepared: JSON.parse(timed.trim().split('\n').at(-1) ?? '{}'), checksum, role };
}

function bench(db: string) {
  psql(db, 'CHECKPOINT;');
  const before = psql(db, 'SELECT pg_current_wal_lsn();').trim();
  const output = run('docker', ['exec', container, 'pgbench', '-U', 'postgres', '-n', '-c', '8', '-j', '4', '-T', String(benchSeconds), '-f', '/work/sql/bench.pgb', db]);
  const walBytes = Number(psql(db, `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '${before}');`).trim());
  const result = pgbench(output);
  return { ...result, walBytes, walBytesPerSend: walBytes / result.transactions };
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
  // One transaction per migration, as SQLx applies them.
  psql('p519', migrations.map(m => `BEGIN;\n\\i /work/server/migrations/${m}\nCOMMIT;`).join('\n') + '\n');
  psql('p519', "BEGIN;\nSELECT set_config('fukulow.app_password', 'probe', true) \\g /dev/null\n\\i /work/deploy/db-roles.sql\nCOMMIT;\n");
  file('p519', 'deploy/db-grants.sql');
  file('p519', 'sql/seed.sql');
  const array = psql('p519', `SELECT ${channels};`).trim();
  const metadata = {
    status: 'DIAGNOSTIC / NOT EVALUATED', mode: smoke ? 'smoke' : 'diagnostic', started, pinnedCommit: commit, harnessCommit: git('rev-parse', 'HEAD'),
    harnessDirty: git('status', '--porcelain', '--', 'load/sql-probes/519-unread-counts') !== '',
    image, imageId: run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).trim(),
    settings: JSON.parse(psql('p519', `SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN
      ('server_version','shared_buffers','work_mem','jit','plan_cache_mode','synchronous_commit','fsync','autovacuum','default_transaction_isolation');`)),
    host: { platform: platform(), release: release(), cpus: cpus().length, memoryBytes: totalmem() },
    cache: 'warm: one discarded EXPLAIN and one discarded EXECUTE per measured cell', samplesPerCell: samples, cuts, benchSeconds, benchOrder,
  };
  save('metadata.json', metadata);
  for (const arm of ['current', 'a3'] as Arm[]) {
    psql('postgres', `CREATE DATABASE r_${arm} TEMPLATE p519;`);
    if (arm === 'a3') file('r_a3', 'sql/a3-schema.sql');
    file(`r_${arm}`, `sql/${arm}-fresh.sql`);
  }
  const reads = [];
  for (const [i, cut] of cuts.entries()) {
    const order: Arm[] = i % 2 === 0 ? ['current', 'a3'] : ['a3', 'current'];
    for (const arm of order) {
      psql(`r_${arm}`, `\\set cut ${cut}\n\\i /work/sql/setcut.sql\n` + (arm === 'a3' ? '\\i /work/sql/a3-ordinals.sql\n' : ''));
      reads.push(measure(`r_${arm}`, arm, cut, array));
    }
    const sums = new Set(reads.filter(r => r.cut === cut).map(r => r.checksum));
    if (sums.size !== 1) { failed = true; console.error(`checksum mismatch at cut ${cut}`); }
  }
  save('reads.json', reads);
  for (const arm of ['current', 'a3'] as Arm[]) {
    psql('postgres', `CREATE DATABASE s_${arm} TEMPLATE p519;`);
    if (arm === 'a3') file('s_a3', 'sql/a3-schema.sql');
    file(`s_${arm}`, `sql/send-${arm === 'a3' ? 'a3' : 'current'}.sql`);
  }
  const sends = benchOrder.flatMap((pair, i) => pair.map(arm => ({ pair: i + 1, arm, ...bench(`s_${arm}`) })));
  save('sends.json', sends);
  const lines = ['| cut | arm | p50 ms | p95 ms | EXPLAIN ms | blocks | checksum |', '|---:|---|---:|---:|---:|---:|---|',
    ...reads.map(r => `| ${r.cut} | ${r.arm} | ${r.p50Ms} | ${r.p95Ms} | ${r.executionMs} | ${r.sharedBlocks} | ${r.checksum} |`),
    '', '| pair | arm | tps | latency ms | WAL bytes/send |', '|---:|---|---:|---:|---:|',
    ...sends.map(s => `| ${s.pair} | ${s.arm} | ${s.tps.toFixed(0)} | ${s.latencyMs} | ${s.walBytesPerSend.toFixed(0)} |`)];
  writeFileSync(join(out, 'summary.md'), `# #519 counts probe (${metadata.status})\n\n${lines.join('\n')}\n`);
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
