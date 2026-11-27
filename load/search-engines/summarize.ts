import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { percentile, save } from './bench.ts';
import { denialCases, probe } from './definer.ts';
import { b1RlsFacts, b1RoleFacts } from './b1.ts';

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
  // Frozen performance shape: 5 clients x 20 transactions per query per round. Fewer (or more) is not evidence.
  samplesPerQueryRound:100,
  latency:'every query, every round: exactly 100 pgbench samples (5 clients x 20) and p95 <= 500 ms',
  index:'round 1 function-body plans: no Seq Scan on messages for any query; search_body used for every rare query at or above the engine minimum length',
  completeness:'round 1 completeness report equal to the reference scan (6 actors, owner index, direct access path, page order)',
  denials:'every definer denial case with its positive control passed, unforced and forced, on every engine',
  minimumLength:{trgm:3,bigm:2,pgroonga:2} as Record<string,number>,
  // Queries matching only the sparse i%997 rows (explicit, not by name), with their normalized scalar
  // counts frozen here (from the smoke run's normalization), so an artifact cannot shrink them.
  rareQueries:{'ja1-rare':1,'ja2-rare':2,'ja3-rare':4,'ascii1-rare':1,'ascii2-rare':2,'ascii-rare':3,'mixed':4} as Record<string,number>};
