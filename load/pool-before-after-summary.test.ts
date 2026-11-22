import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, judgeAll, overall, rehearsalChecks, rehearsalForecast, runProblems, settings, validity, pairs, plan, scope, sequence, type Row, type Run, type Lane } from './pool-before-after-summary.ts';
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
test('other Organization is judged per step; whole-run reader failures elsewhere do not fail this step; missing continuous evidence is not evaluated',()=>{
  const r=runs();r[0].reader.accepted--;r[0].reader.clientTimeouts++;
  assert.equal(judge(r,'send',250).status,'PASS');
  const step=runs();const reader=step.find(c=>c.arm==='A')!.steps[0].reader;reader.accepted--;reader.clientTimeouts++;
  assert.equal(judge(step,'send',250).status,'FAIL');
  r[0].reader.droppedIterations++;assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
});
test('omitted resource fields and full-run success latency remain missing evidence',()=>{
  const r=runs();delete (r[0].steps[0].evidence as Partial<Row['evidence']>).maxSampleGapMs;
  assert.equal(judge(r,'send',250).status,'NOT EVALUATED');
  const other=runs();other[0].reader.p95=null;assert.equal(judge(other,'send',250).status,'NOT EVALUATED');
});
test('zero candidate or other-Organization successes fail instead of going unmeasured',()=>{
  const r=runs();const a=r.find(c=>c.arm==='A')!.steps[0];a.send.accepted=0;a.send.rejected503=15000;a.send.p95=a.send.p99=null;
  assert.deepEqual(validity(a),[]);assert.equal(judge(r,'send',250).status,'FAIL');
  const other=runs();const reader=other.find(c=>c.arm==='A')!.steps[0].reader;reader.clientTimeouts=reader.accepted;reader.accepted=0;reader.p95=reader.p99=null;
  assert.equal(judge(other,'send',250).status,'FAIL');
});
test('an incomplete, interrupted or uncleaned run never yields a verdict',()=>{
  const mixed=runs().map(r=>({...r,scenario:'mixed' as const,steps:[{...row(),reads:lane(500),signin:lane(20)}]}));
  const all=[...runs(),...mixed];
  assert.equal(judgeAll(all,true).find(j=>j.scenario==='send'&&j.rate===250)!.status,'PASS');
  assert.ok(judgeAll(all,false).every(j=>j.status==='NOT EVALUATED'));
});
const mixedRuns=()=>runs().map(r=>({...r,scenario:'mixed' as const,steps:[{...row(),reads:lane(500),signin:lane(20)}]}));
test('healthy mixed 250/s diagnostic shortfall stays INVALID and never passes judgement',()=>{
  for (const arm of ['B','A'] as const) for (const attempted of [14601,14635,14625]) {
    const r=mixedRuns();
    assert.equal(judge(r,'mixed',250).status,'PASS');
    const step=r.find(run=>run.arm===arm)!.steps[0];
    step.send.attempted=step.send.accepted=attempted;
    step.send.droppedIterations=15001-attempted;
    // All generated requests succeeded, and offers exceed 95%; drops alone
    // must invalidate before latency or success-rate gates can grant PASS.
    assert.deepEqual(validity(step),['send: target load not generated']);
    const judgement=judge(r,'mixed',250);
    assert.equal(judgement.status,'NOT EVALUATED');
    assert.equal(judgement.pairs[0].status,'NOT EVALUATED');
    assert.match(judgement.pairs[0].reason!,/send: target load not generated/);
    assert.equal(judgeAll(r,true).find(j=>j.scenario==='mixed'&&j.rate===250)!.status,'NOT EVALUATED');
  }
});
test('mixed reads and sign-ins are judged like sends; their loss never passes',()=>{
  assert.equal(judge(mixedRuns(),'mixed',250).status,'PASS');
  for(const name of ['reads','signin'] as const) {
    const zero=mixedRuns();const a=zero.find(c=>c.arm==='A')!.steps[0][name]!;a.rejected503=a.accepted;a.accepted=0;a.p95=a.p99=null;
    assert.deepEqual(validity(zero.find(c=>c.arm==='A')!.steps[0]),[]);assert.equal(judge(zero,'mixed',250).status,'FAIL');
    const drop=mixedRuns();const d=drop.find(c=>c.arm==='A')!.steps[0][name]!;d.otherErrors=Math.ceil(d.attempted*.011);d.accepted-=d.otherErrors;
    assert.equal(judge(drop,'mixed',250).status,'FAIL');
    const slow=mixedRuns();slow.find(c=>c.arm==='A')!.steps[0][name]!.p99=22.01;assert.equal(judge(slow,'mixed',250).status,'FAIL');
    const sat=mixedRuns();for(const b of sat.filter(c=>c.arm==='B')){const l=b.steps[0][name]!;l.otherErrors=Math.ceil(l.attempted*.02);l.accepted-=l.otherErrors;}
    assert.equal(judge(sat,'mixed',250).status,'REPORT ONLY');
    sat[0].steps=[{...row(),reads:lane(500),signin:lane(20)}];assert.equal(judge(sat,'mixed',250).status,'NOT EVALUATED');
  }
});

