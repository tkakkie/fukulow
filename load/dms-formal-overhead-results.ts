import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { checked, type Executor } from './dms-formal-exec.ts';
import { concurrentBrowsingReasons } from './dms-formal-concurrency.ts';
import { productionPoolEvidence } from './dms-formal-pool.ts';
import { overheadClasses, type OverheadArm } from './dms-formal-overhead.ts';

function retainedLog(path:string,manifest:{bytes?:number;complete?:boolean}) {
  try {
    const file=lstatSync(path);
    return manifest.complete===true && typeof manifest.bytes==='number' && Number.isSafeInteger(manifest.bytes) && manifest.bytes>0 && file.isFile() && file.size===manifest.bytes;
  } catch {return false;}
}

type Resource={at:number;intervalMs:number;cpu:number;rssKiB:number;identity?:unknown};
export function overheadResources(rows:Resource[],from:number,to:number) {
  const core=rows.filter(r=>r.at>=from && r.at<to),seconds=(to-from)/1000;
  const covered=(list:Resource[])=>new Set(list.map(r=>Math.floor((r.at-from)/1000))).size>=seconds*.99;
  const cpu=core.filter(r=>Number.isFinite(r.cpu) && r.cpu>=0 && r.intervalMs>=800 && r.intervalMs<=1200);
  const rss=core.filter(r=>Number.isFinite(r.rssKiB) && r.rssKiB>0);
  const reasons:string[]=[];
  if(!covered(cpu)||!covered(rss))reasons.push('Resource coverage below 99% one-second samples');
  if(!rows.length || rows.some(r=>!r.identity || JSON.stringify(r.identity)!==JSON.stringify(rows[0]?.identity)))reasons.push('Container restart, changed start time or conditions');
  return {reasons,metrics:{'app.cpuMean':cpu.reduce((n,r)=>n+r.cpu,0)/cpu.length,'app.rssKiB':rss.length?Math.max(...rss.map(r=>r.rssKiB)):NaN}};
}
export async function reportOverheadArm(directory:string,exec:Executor) {
  const read=(name:string)=>JSON.parse(readFileSync(directory+'/'+name,'utf8'));
  try {
    const context=read('overhead-context.json'),{from,to}=context.window;
    const reasons:string[]=[];
    if(!/^[a-f0-9]{40}$/.test(context.sha) || !/^[a-f0-9]{64}$/.test(context.patchSha256) || context.toolchains?.sha!==context.sha)reasons.push('Missing/mismatched source provenance');
    if(!Number.isFinite(context.epoch) || from!==context.epoch+600000 || to!==from+300000)throw new Error('Invalid shortened ramp/warm/core window');
    if(!context.generatorBefore || JSON.stringify(context.generatorBefore)!==JSON.stringify(context.generatorAfter))reasons.push('Changed generator host/toolchains');
    const configurations=context.generator?.configurations;
    if(!Array.isArray(configurations) || configurations.length!==11)throw new Error('Missing generator configuration');
    configurations.forEach((config:Record<string,string>,i:number)=>{
      const expected={DM_FORMAL:'1',DM_FORMAL_SCENARIO:'main',DM_EPOCH:String(context.epoch),DM_SECONDS:'605',DM_SEND_START:'300',DM_CONNECT_INTERVAL_MS:'30000',DM_SOCKETS:'1000',DM_SENDERS:'200',DM_RATE:i===10?'0':'200',DM_OPEN_RATE:i===10?'0':'2',DM_BROWSE_RATE:i===10?'100':'0',DM_BROWSER_ONLY:i===10?'1':'0',DM_LEDGER:'1',DM_SMOKE:'0'};
      if(Object.entries(expected).some(([key,value])=>config[key]!==value))reasons.push('Mismatched generator configuration');
    });
    const generatorLimits:unknown[]=[];
    const summaries=[];
    for(let shard=0;shard<11;shard++) {
      for(const file of ['metrics.json','run.log','summary.json'])if(!existsSync(`${directory}/shard-${shard}/${file}`))throw new Error('Missing generator log');
      if(!retainedLog(`${directory}/shard-${shard}/run.log`,read(`shard-${shard}/run.log-retention.json`)))throw new Error('Missing/incomplete generator logs');
      const dir=directory+'/overhead-'+shard;mkdirSync(dir,{mode:0o700});symlinkSync(`${directory}/shard-${shard}`,dir+'/shard-0','dir');
      await checked(exec,{program:'env',args:['DM_FORMAL_MODE=formal','DM_FORMAL_SCENARIO=main','DM_SHARDS=1',`DM_SOCKETS=${shard===10?10000:1000}`,`DM_WINDOW_FROM=${from}`,`DM_WINDOW_TO=${to}`,process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),dir],timeout:600000});
      summaries.push(JSON.parse(readFileSync(dir+'/combined.json','utf8')));
      const container=read(`shard-${shard}/container.json`);
      if(!container.limits)reasons.push('Missing generator resource limits');
      generatorLimits.push(container.limits);
      if(container.restarts!==0 || !Number.isFinite(container.startedAt) || container.startedAt>context.epoch || container.startedAt<container.createdAt || container.startedAt-container.createdAt>5000 || container.exit!==0 || container.image!==context.generatorBefore.k6)reasons.push('Generator container restart/start-time/image mismatch');
      const summary=read(`shard-${shard}/summary.json`),metrics=summary.metrics;
      for(const key of ['dm_errors','dropped_iterations']) {
        const count=metrics?.[key]?.values?.count;
        if(key==='dropped_iterations' && count===undefined && summary.state?.testRunDurationMs>=900000 && metrics?.iterations?.values?.count>0)continue;
        if(count!==0)reasons.push('Missing/nonzero '+key);
      }
    }
    const exits=read('exits.json');
    if(exits.length!==11 || new Set(exits.map((r:{shard:number})=>r.shard)).size!==11 || Array.from({length:11},(_,i)=>i).some(i=>!exits.some((r:{shard:number;code:number})=>r.shard===i && r.code===0)))reasons.push('Missing/failed generator');
    reasons.push(...concurrentBrowsingReasons({from,to},summaries.slice(0,10),summaries[10],'main'));
    const dbLog=read('db-log-retention.json');
    if(!retainedLog(directory+'/db.log',dbLog) || !Number.isFinite(dbLog.startedAt) || !Number.isFinite(dbLog.endedAt) || dbLog.startedAt>from || dbLog.endedAt<to)reasons.push('Missing/incomplete DB logs');
    const appLog=read('app-log-retention.json');
    if(!retainedLog(directory+'/app.log',appLog) || !Number.isFinite(appLog.startedAt) || !Number.isFinite(appLog.endedAt) || appLog.startedAt>from || appLog.endedAt<to)reasons.push('Missing/incomplete app logs');
    if(context.arm==='C' && retainedLog(directory+'/app.log',appLog))reasons.push(...productionPoolEvidence(readFileSync(directory+'/app.log','utf8').split('\n'),from,to,appLog).reasons);
    const resource=(role:string)=>readFileSync(directory+'/resources-'+role+'.jsonl','utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const appResources=overheadResources(resource('app'),from,to),dbResources=overheadResources(resource('db'),from,to);
    reasons.push(...appResources.reasons,...dbResources.reasons);
    const appObservation=read('overhead-observation-app.json'),dbObservation=read('overhead-observation-db.json');
    for(const observation of [appObservation,dbObservation]) {
      if(!observation.before?.host || !observation.before?.toolchains || observation.before?.toolchains?.source?.sha!==context.sha || !(observation.before?.limits?.cpu>0) || !(observation.before?.limits?.memory>0))reasons.push('Missing host/resource/toolchain evidence');
    }
    for(const observation of [appObservation,dbObservation])if(JSON.stringify(observation.before)!==JSON.stringify(observation.after))reasons.push('Changed host, toolchain or container conditions');
    const fixture=read('overhead-restore.json');
    if(!fixture.snapshot || fixture.snapshot!==fixture.expectedSnapshot)reasons.push('Missing/mismatched fixture snapshot');
    const metrics:Record<string,number>={...appResources.metrics},samples:Record<string,number>={};
    // Keep each request class and its population; no mixing with separate browsing Organization.
    const aggregate=directory+'/overhead-aggregate';mkdirSync(aggregate,{mode:0o700});
    for(let i=0;i<10;i++)symlinkSync(`${directory}/shard-${i}`,aggregate+'/shard-'+i,'dir');
    await checked(exec,{program:'env',args:['DM_FORMAL_MODE=formal','DM_FORMAL_SCENARIO=main','DM_SHARDS=10',`DM_WINDOW_FROM=${from}`,`DM_WINDOW_TO=${to}`,process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),aggregate],timeout:600000});
    const aggregateLatencies=JSON.parse(readFileSync(aggregate+'/combined.json','utf8')).latencies;
    for(const [shape,[,key]] of Object.entries(overheadClasses)) {
      const populations=(shape==='first'||shape==='deep'?[summaries[10]]:summaries.slice(0,10)).map(s=>s.latencies[key]);
      samples[shape]=populations.reduce((n,p)=>n+(p?.samples ?? 0),0);
      // Aggregate raw samples are reduced together, rather than averaging percentiles.
      const latency=(shape==='first'||shape==='deep'?summaries[10].latencies:aggregateLatencies)[key];
      for(const p of ['p95','p99'])metrics[shape+'.'+p]=latency?.[p];
      if(populations.some(p=>!p || p.samples<=0))reasons.push('Missing request class population '+shape);
    }
    const conditions={sha:context.sha,patchSha256:context.patchSha256,hosts:[appObservation.before.host,dbObservation.before.host,context.generator.host],limits:[appObservation.before.limits,dbObservation.before.limits,generatorLimits],snapshot:fixture.snapshot,generator:{...context.generator,configurations:configurations.map(({DM_EPOCH,...rest}:Record<string,string>)=>rest)},toolchains:[appObservation.before.toolchains,dbObservation.before.toolchains,context.toolchains]};
    for(const obs of [appObservation,dbObservation])if(obs.before.sha!==context.sha)reasons.push('Source SHA mismatch');
    if(appObservation.before.revision!==context.sha)reasons.push('Image SHA mismatch');
    if(appObservation.before.image!==context.expectedImage)reasons.push('Image digest mismatch');
    const report:OverheadArm={arm:context.arm,metrics,samples,conditions,imageDigest:appObservation.before.image,reasons};
    writeFileSync(directory+'/judgment.json',JSON.stringify(report,null,2),{mode:0o600});return report;
  } catch(error) {
    const report:OverheadArm={arm:'B',metrics:{},samples:{},conditions:{},imageDigest:'',reasons:[error instanceof Error?error.message:'Missing overhead evidence']};
    writeFileSync(directory+'/judgment.json',JSON.stringify(report),{mode:0o600});return report;
  }
}
