import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, existsSync, utimesSync, appendFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './dms-formal-config.ts';
import { judge } from './dms-formal-judgment.ts';
import { spawnSync } from 'node:child_process';
import { abortSettleMs, cleanupReserveMs, collectionEndMs, collectionSlackMs, dbLogCommand, dbLogTimeoutMs, hostStopMaxMs, localCleanupMs, run, samplerStopEndMs, seedDbLogMs, type Runtime } from './dms-formal-run.ts';
import type { Command } from './dms-formal-exec.ts';
import { kernelFiles, snapshotsPerSession, stopTiming } from './dms-formal-seed-samplers.ts';
import { checkout, temporary } from './dms-formal-run-fixture.ts';

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
test('deadline admission reserves an entire attempt and cleanup',async()=>{
  const {canStartAttempt,attemptBudgetMs,cleanupReserveMs}=await import('./dms-formal-run.ts');
  const config={mode:'formal',deadline:1000+attemptBudgetMs('formal')+cleanupReserveMs} as Config;
  assert.equal(canStartAttempt(config,1000),true);assert.equal(canStartAttempt(config,1001),false);
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
test('deferred selection records its scenario as NOT EVALUATED without contacting hosts',async t=>{
  const path=temporary(t);
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',scenario:'hot-DM',attempts:3,mode:'formal'};
  const unused=()=>{throw new Error('Deferred stub contacted a host');};
  const result=await run(config,{exec:unused,transfer:unused,on:unused,off:unused});
  assert.equal(result.acceptance,false);
  const summary=JSON.parse(readFileSync(config.output+'/summary.json','utf8'));
  assert.equal(summary.scenario,'hot-DM');assert.equal(summary.status,'NOT EVALUATED');
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
test('every transfer.log capture of the runner is redacted',async t=>{
  const {config,runtime}=stub(t,false);const original=runtime.exec;const logged:Command[]=[];
  runtime.exec=async command=>{if(command.log?.endsWith('/transfer.log'))logged.push(command);return original(command);};
  await assert.rejects(run(config,runtime));
  assert.ok(logged.length>0,'the preflight uploads write transfer.log');
  for(const command of logged)assert.equal(command.redactLog?.('cp: /Users/someone/x: Permission denied'),'cp: /Users/[user]/x: Permission denied',command.program);
});

test('a rehearsal is refused outside a seed diagnostic arm', async t => {
  const path=temporary(t);
  const config:Config={app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:path+'/output',scenario:'pool-overhead',attempts:3,mode:'formal',target:'local',seedRehearsal:true};
  await assert.rejects(run(config,{exec:async()=>{throw new Error('no host contact');},transfer:async()=>{},on:()=>{},off:()=>{}}),/Rehearsal requires a seed diagnostic arm/);
  assert.ok(!existsSync(config.output));
});

// The rows and DB log a seed diagnostic writes: per Organization 200 batches and its Organization row; each instrumented
// batch logs the opening clock query and Message INSERT durations. A stopped seed ends at Organization 6 batch 124.
function diagnosticSeedRecords(arm:'instrumented'|'baseline',stopped:boolean,shape={organizations:10,batchesPerOrganization:200}) {
  const base=Date.parse('2026-11-22T00:00:00Z'), rows:string[]=[], log:string[]=[];
  const at=(ms:number)=>new Date(ms).toISOString().replace('T',' ').replace('Z',' UTC');
  for(let o=0;o<shape.organizations;o++) {
    for(let b=0;b<shape.batchesPerOrganization;b++) {
      const index=o*201+b, startMs=base+index*1000, stop=stopped && o===6 && b===124, durationMs=stop?12166:b===0?2000:1000;
      rows.push(JSON.stringify(arm==='baseline'?{kind:'batch',organization:o,batchIndex:b,durationMs}
        :{kind:'batch',organization:o,batchIndex:b,durationMs,startedAtMs:startMs,endedAtMs:startMs+durationMs,dbClockStartMs:startMs,dbClockEndMs:startMs+900,dbClockSpanMs:900,dbBackendPid:1000+index,recorderMs:0.1}));
      for(const [offset,ms] of [[0,'0.050'],[899,'850.120']] as const)
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
  assert.deepEqual(server[1],{organization:0,batchIndex:1,durationMs:1000,dbClockSpanMs:900,serverMs:late?null:850.17,serverStatements:late?0:2});
  const dbLogFile=config.output+'/formal/db.log'+(late?'.partial':'');
  if(late)assert.equal(readFileSync(dbLogFile,'utf8').trim().split('\n').length,1);
  else assert.match(readFileSync(dbLogFile,'utf8'),/duration: 850\.120 ms/);
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