test('#769 rehearsal: one B and one A run per scenario on the formal plan; formal and smoke sequences unchanged',()=>{
  assert.deepEqual(sequence('rehearsal'),[{scenario:'send',pair:1,arm:'B'},{scenario:'send',pair:1,arm:'A'},{scenario:'mixed',pair:1,arm:'B'},{scenario:'mixed',pair:1,arm:'A'}]);
  assert.deepEqual(sequence('smoke'),[{scenario:'send',pair:1,arm:'B'}]);
  assert.deepEqual(sequence('formal'),['send','mixed'].flatMap(scenario=>[['B','A'],['A','B'],['B','A']].flatMap((arms,i)=>arms.map(arm=>({scenario,pair:i+1,arm})))));
});
test('#769 rehearsal runs never yield a verdict, even when marked complete',()=>{
  const rehearsed=runs().map(r=>({...r,rehearsal:true}));
  for (const j of judgeAll(rehearsed,true)) assert.equal(j.status,'NOT EVALUATED');
  assert.deepEqual(judge(rehearsed,'send',250).pairs.map(p=>p.reason),['missing or duplicate arm','missing or duplicate arm','missing or duplicate arm']);
  assert.notEqual(judge(runs(),'send',250).pairs[0].reason,'missing or duplicate arm');
});
test('#771 rehearsal applies every per-run evidence check judge() uses, without pairing',()=>{
  const full=(scenario:'send'|'mixed',arm:'B'|'A'):Run=>({scope,pair:1,arm,scenario,smoke:false,rehearsal:true,reader:{...lane(2),seconds:284,attempted:568,accepted:568},
    steps:settings.rates.map(rate=>({...row(),rate,send:lane(rate),...(scenario==='mixed'?{reads:lane(500),signin:lane(20)}:{})}))});
  const all=()=>sequence('rehearsal').map(c=>full(c.scenario,c.arm));
  assert.ok(rehearsalChecks(all()).every(c=>c.problems.length===0));
  const noSignin=all();delete noSignin[2].steps[1].signin;
  assert.deepEqual(rehearsalChecks(noSignin)[2].problems,['500/s: settings mismatch']);
  const missingStep=all();missingStep[0].steps.pop();
  assert.deepEqual(runProblems(missingStep[0]),['2000/s: missing or duplicate step','3 steps, expected 4']);
  const reader=all();reader[1].reader.droppedIterations=1;
  assert.deepEqual(runProblems(reader[1]),['missing continuous other-Organization evidence']);
  const drop=all();drop[3].steps[0].send.droppedIterations=1;
  assert.deepEqual(runProblems(drop[3]),['250/s: send: target load not generated']);
  assert.deepEqual(rehearsalChecks(all().slice(1))[0].problems,['0 runs, expected 1']);
  for(const j of judgeAll(all(),false)) assert.equal('reason' in j && j.reason,'run incomplete, interrupted, smoke, missing results or cleanup failed');
});

