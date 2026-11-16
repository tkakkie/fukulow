import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, linkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readConfig } from './dms-formal-config.ts';
import { arrivalRate, scaledSocketMember } from './dms-formal-scenarios.ts';
import { scaledLoad, apparentBytes, dockerfileBases } from './dms-formal-local.ts';
import { concurrentBrowsingReasons, type OfferedBucket } from './dms-formal-concurrency.ts';
import { overheadConditionKeys, overheadOrder, overheadMetrics, overheadClasses, judgeOverhead, type OverheadArm } from './dms-formal-overhead.ts';
import { execute } from './dms-formal-exec.ts';
const temporary=(t:{after:(fn:()=>void)=>void})=>{const dir=mkdtempSync(tmpdir()+'/ohmac-test-');t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
function config(t:Parameters<typeof temporary>[0],extra='',pilot=false) {
  const dir=temporary(t),file=dir+'/runner.env';
  writeFileSync(file,`DM_FORMAL_TARGET=local\nDM_FORMAL_SHA=${'a'.repeat(40)}\nDM_FORMAL_OUTPUT=${dir}/output\n${extra}`,{mode:0o600});
  return ()=>readConfig(file,resolve(import.meta.dirname,'..'),pilot);
}
for(const scenario of ['main','held200'])for(const mode of ['formal','smoke'])test('local refuses '+scenario+' '+mode,t=>{
  assert.throws(config(t,`DM_FORMAL_SCENARIO=${scenario}\nDM_FORMAL_MODE=${mode}\n`),/main\/held200/);
});
test('local smoke is explicit and cannot become formal acceptance',t=>{
  assert.equal(config(t,'DM_FORMAL_SCENARIO=smoke\nDM_FORMAL_MODE=smoke\nDM_FORMAL_ATTEMPTS=1\n')().target,'local');
  assert.throws(config(t,'DM_FORMAL_SCENARIO=smoke\n'),/smoke mode/);
});
test('one rational uniformly scales sockets, senders, sends, opens and browsing and records all rates',()=>{
  const load=scaledLoad('2/20');assert.equal(load.factor,'1/10');
  for(const key of ['socketsPerOrganization','sockets','sendersPerOrganization','sendsPerOrganization','sends','opensPerOrganization','opens','resolvePerOrganization','createPerOrganization','renewPerOrganization','browsing','first','deep'] as const)assert.equal(load[key],scaledLoad()[key]/10,key);
  assert.equal(load.organizations,10);assert.equal(JSON.parse(JSON.stringify(load)).factor,'1/10');
  for(const invalid of ['0/1','2/1','1/0','0.1','1/101','1/1000','1/100'])assert.throws(()=>scaledLoad(invalid));
});
test('local config records limits and scale; short timing is pilot-only',t=>{
  const text=`DM_FORMAL_SCENARIO=pool-overhead\nDM_FORMAL_REVIEWED_PATCH_SHA256=${'a'.repeat(64)}\nDM_FORMAL_LOAD_SCALE=1/10\nDM_FORMAL_APP_CPU=1.5\nDM_FORMAL_DB_MEMORY=3g\n`;
  const c=config(t,text)();assert.equal(c.loadScale,'1/10');assert.equal(c.limits?.appCpu,1.5);assert.equal(c.limits?.dbMemory,'3g');
  assert.throws(config(t,text+'DM_FORMAL_PILOT_SECONDS=30\n'),/pilot-only/);
  assert.equal(config(t,text+'DM_FORMAL_PILOT_SECONDS=30\n',true)().pilotSeconds,30);
});
function arms():OverheadArm[] {return overheadOrder.map(arm=>({label:'MAC-RELATIVE',arm,metrics:Object.fromEntries(overheadMetrics.map(k=>[k,100])),samples:Object.fromEntries(Object.keys(overheadClasses).map(k=>[k,100])),conditions:{...Object.fromEntries(overheadConditionKeys.map(k=>[k,'same'])),target:'local',label:'MAC-RELATIVE',loadScale:'1/10'},imageDigest:'sha256:'+(arm==='B'?'b':'c').repeat(64),reasons:[]}));}
test('local comparison is labelled MAC-RELATIVE, never formal acceptance; a differing scale invalidates all metrics',()=>{
  const rows=arms(),report=judgeOverhead(rows);assert.equal(report.status,'PASS');assert.equal(report.label,'MAC-RELATIVE');assert.equal(report.acceptance,false);
  rows[4]!.conditions.loadScale='1/5';const invalid=judgeOverhead(rows);assert.equal(invalid.status,'NOT EVALUATED');assert.ok(invalid.rows.every(r=>r.status==='NOT EVALUATED'));assert.match(invalid.reasons.join(),/loadScale/);
});
test('scaled Q4 uses full targets, retains one-offer boundaries and rejects a 1% shortfall',()=>{
  const load=scaledLoad('1/10'),core={from:1000000,to:1120000};
  const buckets:OfferedBucket[]=Array.from({length:2},(_,i)=>{const from=core.from+i*60000;return {from,to:from+60000,offered:{send:1200,resolve:6,create:3,renew:3,first:300,deep:300},rounds:Array.from({length:100},(_,index)=>[0,30000].map(offset=>{const member=scaledSocketMember(index,100,20);return {member,retained:member%2?50:0,at:from+offset,lanes:['delta','coverage','browse','recovery',member%2?'held':'delta']};})).flat()};});
  const summary={fullIntervals:[{start:core.from,end:core.to}],offeredWork:{bucketMs:60000,buckets}};
  const check=()=>concurrentBrowsingReasons(core,Array(10).fill(summary),summary,'main',load);
  assert.deepEqual(check(),[]);
  buckets[0]!.offered.send!--;buckets[1]!.offered.send!++;assert.deepEqual(check(),[]);
  buckets[1]!.offered.send!--;assert.match(check().join(),/whole-core offered send/);
  buckets[0]!.offered.send=1188;buckets[1]!.offered.send=1188;assert.match(check().join(),/outside one-offer/);assert.match(check().join(),/whole-core offered send/);
  buckets.forEach(b=>{b.offered.send=1200;b.offered.first=297;});assert.match(check().join(),/whole-core offered first/);
  buckets[1]!.offered.first=303;assert.match(check().join(),/offered first outside one-offer/);
});
test('portable apparent size matches GNU du -sb semantics for files, directories, links and hard links',t=>{
  const dir=temporary(t);mkdirSync(dir+'/sub');writeFileSync(dir+'/sub/file','abc');linkSync(dir+'/sub/file',dir+'/hard');symlinkSync('sub/file',dir+'/symbolic');
  const expected=lstatSync(dir).size+lstatSync(dir+'/sub').size+3+lstatSync(dir+'/symbolic').size;
  assert.equal(apparentBytes(dir),expected);assert.equal(apparentBytes(dir+'/symbolic'),lstatSync(dir+'/symbolic').size);
});
test('portable timeout owns and cancels descendants, and records incomplete output',async t=>{
  const dir=temporary(t),log=dir+'/command.log';
  await assert.rejects(execute({program:process.execPath,args:['-e',`console.log('partial');require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)`],timeout:500,log}),/timeout/);
  assert.equal(JSON.parse(readFileSync(log+'-retention.json','utf8')).complete,false);
});

test('scaled cohorts preserve Guest, subscription, retained and ordinary target mix and all sender peers',()=>{
  for(const factor of ['1/50','1/10','1/1']) {
    const load=scaledLoad(factor),members=Array.from({length:load.socketsPerOrganization},(_,i)=>scaledSocketMember(i,load.socketsPerOrganization,load.sendersPerOrganization));
    assert.equal(new Set(members).size,members.length);
    assert.equal(members.filter(i=>i>=900).length,members.length/10);
    assert.equal(members.filter(i=>i%2).length,members.length/2);
    for(let lane=0;lane<4;lane++)assert.equal(members.filter(i=>i%4===lane).length,members.length/4);
    for(let sender=0;sender<load.sendersPerOrganization;sender++)assert.ok(members.includes(sender)&&members.includes(sender^1));
  }
});

test('portable streaming SHA-256 matches the GNU sha256sum digest field',async t=>{
  const {sha256File}=await import('./dms-formal-local.ts');const dir=temporary(t),path=dir+'/bytes';writeFileSync(path,'abc');
  assert.equal(await sha256File(path),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('local executor runs a labelled single-arm pilot using bounded copies with no SSH/scp/GNU timeout',async t=>{
  const {run}=await import('./dms-formal-run.ts');const {createHash}=await import('node:crypto');
  const dir=temporary(t),output=dir+'/output',events:string[]=[],roots=new Set<string>();
  const patch=createHash('sha256').update(readFileSync(import.meta.dirname+'/pool-overhead-baseline.patch')).digest('hex');
  const result=await run({target:'local',pilot:true,pilotSeconds:30,loadScale:'1/50',app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output,scenario:'pool-overhead',mode:'formal',attempts:3,reviewedPatchSha256:patch},{on:()=>{},off:()=>{},transfer:async()=>{throw new Error('No image transfer on shared daemon');},exec:async command=>{
    assert.ok(command.timeout);assert.ok(!['ssh','scp','timeout'].includes(command.program));
    events.push(command.program+' '+command.args.join(' '));
    const invocation=command.program==='sh'?/NODE_EXTRA_CA_CERTS='([^']+)\/ca.crt'.*dms-formal-host.ts' '([^']+)'/.exec(command.args[1]!):undefined;
    if(!invocation)return execute(command);
    const [,root,op]=invocation;roots.add(root!.replace(/\/(app|db|generator)$/,''));
    const save=(name:string,value:unknown)=>writeFileSync(root+'/'+name,JSON.stringify(value));
    if(op==='preflight')save('preflight.json',{machine:'same'});
    if(op==='build'){save('image.json',[{Id:'candidate'}]);save('source-toolchains.json',{sha:'a'.repeat(40)});}
    if(op==='database')save('image.json',[{Id:'candidate'}]);
    if(op==='app')writeFileSync(root+'/ca.crt','ca');
    if(op==='seed'){mkdirSync(root+'/formal');for(let i=0;i<10;i++)save('formal/org-'+i+'.json',{});save('deep.json',{});}
    if(op==='reduce') {
      const summary=dir+'/summary';mkdirSync(summary);writeFileSync(summary+'/judgment.json',JSON.stringify({label:'MAC-RELATIVE',pilot:true,acceptance:false,sustained:true}));
      return execute({program:'tar',args:['-czf',root+'/summary-1.tgz','-C',summary,'judgment.json'],timeout:10000});
    }
    return {code:0,stdout:''};
  }});
  for(const root of roots)rmSync(root,{recursive:true,force:true});
  assert.equal(result.attempts.length,1);assert.equal(JSON.parse(readFileSync(output+'/metadata.json','utf8')).load.factor,'1/50');
  assert.equal(JSON.parse(readFileSync(output+'/pilot.json','utf8')).label,'MAC-RELATIVE');
  assert.equal(JSON.parse(readFileSync(output+'/summary.json','utf8')).acceptance,false);
  assert.ok(events.some(e=>e.startsWith('cp -pR ')));assert.ok(events.every(e=>!e.includes('timeout --signal')));
});

