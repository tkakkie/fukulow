import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { percentile, save } from './bench.ts';
import { denialCases } from './definer.ts';

type Latency = {query:string,n:number,p50:number,p95:number,p99:number,tps:number};
type Run = {manifestHash:string,runKind?:string,round:number,engine:string,buildMs:number,relationBytes:number,physicalDeltaBytes:number,
  write:Latency,walBytesPerInsert:number,latencies?:Latency[]};
const readJson = (path: string) => { try { return JSON.parse(readFileSync(path,'utf8')); } catch { return undefined; } };
type Plan = {query:string,searchIndex:boolean,seqScanMessages:boolean};
type JudgedRun = Run & {plans?:Plan[],completeness?:{equal:boolean,cases?:number}};
type Status = 'PASS'|'FAIL'|'NOT EVALUATED';
// Criteria fixed before the 1M re-measurement (#153, maintainer 2026-11-17); never changed after results.
// Developer-Mac evidence (maintainer 2026-11-15), not a formal #431 budget; P2 production adoption stays held (#314).
export const criteria = {p95LimitMs:500,
  latency:'every query, every round: pgbench p95 at 5 clients <= 500 ms',
  index:'round 1 function-body plans: no Seq Scan on messages for any query; search_body used for every rare query at or above the engine minimum length',
  completeness:'round 1 completeness report equal to the reference scan (6 actors, owner index, direct access path, page order)',
  denials:'every definer denial case with its positive control passed, unforced and forced, on every engine',
  minimumLength:{trgm:3,bigm:2,pgroonga:2} as Record<string,number>,
  // Queries matching only the sparse i%997 rows (explicit, not by name).
  rareQueries:['ja1-rare','ja2-rare','ja3-rare','ascii1-rare','ascii2-rare','ascii-rare','mixed']};
