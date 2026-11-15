import { retainedAssignment } from './dms-formal-mix.ts';
import type { MixedScenario } from './dms-formal-scenarios.ts';

export const offeredBucketMs = 60000;
export type OfferedRound = { member: number; retained: number; at: number; lanes: string[] };
export type OfferedBucket = { from: number; to: number; offered: Record<string, number>; rounds: OfferedRound[] };
type Summary = { offeredWork?: { bucketMs: number; buckets: OfferedBucket[] }; fullIntervals: {start:number;end:number}[] };

// Missing historical evidence never establishes a concurrent-load PASS.
export function concurrentBrowsingReasons(core:{from:number;to:number}, organizations:Summary[], browser:Summary, scenario:MixedScenario):string[] {
  const reasons:string[]=[];
  const buckets=(summary:Summary,label:string)=>{
    const work=summary.offeredWork;
    const count=Math.ceil((core.to-core.from)/offeredBucketMs);
    if(!work || !Array.isArray(work.buckets) || work.bucketMs!==offeredBucketMs || work.buckets.length!==count || work.buckets.some((b,i)=>!b || !b.offered || b.from!==core.from+i*offeredBucketMs || b.to!==Math.min(core.to,b.from+offeredBucketMs))) {
      reasons.push(label+': missing/malformed time-resolved offered-work and O5 cadence evidence');return [];
    }
    return work.buckets;
  };
  // constant-arrival-rate spaces arrivals uniformly; opens repeat resolve,
  // resolve, create, renew and browsing alternates first/deep (dms.ts).
  // A half-open bucket can cut a cycle at either edge: each component's
  // count differs from rate * duration by at most one offer. This is only
  // a boundary allowance: every whole-core component must reach its full target.
  const rates=(work:OfferedBucket[],label:string,components:Record<string,number>)=>{
    const totals:Record<string,number>={};
    for(const [kind,rate] of Object.entries(components)) {
      let total=0;
      for(const b of work) {
        const actual=b.offered[kind];
        if(!Number.isSafeInteger(actual) || actual!<0 || Math.abs(actual!-rate*(b.to-b.from)/1000)>1)reasons.push(label+' bucket '+b.from+': offered '+kind+' outside one-offer scheduler boundary allowance');
        total+=actual ?? NaN;
      }
      totals[kind]=total;
      if(!Number.isSafeInteger(total) || total<Math.ceil(rate*(core.to-core.from)/1000))reasons.push(label+': whole-core offered '+kind+' below full adopted target');
    }
    return totals;
  };
  if(organizations.length!==10)reasons.push('Missing ten mixed-load Organizations');
  organizations.forEach((org,index)=>{
    const label='Organization '+index, work=buckets(org,label);
    rates(work,label,{send:200,resolve:1,create:.5,renew:.5});
    const byMember=new Map<number,OfferedRound[]>();
    for(const b of work) {
      const prefix=label+' bucket '+b.from;
      if(!org.fullIntervals?.some(i=>i.start<=b.from && i.end>=b.to))reasons.push(prefix+': missing 1,000 concurrent connections');
      if(!Array.isArray(b.rounds)) {reasons.push(prefix+': missing O5 cadence evidence');continue;}
      for(const r of b.rounds) {
        if(!Number.isInteger(r.member) || r.member<0 || r.member>=1000 || !Number.isFinite(r.at) || r.at<b.from || r.at>=b.to) {
          reasons.push(prefix+': malformed O5 Member/start evidence');continue;
        }
        if(!byMember.has(r.member))byMember.set(r.member,[]);
        byMember.get(r.member)!.push(r);
      }
    }
    for(let member=0;member<1000;member++) {
      const held=retainedAssignment(member,scenario);
      const rounds=(byMember.get(member) ?? []).sort((a,c)=>a.at-c.at);
      const starts=rounds.map(r=>r.at);
      // Judge the actual schedule across the whole core, including bucket edges;
      // adopted 30 s +/-3 s jitter does not imply a percentage of nominal rounds.
      if(!starts.length || starts[0]!-core.from>33000 || core.to-starts.at(-1)!>33000 || rounds.some(r=>r.lanes?.length!==5 || r.retained!==held || !['delta','coverage','browse','recovery',...(held?['held']:[])].every(lane=>r.lanes?.includes(lane)))) {
        reasons.push(label+': Member '+member+' missing O5 cadence or adopted lanes');break;
      }
      if(starts.some((at,i)=>i>0 && at-starts[i-1]!>33000)) {
        reasons.push(label+': Member '+member+' O5 gap exceeds 33 seconds');break;
      }
    }
  });
  const browsing=rates(buckets(browser,'Browsing Organization'),'Browsing Organization',{first:50,deep:50});
  if(Math.abs(browsing.first!-browsing.deep!)>1)reasons.push('Browsing Organization: whole-core first/deep offers differ beyond alternation remainder');
  return reasons;
}
