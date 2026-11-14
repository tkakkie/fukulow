// Disposable admin fixture; secrets go only into a mode-0600 external seed file.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { outsideCheckout } from './dms-workload.ts';

const output = resolve(process.env.DM_SEED_OUT || '');
if (!process.env.DM_SEED_OUT || !outsideCheckout(output, resolve(import.meta.dirname, '..'))) throw new Error('DM_SEED_OUT must be outside checkout');
const container = process.env.DM_DB_CONTAINER;
if (!container) throw new Error('DM_DB_CONTAINER required (disposable PostgreSQL only)');
const id = (kind: string, i: number) => {
  const hex = createHash('md5').update(`dm151:${kind}:${i}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const org = id('org', 0), channel = id('ordinary', 0), topic = id('topic', 0);
const members = Array.from({ length: 10000 }, (_, i) => ({ id: id('member', i), token: randomBytes(32).toString('hex'), channel: id('pair', Math.floor(i / 2)), peer: id('member', i ^ 1) }));
const sql: string[] = ['BEGIN;', `INSERT INTO organizations(organization_id,name) VALUES('${org}','DM preliminary');
INSERT INTO channels(organization_id,id,name,visibility) VALUES('${org}','${channel}','Ordinary','public'); COMMIT; BEGIN;`];
for (const [i, m] of members.entries()) {
  const hash = createHash('sha256').update(m.token).digest('hex');
  sql.push(`INSERT INTO accounts(id,email,password_hash) VALUES('${m.id}','dm-${i}@example.invalid','unused');
INSERT INTO users(organization_id,id,account_id,name,role) VALUES('${org}','${m.id}','${m.id}','Member ${i}','member');
INSERT INTO account_sessions(account_id,token_hash) VALUES('${m.id}',decode('${hash}','hex'));`);
  if ((i+1)%250 === 0) sql.push('COMMIT; BEGIN;');
}
for (let i = 0; i < members.length; i += 2) sql.push(`INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id,created_at) VALUES('${org}','${members[i].channel}','dm',least('${members[i].id}'::uuid,'${members[i+1].id}'::uuid),greatest('${members[i].id}'::uuid,'${members[i+1].id}'::uuid),'2026-01-01');`);
// Member 9999 is the dense-list probe; preserve every sender's independent pair.
for (let i = 0; i < 9998; i++) sql.push(`INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id,created_at) VALUES('${org}','${id('focal', i)}','dm',least('${members[9999].id}'::uuid,'${members[i].id}'::uuid),greatest('${members[9999].id}'::uuid,'${members[i].id}'::uuid),'2026-01-01');`);
sql.push('COMMIT;');
// Bound seed-only advisory locks; never raise the measured DB's lock settings.
for (let start = 0; start < 14998; start += 250) sql.push(`BEGIN; INSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision)
SELECT organization_id,id,m,0 FROM (SELECT * FROM channels WHERE organization_id='${org}' AND kind='dm' ORDER BY id LIMIT 250 OFFSET ${start}) c CROSS JOIN LATERAL unnest(ARRAY[lower_member_id,higher_member_id]) m ORDER BY m,id; COMMIT;`);
sql.push(`BEGIN; INSERT INTO dm_discovery_counters(organization_id,member_id,membership_revision,position)
SELECT organization_id,member_id,0,count(*) FROM channel_members WHERE organization_id='${org}' GROUP BY organization_id,member_id;
INSERT INTO dm_discovery(organization_id,member_id,membership_revision,channel_id,grant_id,birth_position,latest_position)
SELECT organization_id,member_id,0,channel_id,grant_id,row_number() OVER(PARTITION BY member_id ORDER BY channel_id),row_number() OVER(PARTITION BY member_id ORDER BY channel_id) FROM channel_members WHERE organization_id='${org}';
INSERT INTO channel_members(organization_id,channel_id,member_id) VALUES('${org}','${channel}','${members[0].id}');
INSERT INTO channel_message_sequences(organization_id,channel_id,seq) VALUES('${org}','${channel}',1);
INSERT INTO topics(organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES('${org}','${channel}','${topic}','Topic',1,1,1);
INSERT INTO messages(organization_id,channel_id,id,seq,sender,client_message_id,body,topic_id) VALUES('${org}','${channel}','${id('message', 0)}',1,'${members[0].id}','${id('client', 0)}','seed','${topic}');
COMMIT; ANALYZE;`);
execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1'], { input: sql.join('\n'), stdio: ['pipe', 'ignore', 'inherit'], maxBuffer: 16*1024*1024 });
writeFileSync(output, JSON.stringify({ organization: org, channel, topic, members }), { mode: 0o600 });
console.log('Seeded 10,000 distinct Members/Sessions, 14,998 DM pairs, focal 9,999 DMs; zero DM history, no Guests or Mentions');
