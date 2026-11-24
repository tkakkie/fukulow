import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, cpSync, existsSync, utimesSync, appendFileSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readConfig, readRunConfig, type Config } from './dms-formal-config.ts';
import { budgets, commonWindow, judge, reconcile } from './dms-formal-judgment.ts';
import { spawnSync } from 'node:child_process';
import { abortSettleMs, cleanupReserveMs, collectionEndMs, collectionSlackMs, dbLogCommand, dbLogTimeoutMs, hostStopMaxMs, localCleanupMs, run, samplerStopEndMs, seedDbLogMs, type Runtime } from './dms-formal-run.ts';
import { checked, execute, type Command } from './dms-formal-exec.ts';
import { parseSend } from './dms-formal-results.ts';
import { kernelFiles, snapshotsPerSession, stopTiming } from './dms-formal-seed-samplers.ts';
const checkout=resolve(import.meta.dirname,'..');
function temporary(t: {after:(fn:()=>void)=>void}) { const path=mkdtempSync(`${tmpdir()}/dm-formal-test-`);t.after(()=>rmSync(path,{recursive:true,force:true}));return path; }
function env(path:string, extra='') {return `DM_FORMAL_APP=app-alias\nDM_FORMAL_DB=db-alias\nDM_FORMAL_GENERATOR=generator-alias\nDM_FORMAL_SHA=${'a'.repeat(40)}\nDM_FORMAL_OUTPUT=${path}/output\n${extra}`;}
test('private config refuses checkout, symlink, wide mode and existing output',t=>{
  const path=temporary(t), file=`${path}/private.env`;
  writeFileSync(file,env(path),{mode:0o600});
  assert.equal(readConfig(file,checkout).attempts,3);
  assert.equal(readConfig(file,checkout).mode,'formal');
  chmodSync(file,0o640);assert.throws(()=>readConfig(file,checkout),/0600/);chmodSync(file,0o600);
  writeFileSync(file,env(path).replace(`${path}/output`,`${checkout}/output`));assert.throws(()=>readConfig(file,checkout),/outside checkout/);
  writeFileSync(file,env(path));mkdirSync(`${path}/output`);assert.throws(()=>readConfig(file,checkout),/must be new/);
  const inside=`${checkout}/.formal-test-${process.pid}.env`;writeFileSync(inside,env(path),{mode:0o600});t.after(()=>rmSync(inside,{force:true}));
  assert.throws(()=>readConfig(inside,checkout),/outside checkout/);
  symlinkSync(inside,`${path}/linked.env`);assert.throws(()=>readConfig(`${path}/linked.env`,checkout),/outside checkout/);
});
test('config has no ambient env fallback, rejects unsafe aliases, short SHA and too few formal attempts',t=>{
  const path=temporary(t),file=`${path}/private.env`;
  for(const extra of ['DM_FORMAL_ATTEMPTS=1\n','DM_FORMAL_MODE=invalid\n','DM_FORMAL_SCENARIO=unknown\n','DM_FORMAL_UNKNOWN=x\n']) {writeFileSync(file,env(path,extra),{mode:0o600});assert.throws(()=>readConfig(file,checkout));}
  for(const value of [env(path).replace('app-alias','-oProxyCommand=bad'),env(path).replace('a'.repeat(40),'abcd')]) {writeFileSync(file,value);assert.throws(()=>readConfig(file,checkout));}
  writeFileSync(file,env(path,'DM_FORMAL_MODE=smoke\nDM_FORMAL_ATTEMPTS=1\n'));assert.equal(readConfig(file,checkout).attempts,1);
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
function stub(t:Parameters<typeof temporary>[0],interrupt:boolean) {
  const path=temporary(t),events:string[]=[],listeners=new Map<string,()=>void>();
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:`${path}/output`,scenario:'main',attempts:3,mode:'formal'};
  const runtime:Runtime={on:(s,f)=>{events.push(`register:${s}`);listeners.set(s,f);},off:(s)=>{events.push(`unregister:${s}`);listeners.delete(s);},transfer:async()=>{},exec:async(command:Command)=>{
    assert.ok(command.timeout,'all commands bounded');
    if(command.args.includes('-G'))return {code:0,stdout:'hostname example.invalid\n'};
    if(command.program==='tar') { const index=command.args.indexOf('-czf');writeFileSync(command.args[index+1],'stub'); }
    const text=command.args.join(' ');events.push(text);
    if(text.includes('mkdir ') && interrupt) { assert.equal(listeners.size,2);listeners.get('SIGINT')!(); }
    if(command.signal?.aborted)throw new Error('Aborted');
    if(text.includes("'preflight'"))return {code:1,stdout:''};
    return {code:0,stdout:''};
  }};
  return {config,runtime,events};
}
test('preflight failure aborts before build, seeding or timing and cleans all hosts',async t=>{
  const {config,runtime,events}=stub(t,false);
  await assert.rejects(run(config,runtime),/failed/);
  assert.equal(events.filter(event=>event.includes(' cleanup && timeout')).length,3);
  assert.ok(!events.some(event=>event.includes("'generators'")||event.includes("'seed'")||event.includes("'build'")));
  assert.equal(events[0],'register:SIGINT');
  assert.equal(JSON.parse(readFileSync(`${config.output}/status.json`,'utf8')).phase,'failed');
  assert.deepEqual(JSON.parse(readFileSync(`${config.output}/host-0-preflight-0-invocation-failure.json`,'utf8')),{
    event:'worker-invocation-failure',step:'preflight',attempt:0,exitCode:1,errorClass:'CommandFailure',message:'Command exited unsuccessfully',
  });
});
test('remote IPv4 app HostName is rejected before uploading the harness',async t=>{
  const {config,runtime,events}=stub(t,false),original=runtime.exec;
  runtime.exec=async command=>command.args.includes('-G')?{code:0,stdout:'hostname 192.0.2.10\n'}:original(command);
  await assert.rejects(run(config,runtime),/Remote app SSH HostName must be a DNS hostname:.*TLS SNI.*strict_sni_host/);
  assert.ok(!events.some(event=>event.includes('mkdir ')||event.includes('scp')||event.includes('-czf')));
});
test('remote DNS app HostName and IPv4 DB HostName pass address preflight',async t=>{
  const {config,runtime,events}=stub(t,false),original=runtime.exec;
  runtime.exec=async command=>command.args.includes('-G')?{code:0,stdout:`hostname ${command.args.at(-1)===config.app?'app.example.invalid':'192.0.2.20'}\n`}:original(command);
  await assert.rejects(run(config,runtime),/ssh failed \(exit 1\)/);
  assert.ok(events.some(event=>event.includes("'preflight'")));
});
for(const signal of ['SIGINT','SIGTERM'] as const) test(`cleanup registered before creation and invoked once on ${signal}`,async t=>{
  const {config,runtime,events}=stub(t,true);
  const originalOn=runtime.on;runtime.on=(s,f)=>originalOn(s,s==='SIGINT'?()=>{if(signal==='SIGINT')f();else runtimeSignal();}:f);
  let runtimeSignal=()=>{};
  if(signal==='SIGTERM') { const on=runtime.on;runtime.on=(s,f)=>{if(s==='SIGTERM')runtimeSignal=f;on(s,f);}; }
  await assert.rejects(run(config,runtime));
  assert.equal(events.filter(event=>event.includes(' cleanup && timeout')).length,3);
  assert.equal(events.filter(event=>event.startsWith('unregister:')).length,2);
  assert.ok(events.some(event=>event.includes('mkdir ')));
  assert.ok(!events.some(event=>event.includes("'generators'")));
});
test('executor retains nonzero exit and kills a hung child at its deadline',async()=>{
  assert.equal((await execute({program:process.execPath,args:['-e','process.exit(17)'],timeout:1000})).code,17);
  await assert.rejects(checked(execute,{program:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeout:20}),/timeout/);
});
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
test('deadline kills descendants holding inherited pipes and reaps leader',async()=>{
  const start=Date.now();
  await assert.rejects(execute({program:process.execPath,args:['-e',`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)`],timeout:100}),/timeout/);
  assert.ok(Date.now()-start<1000);
});
test('production pool parser rejects instrumented and malformed lines',async()=>{
  const {parseProductionPoolLine,productionPoolEvidence}=await import('./dms-formal-pool.ts');
  for(const line of ['','{}','event=measure_pool us=1 active=0 size=32 error=false','event=measure_hold op=x wait_us=1 hold_us=1 active=0 waiting=0 http=0 acquired=true'])assert.equal(parseProductionPoolLine(line),undefined);
  assert.match(productionPoolEvidence(['{}'],0,1000,{complete:true,startedAt:0,endedAt:1000}).reasons.join(),/Missing pool_stats/);
});
test('restore failure after daemon creation stops, awaits and removes its own copy',async()=>{
  const {copyVolume}=await import('./dms-formal-copy.ts');const events:string[][]=[];
  await assert.rejects(copyVolume(async command=>{
    events.push(command.args);
    if(command.args[0]==='run')throw new Error('failed after creation');
    return {code:0,stdout:command.args[0]==='ps'?'copy-id':''};
  },'dm-formal-test',2,'snapshot','data','pinned',true),/after creation/);
  assert.deepEqual(events.slice(1).map(args=>args[0]),['ps','stop','wait','rm']);
  assert.ok(events.slice(2).every(args=>args.includes('dm-formal-test-copy-2')));
});
test('deadline admission reserves an entire attempt and cleanup',async()=>{
  const {canStartAttempt,attemptBudgetMs,cleanupReserveMs}=await import('./dms-formal-run.ts');
  const config={mode:'formal',deadline:1000+attemptBudgetMs('formal')+cleanupReserveMs} as Config;
  assert.equal(canStartAttempt(config,1000),true);assert.equal(canStartAttempt(config,1001),false);
});
test('reportAttempt rejects absent, duplicate or malformed shards and never passes counters',async t=>{
  const {reportAttempt}=await import('./dms-formal-results.ts');
  for(const manifest of [[],[{shard:0,code:0},{shard:0,code:0}], [{shard:0,code:0},{shard:10,code:'0'}],null]) {
    const path=temporary(t);writeFileSync(path+'/exits.json',JSON.stringify(manifest));
    const report=await reportAttempt(path,'smoke',execute);
    assert.equal(report.acceptance,false);assert.ok(report.rows.every(row=>row.status==='NOT EVALUATED'));
  }
});
function lifecycle(t:Parameters<typeof temporary>[0],failTransfer=false) {
  const path=temporary(t),events:string[]=[],statuses:unknown[]=[];
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',scenario:'main',attempts:3,mode:'formal'};
  let failed=false;
  const runtime:Runtime={on:()=>{},off:()=>{},transfer:async()=>{},exec:async command=>{
    const text=command.args.join(' ');events.push(text);
    try {statuses.push(JSON.parse(readFileSync(config.output+'/status.json','utf8')));}catch{}
    if(command.args.includes('-G'))return {code:0,stdout:'hostname example.invalid\n'};
    if(command.program==='tar') {
      const index=command.args.indexOf('-czf');
      if(index>=0)writeFileSync(command.args[index+1],'stub');
      else {const dest=command.args.at(-1)!;writeFileSync(dest+'/judgment.json',JSON.stringify({...judge({},'formal'),evidence:{}}));}
    }
    if(command.program==='scp' && !command.args.at(-1)!.includes(':')) {
      const dest=command.args.at(-1)!;
      if(failTransfer && !failed && dest.endsWith('/summary.tgz')) {failed=true;throw new Error('summary transfer failed');}
      if(dest.includes('/preflight-'))writeFileSync(dest,JSON.stringify({machine:dest}));
      else if(dest.endsWith('/image.json')||dest.endsWith('/db-image.json'))writeFileSync(dest,JSON.stringify([{Id:'sha256:stub'}]));
      else if(command.args.at(-2)!.endsWith('/formal')) {mkdirSync(dest+'/formal');for(let i=0;i<10;i++)writeFileSync(dest+'/formal/org-'+i+'.json','{}');}
      else writeFileSync(dest,'stub');
    }
    return {code:0,stdout:text.includes('du -sb')?'1':''};
  }};
  return {config,runtime,events,statuses};
}
test('successful full lifecycle reduces remotely and downloads bounded summaries',async t=>{
  const {config,runtime,events,statuses}=lifecycle(t);
  const result=await run(config,runtime);
  assert.equal(result.attempts.length,3);assert.equal(result.infrastructureFailure,false);
  assert.equal(events.filter(e=>e.includes("'reduce'")).length,3);
  assert.ok(events.filter(e=>e.includes("'reduce'")).every(e=>e.includes('generator')));
  assert.equal(events.filter(e=>e.includes('raw-') && e.includes('scp')).length,0);
  assert.equal(events.filter(e=>e.includes("'stop-copy'")).length,3);
  assert.equal(events.filter(e=>e.includes(' cleanup && timeout')).length,3);
  assert.ok(statuses.length>10);
  assert.ok(statuses.every(s=>typeof s==='object' && s!==null && 'operation' in s && 'outcome' in s));
});
test('summary transfer failure preserves failed attempt and allows the next restore',async t=>{
  const {config,runtime,events}=lifecycle(t,true);
  const result=await run(config,runtime);
  assert.equal(result.infrastructureFailure,true);assert.equal(result.attempts.length,3);
  assert.equal(events.filter(e=>e.includes("'restore'")).length,3);
  assert.equal(events.filter(e=>e.includes("'stop-copy'")).length,3);
  const first=JSON.parse(readFileSync(config.output+'/attempt-1/judgment.json','utf8'));
  assert.match(first.operation,/transfer/);assert.match(first.error,/summary transfer/);
});
test('preliminary summary preserves aggregate with old and tagged round fixtures',async t=>{
  for(const tagged of [false,true]) {
    const path=temporary(t);mkdirSync(path+'/shard-0');
    writeFileSync(path+'/shard-0/metrics.json',JSON.stringify({type:'Point',metric:'dm_round_ms',data:{time:new Date().toISOString(),value:42,tags:tagged?{attempts:'5'}:{}}})+'\n');
    await checked(execute,{program:'env',args:['DM_SHARDS=1',process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),path],timeout:10000});
    const summary=JSON.parse(readFileSync(path+'/combined.json','utf8'));
    assert.equal(summary.latencies.dm_round_ms.p99,42);
    if(tagged)assert.equal(summary.latencies['dm_round_ms:attempts=5'].p99,42);
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
test('held assignment and explicit traversal demand make the five-lane mix eligible',async()=>{
  const {retainedAssignment,demandFormalMix}=await import('./dms-formal-mix.ts');
  const {dmListState,stepDmList}=await import('../web/src/dm-list.ts');
  assert.deepEqual(Array.from({length:6},(_,i)=>retainedAssignment(i)),[0,50,0,50,0,50]);
  assert.deepEqual(Array.from({length:6},(_,i)=>retainedAssignment(i,'held200')),[0,50,200,0,50,200]);
  for(const held of [0,50,200]) {
    let state=dmListState();
    state.rows=Array.from({length:held},(_,i)=>({identity:{id:String(i),kind:'dm' as const,peer:{id:'peer',name:'Peer',active:true}},access:i,used:i}));
    state=demandFormalMix(state,'absent-peer');
    const lanes:string[]=[];
    for(let i=0;i<5;i++) {
      state=stepDmList(state,{type:'wake',now:0}).state;
      assert.ok(state.request);
      const request=state.request;lanes.push(request.lane);
      // Failures continue to consume attempts; the next iteration checks lane fairness.
      state=stepDmList(state,{type:'failure',request,retryAt:0,terminal:false}).state;
    }
    assert.ok(lanes.includes('delta')&&lanes.includes('coverage')&&lanes.includes('browse')&&lanes.includes('recovery'));
    if(held)assert.ok(lanes.includes('held'));
  }
});
test('failure after app container creation still cleans every host before returning',async t=>{
  const {config,runtime,events}=lifecycle(t);const original=runtime.exec;
  runtime.exec=async command=>{
    if(command.args.join(' ').includes("'app'")) {events.push('app container created; readiness failed');return {code:1,stdout:''};}
    return original(command);
  };
  await assert.rejects(run(config,runtime),/failed/);
  assert.ok(events.includes('app container created; readiness failed'));
  assert.equal(events.filter(e=>e.includes(' cleanup && timeout')).length,3);
  assert.ok(!events.some(e=>e.includes("'generators'")));
});
test('pool-overhead seed failure retains partial timing evidence without starting any attempt',async t=>{
  const {config,runtime,events}=lifecycle(t);config.scenario='pool-overhead';
  config.reviewedPatchSha256=createHash('sha256').update(readFileSync(checkout+'/load/pool-overhead-baseline.patch')).digest('hex');
  const original=runtime.exec;
  const timing='{"kind":"batch","organization":1,"batchIndex":1,"durationMs":6001}\n';
  runtime.exec=async command=>{
    const result=await original(command);
    if(command.args.join(' ').includes("'seed'"))return {code:1,stdout:''};
    const dest=command.args.at(-1)!;
    if(command.program==='scp' && dest===config.output+'/formal/seed-timing.jsonl') {
      assert.match(command.args.at(-2)!,/^db:.*\/formal\/seed-timing\.jsonl$/);
      writeFileSync(dest,timing);
    }
    return result;
  };
  await assert.rejects(run(config,runtime),/ssh failed \(exit 1\)/);
  assert.equal(events.filter(event=>event.includes("'seed'")).length,1);
  assert.ok(!events.some(event=>event.includes("'restore'")));
  assert.equal(events.filter(event=>event.includes(' cleanup && timeout')).length,3);
  assert.equal(readFileSync(config.output+'/formal/seed-timing.jsonl','utf8'),timing);
  const summary=JSON.parse(readFileSync(config.output+'/summary.json','utf8'));
  assert.equal(summary.status,'NOT EVALUATED');
  assert.equal(summary.infrastructureFailure,true);
  assert.equal(summary.acceptance,false);
  assert.deepEqual(summary.attempts,[]);
  const status=JSON.parse(readFileSync(config.output+'/status.json','utf8'));
  assert.equal(status.outcome,'infrastructure-failed');
  assert.equal(status.operation,'seed');
});
test('seed failure records the transfer failure when timing evidence is missing',async t=>{
  const {config,runtime}=lifecycle(t);
  const original=runtime.exec;
  const seedError=new Error('seed failed before writing timing evidence');
  runtime.exec=async command=>{
    if(command.args.at(-1)?.includes("'seed'"))throw seedError;
    if(command.program==='scp' && command.args.at(-1)===config.output+'/formal/seed-timing.jsonl')return {code:1,stdout:''};
    return original(command);
  };
  await assert.rejects(run(config,runtime),error=>error===seedError);
  const status=JSON.parse(readFileSync(config.output+'/status.json','utf8'));
  assert.equal(status.operation,'seed');
  const failure=JSON.parse(readFileSync(config.output+'/seed-timing-transfer-failure.json','utf8'));
  assert.equal(failure.operation,'transfer:formal/seed-timing.jsonl');
  assert.equal(failure.remoteRoot,'/tmp/'+status.id);
});
test('a formal seed failure keeps the redacted DB log before cleanup removes the container',async t=>{
  const {config,runtime,events}=lifecycle(t);const original=runtime.exec;
  const prefix='2026-11-22T00:00:00.000000000Z 2026-11-22 00:00:00.000 UTC [7] ';
  runtime.exec=async command=>{
    const text=command.args.join(' ');
    if(text.includes("'seed'"))return {code:1,stdout:''};
    if(text.includes('docker logs --timestamps')) {
      assert.equal(command.args.at(-2),'db');
      assert.match(command.args.at(-1)!,/^timeout --signal=KILL 8s sh -c '.+' db-log 'dm-formal-[a-f0-9-]+-db-1'$/);
      assert.equal(command.args.at(-1),'timeout --signal=KILL 8s '+dbLogCommand(/'(dm-formal-[a-f0-9-]+-db-1)'$/.exec(command.args.at(-1)!)![1]!));
      assert.equal(command.timeout,dbLogTimeoutMs,'bounded on both ends');
      assert.ok(!events.some(event=>event.includes(' cleanup && timeout')),'saved before any host cleanup');
      events.push('db logs');
      return {code:0,stdout:[prefix+'LOG:  checkpoints are occurring too frequently (24 seconds apart)',prefix+'STATEMENT:  INSERT secret-token'].join('\n')};
    }
    return original(command);
  };
  await assert.rejects(run(config,runtime),/ssh failed/);
  assert.equal(events.filter(event=>event==='db logs').length,1);
  assert.equal(readFileSync(config.output+'/db.log','utf8'),prefix+'LOG:  checkpoints are occurring too frequently (24 seconds apart)\n');
  assert.ok(!existsSync(config.output+'/db-log-collection.json'));
  assert.equal(JSON.parse(readFileSync(config.output+'/summary.json','utf8')).status,'NOT EVALUATED','the DB log changes no result');
});
test('the DB log command exits 3 only for a missing container; another inspect failure exits 4, recorded as failed',t=>{
  const bin=temporary(t);
  // A fake docker: inspect prints FAKE_INSPECT to stderr and exits FAKE_CODE; logs prints one line.
  writeFileSync(bin+'/docker','#!/bin/sh\nif [ "$1" = container ]; then echo "$FAKE_INSPECT" >&2; exit "$FAKE_CODE"; fi\necho "db log line"\n',{mode:0o700});
  const exit=(inspect:string,code:number)=>{
    const result=spawnSync('sh',['-c',dbLogCommand('dm-formal-x-db-1')],{env:{PATH:`${bin}:/usr/bin:/bin`,FAKE_INSPECT:inspect,FAKE_CODE:String(code)},encoding:'utf8'});
    return [result.status,result.stdout.trim()];
  };
  assert.deepEqual(exit('',0),[0,'db log line']);
  assert.deepEqual(exit('Error response from daemon: No such container: dm-formal-x-db-1',1),[3,'']);
  assert.deepEqual(exit('Error: No such object: dm-formal-x-db-1',1),[3,'']);
  assert.deepEqual(exit('permission denied while trying to connect to the Docker daemon socket',1),[4,''],'a refused daemon is not a missing container');
  assert.deepEqual(exit('Cannot connect to the Docker daemon. Is the docker daemon running?',1),[4,'']);
});
for(const [code,status] of [[3,'missing'],[4,'failed'],[137,'failed'],[1,'failed']] as const)test(`a DB log save that exits ${code} is recorded as ${status} and does not stop cleanup`,async t=>{
  const {config,runtime,events}=lifecycle(t);const original=runtime.exec;
  runtime.exec=async command=>{
    if(command.args.join(' ').includes("'seed'"))return {code:1,stdout:''};
    // 3: no such container; 4: inspect failed otherwise; 137: the remote timeout killed docker logs with the container present.
    if(command.args.join(' ').includes('docker logs --timestamps'))return {code,stdout:''};
    return original(command);
  };
  await assert.rejects(run(config,runtime),/ssh failed/);
  assert.equal(JSON.parse(readFileSync(config.output+'/db-log-collection.json','utf8')).status,status);
  assert.ok(!existsSync(config.output+'/db.log'));
  assert.equal(events.filter(event=>event.includes(' cleanup && timeout')).length,3);
});
test('the DB log save before cleanup fits the cleanup reserve beside the three sequential local cleanups',()=>{
  assert.ok(dbLogTimeoutMs+3*localCleanupMs<=cleanupReserveMs);
});
test('seed diagnostic collection ends before the three local cleanup allowances, even if the deadline fires just after a normal stop began',()=>{
  const deadline=Date.parse('2026-11-23T06:00:00Z'), fired=deadline-cleanupReserveMs;
  assert.equal(collectionSlackMs,30_000);
  // Before the deadline fires, the collection end already leaves the cleanups their allowances.
  assert.equal(collectionEndMs(deadline,undefined),deadline-3*localCleanupMs);
  // Worst case: the normal sampler stop starts at fired-1 ms (10 s stop command, 15 s grace, 10 s kill: 35 s
  // unbounded), the deadline fires 1 ms later. Every sampler step is cut to samplerStopEndMs, the host sampler stop
  // and an aborted exec's teardown are bounded, and the DB log gets at most the time left before the end.
  const end=collectionEndMs(deadline,fired), samplersDone=samplerStopEndMs(end)+abortSettleMs;
  assert.ok(stopTiming.stopCommandMs+15_000+stopTiming.killMs>collectionSlackMs,'the unbounded normal stop would not fit');
  const hostDone=samplersDone+hostStopMaxMs, dbLogDone=hostDone+Math.min(seedDbLogMs.fast,end-hostDone);
  assert.ok(dbLogDone<=end && end<=deadline-3*localCleanupMs,`collection ends ${dbLogDone-(deadline-3*localCleanupMs)} ms into the cleanup allowances`);
  assert.equal(end-hostDone,seedDbLogMs.fast,'the DB log keeps its full fast allowance');
  assert.ok(samplerStopEndMs(end)-fired>=stopTiming.fastStopCommandMs+stopTiming.fastGraceMs,'a stop that starts after the deadline still gets its fast stop command and grace');
  // A signal without a deadline gets the same slack.
  assert.equal(collectionEndMs(undefined,fired),fired+collectionSlackMs);
});
test('config validates deadline timezone and raw opt-in',t=>{
  const path=temporary(t),file=path+'/config.env';
  for(const extra of ['DM_FORMAL_DEADLINE=invalid\n','DM_FORMAL_DEADLINE=2000-01-01T00:00:00Z\n','DM_FORMAL_DOWNLOAD_RAW=yes\n']) {
    writeFileSync(file,env(path,extra),{mode:0o600});assert.throws(()=>readConfig(file,checkout));
  }
  const future=new Date(Date.now()+14*3600000).toISOString();
  writeFileSync(file,env(path,'DM_FORMAL_DEADLINE='+future+'\nDM_FORMAL_DOWNLOAD_RAW=1\n'));
  assert.equal(readConfig(file,checkout).deadline,Date.parse(future));assert.equal(readConfig(file,checkout).downloadRaw,true);
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
test('unverified owned-process cleanup prevents retention and another restore',async t=>{
  const {config,runtime,events}=lifecycle(t);const original=runtime.exec;
  runtime.exec=async command=>{
    if(command.args.join(' ').includes("'stop-workers'"))throw new Error('Owned processes remain after cleanup');
    return original(command);
  };
  await assert.rejects(run(config,runtime),/Owned processes remain/);
  assert.equal(events.filter(event=>event.includes("'restore'")).length,1);
  assert.equal(events.filter(event=>event.includes("'retain-raw'")).length,0);
  assert.equal(events.filter(event=>event.includes(' cleanup && timeout')).length,3);
});

test('scenario config selects main, held200 and explicit deferred stubs',t=>{
  const path=temporary(t),file=path+'/private.env';
  for(const scenario of ['main','held200','hot-DM','pool-overhead']) {
    writeFileSync(file,env(path,`DM_FORMAL_SCENARIO=${scenario}\n${scenario==='pool-overhead'?'DM_FORMAL_REVIEWED_PATCH_SHA256='+createHash('sha256').update(readFileSync(checkout+'/load/pool-overhead-baseline.patch')).digest('hex')+'\n':''}`),{mode:0o600});
    assert.equal(readConfig(file,checkout).scenario,scenario);
  }
});
test('deferred selection records its scenario as NOT EVALUATED without contacting hosts',async t=>{
  const path=temporary(t);
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',scenario:'hot-DM',attempts:3,mode:'formal'};
  const unused=()=>{throw new Error('Deferred stub contacted a host');};
  const result=await run(config,{exec:unused,transfer:unused,on:unused,off:unused});
  assert.equal(result.acceptance,false);
  const summary=JSON.parse(readFileSync(config.output+'/summary.json','utf8'));
  assert.equal(summary.scenario,'hot-DM');assert.equal(summary.status,'NOT EVALUATED');
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
test('pool overhead refuses unreviewed patch before contacting hosts',async t=>{
  const path=temporary(t);
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',scenario:'pool-overhead',attempts:3,mode:'formal'};
  const unused=()=>{throw new Error('Unreviewed overhead contacted a host');};
  await assert.rejects(run(config,{exec:unused,transfer:unused,on:unused,off:unused}),/reviewed patch/);
});

test('reviewed overhead runner restores six arms in order and retains a judged comparison',async t=>{
  const {config,runtime,events}=lifecycle(t);config.scenario='pool-overhead';
  config.reviewedPatchSha256=createHash('sha256').update(readFileSync(checkout+'/load/pool-overhead-baseline.patch')).digest('hex');
  const {overheadOrder,overheadMetrics,overheadClasses,overheadConditionKeys}=await import('./dms-formal-overhead.ts');
  const original=runtime.exec;
  runtime.exec=async command=>{
    const result=await original(command);
    if(command.program==='tar' && command.args.includes('-xzf')) {
      const dest=command.args.at(-1)!,index=Number(dest.split('attempt-')[1])-1,arm=overheadOrder[index];
      writeFileSync(dest+'/judgment.json',JSON.stringify({arm,metrics:Object.fromEntries(overheadMetrics.map(m=>[m,100])),samples:Object.fromEntries(Object.keys(overheadClasses).map(c=>[c,1000])),conditions:Object.fromEntries(overheadConditionKeys.map(k=>[k,'same'])),imageDigest:'sha256:'+(arm==='B'?'b':'c').repeat(64),reasons:[]}));
    }
    return result;
  };
  const result=await run(config,runtime);assert.equal(result.attempts.length,6);
  assert.equal(events.filter(e=>e.includes("'restore'")).length,6);
  const arms=events.filter(e=>e.includes("'overhead-arm'"));assert.equal(arms.length,6);
  arms.forEach((command,i)=>assert.ok(command.includes("'overhead-arm' "+(i+1)+' 0')));
  const report=JSON.parse(readFileSync(config.output+'/overhead-comparison.json','utf8'));
  assert.equal(report.status,'PASS');assert.deepEqual(report.arms.map((a:{arm:string})=>a.arm),overheadOrder);
  assert.equal(JSON.parse(readFileSync(config.output+'/summary.json','utf8')).acceptance,false);
  assert.equal(events.filter(e=>e.includes(' cleanup && timeout')).length,3);
});

for(const code of [0,17])test('executor records flushed generator log bytes, exit '+code,async t=>{
  const path=temporary(t)+'/run.log';
  const result=await execute({program:process.execPath,args:['-e',"process.stdout.write('日本語');process.stderr.write('stderr');process.exitCode="+code],log:path});
  assert.equal(result.code,code);
  const manifest=JSON.parse(readFileSync(path+'-retention.json','utf8'));
  assert.equal(manifest.complete,true);
  assert.equal(manifest.bytes,Buffer.byteLength('日本語stderr'));
  assert.equal(manifest.bytes,readFileSync(path).length);
});
test('executor marks timed out log capture incomplete',async t=>{
  const path=temporary(t)+'/run.log';
  await assert.rejects(execute({program:process.execPath,args:['-e',"process.stdout.write('partial');setInterval(()=>{},1000)"],timeout:500,log:path}),/timeout/);
  const manifest=JSON.parse(readFileSync(path+'-retention.json','utf8'));
  assert.equal(manifest.complete,false);
  assert.equal(manifest.bytes,readFileSync(path).length);
});

test('executor writes a redacted log only, never the raw cp output with home paths',async t=>{
  const path=temporary(t)+'/transfer.log';
  const redactLog=(text:string)=>text.replace(/\/Users\/[^/\s]+/g,'/Users/[user]');
  await assert.rejects(checked(execute,{program:'sh',args:['-c',"echo 'cp: /Users/someone/runs/out/formal: Permission denied' >&2; echo out /Users/someone/x; exit 1"],timeout:5000,log:path,redactLog}),/sh failed/);
  const saved=readFileSync(path,'utf8');
  assert.ok(!saved.includes('someone'),saved);
  assert.match(saved,/cp: \/Users\/\[user\]\/runs\/out\/formal: Permission denied/);
  const manifest=JSON.parse(readFileSync(path+'-retention.json','utf8'));
  assert.deepEqual([manifest.complete,manifest.redacted,manifest.bytes>0],[true,true,true]);
});
test('every transfer.log capture of the runner is redacted',async t=>{
  const {config,runtime}=stub(t,false);const original=runtime.exec;const logged:Command[]=[];
  runtime.exec=async command=>{if(command.log?.endsWith('/transfer.log'))logged.push(command);return original(command);};
  await assert.rejects(run(config,runtime));
  assert.ok(logged.length>0,'the preflight uploads write transfer.log');
  for(const command of logged)assert.equal(command.redactLog?.('cp: /Users/someone/x: Permission denied'),'cp: /Users/[user]/x: Permission denied',command.program);
});
test('seed diagnostic CLI accepts only local pool-overhead at pair scale with a formal fixture', t => {
  const path=temporary(t), file=path+'/config.env';
  const patch='DM_FORMAL_REVIEWED_PATCH_SHA256='+'a'.repeat(64)+'\n';
  const overhead='DM_FORMAL_SCENARIO=pool-overhead\n'+patch;
  const local='DM_FORMAL_TARGET=local\n';
  writeFileSync(file,env(path,local+overhead),{mode:0o600});
  assert.equal(readRunConfig([file],checkout).seedDiagnostic,undefined);
  assert.equal(readRunConfig([file,'--pilot'],checkout).pilot,true);
  const diagnostic=readRunConfig([file,'--seed-diagnostic'],checkout);
  assert.equal(diagnostic.seedDiagnostic,true);
  assert.equal(diagnostic.pilot,false);
  assert.equal(diagnostic.loadScale,'1/25');
  assert.throws(()=>readRunConfig([file,'--pilot','--seed-diagnostic'],checkout),/Expected/);
  // The baseline arm is the same seed diagnostic run with the instrumentation off.
  const baselineArm=readRunConfig([file,'--seed-diagnostic-baseline'],checkout);
  assert.deepEqual([baselineArm.seedDiagnostic,baselineArm.seedBaseline,baselineArm.loadScale,baselineArm.pilot],[true,true,'1/25',false]);
  assert.equal(diagnostic.seedBaseline,undefined);
  for (const extra of [overhead,local+'DM_FORMAL_SCENARIO=smoke\nDM_FORMAL_MODE=smoke\n',
    local+overhead+'DM_FORMAL_LOAD_SCALE=1/10\n',local+overhead+'DM_FORMAL_MODE=smoke\n']) {
    writeFileSync(file,env(path,extra));
    assert.throws(()=>readRunConfig([file,'--seed-diagnostic'],checkout),/requires/);
  }
});

test('the rehearsal options mark the same seed diagnostic arms; the full-size arms keep their current config', t => {
  const path=temporary(t), file=path+'/config.env', patch='a'.repeat(64);
  const overhead=`DM_FORMAL_SCENARIO=pool-overhead\nDM_FORMAL_REVIEWED_PATCH_SHA256=${patch}\n`, local='DM_FORMAL_TARGET=local\n';
  writeFileSync(file,env(path,local+overhead),{mode:0o600});
  // Pinned from the config reader at a17fc978: the full-size instrumented and baseline arms.
  const full={seedDiagnostic:true,pilotImage:undefined,target:'local',loadScale:'1/25',
    limits:{appCpu:2,appMemory:'2g',dbCpu:2,dbMemory:'4g',generatorCpu:1,generatorMemory:'1g'},pilot:false,pilotSeconds:60,
    reviewedPatchSha256:patch,app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:realpathSync(path)+'/output',
    mode:'formal',scenario:'pool-overhead',attempts:3,deadline:undefined,downloadRaw:false};
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic'],checkout),full);
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic-baseline'],checkout),{...full,seedBaseline:true});
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic-rehearsal'],checkout),{...full,seedRehearsal:true});
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic-baseline-rehearsal'],checkout),{...full,seedBaseline:true,seedRehearsal:true});
  assert.throws(()=>readRunConfig([file,'--rehearsal'],checkout),/Expected .*1 Organization, 5 Message batches \(125000 Messages\)/);
  assert.throws(()=>readRunConfig([file,'--seed-diagnostic','--seed-diagnostic-rehearsal'],checkout),/Expected/);
  // The rehearsal has the seed diagnostic's own conditions: local pool-overhead, a formal fixture and load scale 1/25.
  for (const extra of [overhead,local+'DM_FORMAL_SCENARIO=smoke\nDM_FORMAL_MODE=smoke\n',local+overhead+'DM_FORMAL_LOAD_SCALE=1/10\n',local+overhead+'DM_FORMAL_MODE=smoke\n']) {
    writeFileSync(file,env(path,extra));
    for(const option of ['--seed-diagnostic-rehearsal','--seed-diagnostic-baseline-rehearsal'])assert.throws(()=>readRunConfig([file,option],checkout),/requires/);
  }
});

test('a rehearsal is refused outside a seed diagnostic arm', async t => {
  const path=temporary(t);
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',scenario:'pool-overhead',attempts:3,mode:'formal',target:'local',seedRehearsal:true};
  await assert.rejects(run(config,{exec:async()=>{throw new Error('no host contact');},transfer:async()=>{},on:()=>{},off:()=>{}}),/Rehearsal requires a seed diagnostic arm/);
  assert.ok(!existsSync(config.output));
});

// The rows and DB log a seed diagnostic writes: per Organization 200 batches and its Organization row; each instrumented
// batch logs its five statement durations inside its clock window. A stopped seed ends at Organization 6 batch 124.
function diagnosticSeedRecords(arm:'instrumented'|'baseline',stopped:boolean,shape={organizations:10,batchesPerOrganization:200}) {
  const base=Date.parse('2026-11-22T00:00:00Z'), rows:string[]=[], log:string[]=[];
  const at=(ms:number)=>new Date(ms).toISOString().replace('T',' ').replace('Z',' UTC');
  for(let o=0;o<shape.organizations;o++) {
    for(let b=0;b<shape.batchesPerOrganization;b++) {
      const index=o*201+b, startMs=base+index*1000, stop=stopped && o===6 && b===124, durationMs=stop?12166:b===0?2000:1000;
      rows.push(JSON.stringify(arm==='baseline'?{kind:'batch',organization:o,batchIndex:b,durationMs}
        :{kind:'batch',organization:o,batchIndex:b,durationMs,startedAtMs:startMs,endedAtMs:startMs+durationMs,dbClockStartMs:startMs,dbClockEndMs:startMs+900,dbClockSpanMs:900,dbBackendPid:1000+index,recorderMs:0.1}));
      for(const [offset,ms] of [[0,'0.050'],[100,'800.000'],[101,'0.100'],[899,'50.000'],[900,'0.020']] as const)
        log.push(`2026-11-22T00:00:00.000000000Z ${at(startMs+offset)} [${1000+index}] LOG:  duration: ${ms} ms`);
      if(stop)return {timing:rows.join('\n')+'\n',dbLog:log};
    }
    rows.push(JSON.stringify(arm==='baseline'?{kind:'organization',organization:o,durationMs:200000}:{kind:'organization',organization:o,durationMs:200000,startedAtMs:base+o*201000,endedAtMs:base+o*201000+200000}));
  }
  return {timing:rows.join('\n')+'\n',dbLog:log};
}

// One seed diagnostic arm against fakes (no Docker): a full-size arm, or a rehearsal arm (#920) with the same collectors.
// Returns the arm's output directory.
async function seedDiagnosticArm(t:TestContext,outcome:string,rehearsal=false) {
  const path=temporary(t), events:string[]=[], listeners=new Map<string,()=>void>();
  const shape=rehearsal?{organizations:1,batchesPerOrganization:5}:{organizations:10,batchesPerOrganization:200};
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',
    scenario:'pool-overhead',attempts:3,mode:'formal',target:'local',seedDiagnostic:true,...(outcome.startsWith('baseline')?{seedBaseline:true}:{}),...(rehearsal?{seedRehearsal:true}:{}),
    reviewedPatchSha256:createHash('sha256').update(readFileSync(checkout+'/load/pool-overhead-baseline.patch')).digest('hex')};
  const stop={organization:6,batchIndex:124,durationMs:12166,baselineMs:983.941,rule:'message-batch',
    limitMs:2951.823,startedAtMs:100,endedAtMs:12266};
  const baseline=outcome.startsWith('baseline'), vmGap=outcome.endsWith('vm-gap'), interrupted=outcome==='interrupted'||outcome==='interrupted-late', stopped=outcome==='stop-rule'||interrupted;
  const {timing,dbLog}=diagnosticSeedRecords(baseline?'baseline':'instrumented',stopped,shape);
  const vmLogDirectory=path+'/vm';mkdirSync(vmLogDirectory);writeFileSync(vmLogDirectory+'/console.log','1970-01-01T00:00:00Z kernel: ok\n');
  const collectionFailure=outcome==='collection-failure'||vmGap;
  // vm-gap: the init.log followed since the seed start is rotated and removed before the collector reads it (retention
  // shorter than the seed), in either arm.
  if(vmGap)writeFileSync(vmLogDirectory+'/init.log','1970-01-01T00:00:00Z init: ok\n');
  // Written during the run: the copy skips VM logs last changed before the seed started.
  utimesSync(vmLogDirectory+'/console.log',new Date(Date.now()+3600000),new Date(Date.now()+3600000));
  // The DB log fetch after a late interrupt uses up the collection slack: the VM log copy must not run past it.
  if(outcome==='interrupted-late')t.mock.timers.enable({apis:['Date'],now:Date.now()});
  // A sampler wrongly started in the baseline arm is never stopped; mocked timers keep its next tick from outliving the test.
  if(baseline)t.mock.timers.enable({apis:['setTimeout']});
  let releaseSamplers:()=>void=()=>{};
  let follower:{log:string}|undefined;
  const samplersStopped=new Promise<void>(resolve=>{releaseSamplers=resolve;});
  const self='--- self 9 (sh) S 1 9 9 0 -1 0 0 0 0 0 1 1 0 0 20';
  const runtime:Runtime={vmLogDirectory,on:(signal,listener)=>{listeners.set(signal,listener);},off:()=>{},transfer:async()=>{},
    exec:async command=>{
      const text=command.args.join(' ');
      if(command.program==='tar')writeFileSync(command.args[2],'archive');
      if(command.program==='cp')cpSync(command.args[1]!,command.args[2]!);
      if(command.args[0]?.endsWith('dms-formal-local.ts'))return {code:0,stdout:'1'};
      // A sampler exec in the baseline arm shows up in the event list (asserted below) instead of failing inside the run.
      if(command.program==='iostat'||command.program==='vm_stat') {if(baseline && !events.includes('host sampler'))events.push('host sampler');return {code:0,stdout:'counters'};}
      if(command.program==='log') {events.push('host log');return {code:0,stdout:'powerd: ok'};}
      if(command.program==='docker' && baseline && command.log)events.push('sampler loop');
      if(command.program==='docker' && command.args.includes('touch')) {events.push('stop samplers');releaseSamplers();return {code:0,stdout:''};}
      if(command.program==='docker' && command.log) {
        // Each long-lived loop writes one complete sample, then runs until the stop file appears.
        writeFileSync(command.log,command.args.includes('PGOPTIONS=-c statement_timeout=2000')
          ?['--- pid 40','--- clk_tck 100','--- child 41',...Array.from({length:snapshotsPerSession},(_,i)=>['{"atMs":'+(i+1)+',"checkpointer":{},"wal":{},"io":[]}',...(outcome==='collection-failure'&&i===0?[]:['Time: 2.0 ms'])]).flat(),'--- psql-exit 0',self,'--- stopped'].join('\n')
          :['--- clk_tck 100','=== 1.0',...kernelFiles.map(file=>'==> '+file+' <=='),self,'--- stopped'].join('\n'));
        // The baseline arm never stops samplers, so a loop started there must not wait for a stop.
        if(!baseline)await samplersStopped;
        return {code:0,stdout:''};
      }
      // The instrumented arm follows the DB log: the stream replays the log, then delivers the end marker once it is written.
      if(text.includes('docker logs --follow')) {
        writeFileSync(command.log!,['2026-11-22T00:00:00.000000000Z 2026-11-22 00:00:00.000 UTC [42] LOG:  checkpoint starting: time',...dbLog].join('\n')+'\n');
        follower={log:command.log!};
        await new Promise(resolve=>command.signal?.addEventListener('abort',resolve,{once:true}));
        return {code:137,stdout:''};
      }
      if(command.program==='docker' && command.args[0]==='container' && command.args.includes('{{.State.StartedAt}}'))return {code:0,stdout:'2026-11-22T00:00:00.000000000Z'};
      if(command.program==='docker' && text.includes('RAISE LOG')) {
        events.push('db logs');
        if(outcome==='interrupted-late')t.mock.timers.tick(collectionSlackMs);
        appendFileSync(follower!.log,'2026-11-22T01:00:00.000000000Z 2026-11-22 01:00:00.000 UTC [77] LOG:  '+/fukulow-log-end-[0-9a-f]+/.exec(text)![0]+'\n');
        return {code:0,stdout:''};
      }
      if(text.includes('docker logs --timestamps')) {
        events.push('db logs');
        if(outcome==='interrupted-late')t.mock.timers.tick(collectionSlackMs);
        return {code:0,stdout:['2026-11-22T00:00:00.000000000Z 2026-11-22 00:00:00.000 UTC [42] LOG:  checkpoint starting: time',...(baseline?[]:dbLog)].join('\n')};
      }
      const roleRoot=/'([^']+\/dm-formal-[a-f0-9-]+\/(?:db|app|generator))\//.exec(text)?.[1];
      if(command.program==='sh' && roleRoot) {
        if(text.includes('umask 077')) {
          mkdirSync(roleRoot+'/harness',{recursive:true});
          t.after(()=>rmSync(resolve(roleRoot,'..'),{recursive:true,force:true}));
        }
        if(text.includes("'preflight'"))writeFileSync(roleRoot+'/preflight.json','{"machine":"local"}');
        if(text.includes("'app'") || text.includes("'database'"))writeFileSync(roleRoot+'/image.json','[{"Id":"stub"}]');
        if(text.includes("'app'"))writeFileSync(roleRoot+'/ca.crt','cert');
        if(text.includes("'seed'")) {
          events.push('seed');
          const workerState=JSON.parse(readFileSync(roleRoot+'/state.json','utf8'));
          assert.equal(workerState.seedDiagnostic,true);
          assert.equal(workerState.seedBaseline,baseline?true:undefined);
          assert.equal(workerState.pilot,false);
          assert.equal(workerState.loadScale,'1/25');
          assert.equal(workerState.seedRehearsal,rehearsal?true:undefined);
          mkdirSync(roleRoot+'/formal');
          writeFileSync(roleRoot+'/formal/seed-timing.jsonl',timing,{mode:0o600});
          if(outcome==='stop-rule')writeFileSync(roleRoot+'/formal/seed-stop.json',JSON.stringify(stop));
          if(vmGap) {
            appendFileSync(vmLogDirectory+'/init.log','1970-01-01T00:00:01Z init: lost\n');
            // Rotated aside before the new file exists, so Linux cannot hand the new file the freed inode.
            renameSync(vmLogDirectory+'/init.log',vmLogDirectory+'/init.log.19700101-000001.000');
            writeFileSync(vmLogDirectory+'/init.log','1970-01-01T00:00:02Z init: new\n');rmSync(vmLogDirectory+'/init.log.19700101-000001.000');
          }
          if(interrupted)listeners.get('SIGINT')!();
          return {code:outcome==='success'||collectionFailure||baseline?0:1,stdout:''};
        }
        if(text.includes("'cleanup'")) {
          assert.match(readFileSync(config.output+'/formal/db.log'+(outcome==='interrupted-late'?'.partial':''),'utf8'),/checkpoint starting/);
          events.push('cleanup');
        }
        assert.doesNotMatch(text,/'(?:restore|overhead-arm|generators|reduce)'/);
      }
      return {code:0,stdout:''};
    }};
  if(outcome==='success'||outcome==='baseline')assert.equal((await run(config,runtime)).infrastructureFailure,false);
  else if(collectionFailure)await assert.rejects(run(config,runtime),/Seed diagnostic record collection failed/);
  else await assert.rejects(run(config,runtime),/sh failed/);
  // After an interrupt the macOS log is skipped (recorded) so container removal is not delayed.
  assert.deepEqual(events,['seed',...(baseline?[]:['stop samplers']),'db logs',...(interrupted?[]:['host log']),'cleanup','cleanup','cleanup']);
  assert.equal(readFileSync(config.output+'/formal/seed-timing.jsonl','utf8'),timing);
  if(outcome!=='interrupted-late')assert.equal(readFileSync(config.output+'/formal/docker-vm/console.log','utf8'),'1970-01-01T00:00:00Z kernel: ok\n');
  else assert.ok(!existsSync(config.output+'/formal/docker-vm/console.log'),'no VM log is read once the collection slack is used up');
  if(!interrupted)assert.equal(readFileSync(config.output+'/formal/host.log','utf8'),'powerd: ok\n');
  assert.ok(!existsSync(config.output+'/db.log'),'the diagnostic keeps its DB log under formal/ only');
  assert.ok(!existsSync(config.output+'/private-state.json'));
  assert.ok(!existsSync(config.output+'/host-state.json'));
  assert.ok(!existsSync(config.output+'/overhead-comparison.json'));
  const summary=JSON.parse(readFileSync(config.output+'/summary.json','utf8'));
  const status=JSON.parse(readFileSync(config.output+'/status.json','utf8'));
  const metadata=JSON.parse(readFileSync(config.output+'/metadata.json','utf8'));
  const failed=existsSync(config.output+'/failure.json')?[JSON.parse(readFileSync(config.output+'/failure.json','utf8'))]:[];
  for(const record of [summary,status,metadata,...failed]) {
    assert.equal(record.label,rehearsal?'DIAGNOSTIC REHEARSAL':'DIAGNOSTIC');
    // A rehearsal is marked in every record; a full-size arm's records carry no rehearsal field at all.
    assert.equal(record.rehearsal,rehearsal?true:undefined);
    assert.equal('rehearsal' in record,rehearsal);
  }
  for(const record of [summary,status,...failed])assert.equal(record.status,'NOT EVALUATED');
  // The seed size the arm expects: the full fixture (10 Organizations of 200 batches) or the rehearsal's.
  assert.deepEqual(summary.conditions.shape,shape);
  assert.deepEqual(summary.attempts,[]);
  assert.deepEqual(summary.collectionFailures,vmGap?['docker-vm: partial']:collectionFailure?['db-samples.txt: postgres: sample timing missing']
    :outcome==='interrupted'?['host.log: failed']:outcome==='interrupted-late'?['db.log: redaction cut short: no time left before cleanup','db.log: server duration missing or incomplete on 1325 of 1325 batches','docker-vm: failed','host.log: failed']:[]);
  assert.equal(summary.infrastructureFailure,outcome!=='success'&&outcome!=='baseline');
  assert.equal(summary.arm,baseline?'baseline':'instrumented');
  assert.deepEqual(Object.keys(summary.conditions).sort(),['harnessSha256','imageDigest','limits','load','machine','mode','postgres','scenario','sha','shape']);
  assert.deepEqual(summary.collectionMissing,[]);
  assert.equal(summary.vmLogs.status,outcome==='interrupted-late'?'failed':vmGap?'partial':'complete');
  // Both arms use the one during-seed VM log collector: the same record shape, the same gap handling.
  assert.deepEqual(Object.keys(summary.vmLogs).sort(),outcome==='interrupted-late'||vmGap?['bytesRead','bytesWritten','polls','reason','sets','status']:['bytesRead','bytesWritten','polls','sets','status']);
  assert.ok(summary.vmLogs.bytesRead>0&&summary.vmLogs.bytesWritten>0,'observed collector I/O is recorded in both arms');
  assert.ok(summary.vmLogs.polls>=1);
  if(vmGap) {
    assert.match(summary.vmLogs.reason,/init: init\.log was removed before it was read to its end/);
    assert.ok(existsSync(config.output+'/formal/docker-vm/init.log.partial')&&!existsSync(config.output+'/formal/docker-vm/init.log'));
  }
  assert.equal(summary.hostLog.status,interrupted?'failed':'complete');
  const batches=stopped?6*200+125:shape.organizations*shape.batchesPerOrganization;
  assert.deepEqual([summary.overhead.batches.batches,summary.overhead.batches.missingRows,summary.overhead.batches.unexpectedRows],[batches,0,0]);
  if(baseline) {
    assert.deepEqual([summary.samplers,summary.hostSamples,summary.overhead.dockerExecs,summary.overhead.recorderMs],[null,null,null,null]);
    assert.equal(summary.overhead.instrumentationEffect,'baseline-arm');
    assert.equal(summary.overhead.batches.medianMs,1000);
    assert.ok(!existsSync(config.output+'/formal/seed-batch-server.jsonl'));
    return config.output;
  }
  assert.equal(summary.samplers.kernel.samples,1);
  assert.equal(summary.samplers.postgres.samples,3);
  assert.equal(summary.hostSamples.complete,true);
  assert.equal(summary.overhead.dockerExecs,3,'two long-lived loops and one stop exec, not one exec per second');
  assert.equal(summary.overhead.kernelLoopCpuSeconds,0.02);
  assert.equal(summary.overhead.instrumentationEffect,'unevaluated','the effect is claimed only by the matched comparison');
  assert.deepEqual([summary.overhead.batches.medianDbClockSpanMs,summary.overhead.batches.medianServerMs,summary.overhead.batches.serverMissing,summary.overhead.recorderMs.max],[900,outcome==='interrupted-late'?null:850.17,outcome==='interrupted-late'?1325:0,0.1]);
  const server=readFileSync(config.output+'/formal/seed-batch-server.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(server.length,batches);
  const late=outcome==='interrupted-late';
  // A late interrupt leaves no time: the redaction keeps only the first line, so no batch has a server duration.
  assert.deepEqual(server[1],{organization:0,batchIndex:1,durationMs:1000,dbClockSpanMs:900,serverMs:late?null:850.17,serverStatements:late?0:5});
  const dbLogFile=config.output+'/formal/db.log'+(late?'.partial':'');
  if(late)assert.equal(readFileSync(dbLogFile,'utf8').trim().split('\n').length,1);
  else assert.match(readFileSync(dbLogFile,'utf8'),/duration: 800\.000 ms/);
  assert.doesNotMatch(readFileSync(dbLogFile,'utf8'),/fukulow-log-end/,'the end marker is not kept');
  assert.equal(summary.dbLogStream.status,outcome==='interrupted-late'?'partial':'complete');
  assert.equal(summary.dbLogStream.marker,'seen');
  assert.equal(summary.dbLogStream.rawRemoved,true);
  assert.equal(summary.overhead.dbLogDockerExecs,3,'one inspect, one follower and one marker exec');
  for(const file of ['db-kernel.txt','db-samples.txt'])assert.ok(existsSync(config.output+'/formal/'+file));
  assert.deepEqual(readdirSync(config.output+'/formal').filter(file=>/\.(?:raw|partial)/.test(file)),outcome==='interrupted-late'?['db.log.partial']:[],'no raw sampler output in the artifact directory');
  assert.deepEqual(readdirSync(resolve(follower!.log,'..')).filter(file=>file.startsWith('db-log-follow')),[],'the raw DB log stream is removed');
  if(stopped) {
    const failure=JSON.parse(readFileSync(config.output+'/failure.json','utf8'));
    assert.deepEqual(status.seedStop,failure.seedStop);
    if(outcome==='stop-rule')assert.deepEqual(failure.seedStop,stop);
    else {
      assert.equal(failure.seedStop.rule,'seed-failure');
      assert.equal(failure.seedStop.organization,null);
      assert.ok(failure.seedStop.endedAtMs>=failure.seedStop.startedAtMs);
    }
  }
  return config.output;
}
for (const outcome of ['success','stop-rule','interrupted','collection-failure','interrupted-late','baseline','vm-gap','baseline-vm-gap']) test('seed diagnostic captures logs before cleanup on '+outcome, async t => {
  await seedDiagnosticArm(t,outcome);
});
// The rehearsal keeps every collector and the same collection checks: a collector failure still fails the arm.
for (const outcome of ['success','collection-failure','vm-gap','baseline','baseline-vm-gap']) test('seed diagnostic rehearsal runs every collector and captures logs before cleanup on '+outcome, async t => {
  await seedDiagnosticArm(t,outcome,true);
});

test('both rehearsal arms run and are compared as a rehearsal only; a rehearsal is never pair evidence or mixed with a full arm', async t => {
  // Instrumented arms first: the baseline arm mocks setTimeout for the rest of the test.
  const full=await seedDiagnosticArm(t,'success'), instrumented=await seedDiagnosticArm(t,'success',true), baseline=await seedDiagnosticArm(t,'baseline',true);
  const effect=(...args:string[])=>{
    const result=spawnSync(process.execPath,[checkout+'/load/dms-formal-seed-effect.ts',...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  const rehearsed=effect('--rehearsal',instrumented,baseline);
  assert.deepEqual([rehearsed.status,rehearsed.rehearsal,rehearsed.reasons,rehearsed.medianBatchDeltaMs],['rehearsal-compared',true,[],0]);
  assert.deepEqual([rehearsed.instrumented.batches,rehearsed.baseline.batches],[5,5]);
  assert.match(rehearsed.evidence,/never pair evidence/);
  const pair=effect(instrumented,baseline);
  assert.deepEqual([pair.status,pair.reasons],['unevaluated',['instrumented arm is a rehearsal, never pair evidence','baseline arm is a rehearsal, never pair evidence']]);
  assert.equal('medianBatchDeltaMs' in pair,false);
  for(const args of [[full,baseline],['--rehearsal',full,baseline]]) {
    const mixed=effect(...args);
    assert.equal(mixed.status,'unevaluated');
    assert.ok(mixed.reasons.includes('a rehearsal arm and a full-size arm are never compared'),mixed.reasons.join('; '));
  }
});
