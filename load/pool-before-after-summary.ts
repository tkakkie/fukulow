import { throughputPlan } from './throughput-summary.ts';

export const scope = 'Whole PR #388, not the acquire timeout alone; Mac-relative only';
export const timeoutNote = "The 10 s client timeout means B's 30 s acquire timeout itself cannot be observed directly.";
export const settings = { members:4000, channels:200, timeoutSeconds:10, seconds:60, rates:[250,500,1000,2000],
  sendBurst:10, sendRefillPerSecond:1, otherOrganizationRate:2, readRate:500, signinRate:20,
  // Same 95% offered-work tolerance as the existing delivery harness. Any explicit drop still invalidates.
  minimumOfferedFraction:0.95 };
export const scenarios = ['send', 'mixed'] as const;
export type Scenario = typeof scenarios[number];
export type Arm = 'B' | 'A';
export function pairs() { return [['B','A'],['A','B'],['B','A']] as const; }
export type Mode = 'formal' | 'smoke' | 'rehearsal';
// Rehearsal (#769): the formal plan and generator, one run per scenario and arm, all validity checks; never evidence.
export function sequence(mode:Mode) {
  if (mode==='smoke') return [{scenario:'send' as Scenario,pair:1,arm:'B' as Arm}];
  if (mode==='rehearsal') return scenarios.flatMap(scenario=>(['B','A'] as const).map(arm=>({scenario,pair:1,arm})));
  return scenarios.flatMap(scenario=>pairs().flatMap((arms,i)=>arms.map(arm=>({scenario,pair:i+1,arm}))));
}
export function plan(smoke = false, rates = settings.rates) { return throughputPlan(smoke ? '50' : rates.join(','), smoke ? '10' : '60',10); }
export type Counts = { attempted:number; accepted:number; rejected429:number; rejected503:number;
  otherErrors:number; clientTimeouts:number; transportErrors:number; droppedIterations:number;
  p95:number|null; p99:number|null };
export type Lane = Counts & { rate:number; seconds:number };
export type Evidence = { complete:boolean; samples:number; maxSampleGapMs:number; samplingErrors:number };
export type Row = { rate:number; seconds:number; send:Lane; reader:Lane; reads?:Lane; signin?:Lane; evidence:Evidence };
export type Run = { scope:string; pair:number; arm:Arm; scenario:Scenario; smoke:boolean; rehearsal?:boolean; steps:Row[]; reader:Lane };
export function validity(row:Row) {
  const reasons:string[]=[];
  if (!row.evidence?.complete || !Number.isInteger(row.evidence.samples) || row.evidence.samples<=0 || row.evidence.samplingErrors!==0 ||
    !Number.isFinite(row.evidence.maxSampleGapMs) || row.evidence.maxSampleGapMs<0 || row.evidence.maxSampleGapMs > 2500) reasons.push('missing resource/run evidence');
  for (const [name,lane] of Object.entries({send:row.send,reader:row.reader,reads:row.reads,signin:row.signin})) {
    if (!lane) { if(name==='send'||name==='reader')reasons.push(`${name}: missing lane`);continue; }
    const counts=[lane.attempted,lane.accepted,lane.rejected429,lane.rejected503,lane.otherErrors,lane.clientTimeouts,lane.transportErrors,lane.droppedIterations];
    if (!counts.every(n=>Number.isFinite(n)&&n>=0&&Number.isInteger(n)) || lane.attempted !== lane.accepted+lane.rejected429+lane.rejected503+lane.otherErrors+lane.clientTimeouts+lane.transportErrors) reasons.push(`${name}: incomplete outcomes`);
    if (lane.droppedIterations || lane.attempted < lane.rate*lane.seconds*settings.minimumOfferedFraction) reasons.push(`${name}: target load not generated`);
    // Excess load is a generator fault, never a shortfall that rules 2 and 3 classify (#196).
    if (lane.attempted > lane.rate*lane.seconds+1) reasons.push(`${name}: more load than planned`);
    if (lane.accepted && (lane.p95 === null || lane.p99 === null || !Number.isFinite(lane.p95) || !Number.isFinite(lane.p99) || lane.p95 < 0 || lane.p99 < lane.p95)) reasons.push(`${name}: missing success latency`);
  }
  if (row.send.rejected429) reasons.push('send limit interfered (429)');
  return reasons;
}
// Whole-run other-Organization reader: continuous 2/s across all steps and drains.
const readerInvalid=(r:Lane|undefined)=>!r || r.rate!==2 || r.seconds!==284 || r.attempted<r.rate*r.seconds*settings.minimumOfferedFraction ||
  r.droppedIterations!==0 || ![r.attempted,r.accepted,r.rejected429,r.rejected503,r.otherErrors,r.clientTimeouts,r.transportErrors].every(n=>Number.isInteger(n)&&n>=0) ||
  (r.accepted>0 && (r.p95===null||r.p99===null||!Number.isFinite(r.p95)||!Number.isFinite(r.p99)||r.p95<0||r.p99<r.p95)) ||
  r.attempted!==r.accepted+r.rejected429+r.rejected503+r.otherErrors+r.clientTimeouts+r.transportErrors;
