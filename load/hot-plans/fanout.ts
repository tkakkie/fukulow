// #354: plans.sql predates Organization grouping and the statement context wrapper.
// Export the actual Rust builders so permission/context SQL cannot drift here.
// On a dedicated PostgreSQL 18.6 container: migrate, apply deploy/db-roles.sql
// (test-only password) + db-grants.sql, then seed.sql as owner. Run from repo root:
// node load/hot-plans/fanout.ts <container> <database> <new ignored output dir>
// Repeat before/after against the same unchanged dataset; retain raw JSON plans.
// Optional fourth argument replays an earlier export's sql/ directory, allowing
// interleaved before/after passes without modifying production code.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [container, database, destination, exportedSql] = process.argv.slice(2);
if (!container || !database || !destination) throw new Error('container, database, output required');
const output = resolve(destination);
mkdirSync(output); // Refuse to overwrite evidence.
function run(command: string, args: string[], input?: string, extraEnv = {}) {
  const result = spawnSync(command, args, {
    input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...extraEnv }, timeout: 300_000,
  });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.error}`);
  return result.stdout;
}
if (exportedSql) {
  cpSync(resolve(exportedSql), resolve(output, 'sql'), { recursive: true });
} else {
  run('cargo', ['test', '--locked', '--lib', 'export_fanout_plan_sql', '--', '--ignored'], undefined,
    { FANOUT_SQL_DIR: resolve(output, 'sql') });
}
writeFileSync(resolve(output, 'source.json'), JSON.stringify({
  head: run('git', ['rev-parse', 'HEAD']).trim(), node: process.version,
  dirty: run('git', ['status', '--porcelain']),
  exportedSql: exportedSql ? resolve(exportedSql) : 'production builders in working tree',
  hashes: Object.fromEntries(['access_rows_batch', 'access_rows_single', 'member_access', 'member_access_batch'].map(name =>
    [name, createHash('sha256').update(readFileSync(resolve(output, 'sql', `${name}.sql`))).digest('hex')])),
}, null, 2));
function psql(sql: string) {
  return run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'fukulow_app', '-d', database], sql);
}
psql(`DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
     OR EXISTS (SELECT FROM pg_class WHERE oid IN ('users'::regclass,'channels'::regclass,
       'channel_members'::regclass) AND (NOT relrowsecurity OR relowner=current_user::regrole))
  THEN RAISE EXCEPTION 'Require non-owning app role with RLS enabled'; END IF;
END $$;`);
writeFileSync(resolve(output, 'settings.txt'), psql(`
SELECT version();
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user;
SELECT name,setting FROM pg_settings WHERE name IN
('shared_buffers','work_mem','jit','random_page_cost','effective_cache_size');
`));
const cases = [
  { name: 'access_rows_single_1000', builder: 'access_rows_single', count: 1000, start: 1 },
  { name: 'access_rows_batch_1000', builder: 'access_rows_batch', count: 1000, start: 1 },
  { name: 'access_rows_batch_24', builder: 'access_rows_batch', count: 24, start: 1001 },
  { name: 'member_access_1024', builder: 'member_access', count: 1024, start: 1 },
  { name: 'member_access_in_1024', builder: 'member_access_batch', count: 1024, start: 1 },
];
const summary = [];
for (const mode of ['custom', 'generic']) {
  for (const probe of cases) {
    const sql = readFileSync(resolve(output, 'sql', `${probe.builder}.sql`), 'utf8');
    const member = probe.builder.startsWith('member_access');
    const argumentsSql = member ? ":'org', :'chan', :'ids', :'revisions'"
      : ":'org', :'ids', :'revisions', :'channels'";
    const batch = probe.builder.endsWith('_batch');
    const prefix = `
SET plan_cache_mode=force_${mode}_plan;
SELECT '00000000-0000-4000-8000-00000000000a' AS org, md5('chan-a-1')::uuid AS chan \\gset
SELECT array_agg(md5('user-a-' || g)::uuid)::text AS ids,
 array_agg(0::bigint)::text AS revisions,
 array_agg(md5('chan-a-1')::uuid)::text AS channels
 FROM generate_series(${probe.start},${probe.start + probe.count - 1}) g \\gset
PREPARE probe(uuid, ${member ? 'uuid, uuid[], bigint[]' : 'uuid[], bigint[], uuid[]'}) AS ${sql};
${batch ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT set_config('fukulow.organization_id', :'org', true) AS context \\gset" : ''}
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE probe(${argumentsSql});
${batch ? 'COMMIT;' : ''}
`;
    writeFileSync(resolve(output, `${mode}-${probe.name}.sql`), prefix);
    const samples = [];
    const measuredPasses = 15;
    for (let pass = 0; pass <= measuredPasses; pass++) {
      const raw = psql(prefix);
      writeFileSync(resolve(output, `${mode}-${probe.name}-${pass}.json`), raw);
      const plan = JSON.parse(raw)[0];
      if (pass > 0) samples.push(plan);
    }
    samples.sort((a, b) => a['Execution Time'] - b['Execution Time']);
    const median = samples[Math.floor(samples.length / 2)];
    summary.push({ mode, query: probe.name, milliseconds: median['Execution Time'],
      samples: samples.length,
      range: [samples[0]['Execution Time'], samples[samples.length - 1]['Execution Time']],
      hits: median.Plan['Shared Hit Blocks'], reads: median.Plan['Shared Read Blocks'],
      plan: median.Plan });
    console.log(mode, probe.name, median['Execution Time']);
  }
}
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