export function judge(runs: JudgedRun[], queries?: {id:string,scalars:number}[], definer?: {cases?:string[],results?:{engine:string,cases:number}[]}) {
  return ['trgm','bigm','pgroonga'].map(engine=>{
    const group = runs.filter(r=>r.engine===engine);
    const first = group.find(r=>r.round===1);
    const ids = (queries ?? []).map(q=>q.id);
    const lat = group.flatMap(r=>ids.map(id=>r.latencies?.find(l=>l.query===id)?.p95));
    const latency: Status = !ids.length || group.length!==3 || new Set(group.map(r=>r.round)).size!==3 || group.some(r=>r.round<1 || r.round>3) ||
      group.some(r=>ids.some(id=>!(r.latencies?.find(l=>l.query===id)?.n! > 0))) || lat.some(p=>p===undefined || !Number.isFinite(p)) ? 'NOT EVALUATED'
      : lat.every(p=>p!<=criteria.p95LimitMs) ? 'PASS' : 'FAIL';
    const slow = group.flatMap(r=>(r.latencies ?? []).filter(l=>l.p95>criteria.p95LimitMs).map(l=>`round ${r.round} ${l.query} ${l.p95.toFixed(1)} ms`));
    const plans = first?.plans;
    const required = (queries ?? []).filter(q=>criteria.rareQueries.includes(q.id) && q.scalars>=criteria.minimumLength[engine]!).map(q=>q.id);
    const planFor = (id: string) => plans?.find(p=>p.query===id);
    const index: Status = !plans || !ids.length || !required.length
      || ids.some(id=>typeof planFor(id)?.searchIndex!=='boolean' || typeof planFor(id)?.seqScanMessages!=='boolean') ? 'NOT EVALUATED'
      : plans.some(p=>p.seqScanMessages) || required.some(id=>!plans.find(p=>p.query===id)?.searchIndex) ? 'FAIL' : 'PASS';
    // run.ts completeness(): six actors, the owner index and the direct access path per query.
    const checked = first?.completeness;
    const completeness: Status = checked?.equal===false ? 'FAIL'
      : checked?.equal===true && ids.length>0 && checked.cases===ids.length*8 ? 'PASS' : 'NOT EVALUATED';
    const names = denialCases.map(c=>c.name);
    const sameCases = JSON.stringify(definer?.cases)===JSON.stringify(names);
    const everyEngine = ['none','trgm','bigm','pgroonga'].every(e=>definer?.results?.find(r=>r.engine===e)?.cases===names.length*2);
    const denials: Status = sameCases && everyEngine ? 'PASS' : 'NOT EVALUATED';
    const parts = {latency,index,completeness,denials};
    // A measured failure is reported even when another part lacks evidence; missing evidence never passes.
    const status: Status = Object.values(parts).includes('FAIL') ? 'FAIL' : Object.values(parts).includes('NOT EVALUATED') ? 'NOT EVALUATED' : 'PASS';
    return {engine,status,...parts,slow,searchIndexQueries:plans?.filter(p=>p.searchIndex).map(p=>p.query) ?? [],requiredSearchIndex:required,
      scope:'MAC developer-Mac comparison (maintainer 2026-11-15); not a formal #431 budget; P2 production adoption held (#314)'};
  });
}
export function summarize(root: string, publication: 'evaluation'|'smoke' = 'evaluation') {
  const runs: Run[] = JSON.parse(readFileSync(`${root}/results.json`,'utf8'));
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`,'utf8'));
  const manifestHash = createHash('sha256').update(JSON.stringify(manifest.frozen)).digest('hex');
  if (manifestHash!==manifest.sha256) throw new Error('Manifest payload hash mismatch');
  const kind = manifest.runKind ?? 'evaluation';
  if (kind!==publication) throw new Error('SMOKE / NON-EVALUATION cannot be published as evaluation (or vice versa)');
  for (const file of ['completed.json','finished.json','run-status.json']) {
    const record = JSON.parse(readFileSync(`${root}/${file}`,'utf8'));
    if ((record.runKind ?? 'evaluation')!==kind) throw new Error('Completion run kind mismatch');
    if (record.manifestHash!==manifestHash) throw new Error('Completion manifest hash mismatch');
    if (file!=='run-status.json' && record.results!==runs.length) throw new Error('Completion result count mismatch');
    if (file==='run-status.json' && (record.valid!==true || record.cleanupVerified!==true || record.exitCode!==0))
      throw new Error('Run did not complete with verified cleanup');
  }
  if (!manifestHash || runs.some(r=>r.manifestHash!==manifestHash || (r.runKind ?? 'evaluation')!==kind)) throw new Error('Result manifest hash mismatch');
  const rounds = kind==='smoke' ? manifest.frozen.smoke.performance.rounds : 3;
  if (runs.length!==rounds*4) throw new Error('Expected all interleaved runs');
  const stats = (xs: number[]) => ({median:percentile(xs,.5),min:Math.min(...xs),max:Math.max(...xs)});
  const summary = ['none','trgm','bigm','pgroonga'].map(engine=>{
    const group = runs.filter(r=>r.engine===engine);
    if (group.length!==rounds) throw new Error('Expected every repetition');
    const baseline = runs.filter(r=>r.engine==='none');
    return {manifestHash,engine,buildMs:stats(group.map(r=>r.buildMs)),relationBytes:stats(group.map(r=>r.relationBytes)),
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
  const result = kind==='smoke' ? {runKind:'smoke',label:'SMOKE / NON-EVALUATION',evaluation:false,formal:false,results:summary} : summary;
  save(`${root}/summary.json`,result);
  const verdict = judge(runs as JudgedRun[],readJson(`${root}/queries.json`),readJson(`${root}/definer.json`));
  save(`${root}/judgement.json`,kind==='smoke' ? {label:'SMOKE / NON-EVALUATION',evaluation:false,verdict} : verdict);
  console.log(JSON.stringify(result,null,2));

}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) summarize(resolve(process.argv[2] ?? ''));
