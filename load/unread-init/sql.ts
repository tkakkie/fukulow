import { readFileSync } from 'node:fs';
import type { Point } from './model.ts';
export const org="md5('org')::uuid",member="md5('member-1')::uuid",channel="md5('channel-1')::uuid";
export const begin=`BEGIN; DO $$ BEGIN PERFORM set_config('fukulow.organization_id',${org}::text,true); END $$; SET LOCAL statement_timeout='850s'; SET LOCAL lock_timeout='840s';`;
export const barrier=(shared:boolean)=>`SELECT pg_advisory_xact_lock${shared?'_shared':''}(hashtextextended(${org}::text||'/'||${channel}::text,135));`;
export function fixture(point:Point,publicChannels:number) {
  const channels=['join','reactivate'].includes(point.operation)?publicChannels:1;
  let sql=readFileSync(new URL('seed.sql',import.meta.url),'utf8').replaceAll('@members@',String(point.members)).replaceAll('@topics@',String(point.topics)).replaceAll('@channels@',String(channels)).replaceAll('@guest@',String(point.operation==='guest-grant'));
  if(['join','reactivate','guest-grant'].includes(point.operation)) {
    if(point.operation==='reactivate')sql+=`UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=${org} AND id=${member};`;
    if(point.operation==='join') {
      // Keep the account, but no Member identity exists until the measured INSERT.
      // The never-activated fixture Member is suppressed during seed instead below.
      sql=sql.replace('FROM generate_series(0,1) g;', 'FROM generate_series(0,0) g;');
    }
    sql+=`UPDATE channels SET visibility='public' WHERE organization_id=${org};`;
  }
  if(point.operation==='regrant')sql+=grant()+`;
INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at) VALUES
(${org},md5('between-grants')::uuid,${channel},${point.topics+1},md5('member-0')::uuid,md5('between-grants')::uuid,'between grants',timestamptz '2026-11-01');
UPDATE channel_message_sequences SET seq=seq+1 WHERE organization_id=${org} AND channel_id=${channel};`;
  return sql+'\nANALYZE;';
}
const grant=()=>`INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) SELECT ${org},${channel},id,membership_revision FROM users WHERE organization_id=${org} AND id=${member}`;
export function mutation(p:Point):string {
  switch(p.operation){
    case 'private-grant':case 'guest-grant':return grant();
    case 'public':return `UPDATE channels SET visibility='public' WHERE organization_id=${org} AND id=${channel}`;
    case 'reactivate':return `UPDATE users SET deactivated_at=NULL WHERE organization_id=${org} AND id=${member}`;
    case 'join':return `INSERT INTO users (organization_id,id,name,role,account_id) VALUES (${org},${member},'Member 1','member',md5('account-1')::uuid)`;
    case 'regrant':return grant();
  }
}
export const revoke=`DELETE FROM channel_members WHERE organization_id=${org} AND channel_id=${channel} AND member_id=${member};`;
export const sender=`${barrier(false)}
WITH next AS (UPDATE channel_message_sequences SET seq=seq+1 WHERE organization_id=${org} AND channel_id=${channel} RETURNING seq)
INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at)
SELECT ${org},md5('sender-probe')::uuid,${channel},seq,md5('member-0')::uuid,md5('sender-probe')::uuid,'probe',timestamptz '2026-11-01' FROM next;`;
export const baselineRows=`SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY channel_id,member_id),'[]') FROM channel_read_positions p WHERE organization_id=${org};`;
export const stats=`SELECT jsonb_object_agg(relname,jsonb_build_object('insert',n_tup_ins,'update',n_tup_upd,'delete',n_tup_del)) FROM pg_stat_user_tables WHERE relname IN ('channel_read_positions','topic_read_positions');`;
// Use current production count SQL verbatim: this also measures Mention counts.
export function countSql(){const text=readFileSync(new URL('../../server/src/messages/unread/counts.rs',import.meta.url),'utf8');const sql=/const LIST_COUNTS_SQL: &str = r#"([\s\S]*?)"#;/.exec(text)?.[1];if(!sql)throw new Error('counts source drift');return sql;}
// Same production projection including W-relative grouping, paging and Mention
// counts. Replace Rust's visibility interpolation with the equivalent ordinary
// Channel predicate for this fixture; assert ordinary Channels only in runner.
export function projectionSql(){
  const text=readFileSync(new URL('../../server/src/messages/topics/projection.rs',import.meta.url),'utf8');
  const sql=/r#"([\s\S]*?)"#,[\s\S]*?channels::member_visibility_sql/.exec(text)?.[1];if(!sql)throw new Error('projection source drift');
  return sql.replace('{}',`SELECT EXISTS (SELECT 1 FROM channels c JOIN users u ON u.organization_id=c.organization_id
    WHERE c.organization_id=$1 AND c.id=$4 AND u.id=$2 AND u.membership_revision=$3 AND u.deactivated_at IS NULL
    AND ((c.visibility='public' AND u.role<>'guest') OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.organization_id=$1 AND cm.channel_id=$4 AND cm.member_id=$2 AND cm.membership_revision=$3)))`);
}
export function readSetup(){return `
PREPARE counts(uuid,uuid,bigint,uuid[]) AS ${countSql()};
PREPARE projection(uuid,uuid,bigint,uuid,bigint,bigint,int,bool,uuid) AS ${projectionSql()};`;
}
export const argsQuery=`SELECT json_build_object('org',${org},'member',${member},'revision',(SELECT membership_revision FROM users WHERE organization_id=${org} AND id=${member}),'channel',${channel},'w',(SELECT seq FROM channel_message_sequences WHERE organization_id=${org} AND channel_id=${channel}),'channels',(SELECT array_agg(id ORDER BY id)::text FROM channels WHERE organization_id=${org}));`;
export function readArgs(a:Record<string,string|number>){return {counts:`('${a.org}','${a.member}',${a.revision},'${a.channels}'::uuid[])`,projection:`('${a.org}','${a.member}',${a.revision},'${a.channel}',${a.w},NULL,51,true,NULL)`};}
export function postGrant(topics:number,initial=topics) {return `
-- Post-grant history: own sends, other sends, direct Mentions and main timeline.
INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id,created_at)
SELECT ${org},md5('new-'||c.id||'-'||g)::uuid,c.id,${initial}+1+g,
 CASE WHEN g%3=0 THEN ${member} ELSE md5('member-0')::uuid END,
 md5('new-'||c.id||'-'||g)::uuid,'new',CASE WHEN g<=${topics} THEN md5('topic-'||split_part(c.name,'-',2)||'-'||g)::uuid END,timestamptz '2026-11-01'
FROM channels c,generate_series(1,${topics}+2)g WHERE c.organization_id=${org};
INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id)
SELECT organization_id,channel_id,id,${member} FROM messages WHERE organization_id=${org} AND body='new' AND seq%2=0;
UPDATE channel_message_sequences SET seq=${initial}+${topics}+3 WHERE organization_id=${org};
UPDATE topics t SET last_seq=m.seq,message_count=2 FROM messages m WHERE m.organization_id=${org} AND m.body='new' AND m.topic_id=t.id AND t.organization_id=${org};
ANALYZE;`;}
export const sparse=`INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq)
SELECT ${org},t.channel_id,${member},t.id,t.last_seq FROM topics t WHERE t.organization_id=${org} AND split_part(t.name,' ',2)::int%10=0
ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=GREATEST(topic_read_positions.read_seq,EXCLUDED.read_seq);`;
