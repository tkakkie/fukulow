import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { percentile } from './dms-workload.ts';
import type { DmList } from '../web/src/api-schema.d.ts';
const seed = JSON.parse(readFileSync(process.env.DM_SEED_OUT!, 'utf8'));
const output = process.env.DM_OUTPUT!, org: string = seed.organization, member = seed.members[9999];
const sql = (query: string) => execFileSync('docker', ['exec', '-i', process.env.DM_DB_CONTAINER!, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8', maxBuffer: 64*1024*1024 }).trim();
const ids = `ARRAY[${(seed.ids as string[]).map(id => `'${id}'::uuid`).join(',')}]`;
const start = Date.now();
const settledOnly = process.env.DM_HISTORY_SETTLED_ONLY === '1';
if (!settledOnly) sql(`INSERT INTO channel_message_sequences(organization_id,channel_id,seq) SELECT '${org}',id,10000 FROM unnest(${ids}) id ON CONFLICT(organization_id,channel_id) DO UPDATE SET seq=10000;
INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body)
SELECT '${org}',gen_random_uuid(),c.id,n,CASE WHEN n%2=0 THEN '${member.id}'::uuid WHEN c.lower_member_id='${member.id}' THEN c.higher_member_id ELSE c.lower_member_id END,gen_random_uuid(),repeat('x',1024) FROM channels c CROSS JOIN generate_series(1,10000) n WHERE c.organization_id='${org}' AND c.id=ANY(${ids}); ANALYZE;`);
const seedMs = Date.now()-start;
const counts = readFileSync('server/src/messages/unread.rs', 'utf8').match(/LIST_COUNTS_SQL: &str = r#"([\s\S]+?)"#;/)![1];
const rows: unknown[] = [];
if (settledOnly) sql('VACUUM(ANALYZE) messages;');
const cases: [string, number][] = settledOnly ? [['vacuum_all_unread',0]] : [['all_unread',0],['100_tail',9900],['fully_read',10000]];
for (const [shape, position] of cases) {
  sql(`UPDATE channel_read_positions SET read_seq=${position} WHERE organization_id='${org}' AND member_id='${member.id}' AND channel_id=ANY(${ids});`);
  const samples = Number(process.env.DM_HISTORY_SAMPLES || 1000), times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const begin = performance.now();
    const r = await fetch(`${process.env.BASE_URL}/api/v1/orgs/${org}/dms`, { headers: { Authorization: `Bearer ${member.token}` } });
    if (r.status !== 200) throw new Error(`History probe HTTP ${r.status}`);
    const data = await r.json() as DmList;
    times.push(performance.now()-begin);
    if (data.dms.length !== 50 || data.dms.some(d => d.unread_count !== (10000-position)/2)) throw new Error('History exact count mismatch');
  }
  const report = sql(`SET ROLE fukulow_app; BEGIN; SELECT set_config('fukulow.organization_id','${org}',true); SET LOCAL plan_cache_mode=force_generic_plan; PREPARE probe AS ${counts}; EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE probe('${org}','${member.id}',0,${ids}); ROLLBACK;`);
  writeFileSync(`${output}/plan-counts-${shape}.txt`, report);
  rows.push({ shape, samples, p50: percentile(times,.5), p95: percentile(times,.95), p99: percentile(times,.99) });
  writeFileSync(`${output}/${settledOnly ? 'history-settled' : 'history'}.json`, JSON.stringify({ seedMs, dms: 50, messagesPerDm: 10000, messageBytes: 1024, alternating: true, mentions: 0, rows }, null, 2));
  console.log(`History ${shape}: n=${samples} p95=${percentile(times,.95)?.toFixed(2)} p99=${percentile(times,.99)?.toFixed(2)} ms`);
}