type Check = {case:string,forced:boolean,found:string[],expected:string[]};
type Query = {id:string,raw:string,value:string,scalars:number};
// Parsed artifacts are untrusted: a non-array or a non-object element is missing evidence, never a crash.
const objects = <T,>(value: unknown) => (Array.isArray(value) ? value.filter(v=>v!==null && typeof v==='object') : []) as T[];
const strings = (value: unknown) => Array.isArray(value) && value.every(v=>typeof v==='string');
// One engine's denial evidence: every case, unforced and forced, exactly once, recording the frozen expectation.
// Complete evidence with a found/expected mismatch is a measured FAIL.
function denialEvidence(checks: unknown): Status {
  const list = objects<Check>(checks);
  if (!Array.isArray(checks) || list.length!==checks.length || list.length!==denialCases.length*2) return 'NOT EVALUATED';
  const hits = denialCases.flatMap(c=>[false,true].map(forced=>({want:JSON.stringify(c.expect.map(probe)),
    hit:list.filter(k=>k.case===c.name && k.forced===forced)})));
  if (hits.some(({want,hit})=>hit.length!==1 || !strings(hit[0]!.found) || JSON.stringify(hit[0]!.expected)!==want)) return 'NOT EVALUATED';
  return hits.every(({want,hit})=>JSON.stringify(hit[0]!.found)===want) ? 'PASS' : 'FAIL';
}
// expectedQueries: the frozen manifest's performance [id, raw] pairs, in order. Any other query list, or a
// scalar count that does not match its normalized value, is not evidence.
function frozenQueries(queries: unknown, expectedQueries: [string,string][]) {
  const list = objects<Query>(queries);
  const valid = Array.isArray(queries) && expectedQueries.length>0 && list.length===queries.length && list.length===expectedQueries.length
    && list.every((q,i)=>q.id===expectedQueries[i]![0] && q.raw===expectedQueries[i]![1] && typeof q.value==='string'
      && Number.isInteger(q.scalars) && q.scalars>0 && q.scalars===[...q.value].length
      && (!(q.id in criteria.rareQueries) || q.scalars===criteria.rareQueries[q.id]));
  return valid ? list : undefined;
}
export function judge(runs: JudgedRun[], rawQueries: unknown, definer: unknown, expectedQueries: [string,string][]) {
  const queries = frozenQueries(rawQueries,expectedQueries);
  const record = (definer!==null && typeof definer==='object' ? definer : {}) as {cases?:unknown,results?:unknown};
  return ['trgm','bigm','pgroonga'].map(engine=>{
    const group = objects<JudgedRun>(runs).filter(r=>r.engine===engine);
    const first = group.find(r=>r.round===1);
    const ids = (queries ?? []).map(q=>q.id);
    const latencyOf = (r: JudgedRun, id: string) => objects<Latency>(r.latencies).find(l=>l.query===id);
    const lat = group.flatMap(r=>ids.map(id=>latencyOf(r,id)?.p95));
    const latency: Status = !ids.length || group.length!==3 || new Set(group.map(r=>r.round)).size!==3 || group.some(r=>!(r.round>=1 && r.round<=3)) ||
      group.some(r=>ids.some(id=>latencyOf(r,id)?.n!==criteria.samplesPerQueryRound)) || lat.some(p=>typeof p!=='number' || !Number.isFinite(p)) ? 'NOT EVALUATED'
      : lat.every(p=>p!<=criteria.p95LimitMs) ? 'PASS' : 'FAIL';
    const slow = group.flatMap(r=>objects<Latency>(r.latencies).filter(l=>typeof l.p95==='number' && l.p95>criteria.p95LimitMs)
      .map(l=>`round ${r.round} ${l.query} ${l.p95.toFixed(1)} ms`));
    const plans = Array.isArray(first?.plans) ? objects<Plan>(first.plans) : undefined;
    const required = (queries ?? []).filter(q=>q.id in criteria.rareQueries && criteria.rareQueries[q.id]!>=criteria.minimumLength[engine]!).map(q=>q.id);
    const planFor = (id: string) => plans?.find(p=>p.query===id);
    const index: Status = !plans || !ids.length || !required.length
      || ids.some(id=>typeof planFor(id)?.searchIndex!=='boolean' || typeof planFor(id)?.seqScanMessages!=='boolean') ? 'NOT EVALUATED'
      : plans.some(p=>p.seqScanMessages===true) || required.some(id=>planFor(id)?.searchIndex!==true) ? 'FAIL' : 'PASS';
    // run.ts completeness(): six actors, the owner index and the direct access path per query.
    const checked = first?.completeness;
    const completeness: Status = checked?.equal===false ? 'FAIL'
      : checked?.equal===true && ids.length>0 && checked.cases===ids.length*8 ? 'PASS' : 'NOT EVALUATED';
    const names = denialCases.map(c=>c.name);
    const results = objects<{engine?:unknown,cases?:unknown,checks?:unknown}>(record.results);
    const perEngine = ['none','trgm','bigm','pgroonga'].map(e=>{
      const found = results.filter(r=>r.engine===e);
      return found.length===1 && found[0]!.cases===names.length*2 ? denialEvidence(found[0]!.checks) : 'NOT EVALUATED';
    });
    const sameCases = JSON.stringify(record.cases)===JSON.stringify(names);
    const denials: Status = perEngine.includes('FAIL') ? 'FAIL' : sameCases && perEngine.every(p=>p==='PASS') ? 'PASS' : 'NOT EVALUATED';
    const parts = {latency,index,completeness,denials};
    // A measured failure is reported even when another part lacks evidence; missing evidence never passes.
    const status: Status = Object.values(parts).includes('FAIL') ? 'FAIL' : Object.values(parts).includes('NOT EVALUATED') ? 'NOT EVALUATED' : 'PASS';
    return {engine,status,...parts,frozenQueries:queries!==undefined,slow,searchIndexQueries:plans?.filter(p=>p.searchIndex===true).map(p=>p.query) ?? [],
      requiredSearchIndex:required,
      scope:'MAC developer-Mac comparison (maintainer 2026-11-15); not a formal #431 budget; P2 production adoption held (#314)'};
  });
}
type B1PlanFacts = Omit<Plan,'query'> & {scans:unknown[];executionMs:number};
type B1Plan = B1PlanFacts & {query:string};
type B1Completeness = {query:string;actors:{actor:number;equal:boolean;rows:number}[];ownerIndexEqual:boolean;directEqual:boolean;
  pageEqual:boolean;matchesByOrganization:Record<string,number>};
type TimingArm = Latency & {foreignMatches:number;plan?:B1PlanFacts};
type Timing = {query:string;few:TimingArm;many:TimingArm;equalNonemptyPage:boolean};
type B1Round = Omit<Run,'write'|'walBytesPerInsert'> & {plans?:B1Plan[];completeness?:B1Completeness[];
  safety?:{definers:string;policy:string;role:string;rls:string;memberships:string}};
