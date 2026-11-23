import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash } from './manifest.ts';
import { criteria, judge, judgeB1, summarize } from './summarize.ts';
import { b1RoleFacts, b1RlsFacts } from './b1.ts';
import { denialCases, probe } from './definer.ts';

for (const mode of ['success','smoke-success','smoke-refused','smoke-mixed','tampered','missing-status','failed-cleanup','invalid-status','wrong-status-hash','missing-completed','missing-finished','wrong-completion-hash']) {
  test(`summary requires verified frozen completion: ${mode}`,t=>{
    const dir = mkdtempSync(join(tmpdir(),'search-summary-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const smoke = mode.startsWith('smoke-');
    const runKind = smoke?'smoke':'evaluation';
    const frozen = {performance:{clients:5},smoke:{performance:{rounds:1}}};
    const manifestHash = hash(JSON.stringify(frozen));
    if (mode==='tampered') frozen.performance.clients=99;
    const save = (name: string,value: unknown)=>writeFileSync(join(dir,name+'.json'),JSON.stringify(value));
    save('manifest',{sha256:manifestHash,frozen,runKind});
    const runs = (smoke?[1]:[1,2,3]).flatMap(round=>['none','trgm','bigm','pgroonga'].map(engine=>({manifestHash,runKind:mode==='smoke-mixed'?'evaluation':runKind,round,engine,
      buildMs:1,relationBytes:1,physicalDeltaBytes:1,walBytesPerInsert:1,write:{p50:1,p95:1,p99:1,tps:1}})));
    save('results',runs);
    if(mode!=='missing-status') save('run-status',{manifestHash:mode==='wrong-status-hash'?'wrong':manifestHash,
      runKind,valid:mode!=='invalid-status',cleanupVerified:mode!=='failed-cleanup',exitCode:0});
    for (const name of ['completed','finished']) {
      if(mode!==`missing-${name}`)save(name,{manifestHash:mode==='wrong-completion-hash'?'wrong':manifestHash,runKind,results:smoke?4:12});
    }
    if(mode==='success' || mode==='smoke-success') {
      summarize(dir,smoke?'smoke':'evaluation');
      const summary = JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'));
      if (smoke) {
        assert.equal(summary.label,'SMOKE / NON-EVALUATION');
        assert.equal(summary.evaluation,false);
        assert.equal(summary.formal,false);
        assert.equal(summary.results.length,4);
        assert.throws(()=>summarize(dir),/cannot be published as evaluation/);
      } else assert.equal(summary.length,4);
    } else {
      assert.throws(()=>summarize(dir,mode==='smoke-mixed'?'smoke':'evaluation'));
      assert.equal(existsSync(join(dir,'summary.json')),false);
    }
  });
}

test('judgement: 500 ms p95 in every round, index use, completeness and denials; missing evidence never passes',()=>{
  const query = (id: string, value: string) => ({id,raw:` ${value}`,value,scalars:[...value].length});
  const queries = [query('ja2-rare','麒麟'),query('ja3-rare','特殊照合'),query('ja1-frequent','開'),query('mixed','照合z9')];
  const names = denialCases.map(c=>c.name);
  const checks = denialCases.flatMap(c=>[false,true].map(forced=>({case:c.name,forced,found:c.expect.map(probe),expected:c.expect.map(probe)})));
  const definer = {cases:names,results:['none','trgm','bigm','pgroonga'].map(engine=>({engine,cases:names.length*2,checks}))};
  const ids = queries.map(q=>[q.id,q.raw] as [string,string]);
  const plans = (index: string[], seq = false) => queries.map(q=>({query:q.id,searchIndex:index.includes(q.id),seqScanMessages:seq}));
  const runs = (p95: number, planList = plans(['ja2-rare','ja3-rare','mixed']), equal = true) => ['trgm','bigm','pgroonga'].flatMap(engine=>[1,2,3].map(round=>({
    manifestHash:'h',round,engine,buildMs:1,relationBytes:1,physicalDeltaBytes:1,walBytesPerInsert:1,write:{query:'w',n:1,p50:1,p95:1,p99:1,tps:1},
    latencies:queries.map(q=>({query:q.id,n:100,p50:1,p95:round===2&&engine==='bigm'?p95:10,p99:p95,tps:1})),
    ...(round===1?{plans:planList,completeness:{equal,cases:queries.length*8}}:{})})));
  const by = (r: ReturnType<typeof judge>, e: string) => r.find(x=>x.engine===e)!;
  const pass = judge(runs(500),queries,definer,ids);
  assert.deepEqual(pass.map(r=>r.status),['PASS','PASS','PASS']);
  // trgm needs 3 scalars, so ja2-rare without search_body is not required for trgm.
  assert.deepEqual(by(pass,'trgm').requiredSearchIndex,['ja3-rare','mixed']);
  assert.equal(by(judge(runs(500.1),queries,definer,ids),'bigm').latency,'FAIL');
  assert.equal(by(judge(runs(10,plans(['ja3-rare','mixed'])),queries,definer,ids),'bigm').index,'FAIL');
  assert.equal(by(judge(runs(10,plans(['ja3-rare','mixed'])),queries,definer,ids),'trgm').index,'PASS');
  assert.equal(by(judge(runs(10,plans(['ja2-rare','ja3-rare','mixed'],true)),queries,definer,ids),'pgroonga').index,'FAIL');
  assert.equal(by(judge(runs(10,undefined,false),queries,definer,ids),'trgm').completeness,'FAIL');
  assert.equal(by(judge(runs(10).map(r=>r.round===1?{...r,completeness:{equal:true,cases:3}}:r),queries,definer,ids),'trgm').completeness,'NOT EVALUATED');
  assert.equal(by(judge(runs(10).map(r=>r.round===1?{...r,completeness:undefined}:r),queries,definer,ids),'trgm').completeness,'NOT EVALUATED');
  // A plan without boolean flags, or a query list with no gated rare query, is not evidence.
  assert.equal(by(judge(runs(10).map(r=>r.round===1?{...r,plans:r.plans!.map(p=>({query:p.query}) as never)}:r),queries,definer,ids),'trgm').index,'NOT EVALUATED');
  const common = queries.filter(q=>q.id==='ja1-frequent');
  assert.equal(by(judge(runs(10),common,definer,ids),'trgm').index,'NOT EVALUATED');
  // A measured failure is reported as FAIL even when another part lacks evidence.
  assert.equal(by(judge(runs(500.1),queries,undefined,ids),'bigm').status,'FAIL');
  assert.equal(by(judge(runs(10),queries,undefined,ids),'trgm').status,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),undefined,definer,ids),'trgm').status,'NOT EVALUATED');
  assert.equal(by(judge(runs(10).filter(r=>r.round!==3),queries,definer,ids),'trgm').latency,'NOT EVALUATED');
  // Every query in every round needs exactly the frozen 100 samples; a short (or padded) sample is not evidence.
  const sampled = (n: unknown) => runs(10).map(r=>r.engine==='trgm'&&r.round===3?{...r,latencies:r.latencies.map((l,i)=>i===0?{...l,n:n as number}:l)}:r);
  for (const n of [99,1,0,101,'100',undefined]) assert.equal(by(judge(sampled(n),queries,definer,ids),'trgm').latency,'NOT EVALUATED',String(n));
  assert.equal(by(judge(sampled(99),queries,definer,ids),'bigm').latency,'PASS');
  assert.equal(by(judge(sampled(100),queries,definer,ids),'trgm').latency,'PASS');
  // An explicitly listed rare query without a "rare" name is still gated.
  assert.equal(by(judge(runs(10,plans(['ja2-rare','ja3-rare'])),queries,definer,ids),'trgm').index,'FAIL');
  // A query list that is not the frozen manifest's, in full and in order, is not evidence.
  assert.equal(by(judge(runs(10),queries.slice(0,3),definer,ids),'trgm').status,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),[...queries].reverse(),definer,ids),'trgm').latency,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,definer,ids),'trgm').frozenQueries,true);
  // Denials need every case, unforced and forced, once per engine with the frozen expectation; a count alone is not evidence.
  const withChecks = (f: (c: typeof checks) => unknown[]) => ({cases:names,results:definer.results.map(r=>r.engine==='bigm'?{...r,checks:f(r.checks) as typeof checks}:r)});
  assert.equal(by(judge(runs(10),queries,withChecks(c=>c.slice(1)),ids),'trgm').denials,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,withChecks(c=>[...c.slice(1),c[2]]),ids),'trgm').denials,'NOT EVALUATED');
  // Complete evidence whose found ids differ from the frozen expectation is a measured FAIL, even with other parts missing.
  const mismatch = withChecks(c=>c.map((k,n)=>n===0?{...k,found:[probe(1)]}:k));
  assert.equal(by(judge(runs(10),queries,mismatch,ids),'trgm').denials,'FAIL');
  assert.equal(by(judge(runs(10),undefined,mismatch,ids),'trgm').status,'FAIL');
  // A record whose found and expected agree but differ from the frozen expectation is not evidence.
  assert.equal(by(judge(runs(10),queries,withChecks(c=>c.map((k,n)=>n===0?{...k,found:[],expected:[]}:k)),ids),'trgm').denials,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,withChecks(c=>c.map((k,n)=>n===0?null as never:k)),ids),'trgm').denials,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,{cases:names,results:[...definer.results,definer.results[1]!]},ids),'trgm').denials,'NOT EVALUATED');
  // Malformed artifacts are missing evidence, never a crash.
  for (const bad of [{},123,null,'x',[null],[{}]]) {
    assert.equal(by(judge(runs(10),bad,definer,ids),'trgm').status,'NOT EVALUATED');
    assert.equal(by(judge(runs(10),queries,{cases:names,results:bad},ids),'trgm').denials,'NOT EVALUATED');
    assert.equal(by(judge(runs(10),queries,bad,ids),'trgm').denials,'NOT EVALUATED');
    assert.equal(by(judge(runs(10).map(r=>({...r,latencies:bad as never,plans:bad as never})),queries,definer,ids),'trgm').status,'NOT EVALUATED');
  }
  // Tampered raw text or scalar counts are not the frozen query list.
  assert.equal(by(judge(runs(10),queries.map(q=>q.id==='ja3-rare'?{...q,scalars:0}:q),definer,ids),'bigm').index,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries.map(q=>q.id==='ja3-rare'?{...q,raw:'x'}:q),definer,ids),'bigm').latency,'NOT EVALUATED');
  // A rare query whose value was shrunk (consistent scalars) differs from the frozen count.
  assert.equal(by(judge(runs(10),queries.map(q=>q.id==='ja3-rare'?{...q,value:'a',scalars:1}:q),definer,ids),'trgm').index,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,withChecks(()=>undefined as never),ids),'trgm').denials,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,{cases:names,results:definer.results.map(({checks,...r})=>r)},ids),'trgm').denials,'NOT EVALUATED');
  // Three rows from duplicated rounds, or an empty sample, are not three rounds of evidence.
  assert.equal(by(judge(runs(10).map(r=>r.round===3?{...r,round:2}:r),queries,definer,ids),'trgm').latency,'NOT EVALUATED');
  assert.equal(by(judge(runs(10).map(r=>({...r,latencies:r.latencies.map(l=>({...l,n:0}))})),queries,definer,ids),'trgm').latency,'NOT EVALUATED');
  // Denials need the current case list on every engine, the baseline included.
  assert.equal(by(judge(runs(10),queries,{...definer,cases:['a','b'],results:definer.results.map(r=>({...r,cases:4}))},ids),'trgm').denials,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,{...definer,results:definer.results.filter(r=>r.engine!=='none')},ids),'trgm').denials,'NOT EVALUATED');
});

