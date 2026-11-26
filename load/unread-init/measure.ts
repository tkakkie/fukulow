import { Database, Session } from './database.ts';
import { begin,barrier,sender,stats,mutation,revoke,org,member,channel,baselineRows,postGrant,sparse,readSetup,argsQuery,readArgs,countSql,projectionSql } from './sql.ts';
import type { Point,Sample,ReadSample } from './model.ts';
export function documents(text:string):unknown[] {
  const result:unknown[]=[];let start=-1,depth=0,string=false,escape=false;
  for(let i=0;i<text.length;i++) {const c=text[i];if(start<0){if(/\s/.test(c))continue;if(c!=='['&&c!=='{')throw new Error(`unexpected SQL output: ${text.slice(i,i+100)}`);start=i;depth=1;continue;}
    if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
    if(c==='"')string=true;else if(c==='['||c==='{')depth++;else if(c===']'||c==='}')depth--;
    if(depth===0){result.push(JSON.parse(text.slice(start,i+1)));start=-1;}
  }
  if(start>=0)throw new Error('incomplete JSON output');return result;
}
interface Plan { 'Execution Time':number; Plan:Record<string,number>; Triggers?:unknown }
const plan=(s:string)=> (documents(s)[0] as Plan[])[0];
const buffers=(p:Plan)=>(p.Plan['Shared Hit Blocks']??0)+(p.Plan['Shared Read Blocks']??0);
const clockStart=`SELECT clock_timestamp() AS started \\gset`;
const clockEnd=`SELECT json_build_object('latency_ms',extract(epoch FROM clock_timestamp()-:'started'::timestamptz)*1000);`;
type Stats=Record<string,Record<string,number>>;
export const senderBaselineMethod = 'In a disposable clone, one untimed sender transaction commits in the same session before the timed uncontended sender commit.';
export async function measure(db:Database,name:string,p:Point,variant:string,repeat:number) {
  // Preserve an actual COMMIT baseline without deleting a retained creation or rewinding its counter.
  const baselineName = name + '_baseline';
  db.clone(baselineName, name);
  const baseline = new Session(db.name, baselineName);
  let senderBaselineMs: number;
  try {
    await baseline.query(`${begin}${sender.replaceAll('sender-probe','warmup-probe')} COMMIT;`);
    const output = documents(await baseline.query(`${clockStart}\n${begin}${sender} COMMIT;\n${clockEnd}`));
    senderBaselineMs = (output.at(-1) as { latency_ms: number }).latency_ms;
  } finally {
    await baseline.close();
    db.drop(baselineName);
  }
  const writer=new Session(db.name,name),send=new Session(db.name,name),observer=new Session(db.name,name,'postgres');
  const reads:ReadSample[]=[]; const readPlans:unknown[]=[];
  try {
    await Promise.all([writer.query(`SET application_name='unread-grant';`),send.query(`SET application_name='unread-sender';`),observer.query(`SET application_name='unread-observer';`)]);
    const role=JSON.parse(await writer.query(`SELECT json_build_object('user',current_user,'bypass',rolbypassrls,'super',rolsuper,'owns',(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))) FROM pg_roles WHERE rolname=current_user;`));
    if(role.user!=='fukulow_app'||role.bypass||role.super||Number(role.owns)!==0)throw new Error('app role is privileged');
    // Fail-closed RLS control before any context is supplied.
    if(await writer.query('SELECT count(*) FROM channels;')!=='0')throw new Error('RLS missing-context failure');
    const before=JSON.parse(await observer.query(stats)) as Stats;
    const bufferBefore=JSON.parse(await observer.query(`SELECT json_build_object('hit',blks_hit,'read',blks_read) FROM pg_stat_database WHERE datname=current_database();`)) as {hit:number;read:number};
    const lsn=await observer.query('SELECT pg_current_wal_lsn();');
    await writer.query(`${begin}${barrier(true)}`);
    const senderPromise=send.query(`${clockStart}\n${begin}${sender} COMMIT;\n${clockEnd}\nSELECT pg_stat_force_next_flush();`);
    void senderPromise.catch(()=>{}); // Keep early SQL failures handled until the paired await.
    // Observe the sender actually waiting before starting the grant. This is a
    // controlled worst-case overlap, not a random natural-contention estimate.
    let observedWait=false;
    for(let attempt=0;attempt<100;attempt++) {
      if(await observer.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='unread-sender' AND wait_event='advisory');`)==='t'){observedWait=true;break;}
      await new Promise(r=>setTimeout(r,2));
    }
    if(!observedWait)throw new Error('sender failed to reach grant barrier');
    let finished=false;
    const statements=p.operation==='regrant'?[revoke,mutation(p)]:[mutation(p)];
    const grantPromise=writer.query(`${clockStart}\n${statements.map(s=>`EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) ${s.replace(/;$/,'')};`).join('\n')}\nCOMMIT;\n${clockEnd}\nSELECT pg_stat_force_next_flush();`).finally(()=>{finished=true;});
    void grantPromise.catch(()=>{});
    const lockSamples:unknown[]=[];
    do {
      lockSamples.push(JSON.parse(await observer.query(`SELECT json_build_object('at',clock_timestamp(),'activity',(SELECT json_agg(a) FROM (SELECT pid,application_name,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('unread-grant','unread-sender')) a),'locks',(SELECT json_agg(l) FROM (SELECT pid,locktype,mode,granted,relation::regclass::text relation,classid,objid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())) l));`)));
      if(!finished)await new Promise(r=>setTimeout(r,10));
    }while(!finished);
    const [grantText,senderText]=await Promise.all([grantPromise,senderPromise]);
    const grantDocs=documents(grantText),plans=grantDocs.filter(Array.isArray).map(a=>(a as Plan[])[0]);
    const latencyMs=(grantDocs.find(d=>!Array.isArray(d)) as {latency_ms:number}).latency_ms;
    const senderMs=(documents(senderText).find(d=>!Array.isArray(d)) as {latency_ms:number}).latency_ms;
    // Flush request was issued by each writer after commit; clear observer's
    // statistics snapshot before reading the per-table totals.
    await observer.query('SELECT pg_stat_clear_snapshot();');
    const after=JSON.parse(await observer.query(stats)) as Stats;
    const deltas:Stats={};let rows=0;
    for(const table of Object.keys(before)){deltas[table]={};for(const key of ['insert','update','delete']){const n=after[table][key]-before[table][key];deltas[table][key]=n;rows+=n;}}
    const bufferAfter=JSON.parse(await observer.query(`SELECT json_build_object('hit',blks_hit,'read',blks_read) FROM pg_stat_database WHERE datname=current_database();`)) as {hit:number;read:number};
    const bufferWindow={hit:bufferAfter.hit-bufferBefore.hit,read:bufferAfter.read-bufferBefore.read};
    const walBytes=Number(await observer.query(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'${lsn}');`));
    const initial=p.topics+(p.operation==='regrant'?1:0);
    const baselines=JSON.parse(await writer.query(`${begin}${baselineRows} COMMIT;`));
    if(await writer.query(`${begin} SELECT count(*) FROM channel_read_positions WHERE organization_id=${org} AND member_id=${member} AND initial_seq<>${initial}; COMMIT;`)!=='0')throw new Error('Channel baseline deferred or moved');
    const targetRows=Number(await writer.query(`${begin} SELECT count(*) FROM channel_read_positions WHERE organization_id=${org} AND member_id=${member}; COMMIT;`));
    const expectedTargetRows=['join','reactivate'].includes(p.operation)?Number(await writer.query(`${begin} SELECT count(*) FROM channels WHERE organization_id=${org}; COMMIT;`)):1;
    if(targetRows!==expectedTargetRows)throw new Error('missing grant-time Channel baseline');
    const topicRows=Number(await writer.query(`${begin} SELECT count(*) FROM topic_read_positions WHERE organization_id=${org} AND member_id=${member}; COMMIT;`));
    if(topicRows!==(variant==='eager'?targetRows*p.topics:0))throw new Error('unexpected Topic persistence');
    const affected=p.operation==='public'?p.members:targetRows;
    const expectedWrites=p.operation==='regrant'?(variant==='eager'?2*(p.topics+1):p.topics+2):affected*(variant==='eager'?p.topics+1:1);
    if(rows!==expectedWrites)throw new Error(`position statistics not flushed or unexpected writes: ${rows} != ${expectedWrites}`);
    await writer.query(`${begin}${postGrant(p.topics,initial)} COMMIT;`);
    await writer.query(readSetup());
    const values=JSON.parse(await writer.query(`${begin}${argsQuery} COMMIT;`)) as Record<string,string|number>;
    const args=readArgs(values);
    const oracle:Record<string,unknown>={baselines};
    for(const stage of ['baseline','sparse']) {
      if(stage==='sparse')await writer.query(`${begin}${sparse} COMMIT; ANALYZE;`);
      const literal=[`'${values.org}'::uuid`,`'${values.member}'::uuid`,String(values.revision),`'${values.channel}'::uuid`,String(values.w),'NULL::bigint','2147483647','true','NULL::uuid'];
      for(const query of ['counts','projection'] as const) {
        const bound=(query==='counts'?countSql():projectionSql()).replace(/\$(\d+)/g,(_,n:string)=>query==='counts'&&n==='4'?`'${values.channels}'::uuid[]`:literal[Number(n)-1]);
        oracle[`${stage}/${query}`]=JSON.parse(await writer.query(`${begin} SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text),'[]') FROM (${bound})q; COMMIT;`));
        for(const mode of ['custom','generic']) {
          // Discard one warm-up, retain a second plan in each forced mode.
          const sql=`${begin} SET LOCAL plan_cache_mode='force_${mode}_plan'; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE ${query}${args[query]}; COMMIT;`;
          await writer.query(sql);const raw=await writer.query(sql),parsed=plan(raw);
          reads.push({stage,query,mode,ms:parsed['Execution Time'],buffers:buffers(parsed)});readPlans.push({stage,query,mode,plan:JSON.parse(raw)});
        }
      }
    }
    return {sample:{...p,variant,repeat,latencyMs,walBytes,rows,buffers:bufferWindow.hit+bufferWindow.read,senderMs,senderBaselineMs,reads} satisfies Sample,
      oracle,role,deltas,plans,bufferWindow,observedWait,lockSamples,readPlans};
  } finally {await Promise.allSettled([writer.close(),send.close(),observer.close()]);}
}
