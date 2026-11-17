import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash } from './manifest.ts';
import { judge, summarize } from './summarize.ts';

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
  const queries = [{id:'ja2-rare',scalars:2},{id:'ja3-rare',scalars:4},{id:'ja1-frequent',scalars:1}];
  const definer = {cases:['a','b'],results:['none','trgm','bigm','pgroonga'].map(engine=>({engine,cases:4}))};
  const plans = (index: string[], seq = false) => queries.map(q=>({query:q.id,searchIndex:index.includes(q.id),seqScanMessages:seq}));
  const runs = (p95: number, planList = plans(['ja2-rare','ja3-rare']), equal = true) => ['trgm','bigm','pgroonga'].flatMap(engine=>[1,2,3].map(round=>({
    manifestHash:'h',round,engine,buildMs:1,relationBytes:1,physicalDeltaBytes:1,walBytesPerInsert:1,write:{query:'w',n:1,p50:1,p95:1,p99:1,tps:1},
    latencies:queries.map(q=>({query:q.id,n:100,p50:1,p95:round===2&&engine==='bigm'?p95:10,p99:p95,tps:1})),
    ...(round===1?{plans:planList,completeness:{equal}}:{})})));
  const by = (r: ReturnType<typeof judge>, e: string) => r.find(x=>x.engine===e)!;
  const pass = judge(runs(500),queries,definer);
  assert.deepEqual(pass.map(r=>r.status),['PASS','PASS','PASS']);
  // trgm needs 3 scalars, so ja2-rare without search_body is not required for trgm.
  assert.deepEqual(by(pass,'trgm').requiredSearchIndex,['ja3-rare']);
  assert.equal(by(judge(runs(500.1),queries,definer),'bigm').latency,'FAIL');
  assert.equal(by(judge(runs(10,plans(['ja3-rare'])),queries,definer),'bigm').index,'FAIL');
  assert.equal(by(judge(runs(10,plans(['ja3-rare'])),queries,definer),'trgm').index,'PASS');
  assert.equal(by(judge(runs(10,plans(['ja2-rare','ja3-rare'],true)),queries,definer),'pgroonga').index,'FAIL');
  assert.equal(by(judge(runs(10,undefined,false),queries,definer),'trgm').completeness,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),queries,undefined),'trgm').status,'NOT EVALUATED');
  assert.equal(by(judge(runs(10),undefined,definer),'trgm').status,'NOT EVALUATED');
  assert.equal(by(judge(runs(10).filter(r=>r.round!==3),queries,definer),'trgm').latency,'NOT EVALUATED');
});