test('required samples per query and round equal the frozen manifest performance shape', () => {
  const frozen = JSON.parse(readFileSync(new URL('./manifest-v2.json', import.meta.url), 'utf8')).frozen.performance;
  assert.equal(frozen.clients*frozen.transactions, criteria.samplesPerQueryRound);
  assert.equal(frozen.rounds, 3);
});

const b1QuerySet: [string,string][] = [['ja2-rare','麒麟'],['ja1-frequent','開']];
function b1Evidence(querySet = b1QuerySet, rounds = 3, samples = 100) {
  const queries = querySet.map(([id,raw])=>({id,raw,value:raw,scalars:[...raw].length}));
  const cases = denialCases.map(c=>c.name);
  const checks = denialCases.flatMap(c=>[false,true].map(forced=>({case:c.name,forced,found:c.expect.map(probe),expected:c.expect.map(probe)})));
  const latencies = queries.map(q=>({query:q.id,n:samples,p50:1,p95:2,p99:3}));
  const completeness = queries.map(q=>({query:q.id,actors:[1,2,3,4,5,6].map(actor=>({actor,equal:true,rows:0})),
    ownerIndexEqual:true,directEqual:true,pageEqual:true,matchesByOrganization:{a:100,b:20,c:10}}));
  const plan = {searchIndex:true,seqScanMessages:false,executionMs:1,scans:[{}]};
  const plans = queries.map(q=>({query:q.id,...plan}));
  const timing = latencies.map(q=>({query:q.query,few:{...q,foreignMatches:2,plan},many:{...q,foreignMatches:1000,plan},equalNonemptyPage:true}));
  const safety = {role:b1RoleFacts,rls:b1RlsFacts,memberships:'0',definers:'0',policy:'a'.repeat(32)};
  return {queries,rounds:Array.from({length:rounds},(_,i)=>({round:i+1,engine:'pgroonga',latencies,completeness,plans,safety})),
    denials:{cases,checks},restore:{completeness},timing};
}

