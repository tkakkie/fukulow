import assert from 'node:assert/strict';
import { begin, definerFunction } from './queries.ts';
import { channel, literal, member, org, uuid } from './seed.ts';

const signature = `${definerFunction}(uuid,text,boolean)`;
// Exactly the columns definer.sql reads; anything more is a privilege leak.
export const definerColumns = [
  'channel_members.channel_id','channel_members.grant_id','channel_members.member_id','channel_members.membership_revision','channel_members.organization_id',
  'channels.id','channels.organization_id','channels.visibility',
  'messages.body','messages.channel_id','messages.created_at','messages.id','messages.normalized_body','messages.organization_id',
  'users.deactivated_at','users.id','users.membership_revision','users.organization_id','users.role',
].map(c=>`${c}:SELECT`).join(',');

// `definition` is a hash of pg_get_functiondef; pass the first one to require
// the identical function in every later database (clones, restores, denials).
// Exactly the query-path settings (manifest queryPath.functionSettings); nothing
// that changes v1's planner or executor conditions, such as jit.
export const definerConfig = 'search_path=pg_catalog, pg_temp;plan_cache_mode=force_custom_plan';
export function verifyDefiner(owner: (text: string)=>string, definition?: string) {
  const facts = {
    definition:owner(`SELECT md5(pg_get_functiondef('${signature}'::regprocedure));`),
    role:owner("SELECT rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='fukulow_search';"),
    memberships:owner("SELECT count(*) FROM pg_auth_members WHERE member IN ('fukulow_search'::regrole,'fukulow_app'::regrole) OR roleid='fukulow_search'::regrole;"),
    function:owner(`SELECT p.proowner::regrole,p.prosecdef,p.provolatile,p.proisstrict,p.prosqlbody IS NOT NULL,array_to_string(p.proconfig,';')
      FROM pg_proc p WHERE p.oid='${signature}'::regprocedure;`),
    execute:owner(`SELECT string_agg(g,',' ORDER BY g) FROM (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END||':'||a.privilege_type g
      FROM pg_proc p,aclexplode(p.proacl) a WHERE p.oid='${signature}'::regprocedure) s;`),
    columns:owner("SELECT string_agg(g,',' ORDER BY g) FROM (SELECT table_name||'.'||column_name||':'||privilege_type g FROM information_schema.column_privileges WHERE grantee='fukulow_search') s;"),
    tables:owner("SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='fukulow_search';"),
    owns:owner(`SELECT count(*) FROM pg_shdepend d JOIN pg_database b ON b.oid=d.dbid AND b.datname=current_database()
      WHERE d.refobjid='fukulow_search'::regrole AND d.deptype='o';`),
  };
  assert.match(facts.definition,/^[0-9a-f]{32}$/);
  assert.deepEqual(facts,{definition:definition ?? facts.definition,role:'f|f|f|f|f|f|t',memberships:'0',
    function:`fukulow_search|t|s|t|t|${definerConfig}`,
    execute:'fukulow_app:EXECUTE,fukulow_search:EXECUTE',columns:definerColumns,tables:'0',owns:'1'},'Definer role, ownership or privileges differ');
  return facts;
}

// Handcrafted rows in a separate small database; the measured dataset is untouched.
// [key, Organization, Channel, body, created_at]
const probes = [
  [1,1,0,'denialprobe public','2026-11-14'],[2,1,1,'denialprobe private','2026-11-14'],[3,1,10,'denialprobe public later','2026-11-14'],
  [4,1,0,'denialprobe outside range','2026-01-01'],[5,2,0,'denialprobe other organization','2026-11-14'],
  [6,2,0,'abz oracle','2026-11-14'],[7,2,0,'ab\\z oracle','2026-11-14'],[8,1,0,'ab\\y own','2026-11-14'],
  [9,1,21,'denialprobe private ungranted','2026-11-14'],[10,1,90,'denialprobe direct message','2026-11-14'],
  [11,1,23,'denialprobe private revoked','2026-11-14'],
] as const;
// Senders: the DM probe is sent by participant 2, the revoked probe by Member 9 before revocation.
const sender = (k: number) => k===10 ? 2 : k===11 ? 9 : 1;
const probe = (k: number) => uuid(9_000_000+k);
// Extra Organization 1 Members, only in the denial database: 7 admin without grants (and DM
// participant), 8 member demoted to guest, 9 member whose private grant is revoked after sending,
// 10 member keeping that grant (positive control). Channel 90 is a DM between Members 2 and 7.
const extraMembers = `${[[7,'admin'],[8,'member'],[9,'member'],[10,'member']].map(([u,role])=>
  `INSERT INTO accounts VALUES ('${member(1,u as number)}','synthetic-1-${u}@example.invalid','measurement-only');
