import type { Evidence } from './dms-formal-judgment.ts';

export const waitEdges = [100,500,1000,5000,10000,25000,50000,100000,500000,1000000,5000000];
export const occupancyEdges = [0,1,2,4,8,16,24,32,48,64,100];
const waits = waitEdges.map(edge=>`wait_le_${edge}_us`);
const occupancy = occupancyEdges.map(edge=>`occupancy_le_${edge}`);
const outcomes = ['success','timeout','closed','io','database','other','cancelled'].map(name=>`acquire_${name}`);
const counters = [...waits,'wait_count',...occupancy,'occupancy_count',...outcomes];
const numeric = ['version','interval_ms','sample_sequence','sample_elapsed_ms','in_use','idle','waiting',...counters];
const fields = ['event','coverage','uncovered_paths',...numeric].sort();
export type PoolSample = { at:number; fields:Record<string,number|string> };
export type PoolRetention = { complete:boolean; startedAt:number; endedAt:number; reason?:string };
// Docker --timestamps adds an RFC3339 prefix. The JSON timestamp is the app's
// wall clock; elapsed_ms and sequence independently guard cadence and restarts.
export function parseProductionPoolLine(line:string):PoolSample|undefined {
  try {
    const row=JSON.parse(line.replace(/^\S+\s+(?=\{)/,''));
    const f=row.fields;
    if(!f || Object.keys(f).sort().join(',')!==fields.join(',') || f.event!=='pool_stats' || f.version!==1) return;
    if(!numeric.every(key=>Number.isSafeInteger(f[key]) && f[key]>=0) || !['coverage','uncovered_paths'].every(key=>typeof f[key]==='string'))return;
    if(typeof row.timestamp!=='string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(row.timestamp))return;
    const at=Date.parse(row.timestamp);
    if(!Number.isFinite(at) || f.interval_ms!==1000 || f.sample_sequence<1)return;
    return {at,fields:f};
  } catch { return; }
}
export function productionPoolEvidence(lines:string[],from:number,to:number,retention?:PoolRetention) {
  const reasons:string[]=[];
  const evidence:Evidence={};
  const fail=(reason:string)=>{for(const key of Object.keys(evidence))delete evidence[key];reasons.push(reason);return {evidence,reasons};};
  if(!retention || retention.complete!==true)return fail('Missing or incomplete app log retention manifest'+(retention?.reason?': '+retention.reason:''));
  if(retention.startedAt>from || retention.endedAt<to || !Number.isFinite(retention.startedAt) || !Number.isFinite(retention.endedAt))return fail('App log capture does not cover measurement window');
  if(!Number.isFinite(from) || !Number.isFinite(to) || to<=from)return fail('Invalid measurement window');
  const samples:PoolSample[]=[];
  for(const line of lines) {
    if(/measure_(hold|pool)/.test(line))return fail('Rejected measure_hold/measure_pool instrumentation');
    const sample=parseProductionPoolLine(line);
    if(sample) {
      if(sample.fields.coverage!=='application_after_connect')return fail('Unsupported coverage: '+sample.fields.coverage);
      if(sample.fields.uncovered_paths!=='startup_connect,migration_commands')return fail('Unsupported uncovered_paths: '+sample.fields.uncovered_paths);
      samples.push(sample);
    }
    else if(line.includes('pool_stats'))return fail('Invalid pool_stats version, exact field set, types or timestamp');
  }
  if(!samples.length)return fail('Missing pool_stats lines');
  // A restart or reader loss anywhere in the retained attempt is not evidence
  // from one uninterrupted process, even if it precedes the selected baseline.
  for(let i=1;i<samples.length;i++) {
    const f=samples[i].fields,p=samples[i-1].fields;
    if(Number(f.sample_sequence)<=Number(p.sample_sequence))return fail('Non-monotonic sample_sequence (process restart)');
    if(Number(f.sample_sequence)!==Number(p.sample_sequence)+1)return fail('sample_sequence gap (missing line or rotation loss)');
    if(counters.some(key=>Number(f[key])<Number(p[key])))return fail('Cumulative counter decrease (process restart)');
    if(samples[i].at<=samples[i-1].at)return fail('Non-monotonic pool sample timestamps');
  }
  // Do not sort: order is evidence of replacement, loss or clock reversal.
  const start=samples.findLastIndex(row=>row.at<=from);
  if(start<0 || from-samples[start].at>2000)return fail('Missing baseline at or within 2 s before window start');
  const finish=samples.findIndex((row,i)=>i>start && row.at>=to);
  if(finish<0 || samples[finish].at-to>2000)return fail('Missing end row at or within 2 s after window end');
  const rows=samples.slice(start,finish+1);
  for(let i=0;i<rows.length;i++) {
    const f=rows[i].fields;
    if(i===0)continue;
    const previous=rows[i-1];
    const gap=rows[i].at-previous.at;
    if(gap<=0 || gap>2000 || Number(f.sample_elapsed_ms)<=0 || Number(f.sample_elapsed_ms)>2000 || Math.abs(gap-Number(f.sample_elapsed_ms))>100)return fail('Sampling elapsed/wall-clock gap (maximum 2 s; clocks must agree within 100 ms)');
  }
  const first=rows[0],last=rows.at(-1)!;
  if(rows.length-1<(last.at-first.at)/1000*.99)return fail('Sampling coverage below 99% of expected one-second samples');
  const delta=(key:string)=>Number(last.fields[key])-Number(first.fields[key]);
  if(delta('wait_count')===0)return fail('Zero acquisitions in measurement window');
  const quantile=(keys:string[],edges:number[],count:number,q:number)=>{
    const values=[...keys.map(delta),count];
    if(values.some((value,i)=>value<0 || (i>0 && value<values[i-1])))throw new Error('Inconsistent cumulative histogram deltas');
    return [...edges,Number.MAX_SAFE_INTEGER][values.findIndex(value=>value>=Math.ceil(q*count))];
  };
  try {
    evidence['pool.p95']=quantile(waits,waitEdges,delta('wait_count'),.95)/1000;
    evidence['pool.p99']=quantile(waits,waitEdges,delta('wait_count'),.99)/1000;
    if(delta('occupancy_count')!==rows.length-1)throw new Error('Occupancy count does not match emitted samples');
    evidence['pool.activeP95']=quantile(occupancy,occupancyEdges,delta('occupancy_count'),.95);
  }catch(error) { return fail((error as Error).message); }
  const raw=rows.filter(row=>row.at>=from && row.at<=to);
  if(!raw.length)return fail('Missing raw occupancy samples inside measurement window');
  evidence['pool.peak']=Math.max(...raw.map(row=>Number(row.fields.in_use)));
  evidence['pool.timeouts']=delta('acquire_timeout');
  for(const key of outcomes)evidence[`pool.${key}`]=delta(key);
  return {evidence,reasons,window:{baseline:first.at,end:last.at,samples:rows.length,acquisitions:delta('wait_count')}};
}