test('B1 judges every round and requires per-class plan, reference and timing evidence',()=>{
  const evidence = b1Evidence();
  const {latencies,completeness,plans,safety} = evidence.rounds[0]!;
  const {timing,denials:{cases,checks}} = evidence;
  const judge = (value: Parameters<typeof judgeB1>[0],evaluation = true) =>
    judgeB1(value,b1QuerySet,3,100,evaluation);
  assert.equal(judge(evidence).status,'PASS');
  assert.equal(judge(evidence).classes[1]?.latency,'PASS');
  assert.equal(judge(evidence).classes[1]?.actorDenials,'PASS');
  assert.equal(judge(evidence,false).status,'NOT EVALUATED');

  for (const missing of ['rounds','queries','denials','restore','timing'] as const)
    assert.equal(judge({...evidence,[missing]:undefined}).status,'NOT EVALUATED',missing);
  const drift = <T extends object>(patch: T) => evidence.rounds.map(r=>r.round===1 ? {...r,...patch} : r);
  assert.equal(judge({...evidence,rounds:drift({safety:{...safety,rls:''}})}).status,'NOT EVALUATED');
  assert.equal(judge({...evidence,rounds:drift({plans:plans.slice(1)})}).status,'NOT EVALUATED');
  assert.equal(judge({...evidence,rounds:drift({plans:plans.map(p=>({...p,searchIndex:false}))})}).status,'FAIL');
  assert.equal(judge({...evidence,rounds:drift({completeness:completeness.map(c=>({...c,pageEqual:false}))})}).status,'FAIL');
  assert.equal(judge({...evidence,denials:{cases,checks:checks.slice(1)}}).status,'NOT EVALUATED');
  assert.equal(judge({...evidence,timing:timing.map(t=>({...t,many:t.few}))}).status,'NOT EVALUATED');
  const slow = latencies.map(l=>l.query==='ja1-frequent' ? {...l,p95:501,p99:550} : l);
  assert.equal(judge({...evidence,rounds:drift({latencies:slow})}).status,'FAIL');
});

