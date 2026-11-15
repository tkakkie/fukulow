import { createReadStream, readFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { checked, type Executor } from './dms-formal-exec.ts';
import { commonWindow, judge, reconcile, type LedgerRow, type Evidence } from './dms-formal-judgment.ts';
import { percentile } from './dms-workload.ts';
import { productionPoolEvidence } from './dms-formal-pool.ts';
export type SendRow = LedgerRow & { started:number; completed:number; status:number; bodyBytes:number };
export async function* lines(path: string) { for await (const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})) yield line; }
export function parseSend(line: string): SendRow | undefined {
  const marker = line.indexOf('DM_SEND ');
  if (marker < 0) return;
  // Formal k6 uses --log-format raw. Do not silently swallow malformed ledger records.
  return JSON.parse(line.slice(marker+8)) as SendRow;
}
async function reduceAttempt(directory: string, mode: 'formal' | 'smoke', exec: Executor) {
  const exits = JSON.parse(readFileSync(`${directory}/exits.json`,'utf8')) as {shard:number;code:number}[];
  const expected=mode==='smoke'?[0,10]:Array.from({length:11},(_,i)=>i);
  if(!Array.isArray(exits) || exits.length!==expected.length || new Set(exits.map(row=>row.shard)).size!==expected.length || expected.some(shard=>!exits.some(row=>row.shard===shard && Number.isInteger(row.code))))throw new Error('Invalid expected shard manifest');
  for(const {shard} of exits)for(const file of ['metrics.json','run.log','summary.json'])if(!existsSync(`${directory}/shard-${shard}/${file}`))throw new Error('Missing shard evidence');
  const {from,to} = commonWindow(JSON.parse(readFileSync(`${directory}/window-starts.json`,'utf8')),mode);
  const envArgs = [`DM_FORMAL_MODE=${mode}`,'DM_SHARDS=11',`DM_WINDOW_FROM=${from}`,`DM_WINDOW_TO=${to}`,`DM_SOCKETS=${mode === 'smoke' ? 20 : 10000}`];
  await checked(exec,{program:'env',args:[...envArgs,process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),directory],timeout:600000,log:`${directory}/summary.log`});
  const combined = JSON.parse(readFileSync(`${directory}/combined.json`,'utf8'));
  let sampleSummary=combined;
  if(mode==='formal') {
    const extended=`${directory}/extended`;mkdirSync(extended,{mode:0o700});
    for(let i=0;i<11;i++)if(existsSync(`${directory}/shard-${i}`))symlinkSync(`${directory}/shard-${i}`,`${extended}/shard-${i}`,'dir');
    await checked(exec,{program:'env',args:['DM_FORMAL_MODE=formal','DM_SHARDS=11',`DM_WINDOW_FROM=${from}`,`DM_WINDOW_TO=${to+240000}`,'DM_SOCKETS=10000',process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),extended],timeout:600000,log:`${extended}/summary.log`});
    sampleSummary=JSON.parse(readFileSync(`${extended}/combined.json`,'utf8'));
  }
  const organizations: unknown[] = [];
  const organizationsCore:unknown[]=[];
  for (let i=0;i<(mode === 'smoke' ? 1 : 10);i++) {
    const per = `${directory}/organization-${i}`; mkdirSync(per,{mode:0o700});
    symlinkSync(`${directory}/shard-${i}`,`${per}/shard-0`,'dir');
    await checked(exec,{program:'env',args:[`DM_FORMAL_MODE=${mode}`,'DM_SHARDS=1',`DM_WINDOW_FROM=${from}`,`DM_WINDOW_TO=${mode==='formal'?to+240000:to}`,`DM_SOCKETS=${mode === 'smoke' ? 20 : 1000}`,process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),per],timeout:600000,log:`${per}/summary.log`});
    organizations.push(JSON.parse(readFileSync(`${per}/combined.json`,'utf8')));
    await checked(exec,{program:'env',args:[`DM_FORMAL_MODE=${mode}`,'DM_SHARDS=1',`DM_WINDOW_FROM=${from}`,`DM_WINDOW_TO=${to}`,`DM_SOCKETS=${mode==='smoke'?20:1000}`,process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),per],timeout:600000,log:`${per}/core-summary.log`});
    organizationsCore.push(JSON.parse(readFileSync(`${per}/combined.json`,'utf8')));
  }
  const evidence: Evidence = {};
  evidence.generatorFailures = exits.filter(row=>row.code!==0).length;
  let errors = 0, dropped = 0, duplicateFrames = 0, byteFailures = 0, offered = 0, accepted = 0, issuedTimed = 0;
  // Partition reconciliation: no need to keep millions of ledger rows in operator RAM.
  const buckets = `${directory}/ledger-buckets`; mkdirSync(buckets,{mode:0o700});
  const { appendFileSync } = await import('node:fs');
  const bucket = (row: LedgerRow) => {
    if(!row || !['organization','member','channel'].every(key=>typeof row[key as keyof LedgerRow]==='string') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.client_message_id))throw new Error('Malformed ledger identity');
    return row.client_message_id.replaceAll('-','').slice(0,2).toLowerCase();
  };
  for (const {shard} of exits) {
    const summary = `${directory}/shard-${shard}/summary.json`;
    if (existsSync(summary)) {
      const metrics = JSON.parse(readFileSync(summary,'utf8')).metrics;
      const count=(key:string,optional=false)=>{
        const value=metrics[key]?.values?.count;
        const full=JSON.parse(readFileSync(summary,'utf8'));
        // k6 can omit an unused dropped_iterations series. A successful exit,
        // completed test duration and real iterations distinguish that omission
        // from partial/missing generator evidence.
        if(optional && value===undefined && exits.find(row=>row.shard===shard)?.code===0 && Number.isFinite(full.state?.testRunDurationMs) && full.state.testRunDurationMs>=(mode==='formal'?2640000:120000) && Number.isFinite(metrics.iterations?.values?.count) && metrics.iterations.values.count>0)return 0;
        if(!Number.isFinite(value) || value<0)throw new Error('Missing/malformed required metric '+key);
        return value as number;
      };
      duplicateFrames += count('dm_duplicate_frames');
      errors += count('dm_errors'); dropped += count('dropped_iterations',true);
    } else evidence.generatorFailures!++;
    for await (const line of lines(`${directory}/shard-${shard}/run.log`)) {
      const row = parseSend(line); if (!row) continue;
      if(![row.started,row.completed,row.status,row.bodyBytes].every(Number.isFinite))throw new Error('Malformed send outcome');
      if (row.bodyBytes!==1024) byteFailures++;
      if (row.started>=from && row.started<to) { issuedTimed++; if (row.status===201 && row.completed<to) accepted++; }
      appendFileSync(`${buckets}/${bucket(row)}-issued.jsonl`,JSON.stringify(row)+'\n',{mode:0o600});
    }
  }
  for await (const line of lines(`${directory}/durable.jsonl`)) { if (!line.trim()) continue; const row = JSON.parse(line) as LedgerRow; appendFileSync(`${buckets}/${bucket(row)}-durable.jsonl`,line+'\n',{mode:0o600}); }
  let missing=0, duplicates=0, unexpected=0;
  for(let n=0;n<256;n++) {
    const prefix = `${buckets}/${n.toString(16).padStart(2,'0')}`;
    const read = (path:string): LedgerRow[] => existsSync(path) ? readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
    const result = reconcile(read(`${prefix}-issued.jsonl`),read(`${prefix}-durable.jsonl`));
    missing+=result.missing; duplicates+=result.duplicates; unexpected+=result.unexpected;
  }
  offered = (mode === 'smoke' ? 2 : 2000)*(to-from)/1000;
  Object.assign(evidence,{'errors':errors,'dropped':dropped,'send.bodyByteFailures':byteFailures,'offered.deficit':Math.max(0,offered-issuedTimed),'send.uncommittedPercent':100*(1-accepted/offered),'send.undrained':missing+Math.max(0,offered-issuedTimed),'ledger.missing':missing,'ledger.duplicates':duplicates,'ledger.unexpected':unexpected,'peer.missing':combined.peerMissing == null ? null : Math.abs(combined.peerMissing),'duplicates':duplicateFrames});
  const classes = {open:['resolve','create','renew'],page:['refresh','delta'],ack:['send']} as const;
  let sampleDeficit=0;
  for (const [kind,shapes] of Object.entries(classes)) for(const p of ['p95','p99']) {
    const found: number[]=[];
    for(const org of organizations as typeof combined[]) for(const shape of shapes) {
      const latency=org.latencies[`dm_latency_ms:${shape}`];
      if (!latency) continue;
      found.push(latency[p]);

    }
    evidence[`${kind}.${p}`]=found.length===organizations.length*shapes.length ? Math.max(...found) : null;
  }
  for(const shape of ['resolve','create','renew','refresh','delta','send','first','deep']) sampleDeficit+=Math.max(0,10000-(sampleSummary.latencies[`dm_latency_ms:${shape}`]?.samples || 0));
  for (const shape of ['first','deep']) {
    const latency=sampleSummary.latencies[`dm_latency_ms:${shape}`];
    if (!latency) { evidence['page.p95']=null; evidence['page.p99']=null; }
    else { for(const p of ['p95','p99']) if(evidence[`page.${p}`]!=null) evidence[`page.${p}`]=Math.max(evidence[`page.${p}`]!,latency[p]); }
  }
  for(const [name,key] of [['peer','dm_receipt_ms'],['fiveAttemptRound','dm_round_ms:attempts=5']]) {
    sampleDeficit+=Math.max(0,10000-(sampleSummary.latencies[key]?.samples || 0));
    for(const p of ['p95','p99']) {
      const values=(organizations as typeof combined[]).map(org=>org.latencies[key]?.[p]);
      evidence[`${name}.${p}`]=values.every(Number.isFinite)?Math.max(...values):null;
    }
  }
  evidence.sampleDeficit=sampleDeficit;
  evidence['mix.missing']=(organizationsCore as typeof combined[]).reduce((sum,org)=>sum+[0,50,200].reduce((n,held)=>n+['delta','coverage','browse','recovery',...(held?['held']:[]),'completed5'].filter(lane=>(org.mixMembers?.[held+':'+lane]??0)<Array.from({length:mode==='smoke'?20:1000},(_,i)=>[0,50,200][i%3]).filter(value=>value===held).length).length,0),0);
  Object.assign(evidence,productionPoolEvidence(existsSync(`${directory}/app.log`)?readFileSync(`${directory}/app.log`,'utf8').split('\n'):[],from,to));
  evidence['connections.deficit']=combined.fullIntervals.some((interval:{start:number;end:number})=>interval.start<=from && interval.end>=to) ? 0 : 1;
  for(const role of ['app','db']) {
    const path=`${directory}/resources-${role}.jsonl`;
    if (!existsSync(path)) continue;
    const resources=readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.at>=from && row.at<to);
    const cpu=resources.filter(row=>row.cpu!=null && row.intervalMs>=800 && row.intervalMs<=1200).map(row=>row.cpu);
    const covered=(rows:{at:number}[])=>new Set(rows.map(row=>Math.floor((row.at-from)/1000))).size >= (to-from)/1000*.99;
    const coverage=covered(resources.filter(row=>Number.isFinite(row.cpu) && row.intervalMs>=800 && row.intervalMs<=1200));
    if(coverage) { evidence[`${role}.cpuMean`]=cpu.reduce((a,b)=>a+b,0)/cpu.length; evidence[`${role}.cpuP99`]=percentile(cpu,.99); }
    if(role==='app') {
      const rss=resources.filter(row=>row.rssKiB!=null).map(row=>row.rssKiB);
      evidence['app.rssKiB']=covered(resources.filter(row=>Number.isFinite(row.rssKiB) && row.rssKiB>0)) ? Math.max(...rss) : null;
      const first=resources.filter(row=>row.at<from+300000).map(row=>row.rssKiB).filter(Number.isFinite);
      const last=resources.filter(row=>row.at>=to-300000).map(row=>row.rssKiB).filter(Number.isFinite);
      const bins=(start:number,end:number)=>new Set(resources.filter(row=>row.at>=start && row.at<end && Number.isFinite(row.rssKiB) && row.rssKiB>0).map(row=>Math.floor(row.at/1000))).size;
      if(mode==='formal' && bins(from,from+300000)>=297 && bins(to-300000,to)>=297) { const avg=(v:number[])=>v.reduce((a,b)=>a+b,0)/v.length; evidence['app.rssGrowthPercent']=100*(avg(last)/avg(first)-1); }
    }
  }
  const judgment=judge(evidence,mode);
  const report={...judgment,window:{from,to},offered,issuedTimed,acceptedInWindow:accepted,drain:existsSync(`${directory}/drain.json`) ? JSON.parse(readFileSync(`${directory}/drain.json`,'utf8')) : null,reconciliation:{missing,duplicates,unexpected},evidence,organizations,organizationsCore,core:combined,sampleExtension:mode==='formal'?{from,to:to+240000,latencies:sampleSummary.latencies}:null,limitations:['Missing pool acquisition telemetry is NOT EVALUATED for an unmodified production image.','Plan/SQL qualification and deferred scenarios require separate evidence; raw probes are not an automatic plan PASS.','Counts and latency judgments use the same extended population; fixed core retained separately. RSS needs 99% distinct one-second bins and growth needs 297 bins in each five-minute endpoint.']};
  writeFileSync(`${directory}/judgment.json`,JSON.stringify(report,null,2),{mode:0o600});
  writeFileSync(`${directory}/judgment.md`,`${judgment.label}\n\nAcceptance: ${judgment.acceptance ? 'PASSED' : 'NOT PASSED'}\n\n| Budget | Limit | Observed | Judgment |\n|---|---:|---:|---|\n${judgment.rows.map(row=>`| ${row.budget} | ${row.limit} | ${row.value ?? 'missing'} | ${row.status} |`).join('\n')}\n`,{mode:0o600});
  return report;
}
export async function reportAttempt(directory:string,mode:'formal'|'smoke',exec:Executor) {
  try { return await reduceAttempt(directory,mode,exec); }
  catch(error) {
    const report={...judge({},mode),infrastructureFailure:true,evidence:{},error:error instanceof Error?error.message:'Malformed evidence'};
    writeFileSync(`${directory}/judgment.json`,JSON.stringify(report,null,2),{mode:0o600});
    writeFileSync(`${directory}/judgment.md`,report.label+'\n\nAcceptance: NOT PASSED; evidence reduction failed. All budgets NOT EVALUATED.\n',{mode:0o600});
    return report;
  }
}
