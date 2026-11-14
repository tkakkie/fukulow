// Synthetic recipient changes: production counter/upsert SQL, no Message writes.
// This isolates storage amplification; it does not substitute for send/WAL latency.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const output = process.env.DM_OUTPUT!;
const seed = JSON.parse(readFileSync(process.env.DM_SEED_OUT!, 'utf8'));
const org: string = seed.organization, member: string = seed.members[9999].id;
const docker = (args: string[], input?: string) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32*1024*1024 }).trim();
const sql = (query: string) => docker(['exec', '-i', process.env.DM_DB_CONTAINER!, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-Atq'], query);
const events = Number(process.env.DM_STORAGE_EVENTS || 1000000);
if (!Number.isSafeInteger(events) || events < 1000 || events%1000) throw new Error('DM_STORAGE_EVENTS must be a positive multiple of 1000');
if (process.env.DM_HISTORY === '1') execFileSync(process.execPath, ['load/dms-history.ts'], { env: { ...process.env, DM_HISTORY_SETTLED_ONLY: '1' }, stdio: 'inherit' });
sql('CREATE EXTENSION IF NOT EXISTS pgstattuple;');
const snapshot = () => JSON.parse(sql(`SELECT json_build_object('at',clock_timestamp(),'wal',pg_current_wal_insert_lsn(),'table_bytes',pg_table_size('dm_discovery'),'index_bytes',pg_indexes_size('dm_discovery'),'counter_table_bytes',pg_table_size('dm_discovery_counters'),'counter_index_bytes',pg_indexes_size('dm_discovery_counters'),'rows',(SELECT count(*) FROM dm_discovery),'tuple_stats',(SELECT row_to_json(t) FROM pgstattuple('dm_discovery') t),'indexes',(SELECT json_object_agg(indexrelname,pg_relation_size(indexrelid)) FROM pg_stat_user_indexes WHERE relname='dm_discovery'),'database',(SELECT row_to_json(t) FROM (SELECT blks_read,blks_hit,temp_bytes,deadlocks FROM pg_stat_database WHERE datname=current_database()) t));`));
const results: unknown[] = [];
for (const shape of ['fixed','growing']) {
  sql(`TRUNCATE dm_discovery,dm_discovery_counters; VACUUM(ANALYZE) dm_discovery; VACUUM(ANALYZE) dm_discovery_counters;`);
  const zero = snapshot();
  const cardinality = shape === 'fixed' ? 50 : 9999;
  // One recipient, with real existing grants. Each batch commits 1,000 changes;
  // intermediate changes in a transaction are intentional synthetic history.
  const setup = `CREATE TEMP TABLE storage_grants(organization_id uuid NOT NULL,channel_id uuid NOT NULL,grant_id uuid NOT NULL,n bigint NOT NULL);
INSERT INTO storage_grants SELECT organization_id,channel_id,grant_id,row_number() OVER(ORDER BY channel_id) FROM channel_members WHERE organization_id='${org}' AND member_id='${member}' AND dm_created_at IS NOT NULL ORDER BY channel_id LIMIT ${cardinality};
CREATE UNIQUE INDEX ON storage_grants(organization_id,n);
CREATE FUNCTION pg_temp.churn(batch integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i integer; p bigint; c uuid; g uuid;
BEGIN FOR i IN 1..batch LOOP
INSERT INTO dm_discovery_counters(organization_id,member_id,membership_revision,position) VALUES('${org}','${member}',0,1) ON CONFLICT(organization_id,member_id,membership_revision) DO UPDATE SET position=dm_discovery_counters.position+1 RETURNING position INTO p;
SELECT channel_id,grant_id INTO c,g FROM storage_grants WHERE organization_id='${org}' AND n=1+((p-1)%${cardinality});
INSERT INTO dm_discovery(organization_id,member_id,membership_revision,channel_id,grant_id,birth_position,latest_position) VALUES('${org}','${member}',0,c,g,p,p) ON CONFLICT(organization_id,member_id,membership_revision,channel_id) DO UPDATE SET latest_position=EXCLUDED.latest_position,grant_id=EXCLUDED.grant_id;
END LOOP; END $$;`;
  let completed = 0;
  for (const checkpoint of [...new Set([Math.min(events,1000000),events])]) {
    const start = Date.now();
    const batches = Array.from({ length: (checkpoint-completed)/1000 }, () => 'SELECT pg_temp.churn(1000);').join('\n');
    sql(setup+'\n'+batches);
    const elapsedMs = Date.now()-start, peak = snapshot();
    const vacuumStart = Date.now();
    sql('VACUUM(ANALYZE) dm_discovery; VACUUM(ANALYZE) dm_discovery_counters;');
    const vacuumMs = Date.now()-vacuumStart, settled = snapshot();
    const walBytes = Number(sql(`SELECT pg_wal_lsn_diff('${peak.wal}','${zero.wal}');`));
    const result = { shape, events: checkpoint, batchEvents: checkpoint-completed, cardinality, elapsedMs, walBytes, vacuumMs, zero, peak, settled };
    results.push(result); writeFileSync(`${output}/storage.json`, JSON.stringify(results, null, 2));
    console.log(`Storage ${shape}: ${checkpoint} recipient changes, ${elapsedMs} ms this batch, ${walBytes} cumulative WAL bytes, ${settled.rows} rows`);
    completed = checkpoint;
  }
}
// Permanently invalidate the focal revision; observe the actual periodic worker.
sql(`UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id='${org}' AND id='${member}';`);
const invalidated = Date.now();
const reclamation: unknown[] = [];
for (;;) {
  const rows = Number(sql('SELECT count(*) FROM dm_discovery;'));
  reclamation.push({ elapsedMs: Date.now()-invalidated, rows });
  writeFileSync(`${output}/reclamation.json`, JSON.stringify(reclamation));
  if (!rows || Date.now()-invalidated > 125000) break;
  await new Promise<void>(resolve => setTimeout(resolve, 5000));
}