test('B1 timing requires search_body evidence in both arms for every class',()=>{
  const evidence = b1Evidence();
  const judge = (timing: unknown) => judgeB1({...evidence,timing},b1QuerySet,3,100,true);
  assert.ok(judge(evidence.timing).classes.every(c=>c.timingEvaluated));
  const [first,other] = evidence.timing;
  assert.ok(first && other);
  for (const arm of ['few','many'] as const) {
    for (const plan of [undefined,{...first[arm].plan,searchIndex:false},{...first[arm].plan,scans:[]}]) {
      const result = judge([{...first,[arm]:{...first[arm],plan}},other]);
      assert.equal(result.classes[0]?.timingEvaluated,false,`${arm}: ${JSON.stringify(plan)}`);
      assert.equal(result.classes[1]?.timingEvaluated,true);
      assert.equal(result.status,'NOT EVALUATED');
    }
  }
});

for (const [rounds,clients,transactions] of [[3,5,20],[1,5,20],[3,1,1],[1,1,1]] as const) {
  test(`B1 publication verifies v11 with ${rounds} rounds and ${clients*transactions} samples per query`,t=>{
    const dir = mkdtempSync(join(tmpdir(),'search-b1-summary-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const {frozen} = JSON.parse(readFileSync(new URL('manifest-v11.json',import.meta.url),'utf8'));
    Object.assign(frozen.performance,{rounds,clients,transactions});
    const manifestHash = hash(JSON.stringify(frozen));
    const save = (name: string,value: unknown)=>writeFileSync(join(dir,name+'.json'),JSON.stringify(value));
    const {rounds:results,...files} = b1Evidence(frozen.performance.querySet,rounds,clients*transactions);
    for (const [name,value] of Object.entries(files)) save(name,value);
    save('manifest',{sha256:manifestHash,frozen,runKind:'evaluation'});
    save('results',results.map(r=>({...r,manifestHash,runKind:'evaluation'})));
    for (const name of ['completed','finished']) save(name,{manifestHash,results:results.length});
    save('run-status',{manifestHash,valid:true,cleanupVerified:true,exitCode:0});
    if (rounds===3 && clients*transactions===100) {
      summarize(dir);
      assert.equal(JSON.parse(readFileSync(join(dir,'judgement.json'),'utf8')).status,'PASS');
    } else {
      assert.throws(()=>summarize(dir),/must match a checked-in B1 manifest/);
      assert.equal(existsSync(join(dir,'judgement.json')),false);
    }
  });
}
