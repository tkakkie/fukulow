// Dedicated-hardware fixture only: 50M 1-KiB Messages. Never defaults to running.
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { outsideCheckout, regularPairs } from './dms-workload.ts';
if (process.env.DM_FORMAL_SEED !== '1') throw new Error('Set DM_FORMAL_SEED=1 only on the dedicated disposable DB host (50M Messages)');
const output = resolve(process.env.DM_FORMAL_OUT || '');
if (!process.env.DM_FORMAL_OUT || !outsideCheckout(output, resolve('.'))) throw new Error('DM_FORMAL_OUT must be outside checkout');
const container = process.env.DM_DB_CONTAINER;
if (!container) throw new Error('DM_DB_CONTAINER required');
mkdirSync(output, { recursive: true });
const uuid = (label: string) => { const s = createHash('md5').update(`dm151-formal:${label}`).digest('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; };
const sql = (input: string) => execFileSync('docker', ['exec','-i',container,'psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1'], { input, stdio: ['pipe','ignore','inherit'], maxBuffer: 64*1024*1024 });
const pairs = regularPairs(1000,100);
const smoke = process.env.DM_FORMAL_SMOKE === '1';
const history = smoke ? 1 : 100;
for (let o = 0; o < (smoke ? 1 : 10); o++) {
  const org = uuid(`org:${o}`), ordinary = uuid(`ordinary:${o}`), topic = uuid(`topic:${o}`);
  const channelId = (a: number, b: number) => uuid(`pair:${o}:${Math.min(a,b)}:${Math.max(a,b)}`);
  const members = Array.from({ length: 1000 }, (_, i) => ({ id: uuid(`member:${o}:${i}`), token: randomBytes(32).toString('hex'), channel: channelId(i,i^1), peer: uuid(`member:${o}:${i^1}`), extraToken: i%10 === 0 ? randomBytes(32).toString('hex') : undefined }));
  sql(`INSERT INTO organizations(organization_id,name) VALUES('${org}','Formal ${o}'); INSERT INTO channels(organization_id,id,name,visibility) VALUES('${org}','${ordinary}','Ordinary','public');`);
  for (let start = 0; start < 1000; start += 100) {
    const statements = ['BEGIN;'];
    for (let i = start; i < start+100; i++) {
      const m = members[i];
      statements.push(`INSERT INTO accounts(id,email,password_hash) VALUES('${m.id}','formal-${o}-${i}@example.invalid','unused'); INSERT INTO users(organization_id,id,account_id,name,role) VALUES('${org}','${m.id}','${m.id}','Member ${i}','${i >= 900 ? 'guest' : 'member'}');`);
      for (const token of [m.token,m.extraToken].filter((v): v is string => !!v)) statements.push(`INSERT INTO account_sessions(account_id,token_hash) VALUES('${m.id}',decode('${createHash('sha256').update(token).digest('hex')}','hex'));`);
    }
    sql(statements.join('\n')+'\nCOMMIT;');
  }
  // Prepare a current revision with some genuinely historical grants for the
  // timed renewal pool. Watched reciprocal pairs always retain current grants.
  sql(`UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id='${org}'; UPDATE users SET deactivated_at=NULL WHERE organization_id='${org}';`);
  for (let start = 0; start < pairs.length; start += 250) {
    const batch = pairs.slice(start,start+250), ids = batch.map(([a,b]) => channelId(a,b));
    sql('BEGIN;\n'+batch.map(([a,b]) => `INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id,created_at) VALUES('${org}','${channelId(a,b)}','dm',least('${members[a].id}'::uuid,'${members[b].id}'::uuid),greatest('${members[a].id}'::uuid,'${members[b].id}'::uuid),'2026-01-01');`).join('\n')+`\nINSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision) SELECT organization_id,id,m,1 FROM channels CROSS JOIN LATERAL unnest(ARRAY[lower_member_id,higher_member_id]) m WHERE organization_id='${org}' AND id=ANY(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]) ORDER BY m,id; COMMIT;`);
  }
  const renewals = pairs.filter(([a,b]) => a < 900 && (a^1) !== b).slice(0,10000).map(([a,b]) => ({ caller: a, peer: b, channel: channelId(a,b) }));
  for (let start = 0; start < renewals.length; start += 100) sql('BEGIN;\n'+renewals.slice(start,start+100).map(r => `UPDATE channel_members SET membership_revision=0 WHERE organization_id='${org}' AND channel_id='${r.channel}' AND member_id='${members[r.peer].id}';`).join('\n')+'\nCOMMIT;');
  sql(`DELETE FROM channel_read_positions p USING channel_members cm WHERE cm.organization_id='${org}' AND cm.membership_revision=0 AND p.organization_id=cm.organization_id AND p.channel_id=cm.channel_id AND p.member_id=cm.member_id;
INSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision) SELECT '${org}','${ordinary}',id,1 FROM users WHERE organization_id='${org}' AND (role='guest' OR id='${members[0].id}');
INSERT INTO dm_discovery_counters(organization_id,member_id,membership_revision,position) SELECT '${org}',id,1,10100 FROM users WHERE organization_id='${org}';
INSERT INTO dm_discovery(organization_id,member_id,membership_revision,channel_id,grant_id,birth_position,latest_position) SELECT organization_id,member_id,1,channel_id,grant_id,row_number() OVER(PARTITION BY member_id ORDER BY channel_id),10000+row_number() OVER(PARTITION BY member_id ORDER BY channel_id) FROM channel_members WHERE organization_id='${org}' AND dm_created_at IS NOT NULL AND membership_revision=1;
INSERT INTO channel_message_sequences(organization_id,channel_id,seq) SELECT '${org}',id,${history} FROM channels WHERE organization_id='${org}' AND kind='dm';`);
  for (let start = 0; start < pairs.length; start += 250) {
    const ids = pairs.slice(start,start+250).map(([a,b]) => channelId(a,b));
    sql(`INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT '${org}',gen_random_uuid(),c.id,n,CASE WHEN n%2=0 THEN c.lower_member_id ELSE c.higher_member_id END,gen_random_uuid(),repeat('x',1024) FROM channels c CROSS JOIN generate_series(1,${history}) n WHERE c.organization_id='${org}' AND c.id=ANY(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]);`);
  }
  sql(`INSERT INTO channel_message_sequences VALUES('${org}','${ordinary}',1); INSERT INTO topics(organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES('${org}','${ordinary}','${topic}','Topic',1,1,1); INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) VALUES('${org}',gen_random_uuid(),'${ordinary}',1,'${members[0].id}',gen_random_uuid(),'seed','${topic}');`);
  writeFileSync(`${output}/org-${o}.json`, JSON.stringify({ organization: org, channel: ordinary, topic, members, renewals }), { mode: 0o600 });
  console.log(`${smoke ? 'SMOKE ONLY' : 'Formal'} Organization ${o}: 1,000 Members (100 Guests), 1,100 Sessions, 50,000 DMs, ${50000*history} Messages; current revision 1, 90,000 usable + 10,000 old-revision grants, read_seq 0, alternating senders, zero Mentions; 10,000 prepared renewals`);
}
sql('VACUUM(ANALYZE);');
