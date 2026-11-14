import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { percentile } from './dms-workload.ts';
import { randomUUID } from 'node:crypto';

const output = process.env.DM_OUTPUT!;
const seedPath = process.env.DM_SEED_OUT!;
const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { organization: string; members: { id: string; token: string; peer: string; channel: string }[]; deep?: string; ids?: string[] };
const focal = seed.members[9999], org = seed.organization;
const sql = (query: string) => execFileSync('docker', ['exec', '-i', process.env.DM_DB_CONTAINER!, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-At'], { input: query, encoding: 'utf8', maxBuffer: 64*1024*1024 }).trim();
const base = `${process.env.BASE_URL}/api/v1/orgs/${org}`;
async function request(path: string, body?: unknown, member = focal) {
  const start = performance.now();
  const response = await fetch(base+path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const bytes = await response.text();
  const ms = performance.now()-start;
  if (!response.ok) throw new Error(`Probe ${path.split('?')[0]}: ${response.status}`);
  return { ms, bytes: bytes.length, data: JSON.parse(bytes) };
}
// Save a real Session-bound continuation after exactly 5,000 creation-order rows.
let cursor: string | undefined;
for (let i = 0; i < 100; i++) cursor = (await request('/dms'+(cursor ? '?cursor='+encodeURIComponent(cursor) : ''))).data.next_cursor;
seed.deep = cursor;
const first = (await request('/dms')).data;
seed.ids = first.dms.map((d: { id: string }) => d.id);
writeFileSync(seedPath, JSON.stringify(seed), { mode: 0o600 });
const results: Record<string, unknown> = {};
const samples = Number(process.env.DM_PROBE_SAMPLES || 1000);
const cases: [string, string, unknown?][] = [['first', '/dms'], ['deep', '/dms?cursor='+encodeURIComponent(cursor!)], ['refresh', '/dms?'+seed.ids!.map(id => `channel_id=${id}`).join('&')], ['delta50', '/dms/changes?lane=delta'], ['resolve', '/dms', { member_id: focal.peer }], ['renew_noop', '/dms', { member_id: focal.peer, renew: true }]];
for (const [name, path, body] of cases) {
  sql('SELECT pg_stat_statements_reset();');
  const times: number[] = [], bytes: number[] = [];
  for (let i = 0; i < samples; i++) { const r = await request(path, body); times.push(r.ms); bytes.push(r.bytes); }
  const stats = JSON.parse(sql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT query,toplevel,calls,total_exec_time,rows FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY calls DESC) t;"));
  results[name] = { samples, p50: percentile(times, .5), p95: percentile(times, .95), p99: percentile(times, .99), bytes: percentile(bytes, .5), stats };
  console.log(`${name}: n=${samples} p95=${percentile(times,.95)?.toFixed(2)} p99=${percentile(times,.99)?.toFixed(2)} ms`);
}
// True lapsed-grant renewal: fixture authority transition is outside each timed request.
const renewal: number[] = [];
for (let i = 0; i < Math.min(samples, 100); i++) {
  sql(`UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id='${org}' AND id='${seed.members[3000].peer}'; UPDATE users SET deactivated_at=NULL WHERE organization_id='${org}' AND id='${seed.members[3000].peer}';`);
  renewal.push((await request('/dms', { member_id: seed.members[3000].peer, renew: true }, seed.members[3000])).ms);
}
results.renew_lapsed = { samples: renewal.length, p50: percentile(renewal,.5), p95: percentile(renewal,.95), p99: percentile(renewal,.99) };
for (const shape of ['create','send_new']) {
  sql('SELECT pg_stat_statements_reset();');
  const times: number[] = [];
  const n = shape === 'create' ? Math.min(samples, 1000) : 10;
  for (let i = 0; i < n; i++) {
    const member = seed.members[shape === 'create' ? 2000 : i];
    const r = shape === 'create' ? await request('/dms', { member_id: seed.members[4000+i].id }, member)
      : await request(`/channels/${member.channel}/messages`, { client_message_id: randomUUID(), body: JSON.stringify({ sent: Date.now(), text: 'x'.repeat(986) }) }, member);
    times.push(r.ms);
  }
  await new Promise<void>(resolve => setTimeout(resolve, 500));
  const stats = JSON.parse(sql("SELECT coalesce(json_agg(t),'[]') FROM (SELECT query,toplevel,calls,total_exec_time,rows FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%' ORDER BY calls DESC) t;"));
  results[shape] = { samples: n, p50: percentile(times,.5), p95: percentile(times,.95), p99: percentile(times,.99), stats };
}
writeFileSync(`${output}/endpoints.json`, JSON.stringify(results, null, 2));

// Extract production SQL rather than maintain a parallel copy. Both plan modes
// matter: SQLx promotes repeated prepared statements to a PostgreSQL generic plan.
const source = readFileSync(process.env.DM_SELECTOR_SOURCE || 'server/src/channels/dms.rs', 'utf8');
const select = source.match(/(?:query_as\(|let sql = )"(SELECT cm.channel_id[^"\n]+)"/)?.[1];
if (!select) throw new Error('DM selector extraction must match production SQL');
const discovery = readFileSync('server/src/channels/dms/discovery.rs', 'utf8').match(/"(SELECT d.channel_id[^"\n]+)"/)?.[1].replaceAll('{column}', 'latest_position');
const counts = readFileSync('server/src/messages/unread.rs', 'utf8').match(/LIST_COUNTS_SQL: &str = r#"([\s\S]+?)"#;/)?.[1];
if (!discovery || !counts) throw new Error('Production SQL extraction failed');
const ids = `ARRAY[${seed.ids!.map(id => `'${id}'::uuid`).join(',')}]`;
const boundary = sql(`SELECT cm.channel_id FROM channel_members cm WHERE organization_id='${org}' AND member_id='${focal.id}' ORDER BY dm_created_at DESC,channel_id DESC LIMIT 1 OFFSET 4999;`);
const shaped = select.includes('{filter}');
const plans = [ ['first', select.replace('{filter}', ''), shaped ? `'${org}','${focal.id}',0` : `'${org}','${focal.id}',0,NULL,NULL,NULL`],
  ['deep', select.replace('{filter}', 'AND (dm_created_at,channel_id)<($4::timestamptz,$5::uuid)'), shaped ? `'${org}','${focal.id}',0,'2026-01-01','${boundary}'` : `'${org}','${focal.id}',0,'2026-01-01','${boundary}',NULL`],
  ['refresh', select.replace('{filter}', 'AND channel_id=ANY($4::uuid[])'), shaped ? `'${org}','${focal.id}',0,${ids}` : `'${org}','${focal.id}',0,NULL,NULL,${ids}`],
  ['delta', discovery, `'${org}','${focal.id}',0,0,999999999`], ['counts', counts, `'${org}','${focal.id}',0,${ids}`] ];
for (const mode of ['force_custom_plan','force_generic_plan']) for (const [name, query, args] of plans) {
  const report = sql(`SET ROLE fukulow_app; BEGIN; SELECT set_config('fukulow.organization_id','${org}',true); SET LOCAL plan_cache_mode=${mode}; PREPARE probe AS ${query}; EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE probe(${args}); ROLLBACK;`);
  writeFileSync(`${output}/plan-${name}-${mode}.txt`, report);
}
sql('SELECT pg_stat_statements_reset();');
console.log('Saved production-query EXPLAIN plans (custom and generic)');
