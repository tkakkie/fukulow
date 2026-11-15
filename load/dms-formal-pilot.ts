import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { retainedLog, overheadResources } from './dms-formal-overhead-results.ts';
import { productionPoolEvidence } from './dms-formal-pool.ts';
import { scaledLoad } from './dms-formal-local.ts';

// A pilot diagnoses generator headroom and evidence capture. It has no latency
// judgment, no baseline, and cannot be passed to the six-arm comparison.
export async function reportPilot(directory:string) {
  const read=(name:string)=>JSON.parse(readFileSync(directory+'/'+name,'utf8'));
  const reasons:string[]=[], faults:string[]=[];
  let errors=0,dropped=0,load:unknown;
  try {
    const context=read('overhead-context.json'),{from,to}=context.window;
    const targets=scaledLoad(context.loadScale);load=targets;
    const seconds=context.generator?.settings?.seconds-5;
    if(!Number.isSafeInteger(seconds)||seconds!==15+(to-from)/1000)throw new Error('Missing/mismatched pilot timing');
    const offers=(base:number)=>Number((BigInt(base)*BigInt(targets.numerator)*BigInt(seconds)+BigInt(targets.denominator)-1n)/BigInt(targets.denominator));
    if(!context.pilot||context.arm!=='C'||context.target!=='local'||context.label!=='MAC-RELATIVE')throw new Error('Invalid pilot provenance');
    const exits=read('exits.json');
    if(exits.length!==11||new Set(exits.map((r:{shard:number})=>r.shard)).size!==11||exits.some((r:{shard:number;code:number})=>r.shard<0||r.shard>10||r.code!==0))faults.push('Missing/failed generator');
    for(let shard=0;shard<11;shard++) {
      const prefix=`shard-${shard}/`, summary=read(prefix+'summary.json'),c=read(prefix+'container.json');
      if(!retainedLog(directory+'/'+prefix+'run.log',read(prefix+'run.log-retention.json'))||!existsSync(directory+'/'+prefix+'metrics.json'))throw new Error('Missing/incomplete generator evidence');
      // Validate every JSONL record, including the tail; summaries alone cannot
      // establish that the retained output is complete.
      const points=readFileSync(directory+'/'+prefix+'metrics.json','utf8').trim().split('\n').map(line=>JSON.parse(line));
      const samples=points.filter(p=>p.type==='Point');
      if(!samples.length || samples.some(p=>typeof p.metric!=='string'||!p.data||!Number.isFinite(p.data.value)||!Number.isFinite(Date.parse(p.data.time))||!p.data.tags||typeof p.data.tags!=='object'))throw new Error('Missing/incomplete generator metric points');
      // The browsing stream legitimately ends before the half-open core end
      // (its final scheduled arrival is earlier). Reconcile the full scheduled
      // workload instead of treating a last-point timestamp as a heartbeat.
      const opened=offers(2),cycles=Math.floor(opened/4),remainder=opened%4,browsed=offers(100);
      const expected:Record<string,number>=shard===10?{first:Math.ceil(browsed/2),deep:Math.floor(browsed/2)}:{send:offers(200),resolve:cycles*2+Math.min(2,remainder),create:cycles+(remainder>=3?1:0),renew:cycles};
      const actual:Record<string,number>={};
      for(const p of samples.filter(p=>p.metric==='dm_offered'))actual[p.data.tags.shape]=(actual[p.data.tags.shape] ?? 0)+p.data.value;
      // A scheduler tick at the end boundary can add one offer; never permit
      // a deficit against the full scheduled target or percentage tolerance.
      const componentMismatch=Object.entries(expected).some(([kind,count])=>(actual[kind] ?? 0)<count||(actual[kind] ?? 0)>count+1);
      const unknown=Object.keys(actual).some(kind=>!Object.hasOwn(expected,kind));
      const total=(counts:Record<string,number>)=>Object.values(counts).reduce((n,v)=>n+v,0);
      const imbalance=shard===10&&Math.abs((actual.first ?? 0)-(actual.deep ?? 0))>1;
      if(componentMismatch||unknown||total(actual)>total(expected)+1||imbalance)throw new Error('Incomplete pilot offered-work evidence');
      const error=summary.metrics?.dm_errors?.values?.count;
      const drops=summary.metrics?.dropped_iterations?.values?.count;
      const rawErrors=samples.filter(p=>p.metric==='dm_errors').reduce((n,p)=>n+p.data.value,0);
      const rawDrops=points.filter(p=>p.type==='Point'&&p.metric==='dropped_iterations').reduce((n,p)=>n+p.data.value,0);
      // k6 omits a zero-valued dropped_iterations series. Successful completion
      // and the retained full raw output are both required for this case.
      if(!Number.isSafeInteger(error)||error<0||error!==rawErrors||!Number.isFinite(summary.state?.testRunDurationMs)||summary.state.testRunDurationMs<(to-context.epoch))throw new Error('Incomplete generator summary');
      if(drops!==undefined&&(!Number.isSafeInteger(drops)||drops<0||drops!==rawDrops))throw new Error('Invalid dropped-arrival evidence');
      errors+=error;dropped+=drops ?? rawDrops;
      if(c.restarts!==0||c.exit!==0||c.image!==context.generatorBefore.k6||c.startedAt>context.epoch||c.startedAt<c.createdAt||c.startedAt-c.createdAt>5000)faults.push('Generator restarted or changed conditions');
    }
    for(const role of ['app','db']) {
      const manifest=read(role+'-log-retention.json');
      if(!retainedLog(directory+'/'+role+'.log',manifest)||manifest.startedAt>from||manifest.endedAt<to)throw new Error('Incomplete '+role+' log evidence');
      const resources=readFileSync(directory+'/resources-'+role+'.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line));
      reasons.push(...overheadResources(resources,from,to).reasons);
      if(role==='app')reasons.push(...productionPoolEvidence(readFileSync(directory+'/app.log','utf8').split('\n'),from,to,manifest).reasons);
      const observation=read('overhead-observation-'+role+'.json');
      if(!observation.before||JSON.stringify(observation.before)!==JSON.stringify(observation.after))reasons.push('Changed '+role+' observation');
      if(role==='app' && (observation.before?.image!==context.expectedImage||observation.before?.revision!==context.sha))reasons.push('Changed candidate image provenance');
    }
    if(JSON.stringify(context.generatorBefore)!==JSON.stringify(context.generatorAfter))reasons.push('Changed generator conditions');
  } catch(error) {reasons.push(error instanceof Error?error.message:'Missing pilot evidence');}
  const completeEvidence=reasons.length===0 && faults.length===0;
  const report={label:'MAC-RELATIVE',pilot:true,acceptance:false,load,errors,dropped,zeroErrors:completeEvidence&&errors===0,zeroDroppedArrivals:completeEvidence&&dropped===0,completeEvidence,sustained:completeEvidence&&errors===0&&dropped===0&&faults.length===0,reasons:[...reasons,...faults],limits:'Short candidate-only diagnostic; never comparison or capacity evidence'};
  writeFileSync(directory+'/judgment.json',JSON.stringify(report,null,2),{mode:0o600});return report;
}
