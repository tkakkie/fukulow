import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { reportOverheadArm } from './dms-formal-overhead-results.ts';
import { overheadClasses } from './dms-formal-overhead.ts';
import { waitEdges, occupancyEdges } from './dms-formal-pool.ts';
const from=1800000000000,to=from+300000,sha='a'.repeat(40),image='sha256:'+'c'.repeat(64);
for(const fault of ['none','baseline','app-log','db-log','generator-log','generator-config','generator-restart','resources','coverage','pool_stats','restart','start-time','errors','dropped','snapshot','offered','toolchains','sha','image','class'])test('overhead reduction evidence: '+fault,async t=>{
  const directory=mkdtempSync('/private/tmp/overhead-results-');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const save=(name:string,value:unknown)=>writeFileSync(directory+'/'+name,JSON.stringify(value));
  const before={host:'machine',limits:{cpu:8,memory:4},toolchains:{node:'26.13.0',rust:'1.99.0',source:{sha}},sha,revision:sha,image,identity:{id:'app',startedAt:'same',restarts:0}};
  for(const role of ['app','db']) {
    const after=structuredClone(before);
    if(fault==='start-time')after.identity.startedAt='changed';
    if(fault==='toolchains')after.toolchains.node='changed';
    save('overhead-observation-'+role+'.json',{before:{...before,sha:fault==='sha'?'wrong':sha,image:fault==='image'?'wrong':image},after:{...after,sha:fault==='sha'?'wrong':sha,image:fault==='image'?'wrong':image}});
    if(fault!=='resources')writeFileSync(directory+'/resources-'+role+'.jsonl',Array.from({length:fault==='coverage'?296:300},(_,i)=>JSON.stringify({at:from+i*1000,intervalMs:1000,cpu:1,rssKiB:100,identity:{id:'app',startedAt:fault==='restart'&&i===150?'changed':'same',restarts:0}})).join('\n'));
  }
  const epoch=from-600000;
  const configurations=Array.from({length:11},(_,i)=>({DM_FORMAL:'1',DM_FORMAL_SCENARIO:'main',DM_EPOCH:String(epoch),DM_SECONDS:'605',DM_SEND_START:'300',DM_CONNECT_INTERVAL_MS:'30000',DM_SOCKETS:'1000',DM_SENDERS:'200',DM_RATE:i===10?'0':'200',DM_OPEN_RATE:i===10?'0':'2',DM_BROWSE_RATE:i===10?'100':'0',DM_BROWSER_ONLY:i===10?'1':'0',DM_LEDGER:'1',DM_SMOKE:'0'}));
  if(fault==='generator-config')configurations[0]!.DM_RATE='199';
  save('overhead-context.json',{epoch,generatorBefore:{k6:'k6'},generatorAfter:{k6:'k6'},arm:fault==='baseline'?'B':'C',sha,patchSha256:'a'.repeat(64),expectedImage:image,window:{from,to},generator:{host:'gen',configurations},toolchains:{node:'26.13.0',sha}});
  save('overhead-restore.json',{snapshot:'snapshot',expectedSnapshot:fault==='snapshot'?'different':'snapshot'});
  save('db-log-retention.json',{bytes:100,complete:fault!=='db-log',startedAt:from-1000,endedAt:to+1000});writeFileSync(directory+'/db.log','');
  save('app-log-retention.json',{complete:fault!=='app-log',startedAt:from-1000,endedAt:to+1000,bytes:100});
  const pool=Array.from({length:301},(_,i)=>({timestamp:new Date(from+i*1000).toISOString(),fields:{event:'pool_stats',version:1,coverage:'application_after_connect',uncovered_paths:'startup_connect,migration_commands',interval_ms:1000,sample_sequence:i+1,sample_elapsed_ms:1000,in_use:1,idle:31,waiting:0,...Object.fromEntries(['success','timeout','closed','io','database','other','cancelled'].map(key=>['acquire_'+key,key==='success'?i*100:0])),...Object.fromEntries(waitEdges.map(edge=>['wait_le_'+edge+'_us',i*100])),wait_count:i*100,...Object.fromEntries(occupancyEdges.map(edge=>['occupancy_le_'+edge,edge>=1?i+1:0])),occupancy_count:i+1}}));
  writeFileSync(directory+'/app.log',['pool_stats','baseline'].includes(fault)?'{}':pool.map(r=>JSON.stringify(r)).join('\n'));
  save('exits.json',Array.from({length:11},(_,shard)=>({shard,code:0})));
  for(let shard=0;shard<11;shard++) {
    mkdirSync(directory+'/shard-'+shard);
    save(`shard-${shard}/container.json`,{startedAt:epoch-1000,createdAt:epoch-2000,restarts:fault==='generator-restart'?1:0,exit:0,image:'k6',limits:{cpu:0,memory:0}});
    if(fault!=='generator-log')writeFileSync(directory+'/shard-'+shard+'/run.log','ledger');
    writeFileSync(directory+'/shard-'+shard+'/metrics.json','');
    save(`shard-${shard}/summary.json`,{state:{testRunDurationMs:1000000},metrics:{dm_errors:{values:{count:fault==='errors'?1:0}},dropped_iterations:{values:{count:fault==='dropped'?1:0}},iterations:{values:{count:1}}}});
  }
  const result=await reportOverheadArm(directory,async command=>{
    const dir=command.args.at(-1)!;
    const latencies=Object.fromEntries(Object.values(overheadClasses).map(([,key])=>[key,{samples:100,p95:1,p99:2}]));
    if(fault==='class')delete latencies['dm_latency_ms:renew'];
    const offeredWork={bucketMs:60000,buckets:Array.from({length:5},(_,i)=>({from:from+i*60000,to:from+(i+1)*60000,offered:{send:fault==='offered'?11998:12000,resolve:60,create:30,renew:30,first:3000,deep:3000},rounds:Array.from({length:1000},(_,member)=>[0,30000].map(offset=>({member,at:from+i*60000+offset,retained:member%2?50:0,lanes:['delta','coverage','browse','recovery',member%2?'held':'delta']}))).flat()}))};
    writeFileSync(dir+'/combined.json',JSON.stringify({latencies,fullIntervals:[{start:from,end:to}],offeredWork}));return {code:0,stdout:''};
  });
  if(['none','baseline'].includes(fault)){assert.deepEqual(result.reasons,[]);assert.equal(result.metrics['send.p95'],1);assert.equal(result.samples.send,1000);}
  else assert.ok(result.reasons.length,fault);
});
