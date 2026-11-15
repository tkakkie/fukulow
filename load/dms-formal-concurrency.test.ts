import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { concurrentBrowsingReasons, type OfferedBucket } from './dms-formal-concurrency.ts';
import { retainedAssignment } from './dms-formal-mix.ts';

function fixture(scenario:'main'|'held200'='main') {
  const core={from:1000000,to:1120000};
  const buckets:OfferedBucket[]=Array.from({length:2},(_,i)=>{
    const from=core.from+i*60000;
    return {from,to:from+60000,offered:{send:12000,resolve:60,create:30,renew:30,first:3000,deep:3000},rounds:Array.from({length:1000},(_,member)=>{
      const retained=retainedAssignment(member,scenario);
      return [0,30000].map(offset=>({member,retained,at:from+offset,lanes:['delta','coverage','browse','recovery',retained?'held':'delta']}));
    }).flat()};
  });
  const summary={offeredWork:{bucketMs:60000,buckets},fullIntervals:[{start:core.from,end:core.to}]};
  return {core,summary,check:()=>concurrentBrowsingReasons(core,Array(10).fill(summary),summary,scenario)};
}
test('time buckets accept full main and held200 offered work',()=>{
  for(const scenario of ['main','held200'] as const)assert.deepEqual(fixture(scenario).check(),[]);
});
for(const kind of ['send','resolve','create','renew','first','deep']) {
  test(kind+': one-offer boundary deviation reconciled over core passes',()=>{
    const {summary,check}=fixture();
    summary.offeredWork.buckets[0]!.offered[kind]!--;
    summary.offeredWork.buckets[1]!.offered[kind]!++;
    assert.deepEqual(check(),[]);
  });
  test(kind+': one missing offer net over core is rejected',()=>{
    const {summary,check}=fixture();
    summary.offeredWork.buckets[0]!.offered[kind]!--;
    assert.ok(check().some(r=>r.includes('whole-core offered '+kind+' below full adopted target')));
  });
  test(kind+': two-offer bucket deviation is rejected even if reconciled',()=>{
    const {summary,check}=fixture();
    summary.offeredWork.buckets[0]!.offered[kind]!-=2;
    summary.offeredWork.buckets[1]!.offered[kind]!+=2;
    assert.ok(check().some(r=>r.includes('offered '+kind+' outside one-offer')));
  });
}
test('whole-core browsing mix permits only the alternation remainder',()=>{
  const {summary,check}=fixture();
  summary.offeredWork.buckets[0]!.offered.first!++;
  assert.deepEqual(check(),[]);
  summary.offeredWork.buckets[1]!.offered.first!++;
  assert.match(check().join(';'),/beyond alternation remainder/);
});
test('O5 uses actual jittered Member schedule without a nominal round percentage',()=>{
  const {core,summary,check}=fixture();
  for(const b of summary.offeredWork.buckets)b.rounds=b.rounds.filter(r=>r.at===b.from);
  const templates=summary.offeredWork.buckets[0]!.rounds;
  const rounds=[33000,66000,99000].flatMap(offset=>templates.map(r=>({...r,at:core.from+offset})));
  for(const b of summary.offeredWork.buckets)b.rounds=rounds.filter(r=>r.at>=b.from && r.at<b.to);
  assert.deepEqual(check(),[]);
});
test('O5 jitter permits 33 seconds but rejects a larger cross-bucket gap',()=>{
  const {summary,check}=fixture();
  const rounds=summary.offeredWork.buckets[1]!.rounds;
  rounds.filter(r=>r.member===0).forEach(r=>r.at+=3000);
  assert.deepEqual(check(),[]);
  rounds.find(r=>r.member===0)!.at++;
  assert.match(check().join(';'),/gap exceeds 33 seconds/);
});
test('O5 lane/attempt evidence cannot be replaced by round cardinalities',()=>{
  const {summary,check}=fixture();
  summary.offeredWork.buckets[0]!.rounds[0]!.lanes.pop();
  assert.match(check().join(';'),/missing O5 cadence or adopted lanes/);
});
test('missing bucket or per-Member cadence cannot pass',()=>{
  const {summary,check}=fixture();
  summary.offeredWork.buckets[0]!.rounds=summary.offeredWork.buckets[0]!.rounds.filter(r=>r.member!==0);
  assert.match(check().join(';'),/Member 0 missing O5/);
  summary.offeredWork.buckets.pop();
  assert.match(check().join(';'),/missing\/malformed time-resolved/);
});
test('summary retains timestamped offers and per-Member O5 starts and lanes, including late completion',t=>{
  const dir=mkdtempSync(tmpdir()+'/dm-offered-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(dir+'/shard-0');
  const from=1000000,to=1120000;
  const point=(metric:string,at:number,tags:Record<string,string>,value=1)=>JSON.stringify({type:'Point',metric,data:{time:new Date(at).toISOString(),value,tags}});
  const lines=[point('dm_connections',from-100,{},1000),point('dm_connections',to+100,{},0)];
  for(const [offset,shape] of [[0,'send'],[1,'resolve'],[2,'create'],[3,'renew'],[60000,'first'],[60001,'deep']] as const)lines.push(point('dm_offered',from+offset,{shape}));
  const tags={member:'7',retained:'50'};
  lines.push(point('dm_o5_round_start_ms',to-1,{...tags,lane:'start'},to-1));
  for(const lane of ['delta','coverage','browse','recovery','held'])lines.push(point('dm_o5_round_start_ms',to+100,{...tags,lane},to-1));
  writeFileSync(dir+'/shard-0/metrics.json',lines.join('\n')+'\n');
  const result=spawnSync(process.execPath,[import.meta.dirname+'/dms-summary.ts',dir],{env:{...process.env,DM_SHARDS:'1',DM_WINDOW_FROM:String(from),DM_WINDOW_TO:String(to),DM_SOCKETS:'1000'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const summary=JSON.parse(readFileSync(dir+'/combined.json','utf8'));
  assert.deepEqual(summary.fullIntervals,[{start:from-100,end:to+100}]);
  assert.deepEqual(summary.offeredWork.buckets.map((b:OfferedBucket)=>b.offered),[{send:1,resolve:1,create:1,renew:1},{first:1,deep:1}]);
  assert.deepEqual(summary.offeredWork.buckets[1].rounds,[{member:7,retained:50,at:to-1,lanes:['delta','coverage','browse','recovery','held']}]);
});
