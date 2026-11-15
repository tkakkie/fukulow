import { latencyClasses, browsingClasses, type Verdict } from './dms-formal-judgment.ts';
export const overheadOrder = ['B','C','C','B','B','C'] as const;
export const overheadCoreSeconds=300;
// Ordinary held targets are part of the mixed workload and need their own tails.
export const overheadClasses={...latencyClasses,...browsingClasses,
  channels:['page','dm_latency_ms:channels'],me:['page','dm_latency_ms:me'],members:['page','dm_latency_ms:members'],
  'channel-members':['page','dm_latency_ms:channel-members'],topics:['page','dm_latency_ms:topics'],topic:['page','dm_latency_ms:topic'],
} as const;
export const overheadMetrics=['app.cpuMean','app.rssKiB',...Object.keys(overheadClasses).flatMap(key=>[key+'.p95',key+'.p99'])];
export const poolOverheadDesign={scenario:'pool-overhead',status:'NOT EVALUATED',acceptance:false,limitPercent:10,
  baseline:'Same formal DM SHA + load/pool-overhead-baseline.patch, reviewed before measurement',
  procedure:'Three pairs B/C, C/B, B/C; identical main fixture snapshot restored before every arm; 300 s ramp, 300 s warm-up, 300 s judged core. Dedicated formal Linux hosts and fixed resources. Raw logs retained.',
  comparison:'Each pair regression and mean of three pair regressions <=10%; baseline max/min-1 >10% is NOT EVALUATED for that metric. Invalid evidence makes the whole check NOT EVALUATED. Full formal attempts remain required.'};
export type OverheadArm={arm:'B'|'C';metrics:Record<string,number>;samples:Record<string,number>;conditions:Record<string,unknown>;imageDigest:string;reasons:string[]};
export const overheadConditionKeys=['sha','patchSha256','hosts','limits','snapshot','generator','toolchains'] as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const spread=(values:number[])=>({min:Math.min(...values),max:Math.max(...values),range:Math.max(...values)-Math.min(...values)});
// Compare decimal evidence exactly: no epsilon can silently relax the 10% gate.
function decimal(value:number):[bigint,bigint] {
  const [mantissa,exponent='0']=String(value).split('e'),parts=mantissa!.split('.');
  const scale=(parts[1]?.length ?? 0)-Number(exponent),coefficient=BigInt(parts.join(''));
  return [coefficient*10n**BigInt(Math.max(0,-scale)),10n**BigInt(Math.max(0,scale))];
}
function regression(baseline:number,candidate:number) {
  if(!Number.isFinite(baseline)||baseline<=0||!Number.isFinite(candidate)||candidate<0)return {n:0n,d:1n,valid:false};
  const [bn,bd]=decimal(baseline),[cn,cd]=decimal(candidate);
  return {n:100n*(cn*bd-bn*cd),d:cd*bn,valid:true};
}
export function judgeOverhead(arms:OverheadArm[]) {
  arms=arms.map(a=>({arm:a.arm,metrics:a.metrics ?? {},samples:a.samples ?? {},conditions:a.conditions ?? {},imageDigest:a.imageDigest ?? '',reasons:a.reasons ?? ['Missing arm evidence']}));
  const reasons:string[]=[];
  if(arms.length!==6 || arms.some((a,i)=>a.arm!==overheadOrder[i]))reasons.push('Missing arms or wrong B/C, C/B, B/C order');
  const first=arms[0];
  for(const [i,arm] of arms.entries()) {
    reasons.push(...arm.reasons.map(reason=>'Arm '+(i+1)+': '+reason));
    for(const key of overheadConditionKeys)if(arm.conditions[key]===undefined || arm.conditions[key]===null || !same(arm.conditions[key],first?.conditions[key]))reasons.push('Missing/mismatched '+key);
    if(!/^sha256:[a-f0-9]{64}$/.test(arm.imageDigest) || arms.some(other=>other.arm===arm.arm && other.imageDigest!==arm.imageDigest))reasons.push('Missing/mismatched image digest');
    for(const metric of overheadMetrics)if(!Number.isFinite(arm.metrics[metric]) || (arm.arm==='B'?arm.metrics[metric]!<=0:arm.metrics[metric]!<0))reasons.push('Missing/nonpositive metric '+metric);
    for(const shape of Object.keys(overheadClasses))if(!Number.isSafeInteger(arm.samples[shape]) || arm.samples[shape]!<=0)reasons.push('Missing sample population '+shape);
  }
  const rows=overheadMetrics.map(metric=>{
    const pairs=Array.from({length:3},(_,i)=>{
      const pair=arms.slice(i*2,i*2+2),baseline=pair.find(a=>a.arm==='B')?.metrics[metric],candidate=pair.find(a=>a.arm==='C')?.metrics[metric];
      return {pair:i+1,baseline,candidate,regressionPercent:baseline && candidate!==undefined?Number(regression(baseline,candidate).n)/Number(regression(baseline,candidate).d):NaN};
    });
    const baselines=pairs.map(p=>p.baseline ?? NaN),candidates=pairs.map(p=>p.candidate ?? NaN),deltas=pairs.map(p=>p.regressionPercent);
    const ratios=pairs.map(p=>regression(p.baseline!,p.candidate!));
    const sum=ratios.reduce((a,b)=>({n:a.n*b.d+b.n*a.d,d:a.d*b.d}),{n:0n,d:1n});
    const meanPercent=Number(sum.n)/Number(sum.d)/3;
    const meanPassed=ratios.every(r=>r.valid) && sum.n<=30n*sum.d;
    const pairsPassed=ratios.every(r=>r.valid && r.n<=10n*r.d);
    const noise=regression(Math.min(...baselines),Math.max(...baselines));
    const noisy=noise.valid && noise.n>10n*noise.d;
    const failed=!pairsPassed || !meanPassed;
    const status:Verdict=reasons.length || noisy?'NOT EVALUATED':failed?'FAIL':'PASS';
    return {metric,pairs,meanPercent,pairsPassed,meanPassed,baselineSpread:spread(baselines),candidateSpread:spread(candidates),regressionSpread:spread(deltas),baselineSpreadPercent:100*(Math.max(...baselines)/Math.min(...baselines)-1),status,reason:noisy?'Baseline spread exceeds 10%':null};
  });
  const status:Verdict=reasons.length?'NOT EVALUATED':rows.some(r=>r.status==='FAIL')?'FAIL':rows.some(r=>r.status==='NOT EVALUATED')?'NOT EVALUATED':'PASS';
  return {scenario:'pool-overhead',status,acceptance:status==='PASS',reasons:[...new Set(reasons)],rows,arms};
}
