import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import type { Runtime } from './dms-formal-run.ts';
import { execute } from './dms-formal-exec.ts';
import { temporary } from './dms-formal-run-fixture.ts';

test('common-window report retains outside-window errors and reconciles the full ledger',async t=>{
  const {reportAttempt}=await import('./dms-formal-results.ts');
  const path=temporary(t),directory=`${path}/attempt`;mkdirSync(directory);
  const epoch=1000000,from=epoch+60000;
  writeFileSync(`${directory}/window-starts.json`,JSON.stringify(Array(11).fill(epoch)));
  writeFileSync(`${directory}/exits.json`,JSON.stringify([{shard:0,code:99},{shard:10,code:0}]));
  const row={organization:'o',member:'m',channel:'c',client_message_id:'ab000000-0000-0000-0000-000000000000',id:'id',seq:1,started:from+1,completed:from+2,status:201,bodyBytes:1024};
  for(const shard of [0,10]) {
    mkdirSync(`${directory}/shard-${shard}`);
    writeFileSync(`${directory}/shard-${shard}/run.log`,shard===0?'DM_SEND '+JSON.stringify(row)+'\n':'');
    writeFileSync(`${directory}/shard-${shard}/summary.json`,JSON.stringify({metrics:{dm_duplicate_frames:{values:{count:0}},dm_errors:{values:{count:shard===0?1:0}},dropped_iterations:{values:{count:shard===0?1:0}}}}));
    const points=[{type:'Point',metric:'dm_latency_ms',data:{time:new Date(from-1).toISOString(),value:999999,tags:{shape:'send'}}},{type:'Point',metric:'dm_latency_ms',data:{time:new Date(from+1).toISOString(),value:10,tags:{shape:'send'}}}];
    writeFileSync(`${directory}/shard-${shard}/metrics.json`,points.map(point=>JSON.stringify(point)).join('\n')+'\n');
  }
  writeFileSync(`${directory}/durable.jsonl`,JSON.stringify(row)+'\n');
  const report=await reportAttempt(directory,'smoke',execute,'held200');
  assert.ok('reconciliation' in report,JSON.stringify(report));
  assert.equal(report.acceptance,false);assert.equal(report.label,'NON-ACCEPTANCE');
  assert.equal(report.scenario,'held200');
  assert.equal(JSON.parse(readFileSync(`${directory}/combined.json`,'utf8')).scenario,'held200');
  for(const organization of [...report.organizations,...report.organizationsCore])assert.equal((organization as {scenario:string}).scenario,'held200');
  assert.deepEqual(report.reconciliation,{missing:0,duplicates:0,unexpected:0});
  assert.equal(report.evidence.errors,1);assert.equal(report.evidence.dropped,1);
  assert.equal(report.evidence['ack.p99'],10);
  assert.equal(report.rows.find(row=>row.budget==='pool.p95')?.status,'NOT EVALUATED');
  assert.ok(readFileSync(`${directory}/judgment.md`,'utf8').includes('NOT EVALUATED'));
});
test('reportAttempt rejects absent, duplicate or malformed shards and never passes counters',async t=>{
  const {reportAttempt}=await import('./dms-formal-results.ts');
  for(const manifest of [[],[{shard:0,code:0},{shard:0,code:0}], [{shard:0,code:0},{shard:10,code:'0'}],null]) {
    const path=temporary(t);writeFileSync(path+'/exits.json',JSON.stringify(manifest));
    const report=await reportAttempt(path,'smoke',execute);
    assert.equal(report.acceptance,false);assert.ok(report.rows.every(row=>row.status==='NOT EVALUATED'));
  }
});
test('reportAttempt judges slow extension on the population supplying samples, sparse RSS is absent',async t=>{
  const {reportAttempt}=await import('./dms-formal-results.ts');
  const path=temporary(t),epoch=1000000;
  writeFileSync(path+'/window-starts.json',JSON.stringify(Array(11).fill(epoch)));
  writeFileSync(path+'/exits.json',JSON.stringify(Array.from({length:11},(_,shard)=>({shard,code:0}))));
  writeFileSync(path+'/durable.jsonl','');
  writeFileSync(path+'/resources-app.jsonl',JSON.stringify({at:epoch+600001,rssKiB:100,cpu:0,intervalMs:1000})+'\n');
  for(let shard=0;shard<11;shard++) {
    const dir=path+'/shard-'+shard;mkdirSync(dir);
    for(const file of ['run.log','metrics.json'])writeFileSync(dir+'/'+file,'');
    writeFileSync(dir+'/summary.json',JSON.stringify({state:{testRunDurationMs:2700000},metrics:{dm_errors:{values:{count:0}},dm_duplicate_frames:{values:{count:0}},iterations:{values:{count:1}}}}));
  }
  const reducer:Runtime['exec']=async command=>{
    const dest=command.args.at(-1)!;
    const extended=command.args.some(arg=>arg==='DM_WINDOW_TO='+String(epoch+2640000));
    const latencies=Object.fromEntries([...['resolve','create','renew','refresh','delta','coverage','send','first','deep'].map(s=>'dm_latency_ms:'+s),'dm_receipt_ms','dm_round_ms:attempts=5'].map(key=>[key,{samples:extended?10200:9000,p95:extended?500:10,p99:extended?700:10}]));
    writeFileSync(dest+'/combined.json',JSON.stringify({window:{from:epoch+600000,to:epoch+2400000},latencies,mix:{},peerMissing:0,pool:{samples:0},fullIntervals:[]}));
    return {code:0,stdout:''};
  };
  const report=await reportAttempt(path,'formal',reducer);
  assert.ok('core' in report,JSON.stringify(report));
  assert.equal(report.core.latencies['dm_latency_ms:create'].p99,10);
  assert.equal(report.evidence.sampleDeficit,0);
  assert.equal(report.evidence['open.p99'],700);
  assert.equal(report.rows.find(row=>row.budget==='open.p99')?.status,'FAIL');
  assert.equal(report.rows.find(row=>row.budget==='app.rssKiB')?.status,'NOT EVALUATED');
  // Missing required counters in an otherwise complete manifest must not pass.
  const bad=temporary(t);
  for(const file of ['exits.json','window-starts.json','durable.jsonl'])cpSync(path+'/'+file,bad+'/'+file);
  for(let i=0;i<11;i++)cpSync(path+'/shard-'+i,bad+'/shard-'+i,{recursive:true});
  writeFileSync(bad+'/shard-0/summary.json',JSON.stringify({metrics:{iterations:{values:{count:1}}}}));
  const malformed=await reportAttempt(bad,'formal',reducer);
  assert.ok(malformed.rows.every(row=>row.status==='NOT EVALUATED'));
  assert.ok('error' in malformed);assert.match(malformed.error,/required metric/);
});
test('reportAttempt rejects malformed raw points and missing files in an exact manifest',async t=>{
  const {reportAttempt}=await import('./dms-formal-results.ts');
  const path=temporary(t);
  writeFileSync(path+'/exits.json',JSON.stringify([{shard:0,code:0},{shard:10,code:0}]));
  let report=await reportAttempt(path,'smoke',execute);
  assert.ok('error' in report);assert.match(report.error,/Missing shard evidence/);
  writeFileSync(path+'/window-starts.json',JSON.stringify(Array(11).fill(1000000)));
  for(const shard of [0,10]) {
    mkdirSync(path+'/shard-'+shard);
    writeFileSync(path+'/shard-'+shard+'/metrics.json',JSON.stringify({type:'Point',metric:'dm_latency_ms',data:{time:'invalid',value:'fast',tags:{}}})+'\n');
    writeFileSync(path+'/shard-'+shard+'/run.log','');
    writeFileSync(path+'/shard-'+shard+'/summary.json','{}');
  }
  report=await reportAttempt(path,'smoke',execute);
  assert.ok(report.rows.every(row=>row.status==='NOT EVALUATED'));
});

