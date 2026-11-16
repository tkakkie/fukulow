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
export function plan(smoke = false) { return throughputPlan(smoke ? '50' : settings.rates.join(','), smoke ? '10' : '60',10); }
export type Counts = { attempted:number; accepted:number; rejected429:number; rejected503:number;
  otherErrors:number; clientTimeouts:number; transportErrors:number; droppedIterations:number;
  p95:number|null; p99:number|null };
export type Lane = Counts & { rate:number; seconds:number };
export type Evidence = { complete:boolean; samples:number; maxSampleGapMs:number; samplingErrors:number };
export type Row = { rate:number; seconds:number; send:Lane; reader:Lane; reads?:Lane; signin?:Lane; evidence:Evidence };
export type Run = { scope:string; pair:number; arm:Arm; scenario:Scenario; smoke:boolean; steps:Row[]; reader:Lane };
export function validity(row:Row) {
  const reasons:string[]=[];
  if (!row.evidence?.complete || !Number.isInteger(row.evidence.samples) || row.evidence.samples<=0 || row.evidence.samplingErrors!==0 ||
    !Number.isFinite(row.evidence.maxSampleGapMs) || row.evidence.maxSampleGapMs<0 || row.evidence.maxSampleGapMs > 2500) reasons.push('missing resource/run evidence');
  for (const [name,lane] of Object.entries({send:row.send,reader:row.reader,reads:row.reads,signin:row.signin})) {
    if (!lane) { if(name==='send'||name==='reader')reasons.push(`${name}: missing lane`);continue; }
    const counts=[lane.attempted,lane.accepted,lane.rejected429,lane.rejected503,lane.otherErrors,lane.clientTimeouts,lane.transportErrors,lane.droppedIterations];
    if (!counts.every(n=>Number.isFinite(n)&&n>=0&&Number.isInteger(n)) || lane.attempted !== lane.accepted+lane.rejected429+lane.rejected503+lane.otherErrors+lane.clientTimeouts+lane.transportErrors) reasons.push(`${name}: incomplete outcomes`);
    if (lane.droppedIterations || lane.attempted < lane.rate*lane.seconds*settings.minimumOfferedFraction || lane.attempted > lane.rate*lane.seconds+1) reasons.push(`${name}: target load not generated`);
    if (lane.accepted && (lane.p95 === null || lane.p99 === null || !Number.isFinite(lane.p95) || !Number.isFinite(lane.p99) || lane.p95 < 0 || lane.p99 < lane.p95)) reasons.push(`${name}: missing success latency`);
  }
  if (row.send.rejected429) reasons.push('send limit interfered (429)');
  return reasons;
}
export function judge(runs:Run[], scenario:Scenario, rate:number) {
  const cells=pairs().map((_,index)=> {
    const get=(arm:Arm)=>runs.filter(r=>r.scope===scope && !r.smoke && r.scenario===scenario && r.pair===index+1 && r.arm===arm);
    const bs=get('B'), as=get('A');
    if(bs.length!==1 || as.length!==1) return {pair:index+1,status:'NOT EVALUATED',reason:'missing or duplicate arm'};
    const bRows=bs[0].steps.filter(r=>r.rate===rate),aRows=as[0].steps.filter(r=>r.rate===rate);
    if(bRows.length!==1||aRows.length!==1) return {pair:index+1,status:'NOT EVALUATED',reason:'missing or duplicate step'};
    const b=bRows[0],a=aRows[0];
    if([b,a].some(r=>!r.send||!r.reader||!r.evidence))return {pair:index+1,status:'NOT EVALUATED',reason:'missing step evidence'};
    const readers=[bs[0].reader,as[0].reader];
    if(readers.some(r=>!r || r.rate!==2 || r.seconds!==284 || r.attempted<r.rate*r.seconds*settings.minimumOfferedFraction ||
      r.droppedIterations!==0 || ![r.attempted,r.accepted,r.rejected429,r.rejected503,r.otherErrors,r.clientTimeouts,r.transportErrors].every(n=>Number.isInteger(n)&&n>=0) ||
      (r.accepted>0 && (r.p95===null||r.p99===null||!Number.isFinite(r.p95)||!Number.isFinite(r.p99)||r.p95<0||r.p99<r.p95)) ||
      r.attempted!==r.accepted+r.rejected429+r.rejected503+r.otherErrors+r.clientTimeouts+r.transportErrors))
      return {pair:index+1,status:'NOT EVALUATED',reason:'missing continuous other-Organization evidence'};
    if(b.seconds!==60||a.seconds!==60 || b.send.rate!==rate||a.send.rate!==rate || b.send.seconds!==60||a.send.seconds!==60 ||
      [b,a].some(r=>r.reader.rate!==2||r.reader.seconds!==60 || (scenario==='mixed' ? r.reads?.rate!==500||r.signin?.rate!==20||r.reads.seconds!==60||r.signin.seconds!==60 : !!r.reads||!!r.signin))) return {pair:index+1,status:'NOT EVALUATED',reason:'settings mismatch'};
    const invalid=[...validity(b),...validity(a)];
    if(invalid.length) return {pair:index+1,status:'NOT EVALUATED',reason:invalid.join('; ')};
    const br=b.send.accepted/b.send.attempted, ar=a.send.accepted/a.send.attempted;
    if(br<.99) return {pair:index+1,status:'REPORT ONLY',reason:'above B saturation'};
    // Success-rate and other-Organization failures need no latency: a candidate with no successes fails, it is not unmeasured.
    if(!(ar>=.99 && ar+1e-12>=br-.01) || !(b.reader.accepted===b.reader.attempted && a.reader.accepted===a.reader.attempted && readers.every(r=>r.accepted===r.attempted)))
      return {pair:index+1,status:'FAIL',baselineSuccessRate:br,candidateSuccessRate:ar};
    if(b.send.p95===null||b.send.p99===null||a.send.p95===null||a.send.p99===null) return {pair:index+1,status:'NOT EVALUATED',reason:'missing latency'};
    const pass=a.send.p95<=1.10*b.send.p95 && a.send.p99<=1.10*b.send.p99;
    return {pair:index+1,status:pass?'PASS':'FAIL',baselineSuccessRate:br,candidateSuccessRate:ar};
  });
  // An invalid or saturated pair never substitutes for one of the three required comparisons.
  const status=cells.some(c=>c.status==='NOT EVALUATED')?'NOT EVALUATED':cells.every(c=>c.status==='REPORT ONLY')?'REPORT ONLY':
    cells.some(c=>c.status==='REPORT ONLY')?'NOT EVALUATED':cells.some(c=>c.status==='FAIL')?'FAIL':'PASS';
  return {scope,scenario,rate,status,pairs:cells,poolAcquireTimeouts:'NOT EVALUATED',timeoutNote};
}
// An interrupted, failed, smoke or uncleaned run, or one with missing results, never yields a verdict.
export function judgeAll(runs:Run[], complete:boolean) {
  return scenarios.flatMap(s=>settings.rates.map(rate=>{
    const j=judge(runs,s,rate);
    return complete ? j : {...j,status:'NOT EVALUATED',reason:'run incomplete, interrupted, smoke, missing results or cleanup failed'};
  }));
}
