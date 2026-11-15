import test from 'node:test';
import assert from 'node:assert/strict';
import { overheadOrder, overheadMetrics, overheadClasses, overheadConditionKeys, judgeOverhead, type OverheadArm } from './dms-formal-overhead.ts';
import { overheadResources } from './dms-formal-overhead-results.ts';
function arms():OverheadArm[] {return overheadOrder.map(arm=>({arm,metrics:Object.fromEntries(overheadMetrics.map(m=>[m,100])),samples:Object.fromEntries(Object.keys(overheadClasses).map(c=>[c,1500])),conditions:Object.fromEntries(overheadConditionKeys.map(k=>[k,'same'])),imageDigest:'sha256:'+(arm==='B'?'b':'c').repeat(64),reasons:[]}));}
test('overhead PASS reports every metric, pair, mean and spread with class counts',()=>{
  const report=judgeOverhead(arms());assert.equal(report.status,'PASS');assert.equal(report.acceptance,true);
  assert.equal(report.rows.length,36);assert.equal(report.arms[0]!.samples.renew,1500);
  for(const row of report.rows){assert.equal(row.pairs.length,3);assert.equal(row.meanPercent,0);assert.deepEqual(row.baselineSpread,{min:100,max:100,range:0});}
});
for(const metric of overheadMetrics)for(const kind of ['pair','mean','edge'] as const)test(`overhead ${metric}: ${kind}`,()=>{
  const rows=arms();rows.forEach((a,i)=>{if(a.arm==='C' && (kind!=='pair'||i===1))a.metrics[metric]=kind==='edge'?110:111;});
  const result=judgeOverhead(rows),row=result.rows.find(r=>r.metric===metric)!;
  assert.equal(result.status,kind==='edge'?'PASS':'FAIL');
  assert.equal(row.pairsPassed,kind==='edge');assert.equal(row.meanPassed,kind!=='mean');
  assert.equal(row.meanPercent,kind==='pair'?11/3:kind==='edge'?10:11);
});
test('baseline noise above 10% disqualifies its metric; exactly 10% remains eligible',()=>{
  const rows=arms();rows[3]!.metrics['app.cpuMean']=110;
  assert.equal(judgeOverhead(rows).status,'PASS');
  rows[3]!.metrics['app.cpuMean']=110.01;
  const report=judgeOverhead(rows);assert.equal(report.status,'NOT EVALUATED');assert.equal(report.acceptance,false);
  const row=report.rows.find(r=>r.metric==='app.cpuMean')!;assert.equal(row.status,'NOT EVALUATED');assert.equal(row.baselineSpread.range,10.010000000000005);
});
for(const condition of overheadConditionKeys)for(const fault of ['missing','mismatch'])test(`invalid overhead ${condition}: ${fault}`,()=>{
  const rows=arms();if(fault==='missing')delete rows[1]!.conditions[condition];else rows[1]!.conditions[condition]='changed';
  assert.equal(judgeOverhead(rows).status,'NOT EVALUATED');
});
for(const reason of ['Missing generator log','Missing/incomplete app logs','Resource coverage below 99% one-second samples','Missing pool_stats lines','Container restart','Changed start time','Missing/nonzero dm_errors','Missing/nonzero dropped_iterations','Missing offered-work evidence','Missing O5 cadence','Changed generator configuration','Changed toolchain'])test('invalid arm disqualifies whole comparison: '+reason,()=>{
  const rows=arms();rows[2]!.reasons.push(reason);rows[1]!.metrics['app.cpuMean']=200;
  const report=judgeOverhead(rows);assert.equal(report.status,'NOT EVALUATED');assert.ok(report.rows.every(r=>r.status==='NOT EVALUATED'));
});
test('missing values, zero baselines, mismatched images and incomplete arms never pass',()=>{
  for(const change of [(r:OverheadArm[])=>r.pop(),(r:OverheadArm[])=>r[0]!.metrics['app.cpuMean']=0,(r:OverheadArm[])=>delete r[1]!.metrics['send.p99'],(r:OverheadArm[])=>r[1]!.imageDigest='sha256:'+'d'.repeat(64),(r:OverheadArm[])=>delete r[0]!.samples.renew]) {
    const rows=arms();change(rows);assert.equal(judgeOverhead(rows).status,'NOT EVALUATED');
  }
  assert.equal(judgeOverhead([]).status,'NOT EVALUATED');
});
test('three alternating pairs are fixed B/C, C/B, B/C',()=>{
  assert.deepEqual(overheadOrder,['B','C','C','B','B','C']);
  const rows=arms();[rows[2],rows[3]]=[rows[3]!,rows[2]!];assert.equal(judgeOverhead(rows).status,'NOT EVALUATED');
});
test('resources require 99% distinct one-second CPU and RSS bins and stable container identity',()=>{
  const rows=Array.from({length:300},(_,i)=>({at:i*1000,intervalMs:1000,cpu:2,rssKiB:100+i,identity:{id:'app',startedAt:'same',restarts:0}}));
  const result=overheadResources(rows,0,300000);assert.deepEqual(result.reasons,[]);assert.equal(result.metrics['app.cpuMean'],2);assert.equal(result.metrics['app.rssKiB'],399);
  assert.deepEqual(overheadResources(rows.slice(3),0,300000).reasons,[]);
  assert.match(overheadResources(rows.slice(4),0,300000).reasons.join(),/99%/);
  const duplicate=rows.map(r=>({...r,at:0}));assert.match(overheadResources(duplicate,0,300000).reasons.join(),/99%/);
  for(const field of ['startedAt','id','restarts'] as const){const changed=structuredClone(rows);Object.assign(changed[150]!.identity,{[field]:'changed'});assert.match(overheadResources(changed,0,300000).reasons.join(),/restart/);}
  assert.match(overheadResources(rows.map(r=>({...r,cpu:NaN})),0,300000).reasons.join(),/99%/);
  assert.match(overheadResources(rows.map(r=>({...r,rssKiB:NaN})),0,300000).reasons.join(),/99%/);
});
test('a finite zero candidate is an improvement; a zero baseline is not judgeable',()=>{
  const rows=arms();rows[1]!.metrics['send.p95']=0;
  const result=judgeOverhead(rows);assert.equal(result.status,'PASS');assert.equal(result.rows.find(r=>r.metric==='send.p95')!.pairs[0]!.regressionPercent,-100);
});
test('decimal 10% edges use exact comparison without epsilon tolerance',()=>{
  const rows=arms();rows.forEach(a=>a.metrics['app.cpuMean']=a.arm==='B'?7:7.7);
  assert.equal(judgeOverhead(rows).status,'PASS');
  rows[1]!.metrics['app.cpuMean']=7.700000000000001;
  assert.equal(judgeOverhead(rows).status,'FAIL');
});