test('Q4 reduction checks concurrent connection/send/open/O5 evidence and keeps browsing separate',async t=>{
  const {reportAttempt}=await import('./dms-formal-results.ts');
  const epoch=1000000,from=epoch+600000,to=epoch+2400000;
  for(const fault of ['none','connections','send-rate','open-rate','O5','outside-core','sparse-O5','missing-cadence','browsing-rate','browsing-split','browsing-99-rate','browsing-99-split','open-mix','nonconcurrent']) {
    const path=temporary(t);
    writeFileSync(path+'/window-starts.json',JSON.stringify(Array(11).fill(epoch)));
    writeFileSync(path+'/exits.json',JSON.stringify(Array.from({length:11},(_,shard)=>({shard,code:0}))));
    writeFileSync(path+'/durable.jsonl','');
    for(let shard=0;shard<11;shard++) {
      const dir=path+'/shard-'+shard;mkdirSync(dir);
      for(const file of ['run.log','metrics.json'])writeFileSync(dir+'/'+file,'');
      writeFileSync(dir+'/summary.json',JSON.stringify({state:{testRunDurationMs:2700000},metrics:{dm_errors:{values:{count:0}},dm_duplicate_frames:{values:{count:0}},iterations:{values:{count:1}}}}));
    }
    const reducer:Runtime['exec']=async command=>{
      const dest=command.args.at(-1)!,browser=dest.endsWith('/browsing-organization');
      const latencies=Object.fromEntries([...['resolve','create','renew','refresh','delta','coverage','send','first','deep'].map(s=>'dm_latency_ms:'+s),'dm_receipt_ms','dm_round_ms:attempts=5'].map(key=>[key,{samples:10000,p95:1,p99:2}]));
      const mixMembers=Object.fromEntries([0,50].flatMap(held=>['delta','coverage','browse','recovery','held','completed5'].map(lane=>[held+':'+lane,fault==='O5'?0:500])));
      const counters={'dm_offered:send':fault==='send-rate'?359999:360000,'dm_offered:resolve':1800,'dm_offered:create':900,'dm_offered:renew':fault==='open-rate'?899:900};
      const buckets=Array.from({length:30},(_,i)=>{
        const start=from+i*60000;
        const rounds=browser?[]:Array.from({length:1000},(_,member)=>[0,30000].map(offset=>({member,retained:member%2?50:0,at:start+offset,lanes:['delta','coverage','browse','recovery',...(member%2?['held']:['delta'])]}))).flat();
        if(fault==='sparse-O5')rounds.splice(i===0?1000:0);
        return {from:start,to:start+60000,offered:{send:12000,resolve:fault==='open-mix'?120:60,create:fault==='open-mix'?0:30,renew:fault==='open-mix'?0:30,first:fault==='browsing-rate'?1500:fault==='browsing-split'?6000:['browsing-99-rate','browsing-99-split'].includes(fault)?2970:3000,deep:fault==='browsing-rate'?1500:fault==='browsing-99-rate'?2970:fault==='browsing-99-split'?3030:3000},rounds};
      });
      // Whole-core totals remain sufficient; only the sample-time bucket is light.
      if(fault==='nonconcurrent') {buckets[0]!.offered.send=0;buckets[1]!.offered.send=24000;}
      const offeredWork=fault==='missing-cadence'?undefined:{bucketMs:60000,buckets};
      writeFileSync(dest+'/combined.json',JSON.stringify({scenario:'main',window:{from:browser && fault==='outside-core'?from-1:from,to},latencies,mixMembers,counters,offeredWork,peerMissing:0,fullIntervals:fault==='connections'?[]:[{start:from,end:to}]}));
      return {code:0,stdout:''};
    };
    const report=await reportAttempt(path,'formal',reducer);
    assert.ok('browsingLoad' in report,JSON.stringify(report));
    assert.equal(report.browsingLoad.fullMixedLoad,['none','outside-core'].includes(fault));
    assert.ok(report.latencyJudgment.browsingRows.every(row=>row.status===(fault==='none'?'PASS':'NOT EVALUATED')),fault);
    assert.ok(report.latencyJudgment.rows.filter(row=>row.organization!=='browsing').every(row=>!['first','deep'].includes(row.shape)));
    assert.equal(report.acceptance,false);
    assert.match(readFileSync(path+'/judgment.md','utf8'),/Separate browsing Organization/);
  }
});
