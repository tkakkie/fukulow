import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Database, docker, dockerAsync, Session, lsn, sizes } from './database.ts';
import { statsSnapshot, walEnd, walDiagnostics, settleFixture } from './diagnostics.ts';
import { fixtureCondition } from './options.ts';
import { sameOperations, arrivalSchedule, logTable, snapshot, reduce, type Arm, type Conditions, type Sample, type Entry } from './model.ts';
import { org, member, commonSchema, variantSchema, functions, seedSQL, replaySQL, backfill, workloadSQL, record, expected, seedExpected } from './sql.ts';
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
  // pgbench --log: client txn latency_us script epoch us [schedule_lag_us with --rate]
  if(rows.some(r=>r.length!==6 && r.length!==7)) throw new Error('unexpected pgbench log shape');
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
  if(conditions.settleFixture)settleFixture(db);
  db.sql('CHECKPOINT;');
  const before=sizes(db),statsBefore=statsSnapshot(db),wal=lsn(db);
  const report=maximum ? await dockerAsync('exec',db.name,'pgbench','-n','-h','127.0.0.1','-U','postgres','-M','prepared',
    '-c',String(conditions.clients),'-j',String(Math.min(conditions.clients,4)),
    '-T',String(conditions.seconds),'--random-seed=160','--log',`--log-prefix=${prefix}`,
    ...(!maximum ? ['--rate',String(conditions.rate),'--latency-limit=1000'] : []),
    '-D','n=0','-f',script,'compare').catch(error=>{
      writeFileSync(out+'.failed.txt',String(error));
      writeFileSync(out+'.transactions.log',docker('exec',db.name,'sh','-c','cat /tmp/log-compare/txn.*'));
      throw error;
    }) : '';
  const scheduled=arrivalSchedule(conditions.rate,conditions.seconds,conditions.seed,scenario.mix);
  let fixed;
  if(!maximum) {
    writeFileSync(out+'.schedule.json',JSON.stringify(scheduled));
    const sessions=Array.from({length:conditions.clients},()=>new Session(db.name,'compare'));
    const queues=sessions.map(()=>Promise.resolve());const records:{n:number;op?:number;channel?:number;status:string;error?:string}[]=[];
    const latencies:number[]=[],scheduledLatencies:number[]=[];const offeredMix=[0,0,0,0];
    let offered=0,accepted=0,errors=0,late=0;const start=performance.now();
    try {
      // Timer callbacks enqueue every independently generated deadline, regardless
      // of response progress. Queues drain completely before measurement ends.
      await Promise.all(scheduled.operations.map((operation,i)=>new Promise<void>(resolve=>{
        setTimeout(()=>{
          offered++;offeredMix[operation.op]++;
          const client=i%sessions.length;
          queues[client]=queues[client].then(async()=>{
            const began=performance.now();
            const b=operation.op===1 ? String.fromCodePoint((scenario.body===17?65:131072)+operation.n%26)+Array.from(body).slice(1).join('') : body;
            try {
              await sessions[client].query(`BEGIN; SELECT set_config('fukulow.organization_id','${org.slice(1,37)}',true);
                SELECT apply_op(${1+i%scenario.channels},${operation.n},${operation.op},'${b}',${operation.n%10===1},${operation.n%5===0}); COMMIT;`);
              accepted++;const end=performance.now();latencies.push(end-began);scheduledLatencies.push(end-start-operation.at);
              if(end-start-operation.at>1000)late++;
              records.push({n:operation.n,op:operation.op,channel:1+i%scenario.channels,status:'completed'});
            } catch(error) {errors++;records.push({n:operation.n,status:'failed',error:String(error)});}
          }).then(resolve);
        },Math.max(0,operation.at-(performance.now()-start)));
      })));
      const elapsed=Math.max(conditions.seconds,(performance.now()-start)/1000);
      latencies.sort((a,b)=>a-b);scheduledLatencies.sort((a,b)=>a-b);
      fixed={offered,accepted,errors,dropped:0,late,elapsed,p50:percentile(latencies,.5),p95:percentile(latencies,.95),
        p99:percentile(latencies,.99),tps:accepted/elapsed,actualOfferedRate:offered/conditions.seconds,
        scheduledP95:percentile(scheduledLatencies,.95),latencyScope:'persistent psql BEGIN to COMMIT including host transport; scheduledP95 includes queue lag',
        schedule:{count:scheduled.operations.length,hash:scheduled.hash,mix:scheduled.mix},offeredMix,missingOffers:scheduled.operations.length-accepted-errors,
        accounting:{scheduled:scheduled.operations.length,completed:accepted,failed:errors,skipped:0,stillMissing:scheduled.operations.length-accepted-errors},
        generator:'independent seeded Poisson deadlines; persistent psql queues; all scheduled operations drained'};
      const committed=JSON.parse(db.sql("SELECT COALESCE(json_agg(operation ORDER BY operation),'[]') FROM (SELECT DISTINCT operation FROM expected_operations WHERE operation<>'seed') s")) as string[];
      const completed=records.filter(r=>r.status==='completed').map((r:any)=>r.channel+'/'+r.n).sort();
      if(!sameOperations(committed,completed)) throw new Error('committed operation identities differ from completed operations');
    } finally {for(const session of sessions) await session.close();}
    writeFileSync(out+'.operations.json',JSON.stringify(records));
  }
  const {walBytes,endLSN}=walEnd(db,wal),after=sizes(db);
  const diagnostics=walDiagnostics(db,statsBefore,wal,endLSN,out);
  const log=maximum ? docker('exec',db.name,'sh','-c','cat /tmp/log-compare/txn.*') : '';
  const parsed=fixed ?? {...parsePgbench(report,log,conditions.seconds),schedule:{count:0,hash:'completion-paced maximum; no independent offered rate',mix:[]},offeredMix:[],missingOffers:0,generator:'pgbench completion-paced maximum: diagnostic only, never a matched offered-load comparison'};
  if(maximum) {
    const committed=JSON.parse(db.sql("SELECT COALESCE(json_agg(operation ORDER BY operation),'[]') FROM (SELECT DISTINCT operation FROM expected_operations WHERE operation<>'seed') s")) as string[];
    const completed=log.trim().split('\n').filter(Boolean).map(row=>row.split(/\s+/)).filter(r=>!['failed','skipped'].includes(r[2])).map(r=>{
      const client=Number(r[0]),n=Number(r[1]);return (1+(client+n-1)%scenario.channels)+'/'+(client*1000000+n);
    }).sort();
    if(!sameOperations(committed,completed)) throw new Error('maximum committed operation identities mismatch');
  }
  const result={...parsed,arm,round,conditions,walBytes,walDiagnostics:diagnostics,walPerOp:walBytes/parsed.accepted,
    heapPerOp:(after.heap-before.heap)/parsed.accepted,indexPerOp:(after.index-before.index)/parsed.accepted,
    before,after,maximum,correctness:await correctness(db,arm)};
  writeFileSync(out+'.pgbench.txt',report); writeFileSync(out+'.transactions.log',log);
  writeFileSync(out+'.json',JSON.stringify(result,null,2));
  return result;
}
export function positionSQL(arm:Arm) {
  const creates=arm==='events-snapshot' ? 'SELECT organization_id,channel_id,position,message_id FROM creation_snapshots' :
    'SELECT organization_id,channel_id,seq AS position,id AS message_id FROM messages';
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
    SELECT * INTO r FROM messages WHERE organization_id=${org} AND id=fixture_id(1,1099999999);
    ${expected("'probe-delete'", "'Delete'", 'r.id', 'p', 'r.version+1', 'true', "''")}
    UPDATE messages SET body='',deleted=true,version=version+1 WHERE organization_id=${org}
      AND id=fixture_id(1,1099999999) RETURNING * INTO r;
    ${record(arm,"'Delete'",'r','p')} END $$;`);
  const before=counters();
  db.sql(`BEGIN; SELECT apply_op(1,99999999,0,'retry probe',true,false); COMMIT;
    BEGIN; SELECT apply_op(1,99999998,0,'rollback probe',false,true); ROLLBACK;`);
  const retryPositions=Number(counters())-Number(before);
  let missing=Number(db.sql(`WITH positions AS (${positionSQL(arm)}),counts AS (
      SELECT organization_id,channel_id,count(*) n,count(DISTINCT position) u,min(position) lo,max(position) hi
        FROM positions GROUP BY organization_id,channel_id)
      SELECT COALESCE(sum(abs(s.seq-COALESCE(c.n,0))+COALESCE(c.n-c.u,0)+abs(COALESCE(c.lo,1)-1)+abs(s.seq-COALESCE(c.hi,0))),0)
      FROM channel_message_sequences s LEFT JOIN counts c USING (organization_id,channel_id)`));
  const coverage=coverageSQL(arm);
  missing+=Number(db.sql(coverage));
  // Delete evidence comes from the independent ledger AND historical records,
  // never from the current deletion flag alone.
  const history=arm==='baseline' ? "SELECT message_id,ordinal AS position,kind,deleted,body FROM expected_operations" :
    `SELECT e.message_id,e.position,e.kind,${snapshot(arm)?"(payload->>'deleted')::boolean":"m.deleted"} deleted,
      ${snapshot(arm)?"payload->>'body'":"''"} body FROM ${logTable(arm)} e ${snapshot(arm)?'':`JOIN messages m ON m.organization_id=e.organization_id AND m.id=e.message_id`}`;
  const resurrected=Number(db.sql(`WITH history AS (${history}), deletes AS (
    SELECT message_id,min(position) position FROM (
      SELECT message_id,${arm==='baseline'?'ordinal':'position'} AS position FROM expected_operations WHERE kind='Delete'
      UNION ALL SELECT message_id,position FROM history WHERE kind='Delete') d GROUP BY message_id)
    SELECT (SELECT count(*) FROM deletes d LEFT JOIN messages m ON m.organization_id=${org} AND m.id=d.message_id
      WHERE m.id IS NULL OR NOT m.deleted OR m.body<>'') +
      (SELECT count(*) FROM deletes d JOIN history h USING(message_id)
        WHERE h.position>d.position AND (NOT h.deleted OR h.body<>'')) +
      (SELECT count(*) FROM messages WHERE deleted AND body<>'')`));
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
  db.sql('TRUNCATE expected_operations;'+seedExpected()+backfill(arm));
  if(range!=='creation') {
    db.sql(`DO $$ DECLARE ch uuid:=fixture_id(1,0); r messages%ROWTYPE; p bigint; k text; BEGIN
      FOR i IN 1..${Math.floor(positions/10)} LOOP
        p:=i*10; k:=CASE WHEN ${range==='deleted' ? 'true' : 'i%3=0'} THEN 'Delete' WHEN i%3=1 THEN 'Edit' ELSE 'Move' END;
        SELECT * INTO r FROM messages WHERE organization_id=${org} AND id=fixture_id(1,i*9-1);
        ${expected("'fixture/'||i", 'k', 'r.id', "p", '2', "k='Delete'", "CASE WHEN k='Delete' THEN '' WHEN k='Edit' THEN 'edited replay body' ELSE r.body END")}
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
export function coverageSQL(arm:Arm) {
  // Compare every replay-source identity/position, not just sampled windows.
  const expected=`SELECT organization_id,channel_id,position,message_id FROM expected_operations ${arm==='baseline'?"WHERE kind='Create'":''}`;
  const payloadMismatch=snapshot(arm) ? `+(SELECT count(*) FROM expected_operations e JOIN (
    ${arm==='events-snapshot'?"SELECT organization_id,channel_id,position,message_id,version,payload FROM creation_snapshots UNION ALL SELECT organization_id,channel_id,position,message_id,version,payload FROM channel_events":"SELECT organization_id,channel_id,position,message_id,version,payload FROM channel_log"}) a
    USING(organization_id,channel_id,position,message_id) WHERE e.version<>a.version OR e.deleted IS DISTINCT FROM (a.payload->>'deleted')::boolean
    OR e.body IS DISTINCT FROM a.payload->>'body')` : '';
  return `WITH actual AS (${positionSQL(arm)}), expected AS (${expected}), difference AS (
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL
    (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)), final AS (
    SELECT DISTINCT ON (organization_id,message_id) * FROM expected_operations ORDER BY organization_id,message_id,ordinal DESC)
    SELECT (SELECT count(*) FROM difference)+(SELECT count(*) FROM final e FULL JOIN messages m
      ON m.organization_id=e.organization_id AND m.id=e.message_id WHERE e.message_id IS NULL OR m.id IS NULL
      OR e.version<>m.version OR e.deleted<>m.deleted OR e.body<>m.body)${payloadMismatch}`;
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
export async function replay(db:Database,arm:Arm,positions:number,range:'creation'|'mixed'|'deleted',out:string,settle=false) {
  const high=await replayFixture(db,arm,positions,range);
  if(settle)settleFixture(db);
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
  let prior=new Map<string,Entry>(),cursor=0;
  while(cursor<high) {
    const page=JSON.parse(db.sql(`SELECT json_agg(t) FROM (${replaySQL(arm,cursor,10000)}) t`)) as Entry[]|null;
    if(!page?.length) throw new Error('full replay ended before expected watermark');
    const next=reduce(page,cursor,prior);cursor=next.cursor;prior=next.state;
  }
  // Retained historical bodies are a reported cost, never a policy verdict.
  const tables=arm==='events-snapshot' ? ['creation_snapshots','channel_events'] : arm==='log-snapshot' ? ['channel_log'] : [];
  const retained= tables.length ? Number(db.sql(`SELECT COALESCE(sum(octet_length(payload->>'body')),0) FROM
    (${tables.map(t=>`SELECT m.deleted,e.payload FROM ${t} e JOIN messages m ON m.organization_id=e.organization_id AND m.id=e.message_id`).join(' UNION ALL ')}) s
    WHERE deleted AND payload->>'body'<>''`)) : 0;
  const result={arm,positions,range,conditions:fixtureCondition(settle),rows,retainedDeletedBodyBytes:retained,sizes:sizes(db),correctness:await correctness(db,arm)};
  writeFileSync(out,JSON.stringify(result,null,2)); return result;
}
export async function migration(db:Database,arm:Arm,messages:number,out:string,settle=false) {
  await setup(db,'baseline',1,messages);
  db.sql(functions(arm,messages).replace('CREATE FUNCTION apply_op','CREATE FUNCTION writer_op'));
  if(settle)settleFixture(db);
  const before=sizes(db),statsBefore=statsSnapshot(db),wal=lsn(db),started=performance.now();
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
    const durationMs=performance.now()-started,{walBytes,endLSN}=walEnd(db,wal);
    const diagnostics=walDiagnostics(db,statsBefore,wal,endLSN,out.replace(/\.json$/,''));
    const result={arm,messages,conditions:fixtureCondition(settle),walDiagnostics:diagnostics,measurementScope:'WAL/storage include schema, backfill and concurrent writer; duration includes session/barrier observation and size query; backfillMs includes DDL/function replacement and COMMIT; no lock acquisition, rollback/retry or generation-changing cutover measurement',strategy:'blocking SHARE lock, atomic schema/backfill/function cutover; coordinated candidate-aware concurrent writer; no online-migration claim',
      durationMs,backfillMs,walBytes,before,after,
      heapBytes:after.heap-before.heap,indexBytes:after.index-before.index,
      writerTransactionMs:Number(writerOutput.split('\n').at(-1)),
      lockWaitStart:waitStart,preCommitTimestamp:committed.split('\n').at(-1),
      blockingMs:Number(db.sql(`SELECT extract(epoch FROM ('${committed.split('\n').at(-1)}'::timestamptz-'${waitStart}'::timestamptz))*1000`)),
      blockingScope:'observed writer relation-lock wait to pre-COMMIT timestamp; writerTransactionMs also includes commit handoff',
      correctness:await correctness(db,arm)};
    writeFileSync(out,JSON.stringify(result,null,2)); return result;
  } finally {await migrator.close();await writer.close();}
}