test('fractional rates use exact integral k6 schedules; unscaled schedules stay unchanged',()=>{
  assert.deepEqual(arrivalRate(200),{rate:200,timeUnit:'1s'});
  assert.deepEqual(arrivalRate(.04),{rate:1,timeUnit:'25000ms'});
  assert.deepEqual(arrivalRate(.28),{rate:7,timeUnit:'25000ms'});
  for(let n=1;n<=50;n++) {
    const load=scaledLoad(n+'/50'),members=Array.from({length:load.socketsPerOrganization},(_,i)=>scaledSocketMember(i,load.socketsPerOrganization,load.sendersPerOrganization));
    assert.equal(new Set(members).size,members.length);
    assert.equal(members.filter(i=>i>=900).length,members.length/10);
    for(let lane=0;lane<4;lane++)assert.equal(members.filter(i=>i%4===lane).length,members.length/4);
    const schedule=arrivalRate(load.opensPerOrganization),ms=schedule.timeUnit==='1s'?1000:Number(schedule.timeUnit.slice(0,-2));
    assert.equal(schedule.rate*load.denominator*1000,2*load.numerator*ms);
  }
});

test('local summary output carries MAC-RELATIVE through the raw reducer',async t=>{
  const dir=temporary(t);mkdirSync(dir+'/shard-0');
  writeFileSync(dir+'/shard-0/metrics.json',JSON.stringify({type:'Point',metric:'dm_connections',data:{time:new Date(1000).toISOString(),value:20,tags:{}}})+'\n');
  const result=await execute({program:process.execPath,args:[import.meta.dirname+'/dms-summary.ts',dir],env:{...process.env,DM_SHARDS:'1',DM_FORMAL_MODE:'formal',DM_FORMAL_TARGET:'local',DM_WINDOW_FROM:'0',DM_WINDOW_TO:'2000'},timeout:10000});
  assert.equal(result.code,0);const summary=JSON.parse(readFileSync(dir+'/combined.json','utf8'));assert.equal(summary.label,'MAC-RELATIVE');assert.equal(summary.acceptance,false);
});