INSERT INTO users (organization_id,id,account_id,name,role) VALUES ('${org(1)}','${member(1,u as number)}','${member(1,u as number)}','Synthetic Member ${u}','${role}');`).join('\n')}
INSERT INTO channels (organization_id,id,kind,lower_member_id,higher_member_id) VALUES ('${org(1)}','${channel(1,90)}','dm','${member(1,2)}','${member(1,7)}');
INSERT INTO channel_message_sequences VALUES ('${org(1)}','${channel(1,90)}',1);
INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ('${org(1)}','${channel(1,90)}','${member(1,2)}'),('${org(1)}','${channel(1,90)}','${member(1,7)}'),
  ('${org(1)}','${channel(1,23)}','${member(1,9)}'),('${org(1)}','${channel(1,23)}','${member(1,10)}');`;
// Applied after the probes: revocation after the Message was sent, then demotion to Guest.
const grantChanges = `DELETE FROM channel_members WHERE organization_id='${org(1)}' AND channel_id='${channel(1,23)}' AND member_id='${member(1,9)}';
UPDATE users SET role='guest' WHERE organization_id='${org(1)}' AND id='${member(1,8)}';`;
// 20,000 filler rows in Channel 0 make the per-Channel btree unselective, so a
// forced plan (enable_seqscan=off) must show the body's folded LIKE pattern as a
// search_body index condition. Filler never matches any denial query.
const filler = `INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at)
SELECT '${org(1)}',md5('filler'||n)::uuid,'${channel(1,0)}',10000+n,'${member(1,1)}',md5('filler'||n)::uuid,'filler message '||n,'2026-11-13'
FROM generate_series(1,20000) n;`;
export const probeSql = extraMembers+'\n'+filler+`\nINSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at) VALUES
${probes.map(([k,o,c,body,at])=>`('${org(o)}','${probe(k)}','${channel(o,c)}',${1000+k},'${member(o,sender(k))}','${probe(k)}',${literal(body)},'${at}')`).join(',\n')};
${grantChanges} ANALYZE;`;

type Context = number|null|'';
// Fixture: Member 1 owner (grants Channels 0-19), 2 member (grants c%5=0), 3 guest
// (grants 0-7), 4 guest without grant, 5 reactivated with stale grants, 6 deactivated;
// denial database only: 7-10 and the DM in extraMembers above.
// Even Channels are public, odd private. Each denial has a positive control.
export const denialCases: {name:string,context:Context,actor:[number,number],query:string,expect:number[]}[] = [
  {name:'owner sees public, granted private and later public; private Channel and DM non-member Owner is denied',context:1,actor:[1,1],query:'denialprobe',expect:[1,2,3]},
  {name:'private Channel non-member is denied; DM participant sees the DM',context:1,actor:[1,2],query:'denialprobe',expect:[1,3,10]},
  {name:'private Channel non-member Admin is denied; DM participant Admin sees the DM',context:1,actor:[1,7],query:'denialprobe',expect:[1,3,10]},
  {name:'DM non-participant is denied',context:1,actor:[1,3],query:'denialprobe direct',expect:[]},
  {name:'DM participant finds the DM Message (positive control)',context:1,actor:[1,2],query:'denialprobe direct',expect:[10]},
  {name:'access revoked after the Message was sent is denied',context:1,actor:[1,9],query:'denialprobe',expect:[1,3]},
  {name:'kept grant still sees the revoked Member\'s Message (positive control)',context:1,actor:[1,10],query:'denialprobe',expect:[1,3,11]},
  {name:'Member demoted to Guest without a public grant is denied',context:1,actor:[1,8],query:'denialprobe',expect:[]},
  {name:'guest sees only granted Channels',context:1,actor:[1,3],query:'denialprobe',expect:[1,2]},
  {name:'guest without grant is denied',context:1,actor:[1,4],query:'denialprobe',expect:[]},
  {name:'stale grant after reactivation is denied',context:1,actor:[1,5],query:'denialprobe',expect:[1,3]},
  {name:'deactivated Member is denied',context:1,actor:[1,6],query:'denialprobe',expect:[]},
  {name:'other Organization context gets nothing for an Organization 1 actor',context:2,actor:[1,1],query:'denialprobe',expect:[]},
  {name:'Organization 2 context and Member see only Organization 2',context:2,actor:[2,2],query:'denialprobe',expect:[5]},
  {name:'Organization 1 actor id in Organization 3 context',context:3,actor:[1,2],query:'denialprobe',expect:[]},
  {name:'NULL Organization context returns no rows',context:null,actor:[1,1],query:'denialprobe',expect:[]},
  {name:'empty Organization context returns no rows',context:'',actor:[1,1],query:'denialprobe',expect:[]},
  {name:'trailing backslash, other-Organization error rows present',context:1,actor:[1,2],query:'ab\\',expect:[8]},
  {name:'trailing backslash, only other Organizations match',context:3,actor:[3,2],query:'ab\\',expect:[]},
  {name:'trailing backslash, nothing matches',context:1,actor:[1,2],query:'zz\\',expect:[]},
  {name:'empty query returns no rows',context:1,actor:[1,1],query:'',expect:[]},
];