type B1Evidence = {rounds:unknown;queries:unknown;denials:unknown;restore:unknown;timing:unknown};
const stats = (xs: number[]) => ({median:percentile(xs,.5),min:Math.min(...xs),max:Math.max(...xs)});
function oneFor<T extends {query:string}>(items: unknown, id: string) {
  const matches = objects<T>(items).filter(item=>item.query===id);
  return matches.length===1 ? matches[0] : undefined;
}
function latencyValid(value: Latency | undefined, samples: number): value is Latency {
  return value?.n===samples && [value.p50,value.p95,value.p99].every(n=>Number.isFinite(n) && n>=0)
    && value.p50<=value.p95 && value.p95<=value.p99;
}
function planRecorded(plan?: B1PlanFacts): plan is B1PlanFacts {
  return !!plan && Number.isFinite(plan.executionMs) && Array.isArray(plan.scans) && plan.scans.length>0 &&
    typeof plan.searchIndex==='boolean' && typeof plan.seqScanMessages==='boolean';
}
function completenessChecks(c?: B1Completeness) {
  const actors = objects<B1Completeness['actors'][number]>(c?.actors);
  if (actors.length!==6 || actors.some((a,i)=>a.actor!==i+1)) return [];
  return [...actors.map(a=>a.equal),c?.ownerIndexEqual,c?.directEqual,c?.pageEqual];
}
function classDenials(c?: B1Completeness) {
  const actors = [4,6].map(actor=>objects<B1Completeness['actors'][number]>(c?.actors).find(a=>a.actor===actor));
  return actors.map(a=>Number.isSafeInteger(a?.rows) && a!.rows>=0 ? a!.rows===0 : undefined);
}
function checksStatus(checks: unknown[], count: number): Status {
  if (checks.includes(false)) return 'FAIL';
  return checks.length===count && checks.every(check=>check===true) ? 'PASS' : 'NOT EVALUATED';
}