test('scaled fractional Q4 targets use exact ceil, including a decimal that would round above an integer',()=>{
  const load=scaledLoad('7/50'),core={from:1000000,to:1300000};
  const buckets:OfferedBucket[]=Array.from({length:5},(_,i)=>{
    const from=core.from+i*60000;
    return {from,to:from+60000,offered:{send:1680,resolve:i<3?8:9,create:i<4?4:5,renew:i<4?4:5,first:420,deep:420},rounds:Array.from({length:load.socketsPerOrganization},(_,index)=>[0,30000].map(offset=>{
      const member=scaledSocketMember(index,load.socketsPerOrganization,load.sendersPerOrganization);
      return {member,retained:member%2?50:0,at:from+offset,lanes:['delta','coverage','browse','recovery',member%2?'held':'delta']};
    })).flat()};
  });
  const summary={fullIntervals:[{start:core.from,end:core.to}],offeredWork:{bucketMs:60000,buckets}};
  assert.deepEqual(concurrentBrowsingReasons(core,Array(10).fill(summary),summary,'main',load),[]);
});

test('local log-reader shutdown drains output and distinguishes an expected kill from an early exit',async t=>{
  const {captureAppLogs}=await import('./dms-formal-logs.ts');const {setTimeout:delay}=await import('node:timers/promises');
  const dir=temporary(t);
  const stop=captureAppLogs(dir,['-e',"console.error('retained');setInterval(()=>{},1000)"],undefined,process.execPath,'controlled','SIGKILL');
  await delay(200);const manifest=await stop();assert.equal(manifest.complete,true);assert.match(readFileSync(dir+'/controlled.log','utf8'),/retained/);
  const early=captureAppLogs(dir,['-e',"console.error('early');process.exit(1)"],undefined,process.execPath,'early','SIGKILL');
  await delay(200);assert.equal((await early()).complete,false);
});

test('local build checks only external Dockerfile bases, not earlier stage names', () => {
  const dockerfile='FROM rust:1@sha256:a AS rust-base\nFROM rust-base AS wasm\nFROM node:2@sha256:b AS web\nFROM Rust-Base as server\nFROM debian:3@sha256:c\n  from --platform=linux/arm64 alpine:4@sha256:d AS tools\nFROM --platform=linux/arm64 tools\n';
  assert.deepEqual(dockerfileBases(dockerfile),['rust:1@sha256:a','node:2@sha256:b','debian:3@sha256:c','alpine:4@sha256:d']);
  assert.deepEqual(dockerfileBases(readFileSync(resolve(import.meta.dirname,'../Dockerfile'),'utf8')).every(pin=>/@sha256:[a-f0-9]{64}$/.test(pin)),true);
});
