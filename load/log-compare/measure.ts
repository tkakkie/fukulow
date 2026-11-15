import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Database, docker, dockerAsync, Session, lsn, sizes, walDelta } from './database.ts';
import { logTable, snapshot, reduce, type Arm, type Conditions, type Sample, type Entry } from './model.ts';
import { org, member, commonSchema, variantSchema, functions, seedSQL, replaySQL, backfill, workloadSQL, record } from './sql.ts';
export interface Scenario { name:string; channels:number; body:number; mix:[number,number,number,number] }
export const scenarios:Scenario[] = [1,200].flatMap(channels => [17,4000].flatMap(body => [
  {name:`create-${channels}-${body}`,channels,body,mix:[100,0,0,0] as [number,number,number,number]},
  {name:`mixed90-${channels}-${body}`,channels,body,mix:[90,5,3,2] as [number,number,number,number]},
  {name:`mixed50-${channels}-${body}`,channels,body,mix:[50,20,20,10] as [number,number,number,number]},
]));
export async function setup(db:Database,arm:Arm,channels:number,count:number) {
  db.reset(); db.sql(commonSchema()+variantSchema(arm)+functions(arm,count)+seedSQL(arm,channels,count));
}
export const fixtureSize = (s:Scenario,smoke:boolean) => smoke ? (s.channels===1 ? 1000 : 200) : (s.channels===1 ? 100000 : 1000);
function percentile(sorted:number[],p:number) { return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] ?? 0; }
export function parsePgbench(report:string,log:string,seconds:number) {
  const count=Number(/number of transactions actually processed:\s*(\d+)/.exec(report)?.[1]);
  const errors=Number(/number of failed transactions:\s*(\d+)/.exec(report)?.[1]);
  const skipped=Number(/number of transactions skipped:\s*(\d+)/.exec(report)?.[1] ?? 0);
  const late=Number(/number of transactions above the.*?:\s*(\d+)/.exec(report)?.[1] ?? 0);
  if (!Number.isFinite(count) || !Number.isFinite(errors)) throw new Error('incomplete pgbench report');
  const rows=log.trim().split('\n').filter(Boolean).map(l=>l.trim().split(/\s+/));
  const completed=rows.filter(r=>r[2]!=='skipped' && r[2]!=='failed');
  const latencies=completed.map(r=>(Number(r[2])-Number(r[6]??0))/1000).sort((a,b)=>a-b);
  const scheduledLatencies=completed.map(r=>Number(r[2])/1000).sort((a,b)=>a-b);
  const tps=Number(/^tps = ([\d.]+)/m.exec(report)?.[1]);
  if(!Number.isFinite(tps) || completed.length!==count || latencies.some(n=>!Number.isFinite(n)||n<0))
    throw new Error('pgbench log/report mismatch');
  return {offered:count+skipped+errors,accepted:count,errors,dropped:skipped,
    late,elapsed:Math.max(seconds,count/tps),p50:percentile(latencies,.5),p95:percentile(latencies,.95),p99:percentile(latencies,.99),
    tps:Math.min(count/seconds,tps),actualOfferedRate:(count+skipped+errors)/seconds,scheduledP95:percentile(scheduledLatencies,.95),
    latencyScope:'BEGIN to COMMIT, excludes scheduling lag; scheduledP95 includes lag'};
}
export async function bench(db:Database,arm:Arm,scenario:Scenario,conditions:Conditions,round:number,out:string,maximum=false) {
  const body=scenario.body===17 ? 'Load test message' : Array.from({length:4000},(_,n)=>
    String.fromCodePoint(0x20000+createHash('sha256').update(`160/${n}`).digest().readUInt16BE(0))).join('');
  const script='/tmp/log-compare/write.sql',prefix='/tmp/log-compare/txn';
  db.copy(workloadSQL(body,scenario.channels,scenario.mix),script);
  // Previous logs only in this owned container, never shell-expand a host path.
  docker('exec',db.name,'sh','-c','rm -f /tmp/log-compare/txn.*');
  db.sql('CHECKPOINT;');
  const before=sizes(db),wal=lsn(db);
  const report=await dockerAsync('exec',db.name,'pgbench','-n','-h','127.0.0.1','-U','postgres','-M','prepared',
    '-c',String(conditions.clients),'-j',String(Math.min(conditions.clients,4)),
    '-T',String(conditions.seconds),'--random-seed=160','--log',`--log-prefix=${prefix}`,
    ...(!maximum ? ['--rate',String(conditions.rate),'--latency-limit=1000'] : []),
    '-D','n=0','-f',script,'compare').catch(error=>{
      writeFileSync(out+'.failed.txt',String(error));
      writeFileSync(out+'.transactions.log',docker('exec',db.name,'sh','-c','cat /tmp/log-compare/txn.*'));
      throw error;
    });
  const walBytes=walDelta(db,wal),after=sizes(db);
  const log=docker('exec',db.name,'sh','-c','cat /tmp/log-compare/txn.*');
  const parsed=parsePgbench(report,log,conditions.seconds);
  const result={...parsed,arm,round,conditions,walBytes,walPerOp:walBytes/parsed.accepted,
    heapPerOp:(after.heap-before.heap)/parsed.accepted,indexPerOp:(after.index-before.index)/parsed.accepted,
    before,after,maximum,correctness:await correctness(db,arm)};
  writeFileSync(out+'.pgbench.txt',report); writeFileSync(out+'.transactions.log',log);
  writeFileSync(out+'.json',JSON.stringify(result,null,2));
  return result;
}
export function positionSQL(arm:Arm) {
  const creates=`SELECT organization_id,channel_id,seq AS position,id AS message_id FROM messages`;
  if(arm==='baseline') return creates;
  const changes=`SELECT organization_id,channel_id,position,message_id FROM ${logTable(arm)}`;
  return arm.startsWith('events') ? `${creates} UNION ALL ${changes}` : changes;
}
export async function correctness(db:Database,arm:Arm) {
  const counters=()=>db.sql('SELECT sum(seq) FROM channel_message_sequences');
  // Retry the original send after its state has become a tombstone. This includes
  // the receipt hash lookup, while the old body is retained only by snapshot arms.
  db.sql(`BEGIN; SELECT apply_op(1,99999999,0,'retry probe',true,false); COMMIT;`);
  db.sql(`DO $$ DECLARE ch uuid:=fixture_id(1,0); r messages%ROWTYPE; p bigint; BEGIN
    ${arm==='baseline' ? 'p:=1;' : `UPDATE channel_message_sequences SET seq=seq+1 WHERE organization_id=${org} AND channel_id=ch RETURNING seq INTO p;`}
    UPDATE messages SET body='',deleted=true,version=version+1 WHERE organization_id=${org}
      AND id=fixture_id(1,1099999999) RETURNING * INTO r;
    ${record(arm,"'Delete'",'r','p')} END $$;`);
  const before=counters();
  db.sql(`BEGIN; SELECT apply_op(1,99999999,0,'retry probe',true,false); COMMIT;
    BEGIN; SELECT apply_op(1,99999998,0,'rollback probe',false,true); ROLLBACK;`);
  const retryPositions=Number(counters())-Number(before);
  const missing=Number(db.sql(`WITH positions AS (${positionSQL(arm)}),counts AS (
      SELECT organization_id,channel_id,count(*) n,count(DISTINCT position) u,min(position) lo,max(position) hi
        FROM positions GROUP BY organization_id,channel_id)
      SELECT COALESCE(sum(abs(s.seq-COALESCE(c.n,0))+COALESCE(c.n-c.u,0)+abs(COALESCE(c.lo,1)-1)+abs(s.seq-COALESCE(c.hi,0))),0)
      FROM channel_message_sequences s LEFT JOIN counts c USING (organization_id,channel_id)`));
  let resurrected=Number(db.sql('SELECT count(*) FROM messages WHERE deleted AND body<>\'\''));
  if(snapshot(arm)) {
    const source=arm.startsWith('events') ?
      'SELECT message_id,position,payload FROM creation_snapshots UNION ALL SELECT message_id,position,payload FROM channel_events' :
      'SELECT message_id,position,payload FROM channel_log';
    resurrected+=Number(db.sql(`WITH latest AS (SELECT DISTINCT ON (message_id) message_id,payload FROM (${source}) s
      ORDER BY message_id,position DESC) SELECT count(*) FROM latest l JOIN messages m ON m.organization_id=${org}
      AND m.id=l.message_id WHERE m.deleted AND (l.payload->>'body'<>'' OR NOT (l.payload->>'deleted')::boolean)`));
  }
  return {missing,resurrected,retryPositions};
}
export async function replayFixture(db:Database,arm:Arm,positions:number,range:'creation'|'mixed'|'deleted') {
  const count=range==='creation' ? positions : Math.floor(positions*.9);
  await setup(db,'baseline',1,count);
  if(arm!=='baseline') db.sql(variantSchema(arm)+functions(arm,count).replace('CREATE FUNCTION apply_op','CREATE OR REPLACE FUNCTION apply_op'));
  if(range!=='creation' && arm!=='baseline') {
    // Nine creations and one change per ten positions, at every depth.
    db.sql(`UPDATE messages SET seq=seq+${positions}; UPDATE messages SET seq=seq-${positions}+(seq-${positions}-1)/9;`);
  }
  db.sql(backfill(arm));
  if(range!=='creation') {
    db.sql(`DO $$ DECLARE ch uuid:=fixture_id(1,0); r messages%ROWTYPE; p bigint; k text; BEGIN
      FOR i IN 1..${Math.floor(positions/10)} LOOP
        p:=i*10; k:=CASE WHEN ${range==='deleted' ? 'true' : 'i%3=0'} THEN 'Delete' WHEN i%3=1 THEN 'Edit' ELSE 'Move' END;
        UPDATE messages SET version=2,deleted=k='Delete',body=CASE WHEN k='Delete' THEN '' WHEN k='Edit' THEN 'edited replay body' ELSE body END,
          topic_id=CASE WHEN k='Move' THEN fixture_id(1,-2) ELSE topic_id END
          WHERE organization_id=${org} AND id=fixture_id(1,i*9-1) RETURNING * INTO r;
        ${record(arm,'k','r','p')}
      END LOOP;
    END $$;`);
  }
  const high=arm==='baseline' ? count : positions;
  db.sql(`UPDATE channel_message_sequences SET seq=${high}; ANALYZE;`);
  return high;
}
interface PlanNode { 'Node Type':string; 'Actual Rows':number; 'Actual Loops':number; 'Rows Removed by Filter'?:number;
  'Rows Removed by Index Recheck'?:number; 'Shared Hit Blocks'?:number; 'Shared Read Blocks'?:number; Plans?:PlanNode[] }