export function judgeB1(evidence: B1Evidence, expectedQueries: [string,string][], rounds: number, samples: number, evaluation: boolean) {
  const queries = frozenQueries(evidence.queries,expectedQueries);
  const group = objects<B1Round>(evidence.rounds).sort((a,b)=>a.round-b.round);
  const groupComplete = group.length===rounds && group.every((r,i)=>r.engine==='pgroonga' && r.round===i+1);
  const first = group.find(r=>r.round===1);
  const restored = (evidence.restore as {completeness?:unknown} | undefined)?.completeness;
  const denials = evidence.denials as {cases?:unknown;checks?:unknown} | undefined;
  const denialStatus = JSON.stringify(denials?.cases)===JSON.stringify(denialCases.map(c=>c.name))
    ? denialEvidence(denials?.checks) : 'NOT EVALUATED';
  const classes = (queries ?? []).map(q=>{
    const latencies = group.map(r=>oneFor<Latency>(r.latencies,q.id));
    const sampled = latencies.filter(l=>latencyValid(l,samples));
    const latency: Status = sampled.some(l=>l.p95>criteria.p95LimitMs) ? 'FAIL'
      : groupComplete && sampled.length===rounds ? 'PASS' : 'NOT EVALUATED';
    const plan = oneFor<B1Plan>(first?.plans,q.id);
    const required = q.id in criteria.rareQueries && q.scalars>=criteria.minimumLength.pgroonga!;
    const index: Status = !planRecorded(plan) ? 'NOT EVALUATED'
      : plan.seqScanMessages || (required && !plan.searchIndex) ? 'FAIL' : 'PASS';
    const complete = oneFor<B1Completeness>(first?.completeness,q.id);
    const completeness = checksStatus(completenessChecks(complete),9);
    const restoredClass = oneFor<B1Completeness>(restored,q.id);
    const restore = checksStatus([...completenessChecks(restoredClass),...classDenials(restoredClass)],11);
    const actorDenials = checksStatus(classDenials(complete),2);
    const timing = oneFor<Timing>(evidence.timing,q.id);
    const counts = Object.values(complete?.matchesByOrganization ?? {});
    const timingEvaluated = counts.length===3 && counts.every(count=>Number.isSafeInteger(count) && count>=0) &&
      timing?.equalNonemptyPage===true && latencyValid(timing.few,samples) && latencyValid(timing.many,samples) &&
      Number.isSafeInteger(timing.few.foreignMatches) && timing.few.foreignMatches>=0 &&
      Number.isSafeInteger(timing.many.foreignMatches) && timing.many.foreignMatches>timing.few.foreignMatches &&
      planRecorded(timing.few.plan) && timing.few.plan.searchIndex &&
      planRecorded(timing.many.plan) && timing.many.plan.searchIndex;
    const percentiles = sampled.length ? {p50:stats(sampled.map(l=>l.p50)),p95:stats(sampled.map(l=>l.p95)),
      p99:stats(sampled.map(l=>l.p99))} : undefined;
    return {query:q.id,latency,index,completeness,actorDenials,restore,timingEvaluated,percentiles,latencies,plan,
      matchesByOrganization:complete?.matchesByOrganization,timing};
  });
  const parts = classes.flatMap(c=>[c.latency,c.index,c.completeness,c.actorDenials,c.restore]);
  const safetyChecked = groupComplete && group.every(r=>r.safety?.definers==='0' && r.safety.memberships==='0' &&
    r.safety.role===b1RoleFacts && r.safety.rls===b1RlsFacts &&
    /^[a-f0-9]{32}$/.test(r.safety.policy) && r.safety.policy===first?.safety?.policy);
  const status: Status = !evaluation ? 'NOT EVALUATED' : [denialStatus,...parts].includes('FAIL') ? 'FAIL'
    : !queries || !safetyChecked || denialStatus!=='PASS' || parts.includes('NOT EVALUATED') ||
      classes.some(c=>!c.timingEvaluated) ? 'NOT EVALUATED' : 'PASS';
  return {method:'B1',engine:'pgroonga',status,denials:denialStatus,safetyChecked,classes,
    scope:'Measurement gate only. Timing evidence requires separate safety evaluation.'};
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
  if (manifest.frozen.b1) {
    const approved = ['manifest-v11.json','manifest-v13.json','manifest-b1-v14.json'].some(file=>{
      const frozen = JSON.parse(readFileSync(new URL(file,import.meta.url),'utf8'));
      return manifestHash===frozen.sha256;
    });
    if (!approved) throw new Error('B1 artifact must match a checked-in B1 manifest');
    const performance = kind==='smoke' ? {...manifest.frozen.performance,...manifest.frozen.smoke.performance} : manifest.frozen.performance;
    const {classes,...verdict} = judgeB1({rounds:runs,queries:readJson(`${root}/queries.json`),
      denials:readJson(`${root}/denials.json`),restore:readJson(`${root}/restore.json`),timing:readJson(`${root}/timing.json`)},
      performance.querySet,performance.rounds,performance.clients*performance.transactions,kind==='evaluation');
    const result = {manifestHash,runKind:kind,...verdict,classes};
    save(`${root}/summary.json`,result);
    save(`${root}/judgement.json`,{manifestHash,runKind:kind,...verdict});
    console.log(JSON.stringify({manifestHash,runKind:kind,...verdict},null,2));
    return;
  }
  const rounds = kind==='smoke' ? manifest.frozen.smoke.performance.rounds : 3;
  if (runs.length!==rounds*4) throw new Error('Expected all interleaved runs');
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
  const verdict = judge(runs as JudgedRun[],readJson(`${root}/queries.json`),readJson(`${root}/definer.json`),
    objects<[string,string]>(manifest.frozen.performance?.querySet).filter(q=>strings(q) && q.length===2));
  save(`${root}/judgement.json`,kind==='smoke' ? {label:'SMOKE / NON-EVALUATION',evaluation:false,verdict} : verdict);
  console.log(JSON.stringify(result,null,2));

}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) summarize(resolve(process.argv[2] ?? ''));
