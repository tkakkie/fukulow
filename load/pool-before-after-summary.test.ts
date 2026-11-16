import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, validity, pairs, plan, scope, type Row, type Run, type Lane } from './pool-before-after-summary.ts';
const lane=(rate=250):Lane=>({rate,seconds:60,attempted:rate*60,accepted:rate*60,rejected429:0,rejected503:0,otherErrors:0,clientTimeouts:0,transportErrors:0,droppedIterations:0,p95:10,p99:20});
const row=():Row=>({rate:250,seconds:60,send:lane(),reader:lane(2),evidence:{complete:true,samples:60,maxSampleGapMs:1000,samplingErrors:0}});
const runs=():Run[]=>pairs().flatMap((arms,i)=>arms.map(arm=>({scope,pair:i+1,arm,scenario:'send',smoke:false,steps:[row()],reader:{...lane(2),seconds:284,attempted:568,accepted:568}})));
test('three alternating pairs and fixed schedule',()=>{
  assert.deepEqual(pairs(),[['B','A'],['A','B'],['B','A']]);
  assert.deepEqual(plan().map(s=>[s.rate,s.seconds,s.startSeconds]),[[250,60,0],[500,60,71],[1000,60,142],[2000,60,213]]);
  assert.deepEqual(plan(true).map(s=>[s.rate,s.seconds]),[[50,10]]);
});
test('fully measured pairs pass; missing, duplicate and smoke arms never pass',()=>{
  assert.equal(judge(runs(),'send',250).status,'PASS');
  assert.equal(judge(runs().slice(1),'send',250).status,'NOT EVALUATED');
  assert.equal(judge([...runs(),runs()[0]],'send',250).status,'NOT EVALUATED');
  const r=runs();r[0].smoke=true;assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
});
test('drops, short offers, limiter 429s and missing evidence invalidate',()=>{
  for(const edit of [(r:Row)=>{r.send.droppedIterations=1;},(r:Row)=>{r.send.attempted=14000;r.send.accepted=14000;},
    (r:Row)=>{r.send.rejected429=1;r.send.accepted--;},(r:Row)=>{r.evidence.samples=0;},(r:Row)=>{r.evidence.maxSampleGapMs=3000;},
    (r:Row)=>{r.evidence.samplingErrors=1;},(r:Row)=>{r.reader.droppedIterations=1;},(r:Row)=>{r.send.p95=null;},
    (r:Row)=>{r.send.otherErrors=1;},(r:Row)=>{r.send.clientTimeouts=NaN;}]) {
    const r=runs();edit(r[0].steps[0]);assert.ok(validity(r[0].steps[0]).length);assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
  }
});
test('95 percent tolerance is inclusive; explicit drops always invalidate',()=>{
  const r=row();r.send.attempted=r.send.accepted=14250;assert.deepEqual(validity(r),[]);
  r.send.attempted=r.send.accepted=14249;assert.ok(validity(r).length);
});
test('candidate must independently reach 99 percent and satisfy each latency percentile',()=>{
  for(const edit of [(r:Row)=>{r.send.accepted=14849;r.send.rejected503=151;},(r:Row)=>{r.send.p95=11.01;},
    (r:Row)=>{r.send.p99=22.01;},(r:Row)=>{r.reader.accepted--;r.reader.clientTimeouts++;}]) {
    const r=runs();edit(r.find(c=>c.arm==='A')!.steps[0]);assert.equal(judge(r,'send',250).status,'FAIL');
  }
  const r=runs();const a=r.find(c=>c.arm==='A')!.steps[0];a.send.accepted=14850;a.send.rejected503=150;a.send.p95=11;a.send.p99=22;
  assert.equal(judge(r,'send',250).status,'PASS');
});
test('baseline saturation is report-only, mixed saturation cannot pass',()=>{
  const r=runs();for(const b of r.filter(c=>c.arm==='B')) {b.steps[0].send.accepted=14000;b.steps[0].send.otherErrors=1000;}
  assert.equal(judge(r,'send',250).status,'REPORT ONLY');
  r[0].steps=[row()];assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
});
test('missing or mismatched mixed lanes and durations never pass',()=>{
  const r=runs();r[0].steps[0].send.seconds=59;assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
  const mixed=runs().map(r=>({...r,scenario:'mixed' as const}));assert.equal(judge(mixed,'mixed',250).status,'NOT EVALUATED');
  for(const run of mixed) {run.steps[0].reads=lane(500);run.steps[0].signin=lane(20);}
  assert.equal(judge(mixed,'mixed',250).status,'PASS');
  mixed[0].steps[0].signin!.droppedIterations++;assert.equal(judge(mixed,'mixed',250).status,'NOT EVALUATED');
});
test('other-Organization drain failures cannot pass and missing continuous evidence is not evaluated',()=>{
  const r=runs();r[0].reader.accepted--;r[0].reader.clientTimeouts++;
  assert.equal(judge(r,'send',250).status,'FAIL');
  r[0].reader.droppedIterations++;assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
});
test('omitted resource fields and full-run success latency remain missing evidence',()=>{
  const r=runs();delete (r[0].steps[0].evidence as Partial<Row['evidence']>).maxSampleGapMs;
  assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
  const other=runs();other[0].reader.p95=null;assert.equal(judge(other,'send',250).status,'NOT EVALUATED');
});