export function planSummary(plan:PlanNode) {
  const nodes:PlanNode[]=[];
  const walk=(n:PlanNode)=>{nodes.push(n);n.Plans?.forEach(walk);}; walk(plan);
  return {buffers:{hit:plan['Shared Hit Blocks']??0,read:plan['Shared Read Blocks']??0},
    scanRows:nodes.filter(n=>/Scan/.test(n['Node Type']) && !/CTE|Subquery/.test(n['Node Type']))
      .reduce((s,n)=>s+(n['Actual Rows']+(n['Rows Removed by Filter']??0)+(n['Rows Removed by Index Recheck']??0))*n['Actual Loops'],0),
    scanRowsDefinition:'sum of tuples returned/filtered/rechecked by physical scan nodes, including repeated index lookups'};
}
export async function replay(db:Database,arm:Arm,positions:number,range:'creation'|'mixed'|'deleted',out:string) {
  const high=await replayFixture(db,arm,positions,range);
  const rows:unknown[]=[];
  for(const depth of ['recent','deep']) for(const cache of ['cold','warm']) {
    const after=depth==='recent' ? high-50 : Math.floor(high/4);
    const sql=replaySQL(arm,after);
    if(cache==='cold') await db.cold(); else db.sql(sql);
    const plan=JSON.parse(db.sql(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`))[0];
    const entries=JSON.parse(db.sql(`SELECT json_agg(t) FROM (${sql}) t`)) as Entry[];
    reduce(entries,after);
    if(entries.length!==50) throw new Error('replay did not return 50 entries');
    rows.push({arm,positions,actualPositions:high,range,depth,cache,after,entries:entries.length,
      cacheScope:'PostgreSQL shared buffers only; filesystem/VM cache may be warm',
      executionMs:plan['Execution Time'],...planSummary(plan.Plan),plan});
  }
  // Retained historical bodies are a reported cost, never a policy verdict.
  const tables=arm==='events-snapshot' ? ['creation_snapshots','channel_events'] : arm==='log-snapshot' ? ['channel_log'] : [];
  const retained= tables.length ? Number(db.sql(`SELECT COALESCE(sum(octet_length(payload->>'body')),0) FROM
    (${tables.map(t=>`SELECT m.deleted,e.payload FROM ${t} e JOIN messages m ON m.organization_id=e.organization_id AND m.id=e.message_id`).join(' UNION ALL ')}) s
    WHERE deleted AND payload->>'body'<>''`)) : 0;
  const result={arm,positions,range,rows,retainedDeletedBodyBytes:retained,sizes:sizes(db),correctness:await correctness(db,arm)};
  writeFileSync(out,JSON.stringify(result,null,2)); return result;
}
export async function migration(db:Database,arm:Arm,messages:number,out:string) {
  await setup(db,'baseline',1,messages);
  db.sql(functions(arm,messages).replace('CREATE FUNCTION apply_op','CREATE FUNCTION writer_op'));
  const before=sizes(db),wal=lsn(db),started=performance.now();
  const migrator=new Session(db.name,'compare'),writer=new Session(db.name,'compare');
  try {
    await migrator.query(`BEGIN; SET LOCAL lock_timeout='10s'; LOCK TABLE messages IN SHARE MODE;`);
    const writing=writer.query(`BEGIN; SELECT clock_timestamp() AS writer_start \\gset
      SELECT writer_op(1,88888888,0,'concurrent writer',false,true);
      SELECT extract(epoch FROM clock_timestamp()-:'writer_start'::timestamptz)*1000; COMMIT;`);
    // Observe an actual lock wait before backfill, rather than infer it from latency.
    let waitStart='';
    for(let i=0;i<100;i++) {
      waitStart=db.sql(`SELECT min(waitstart)::text FROM pg_locks WHERE NOT granted AND locktype='relation'
        AND relation='messages'::regclass`);
      if(waitStart) break;
      await new Promise(r=>setTimeout(r,10));
    }
    if(!waitStart) throw new Error('concurrent writer did not block on migration');
    const backfillStarted=performance.now();
    const sql=variantSchema(arm)+backfill(arm)+functions(arm,messages).replace('CREATE FUNCTION apply_op','CREATE OR REPLACE FUNCTION apply_op');
    const committed=await migrator.query(sql+` SELECT clock_timestamp(); COMMIT;`);
    const backfillMs=performance.now()-backfillStarted;
    const writerOutput=await writing;
    const after=sizes(db);
    const result={arm,messages,strategy:'blocking SHARE lock, atomic schema/backfill/function cutover; coordinated candidate-aware concurrent writer; no online-migration claim',
      durationMs:performance.now()-started,backfillMs,walBytes:walDelta(db,wal),before,after,
      heapBytes:after.heap-before.heap,indexBytes:after.index-before.index,
      writerTransactionMs:Number(writerOutput.split('\n').at(-1)),
      lockWaitStart:waitStart,preCommitTimestamp:committed.split('\n').at(-1),
      blockingMs:Number(db.sql(`SELECT extract(epoch FROM ('${committed.split('\n').at(-1)}'::timestamptz-'${waitStart}'::timestamptz))*1000`)),
      blockingScope:'observed writer relation-lock wait to pre-COMMIT timestamp; writerTransactionMs also includes commit handoff',
      correctness:await correctness(db,arm)};
    writeFileSync(out,JSON.stringify(result,null,2)); return result;
  } finally {await migrator.close();await writer.close();}
}
