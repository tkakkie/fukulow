import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgets,commonWindow,judge,judgeLatencies,latencyClasses,reconcile,type Latencies} from './dms-formal-judgment.ts';
import {deferredNames,scenarioAcceptance} from './dms-formal-scenarios.ts';
import { parseSend } from './dms-formal-results.ts';
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
  organizations[4]=latencies(999);
  organizations[4]['dm_latency_ms:send']={samples:999,p95:1000,p99:2000};
  const latency=judgeLatencies(latencies(100000),organizations);
  assert.equal(latency.organizationMinimum,1000);
  assert.equal(latency.minimumNeedsMaintainerConfirmation,false);
  assert.ok(latency.rows.filter(row=>row.organization==='4').every(row=>row.status==='NOT EVALUATED' && row.additionalMeasurement && row.samples===999));
  const result=judge({...evidence(),'ack.p95':1000},'formal','main',latency);
  assert.equal(result.rows.find(row=>row.budget==='open.p95')?.status,'NOT EVALUATED');
  assert.equal(result.rows.find(row=>row.budget==='ack.p95')?.status,'NOT EVALUATED');
  assert.equal(result.acceptance,false);
});
test('aggregate minimum is 10000 and absent Organizations are NOT EVALUATED',()=>{
  const latency=judgeLatencies(latencies(9999),[]);
  assert.ok(latency.rows.every(row=>row.status==='NOT EVALUATED'));
  assert.equal(latency.rows.length,202);
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

test('Q3 exact edge: 999 is NOT EVALUATED; 1000 is evaluated with budget-miss investigation',()=>{
  for(const samples of [999,1000]) {
    const organizations=Array.from({length:10},()=>latencies(samples));
    organizations[4]['dm_latency_ms:send']={samples,p95:101,p99:251};
    const judgment=judgeLatencies(latencies(10000),organizations);
    const rows=judgment.rows.filter(row=>row.organization==='4');
    assert.equal(rows.find(row=>row.shape==='send')?.status,samples===999?'NOT EVALUATED':'FAIL');
    assert.equal(rows.find(row=>row.shape==='resolve')?.status,samples===999?'NOT EVALUATED':'PASS');
    assert.ok(rows.filter(row=>row.shape==='send').every(row=>row.additionalMeasurement && row.reason));
  }
});
const browsing=(samples=10000)=>({latencies:{'dm_latency_ms:first':{samples,p95:100,p99:250},'dm_latency_ms:deep':{samples,p95:100,p99:250}},window:{from:10,to:20},core:{from:10,to:20},fullMixedLoad:true,reasons:[] as string[]});
test('Q4 separate browsing Organization passes exact sample/budget edges inside full-load core',()=>{
  const result=judgeLatencies(latencies(),Array.from({length:10},()=>latencies(1000)),browsing());
  assert.ok(result.rows.every(row=>row.status==='PASS'));
  assert.equal(result.browsingRows.length,4);
  assert.ok(result.rows.filter(row=>row.organization!=='browsing').every(row=>!['first','deep'].includes(row.shape)));
});
for(const [name,change] of [
  ['below sample minimum',(b:ReturnType<typeof browsing>)=>b.latencies['dm_latency_ms:deep'].samples=9999],
  ['before core',(b:ReturnType<typeof browsing>)=>b.window.from=9],
  ['after core',(b:ReturnType<typeof browsing>)=>b.window.to=21],
  ['isolated/lighter load',(b:ReturnType<typeof browsing>)=>b.fullMixedLoad=false],
  ['missing rates',(b:ReturnType<typeof browsing>)=>b.reasons.push('Missing offered sends or opens')],
] as const)test('Q4 NOT EVALUATED: '+name,()=>{
  const b=browsing();change(b);
  const result=judgeLatencies(latencies(),Array.from({length:10},()=>latencies(1000)),b);
  assert.ok(result.browsingRows.some(row=>row.status==='NOT EVALUATED' && row.additionalMeasurement && row.reason));
  assert.equal(judge(evidence(),'formal','main',result).acceptance,false);
});
test('Q4 browsing FAIL cannot be hidden by ten-Organization page PASS',()=>{
  const b=browsing();b.latencies['dm_latency_ms:deep'].p99=251;
  const result=judgeLatencies(latencies(),Array.from({length:10},()=>latencies(1000)),b);
  assert.equal(judge(evidence(),'formal','main',result).rows.find(row=>row.budget==='page.p99')?.status,'FAIL');
});

test('every missing or failing budget prevents acceptance, including smoke with perfect evidence',()=>{
  const evidence=Object.fromEntries(Object.keys(budgets).map(key=>[key,0]));
  assert.equal(judge(evidence,'formal').acceptance,true);
  for(const [key,limit] of Object.entries(budgets)) {
    assert.equal(judge({...evidence,[key]:limit+1},'formal').acceptance,false,key);
    assert.equal(judge({...evidence,[key]:undefined},'formal').acceptance,false,key);
    assert.equal(judge({...evidence,[key]:NaN},'formal').rows.find(row=>row.budget===key)?.status,'NOT EVALUATED');
  }
  assert.equal(judge(evidence,'smoke').acceptance,false);assert.equal(judge(evidence,'smoke').label,'NON-ACCEPTANCE');
});
test('common window is minute 10–40, never an artificially shortened intersection',()=>{
  const starts=Array<number>(11).fill(100000);
  assert.deepEqual(commonWindow(starts,'formal'),{from:700000,to:2500000});
  starts[10]++;assert.throws(()=>commonWindow(starts,'formal'),/exact scheduled epoch/);
  assert.throws(()=>commonWindow(starts.slice(1),'formal'),/eleven/);
});
test('ledger catches missing, duplicate, unoffered and mismatched durable results',()=>{
  const row={organization:'o',member:'m',channel:'c',client_message_id:'client',id:'message',seq:1};
  assert.deepEqual(reconcile([row],[row]),{missing:0,duplicates:0,unexpected:0});
  assert.equal(reconcile([row],[]).missing,1);
  assert.equal(reconcile([row],[row,row]).duplicates,1);
  assert.equal(reconcile([row,row],[row]).duplicates,1);
  assert.equal(reconcile([],[row]).unexpected,1);
  assert.equal(reconcile([row],[{...row,seq:2}]).missing,1);
  assert.equal(parseSend('unrelated'),undefined);
  assert.equal(parseSend('DM_SEND '+JSON.stringify(row))?.id,'message');
  assert.throws(()=>parseSend('DM_SEND broken'));
});
