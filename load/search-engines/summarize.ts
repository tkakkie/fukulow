import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { percentile, save } from './bench.ts';

type Latency = {query:string,n:number,p50:number,p95:number,p99:number,tps:number};
type Run = {round:number,engine:string,buildMs:number,relationBytes:number,physicalDeltaBytes:number,
  write:Latency,walBytesPerInsert:number,latencies?:Latency[]};
const root = resolve(process.argv[2] ?? '');
const runs: Run[] = JSON.parse(readFileSync(`${root}/results.json`,'utf8'));
if (runs.length!==12) throw new Error('Expected all 12 interleaved runs');
const stats = (xs: number[]) => ({median:percentile(xs,.5),min:Math.min(...xs),max:Math.max(...xs)});
const summary = ['none','trgm','bigm','pgroonga'].map(engine=>{
  const group = runs.filter(r=>r.engine===engine);
  if (group.length!==3) throw new Error('Expected three repetitions');
  const baseline = runs.filter(r=>r.engine==='none');
  return {engine,buildMs:stats(group.map(r=>r.buildMs)),relationBytes:stats(group.map(r=>r.relationBytes)),
    physicalDeltaBytes:stats(group.map(r=>r.physicalDeltaBytes)),
    write:Object.fromEntries(['p50','p95','p99','tps'].map(key=>[key,stats(group.map(r=>r.write[key as 'p50'|'p95'|'p99'|'tps']))])),
    walBytesPerInsert:stats(group.map(r=>r.walBytesPerInsert)),
    writeTpsChange:stats(group.map(r=>100*(r.write.tps/(baseline.find(b=>b.round===r.round)?.write.tps ?? NaN)-1))),
    latencies:(group[0]?.latencies ?? []).map(q=>({query:q.query,
      ...Object.fromEntries(['p50','p95','p99'].map(key=>[key,stats(group.map(r=>{
        const found = r.latencies?.find(l=>l.query===q.query);
        if (!found) throw new Error(`Missing query ${q.query}`);
        return found[key as 'p50'|'p95'|'p99'];
      }))])),samples:group.reduce((n,r)=>n+(r.latencies?.find(l=>l.query===q.query)?.n ?? 0),0)}))};
});
save(`${root}/summary.json`,summary);
console.log(JSON.stringify(summary,null,2));