export type DenialHarness = {owner:(db:string,text:string)=>string,app:(db:string,text:string)=>string,create:(db:string)=>void,
  index:(db:string,engine:string)=>unknown,drop:(db:string)=>void,
  plan:(db:string,query:string,actor:number,settings:string)=>{log:string,searchIndex:boolean,folded:boolean}};
export function definerDenials(h: DenialHarness, engines: readonly string[], definition: string) {
  h.create('denial'); h.owner('denial',probeSql);
  // Positive control: the unescaped pattern fails on other-Organization rows (22025).
  h.owner('denial',`DO $$ BEGIN PERFORM 1 FROM public.messages WHERE normalized_body LIKE 'ab\\';
    RAISE EXCEPTION 'expected LIKE escape error'; EXCEPTION WHEN invalid_escape_sequence THEN NULL; END $$;`);
  const results = [];
  for (const engine of ['none',...engines]) {
    const db = `denial_${engine}`;
    h.owner('postgres',`CREATE DATABASE ${db} TEMPLATE denial;`); h.index(db,engine);
    const definer = verifyDefiner(text=>h.owner(db,text),definition);
    for (const settings of ['','SET LOCAL enable_seqscan=off;\n']) {
      for (const c of denialCases) {
        const start = c.context===null ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
          : c.context==='' ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT set_config('fukulow.organization_id','',true);\n" : begin(c.context);
        const context = typeof c.context==='number' ? org(c.context) : '';
        const found = h.app(db,start+settings+`SELECT id FROM ${definerFunction}('${member(...c.actor)}',${literal(c.query)},false) ORDER BY id;\nCOMMIT;`)
          .split('\n').filter(s=>s && s!==context);
        assert.deepEqual(found,c.expect.map(probe),`Definer denial check failed (${engine}${settings ? ', forced' : ''}): ${c.name}`);
      }
    }
    // Forced: proves the definer body gets a constant pattern usable by the index.
    const plan = engine==='none' ? null : h.plan(db,'denialprobe',1,'SET LOCAL enable_seqscan=off;\n');
    const lines = plan?.log.split('\n').filter(l=>/ Scan on |Index Cond|Recheck Cond/.test(l)).join('\n');
    if (plan) assert.ok(plan.searchIndex,`Forced definer body plan does not use search_body (${engine}):\n`+lines);
    if (plan) assert.ok(plan.folded,`Forced definer body plan has no folded LIKE pattern (${engine}):\n`+lines);
    results.push({engine,definer,cases:denialCases.length*2,plan:plan?.log ?? ''});
    h.drop(db);
  }
  h.drop('denial');
  return {cases:denialCases.map(c=>c.name),results};
}
