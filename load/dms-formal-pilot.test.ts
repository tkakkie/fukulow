import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { reportPilot } from './dms-formal-pilot.ts';
import { waitEdges, occupancyEdges } from './dms-formal-pool.ts';
import { execute } from './dms-formal-exec.ts';
import { scaledLoad } from './dms-formal-local.ts';

test('executor passes private seed environment explicitly without mutating the process environment',async()=>{
  const result=await execute({program:process.execPath,args:['-e',"process.stdout.write(process.env.DM_FORMAL_SEED||'missing')"],env:{...process.env,DM_FORMAL_SEED:'1'},timeout:1000});
  assert.equal(result.stdout,'1');assert.equal(process.env.DM_FORMAL_SEED,undefined);
});
for(const fault of ['none','errors','dropped','log','metrics','restart','image','resources','pool','missing-shard','comparison-input','offered'])test('pilot headroom/evidence diagnostic: '+fault,async t=>{
  const dir=mkdtempSync(tmpdir()+'/ohmac-pilot-test-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const from=1800000000000,to=from+10000,epoch=from-30000;
  const save=(name:string,value:unknown)=>writeFileSync(dir+'/'+name,JSON.stringify(value));
  const log=(name:string,manifest:string,content:string)=>{writeFileSync(dir+'/'+name,content);save(manifest,{bytes:Buffer.byteLength(content),complete:fault!=='log',startedAt:from-1000,endedAt:to+1000});};
  save('overhead-context.json',{pilot:fault!=='comparison-input',arm:'C',target:'local',label:'MAC-RELATIVE',epoch,sha:'sha',expectedImage:'image',window:{from,to},loadScale:'1/50',load:scaledLoad('1/50'),generator:{settings:{seconds:30}},generatorBefore:{k6:'k6'},generatorAfter:{k6:'k6'}});
  save('exits.json',Array.from({length:fault==='missing-shard'?10:11},(_,shard)=>({shard,code:0})));
  const pool=Array.from({length:12},(_,i)=>({timestamp:new Date(from-1000+i*1000).toISOString(),fields:{event:'pool_stats',version:1,coverage:'application_after_connect',uncovered_paths:'startup_connect,migration_commands',interval_ms:1000,sample_sequence:i+1,sample_elapsed_ms:1000,in_use:1,idle:31,waiting:0,...Object.fromEntries(['success','timeout','closed','io','database','other','cancelled'].map(key=>['acquire_'+key,key==='success'?i*100:0])),...Object.fromEntries(waitEdges.map(edge=>['wait_le_'+edge+'_us',i*100])),wait_count:i*100,...Object.fromEntries(occupancyEdges.map(edge=>['occupancy_le_'+edge,edge>=1?i+1:0])),occupancy_count:i+1}}));
  for(const role of ['app','db']) {
    log(role+'.log',role+'-log-retention.json',role==='app'?(fault==='pool'?'invalid':pool.map(p=>JSON.stringify(p)).join('\n')):'db log');
    const observation={image:fault==='image'?'other':'image',revision:'sha'};save('overhead-observation-'+role+'.json',{before:observation,after:observation});
    writeFileSync(dir+'/resources-'+role+'.jsonl',Array.from({length:fault==='resources'?9:10},(_,i)=>JSON.stringify({at:from+i*1000,intervalMs:1000,cpu:1,rssKiB:10,identity:{id:'same'}})).join('\n'));
  }
  for(let shard=0;shard<11;shard++) {
    const prefix='shard-'+shard+'/';mkdirSync(dir+'/'+prefix);log(prefix+'run.log',prefix+'run.log-retention.json','generator log');
    const dropped=fault==='dropped'?1:0;
    const expected=shard===10?{first:25,deep:25}:{send:fault==='offered'?99:100,resolve:1};
    const points=[{type:'Point',metric:'dm_errors',data:{value:fault==='errors'?1:0,time:new Date(from-1000).toISOString(),tags:{}}},{type:'Point',metric:'dropped_iterations',data:{value:dropped,time:new Date(to-500).toISOString(),tags:{}}},...Object.entries(expected).map(([shape,value])=>({type:'Point',metric:'dm_offered',data:{value,time:new Date(to-500).toISOString(),tags:{shape}}}))];
    writeFileSync(dir+'/'+prefix+'metrics.json',fault==='metrics'?'truncated':points.map(p=>JSON.stringify(p)).join('\n'));
    save(prefix+'summary.json',{state:{testRunDurationMs:50000},metrics:{dm_errors:{values:{count:fault==='errors'?1:0}},dropped_iterations:{values:{count:dropped}}}});
    save(prefix+'container.json',{image:'k6',startedAt:epoch-1000,createdAt:epoch-2000,restarts:fault==='restart'?1:0,exit:0});
  }
  const report=await reportPilot(dir);
  assert.equal(report.label,'MAC-RELATIVE');assert.equal(report.acceptance,false);assert.equal(report.pilot,true);
  assert.equal(report.sustained,fault==='none',report.reasons.join(';'));
  if(fault==='none'){assert.equal(report.zeroDroppedArrivals,true);assert.equal(report.zeroErrors,true);assert.equal(report.completeEvidence,true);}
});
