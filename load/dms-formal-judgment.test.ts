import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgets,judge,judgeLatencies,latencyClasses,type Latencies} from './dms-formal-judgment.ts';
import {deferredNames,scenarioAcceptance} from './dms-formal-scenarios.ts';
const latencies=(samples=10000):Latencies=>Object.fromEntries(Object.values(latencyClasses).map(([,key])=>[key,{samples,p95:1,p99:2}]));
const evidence=()=>Object.fromEntries(Object.keys(budgets).map(key=>[key,0]));
test('aggregate PASS cannot hide an Organization latency FAIL',()=>{
  const organizations=Array.from({length:10},()=>latencies());
  organizations[7]['dm_latency_ms:renew']={samples:10000,p95:151,p99:301};
  const latency=judgeLatencies(latencies(100000),organizations);
  assert.ok(latency.rows.filter(row=>row.organization==='aggregate').every(row=>row.status==='PASS'));
  const result=judge(evidence(),'formal','held200',latency);
  assert.equal(result.rows.find(row=>row.budget==='open.p95')?.status,'FAIL');
  assert.equal(result.rows.find(row=>row.budget==='open.p99')?.status,'FAIL');
  assert.equal(result.acceptance,false);
});
test('one Organization with insufficient samples requires additional measurement and never passes',()=>{
  const organizations=Array.from({length:10},()=>latencies());
  organizations[4]=latencies(9999);
  organizations[4]['dm_latency_ms:send']={samples:9999,p95:1000,p99:2000};
  const latency=judgeLatencies(latencies(100000),organizations);
  assert.equal(latency.organizationMinimum,10000);
  assert.equal(latency.minimumNeedsMaintainerConfirmation,true);
  assert.ok(latency.rows.filter(row=>row.organization==='4').every(row=>row.status==='NOT EVALUATED' && row.additionalMeasurement && row.samples===9999));
  const result=judge({...evidence(),'ack.p95':1000},'formal','main',latency);
  assert.equal(result.rows.find(row=>row.budget==='open.p95')?.status,'NOT EVALUATED');
  assert.equal(result.rows.find(row=>row.budget==='ack.p95')?.status,'NOT EVALUATED');
  assert.equal(result.acceptance,false);
});
test('aggregate minimum is 10000 and absent Organizations are NOT EVALUATED',()=>{
  const latency=judgeLatencies(latencies(9999),[]);
  assert.ok(latency.rows.every(row=>row.status==='NOT EVALUATED'));
  assert.equal(latency.rows.length,242);
});
test('acceptance requires both scenarios with three consecutive formal attempts and deferred evidence',()=>{
  const runs=(scenario:'main'|'held200')=>Array.from({length:3},(_,i)=>({scenario,mode:'formal' as const,attempt:i+1,acceptance:true}));
  const deferred=deferredNames.map(scenario=>({scenario,status:'PASS'}));
  assert.equal(scenarioAcceptance(runs('main'),deferred),false);
  assert.equal(scenarioAcceptance(runs('held200'),deferred),false);
  const both=[...runs('main'),...runs('held200')];
  assert.equal(scenarioAcceptance(both,deferred),true);
  assert.equal(scenarioAcceptance(both,[]),false);
  assert.equal(scenarioAcceptance(both.map(row=>({...row,acceptance:row.scenario==='main'})),deferred),false);
  assert.equal(scenarioAcceptance(both.map(row=>({...row,mode:'smoke'})),deferred),false);
  assert.equal(scenarioAcceptance(both.filter(row=>row.scenario==='main' || row.attempt!==2),deferred),false);
});