// #196 B rules pre-registered on 2026-11-22: rule 2 (B generator), rule 1 (B saturation), rule 3 (A generator).
const dropA=(r:Run[],name:'send'|'reads'|'signin'='send',edit:(l:Lane)=>void=()=>{})=>{for(const run of r.filter(c=>c.arm==='A')){const l=run.steps[0][name]!;l.droppedIterations=100;l.attempted-=100;l.accepted-=100;edit(l);}};
test('#196 rule 2: a B generator shortfall is NOT EVALUATED, never REPORT ONLY, even when B is also saturated',()=>{
  const r=runs();for(const b of r.filter(c=>c.arm==='B')){const l=b.steps[0].send;l.droppedIterations=100;l.attempted=14900;l.accepted=14000;l.rejected503=900;}
  const j=judge(r,'send',250);assert.equal(j.status,'NOT EVALUATED');
  for(const p of j.pairs){assert.equal(p.status,'NOT EVALUATED');assert.match(p.reason!,/^B generator: send: target load not generated/);}
});
test('#196 rule 1: B saturated on valid load is REPORT ONLY whatever the A generator did',()=>{
  const r=runs();for(const b of r.filter(c=>c.arm==='B')){b.steps[0].send.accepted=14000;b.steps[0].send.rejected503=1000;}
  dropA(r);assert.equal(judge(r,'send',250).status,'REPORT ONLY');
  const ev=runs();for(const b of ev.filter(c=>c.arm==='B')){b.steps[0].send.accepted=14000;b.steps[0].send.rejected503=1000;}
  dropA(ev,'send',l=>{l.accepted-=10;l.rejected503=10;});assert.equal(judge(ev,'send',250).status,'REPORT ONLY');
});
test('#196 rule 3: an A-only shortfall fails only with server evidence on every short lane',()=>{
  for(const edit of [(l:Lane)=>{l.accepted-=10;l.rejected503=10;},(l:Lane)=>{l.accepted-=10;l.otherErrors=10;},(l:Lane)=>{l.accepted-=10;l.clientTimeouts=10;},(l:Lane)=>{l.p95=11.01;l.p99=30;}]) {
    const r=runs();dropA(r,'send',edit);const j=judge(r,'send',250);
    assert.equal(j.status,'FAIL');assert.ok(j.pairs.every(p=>p.reason==='A capacity, server evidence (send)'));
  }
  for(const edit of [()=>{},(l:Lane)=>{l.accepted-=10;l.transportErrors=10;},(l:Lane)=>{l.p95=11;l.p99=30;}]) {
    const r=runs();dropA(r,'send',edit);const j=judge(r,'send',250);
    assert.equal(j.status,'NOT EVALUATED');assert.ok(j.pairs.every(p=>p.reason?.startsWith('A generator without server evidence: ')));
  }
  // Two short lanes: evidence on one only is not enough.
  const m=mixedRuns();dropA(m,'send',l=>{l.accepted-=10;l.rejected503=10;});dropA(m,'reads');
  assert.equal(judge(m,'mixed',250).status,'NOT EVALUATED');
  const both=mixedRuns();dropA(both,'send',l=>{l.accepted-=10;l.rejected503=10;});dropA(both,'reads',l=>{l.accepted-=5;l.clientTimeouts=5;});
  assert.equal(judge(both,'mixed',250).status,'FAIL');
});
test('#196 rule 3 never overrides other invalid evidence',()=>{
  const r=runs();dropA(r,'send',l=>{l.accepted-=10;l.rejected503=10;});r.find(c=>c.arm==='A')!.steps[0].evidence.samples=0;
  assert.equal(judge(r,'send',250).pairs[0].status,'NOT EVALUATED');
  const b=runs();dropA(b,'send',l=>{l.accepted-=10;l.rejected503=10;});b[0].steps[0].send.p95=null;
  assert.equal(judge(b,'send',250).pairs[0].status,'NOT EVALUATED');
});
test('#196 overall: any FAIL fails; PASS needs every step PASS or REPORT ONLY and one PASS',()=>{
  const s=(...x:string[])=>x.map(status=>({status}));
  assert.equal(overall(s('PASS','NOT EVALUATED','FAIL')),'FAIL');
  assert.equal(overall(s('PASS','REPORT ONLY')),'PASS');
  assert.equal(overall(s('PASS','NOT EVALUATED')),'NOT EVALUATED');
  assert.equal(overall(s('REPORT ONLY','REPORT ONLY')),'NOT EVALUATED');
  assert.equal(overall(s()),'NOT EVALUATED');
  const mixed=mixedRuns().map(r=>({...r,steps:settings.rates.map(rate=>({...row(),rate,send:lane(rate),reads:lane(500),signin:lane(20)}))}));
  const send=runs().map(r=>({...r,steps:settings.rates.map(rate=>({...row(),rate,send:lane(rate)}))}));
  assert.equal(overall(judgeAll([...send,...mixed],true)),'PASS');
  assert.equal(overall(judgeAll([...send,...mixed],false)),'NOT EVALUATED');
  send.find(c=>c.arm==='A')!.steps[3].send.p95=11.01;
  for(const b of mixed.filter(c=>c.arm==='B')){const l=b.steps[1].send;l.droppedIterations=1;}
  assert.equal(overall(judgeAll([...send,...mixed],true)),'FAIL');
});
test('#196 decision b: a rehearsal load shortfall is a forecast, not a rehearsal problem',()=>{
  const full=(scenario:'send'|'mixed',arm:'B'|'A'):Run=>({scope,pair:1,arm,scenario,smoke:false,rehearsal:true,reader:{...lane(2),seconds:284,attempted:568,accepted:568},
    steps:settings.rates.map(rate=>({...row(),rate,send:lane(rate),...(scenario==='mixed'?{reads:lane(500),signin:lane(20)}:{})}))});
  const all=sequence('rehearsal').map(c=>full(c.scenario,c.arm));
  const mb=all[2].steps[1].send;mb.droppedIterations=50;mb.attempted-=50;mb.accepted-=50;
  const ma=all[3].steps[0].send;ma.droppedIterations=50;ma.attempted-=50;ma.accepted-=60;ma.rejected503=10;
  const checks=rehearsalChecks(all);
  assert.ok(checks.every(c=>c.problems.length===0));
  assert.deepEqual(checks[2].loadNotGenerated,['500/s: send: target load not generated']);
  const f=rehearsalForecast(all);
  assert.ok(f.every(x=>x.evidence===false));
  assert.equal(f.find(x=>x.scenario==='mixed'&&x.rate===500)!.status,'NOT EVALUATED');
  assert.equal(f.find(x=>x.scenario==='mixed'&&x.rate===250)!.status,'FAIL');
  assert.equal(f.find(x=>x.scenario==='send'&&x.rate===250)!.status,'PASS');
  for(const j of judgeAll(all,true)) assert.equal(j.status,'NOT EVALUATED');
  const extra=sequence('rehearsal').map(c=>full(c.scenario,c.arm));const x=extra[1].steps[0].send;x.attempted=15002;x.accepted=15002;
  assert.deepEqual(rehearsalChecks(extra)[1],{scenario:'send',arm:'A',problems:['250/s: send: more load than planned'],loadNotGenerated:[]});
  const broken=all.map(r=>r);delete broken[2].steps[1].signin;
  assert.deepEqual(rehearsalChecks(broken)[2].problems,['500/s: settings mismatch']);
});
test('#196 review: excess load stays a hard invalidation; saturation never precedes hard evidence; 429s are not server evidence',()=>{
  const over=runs();const l=over.find(c=>c.arm==='A')!.steps[0].send;l.attempted=15002;l.accepted=15001;l.rejected503=1;
  assert.deepEqual(validity(over.find(c=>c.arm==='A')!.steps[0]),['send: more load than planned']);
  assert.equal(judge(over,'send',250).pairs[0].status,'NOT EVALUATED');
  for(const b of over.filter(c=>c.arm==='B')){b.steps[0].send.accepted=14000;b.steps[0].send.rejected503=1000;}
  assert.equal(judge(over,'send',250).pairs[0].status,'NOT EVALUATED');
  const sat=()=>{const r=runs();for(const b of r.filter(c=>c.arm==='B')){b.steps[0].send.accepted=14000;b.steps[0].send.rejected503=1000;}return r;};
  const ev=sat();ev[0].steps[0].evidence.samples=0;assert.equal(judge(ev,'send',250).pairs[0].status,'NOT EVALUATED');
  const lim=sat();lim[0].steps[0].send.rejected429=1;lim[0].steps[0].send.rejected503--;assert.equal(judge(lim,'send',250).pairs[0].status,'NOT EVALUATED');
  for(const name of ['reads','signin'] as const){const m=mixedRuns();dropA(m,name,x=>{x.accepted-=5;x.rejected429=5;});
    assert.equal(judge(m,'mixed',250).status,'NOT EVALUATED');}
});