const settingsMismatch=(r:Row,scenario:Scenario,rate:number)=>r.seconds!==60 || r.send.rate!==rate || r.send.seconds!==60 ||
  r.reader.rate!==2||r.reader.seconds!==60 || (scenario==='mixed' ? r.reads?.rate!==500||r.signin?.rate!==20||r.reads.seconds!==60||r.signin.seconds!==60 : !!r.reads||!!r.signin);
// Every per-run evidence check judge() applies, for one run without pairing it (#771 rehearsal). Not a verdict.
export function runProblems(run:Run):string[] {
  const problems:string[]=[];
  if(readerInvalid(run.reader)) problems.push('missing continuous other-Organization evidence');
  for(const rate of settings.rates) {
    const rows=run.steps.filter(r=>r.rate===rate);
    if(rows.length!==1) { problems.push(`${rate}/s: missing or duplicate step`); continue; }
    const r=rows[0];
    if(!r.send||!r.reader||!r.evidence) { problems.push(`${rate}/s: missing step evidence`); continue; }
    if(settingsMismatch(r,run.scenario,rate)) problems.push(`${rate}/s: settings mismatch`);
    problems.push(...validity(r).map(reason=>`${rate}/s: ${reason}`));
  }
  if(run.steps.length!==settings.rates.length) problems.push(`${run.steps.length} steps, expected ${settings.rates.length}`);
  return problems;
}
const notGenerated=': target load not generated';
const lanesOf=(reasons:string[])=>reasons.filter(r=>r.endsWith(notGenerated)).map(r=>r.slice(0,-notGenerated.length) as LaneName);
type LaneName='send'|'reader'|'reads'|'signin';
export type Cell={status:'PASS'|'FAIL'|'REPORT ONLY'|'NOT EVALUATED';reason?:string;baselineSuccessRate?:number;candidateSuccessRate?:number};
// One B/A comparison at one step, in the order pre-registered on #196 (2026-11-22).
export function judgePair(bRun:Run, aRun:Run, scenario:Scenario, rate:number):Cell {
  const bRows=bRun.steps.filter(r=>r.rate===rate),aRows=aRun.steps.filter(r=>r.rate===rate);
  if(bRows.length!==1||aRows.length!==1) return {status:'NOT EVALUATED',reason:'missing or duplicate step'};
  const b=bRows[0],a=aRows[0];
  if([b,a].some(r=>!r.send||!r.reader||!r.evidence))return {status:'NOT EVALUATED',reason:'missing step evidence'};
  if([bRun.reader,aRun.reader].some(readerInvalid)) return {status:'NOT EVALUATED',reason:'missing continuous other-Organization evidence'};
  if([b,a].some(r=>settingsMismatch(r,scenario,rate))) return {status:'NOT EVALUATED',reason:'settings mismatch'};
  const bInvalid=validity(b),aInvalid=validity(a);
  const other=[...bInvalid,...aInvalid].filter(r=>!r.endsWith(notGenerated));
  if(other.length) return {status:'NOT EVALUATED',reason:[...bInvalid,...aInvalid].join('; ')};
  // Rule 2: a baseline that did not receive the target load is never re-read as REPORT ONLY.
  if(bInvalid.length) return {status:'NOT EVALUATED',reason:`B generator: ${bInvalid.join('; ')}`};
  // Mixed contention lanes are judged like sends: losing them would remove the DB pressure the scenario exists for.
  const judged=(['send',...(scenario==='mixed'?['reads','signin'] as const:[])] as const).map(name=>({name,b:b[name]!,a:a[name]!}));
  const rate_=(l:Lane)=>l.accepted/l.attempted;
  const br=rate_(b.send), ar=rate_(a.send);
  // Rule 1: B received valid load and saturated; A's generator does not change that.
  const saturated=judged.filter(l=>rate_(l.b)<.99).map(l=>l.name);
  if(saturated.length) return {status:'REPORT ONLY',reason:`above B saturation (${saturated.join(', ')})`};
  // Rule 3: A alone fell short. FAIL only if every short lane shows server-side evidence; transport errors alone do not count.
  if(aInvalid.length) {
    const short=lanesOf(aInvalid);
    const server=(name:LaneName)=>{const al=a[name],bl=b[name];if(!al||!bl)return false;
      return al.rejected503>0||al.otherErrors>0||al.clientTimeouts>0||(al.p95!==null&&bl.p95!==null&&al.p95>1.10*bl.p95);};
    return short.every(server)
      ? {status:'FAIL',reason:`A capacity, server evidence (${short.join(', ')})`,baselineSuccessRate:br,candidateSuccessRate:ar}
      : {status:'NOT EVALUATED',reason:`A generator without server evidence: ${aInvalid.join('; ')}`};
  }
  // Success-rate and other-Organization failures need no latency: a candidate with no successes fails, it is not unmeasured.
  const rateFails=judged.filter(l=>!(rate_(l.a)>=.99 && rate_(l.a)+1e-12>=rate_(l.b)-.01)).map(l=>l.name);
  // The other Organization is judged per step (maintainer, 2026-11-17); the whole-run reader stays recorded as evidence.
  if(rateFails.length || !(b.reader.accepted===b.reader.attempted && a.reader.accepted===a.reader.attempted))
    return {status:'FAIL',reason:rateFails.length?`success rate (${rateFails.join(', ')})`:'other Organization',baselineSuccessRate:br,candidateSuccessRate:ar};
  if(judged.some(l=>l.b.p95===null||l.b.p99===null||l.a.p95===null||l.a.p99===null)) return {status:'NOT EVALUATED',reason:'missing latency'};
  const slower=judged.filter(l=>!(l.a.p95!<=1.10*l.b.p95! && l.a.p99!<=1.10*l.b.p99!)).map(l=>l.name);
  return {status:slower.length?'FAIL':'PASS',...(slower.length?{reason:`latency (${slower.join(', ')})`}:{}),baselineSuccessRate:br,candidateSuccessRate:ar};
}
// Rehearsal validity (#196 decision b): every check except "target load not generated", which is reported as a forecast.
// The forecast applies the formal per-pair rules to the rehearsal B and A runs; it is never evidence or a verdict.
export function rehearsalChecks(runs:Run[]) {
  return sequence('rehearsal').map(({scenario,arm})=>{
    const found=runs.filter(r=>r.scenario===scenario&&r.arm===arm);
    const all=found.length===1?runProblems(found[0]):[`${found.length} runs, expected 1`];
    return {scenario,arm,problems:all.filter(p=>!p.endsWith(notGenerated)),loadNotGenerated:all.filter(p=>p.endsWith(notGenerated))};
  });
}
export function rehearsalForecast(runs:Run[]) {
  return scenarios.flatMap(scenario=>settings.rates.map(rate=>{
    const get=(arm:Arm)=>runs.filter(r=>r.rehearsal&&r.scenario===scenario&&r.arm===arm);
    const bs=get('B'),as=get('A');
    return {scenario,rate,evidence:false,...(bs.length===1&&as.length===1?judgePair(bs[0],as[0],scenario,rate):{status:'NOT EVALUATED',reason:'missing or duplicate arm'})};
  }));
}
export function judge(runs:Run[], scenario:Scenario, rate:number) {
  const cells=pairs().map((_,index)=> {
    const get=(arm:Arm)=>runs.filter(r=>r.scope===scope && !r.smoke && !r.rehearsal && r.scenario===scenario && r.pair===index+1 && r.arm===arm);
    const bs=get('B'), as=get('A');
    if(bs.length!==1 || as.length!==1) return {pair:index+1,status:'NOT EVALUATED',reason:'missing or duplicate arm'};
    return {pair:index+1,...judgePair(bs[0],as[0],scenario,rate)};
  });
  // An invalid or saturated pair never substitutes for one of the three required comparisons.
  const status=cells.some(c=>c.status==='NOT EVALUATED')?'NOT EVALUATED':cells.every(c=>c.status==='REPORT ONLY')?'REPORT ONLY':
    cells.some(c=>c.status==='REPORT ONLY')?'NOT EVALUATED':cells.some(c=>c.status==='FAIL')?'FAIL':'PASS';
  return {scope,scenario,rate,status,pairs:cells,poolAcquireTimeouts:'NOT EVALUATED',timeoutNote};
}
// An interrupted, failed, smoke or uncleaned run, or one with missing results, never yields a verdict (a rehearsal passes complete=false).
export function judgeAll(runs:Run[], complete:boolean) {
  return scenarios.flatMap(s=>settings.rates.map(rate=>{
    const j=judge(runs,s,rate);
    return complete ? j : {...j,status:'NOT EVALUATED',reason:'run incomplete, interrupted, smoke, missing results or cleanup failed'};
  }));
}
// Overall #196 B verdict (#196 decision a): any FAIL step fails; PASS needs every step PASS or REPORT ONLY and one PASS.
export function overall(steps:{status:string}[]) {
  if(steps.some(s=>s.status==='FAIL')) return 'FAIL';
  if(steps.every(s=>s.status==='PASS'||s.status==='REPORT ONLY')&&steps.some(s=>s.status==='PASS')) return 'PASS';
  return 'NOT EVALUATED';
}
